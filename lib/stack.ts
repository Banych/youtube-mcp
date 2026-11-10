import { XMLParser } from "fast-xml-parser";
import { errorMessage, get, getWithRetry, type Deps } from "./http";

/** The packages the Daily brief's Stack news covers, and the repo whose releases speak for each. */
export const STACK: Record<string, string> = {
  next: "vercel/next.js",
  vue: "vuejs/core",
  nuxt: "nuxt/nuxt",
  react: "facebook/react",
  typescript: "microsoft/TypeScript",
  vite: "vitejs/vite",
  vitest: "vitest-dev/vitest",
  tailwindcss: "tailwindlabs/tailwindcss",
  prisma: "prisma/prisma",
  "@supabase/supabase-js": "supabase/supabase-js",
};

export type Release = {
  pkg: string;
  repo: string;
  tag: string;
  version: string;
  /** UTC, ISO 8601. */
  published: string;
  url: string;
  /** "major", "breaking", "security", "deprecation": what the brief should look at. */
  flags: string[];
  summary: string;
};

export type Advisory = {
  pkg: string;
  version: string;
  id: string;
  aliases: string[];
  severity: string;
  fixed: string | null;
  summary: string;
  url: string;
};

export type PackageVersion = { name: string; version: string };

export type StackReport = {
  since: string;
  releases: Release[];
  advisories: Advisory[];
  /** Checked package versions that came back clean. */
  clean: PackageVersion[];
  /** Package versions sent to OSV (deduplicated, exact versions only). */
  checked: number;
  osvFailed: boolean;
  failedRepos: number;
  errors: { source: string; error: string }[];
};

export const releasesFeedUrl = (repo: string) => `https://github.com/${repo}/releases.atom`;
export const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
export const osvVulnUrl = (id: string) => `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`;

/** GitHub's releases feed holds this many entries, prereleases included. */
export const FEED_SIZE = 10;
const SUMMARY_MAX = 200;
/** OSV detail lookups per call; they run in parallel, so this bounds load, not latency. */
export const MAX_ADVISORY_DETAILS = 50;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => name === "entry" || name === "link",
  parseTagValue: false,
  trimValues: true,
});

type AtomEntry = {
  updated?: string;
  title?: unknown;
  link?: { "@_href"?: string }[];
  content?: unknown;
};

const text = (v: unknown): string =>
  typeof v === "string"
    ? v
    : v && typeof v === "object" && "#text" in v
      ? String((v as { "#text": unknown })["#text"])
      : "";

/** GitHub's feed content is HTML; reduce it to one line of plain text. */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** At most SUMMARY_MAX characters (plus "…"), cut at a space when there is one. */
export function cut(s: string): string {
  if (s.length <= SUMMARY_MAX) return s;
  const space = s.lastIndexOf(" ", SUMMARY_MAX);
  return s.slice(0, space > 0 ? space : SUMMARY_MAX) + "…";
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** "16.4.1" or "15.0.0-canary.5" → "16.4.1" / "15.0.0"; anything else → null. */
const baseVersion = (v: string) => /^(\d+\.\d+\.\d+)/.exec(v)?.[1] ?? null;

/**
 * A stable release of this package: "v16.4.1" or "16.4.1", or "<pkg>@16.4.1" in a monorepo.
 * Canary, beta, rc and other packages' tags (e.g. vite's "create-vite@7.0.0") are skipped.
 */
export function stableVersion(tag: string, pkg: string): string | null {
  const bare = tag.startsWith(`${pkg}@`) ? tag.slice(pkg.length + 1) : tag.replace(/^v/, "");
  return VERSION.test(bare) ? bare : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number),
    pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function flagsFor(version: string, notes: string): string[] {
  const flags: string[] = [];
  if (/^\d+\.0\.0$/.test(version)) flags.push("major");
  if (/breaking change/i.test(notes)) flags.push("breaking");
  if (/CVE-\d{4}-\d+|GHSA-[\w-]+|vulnerab|\bsecurity (fix|patch|release|advisory|update|issue)/i.test(notes)) {
    flags.push("security");
  }
  if (/deprecat/i.test(notes)) flags.push("deprecation");
  return flags;
}

const toUtc = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");

function tagOf(url: string): string {
  const raw = url.split("/releases/tag/")[1] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export type ParsedFeed = {
  releases: Release[];
  /** Entries in the feed, prereleases included. */
  entries: number;
  /** Oldest entry's time (ms), or null for an empty feed. */
  oldest: number | null;
  /** Entries skipped because their date could not be read. */
  badDates: number;
};

/** Stable releases published at or after `since`; times compared as instants, not as text. */
export function parseReleases(xml: string, pkg: string, repo: string, since: string): ParsedFeed {
  const doc = parser.parse(xml) as { feed?: { entry?: AtomEntry[] } };
  if (!doc.feed) throw new Error("not a releases feed");
  const sinceMs = Date.parse(since);
  const entries = doc.feed.entry ?? [];
  const parsed: ParsedFeed = { releases: [], entries: entries.length, oldest: null, badDates: 0 };
  for (const e of entries) {
    const t = Date.parse(e.updated ?? "");
    if (Number.isNaN(t)) {
      parsed.badDates++;
      continue;
    }
    parsed.oldest = parsed.oldest === null ? t : Math.min(parsed.oldest, t);
    const url = e.link?.find((l) => l["@_href"]?.includes("/releases/tag/"))?.["@_href"] ?? "";
    const tag = tagOf(url);
    const version = stableVersion(tag, pkg);
    if (!version || t < sinceMs) continue;
    const notes = plainText(text(e.content));
    parsed.releases.push({
      pkg,
      repo,
      tag,
      version,
      published: toUtc(t),
      url,
      flags: flagsFor(version, notes),
      summary: cut(notes),
    });
  }
  return parsed;
}

/** "^16.3.8", "~15.3.3" or "16.3.8" → "16.3.8"; anything else is not checkable. */
export function exactVersion(raw: string): string | null {
  const v = raw.trim().replace(/^[\^~=v]+/, "");
  return VERSION.test(v) ? v : null;
}

type OsvEvent = { introduced?: string; fixed?: string; last_affected?: string };
type OsvVuln = {
  id: string;
  summary?: string;
  aliases?: string[];
  severity?: { type?: string; score?: string }[];
  database_specific?: { severity?: string };
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { events?: OsvEvent[] }[] }[];
};

/**
 * The fix for the range that contains `version`: the smallest "fixed" whose range was
 * introduced at or before it. A range that ends in "last_affected" has no fix, so null.
 */
export function fixedVersion(vuln: OsvVuln, pkg: string, version: string): string | null {
  const candidates: { raw: string; base: string }[] = [];
  for (const affected of vuln.affected ?? []) {
    if (affected.package?.name !== pkg || affected.package?.ecosystem !== "npm") continue;
    for (const range of affected.ranges ?? []) {
      let introduced: string | null = null;
      for (const ev of range.events ?? []) {
        if (ev.introduced !== undefined) introduced = ev.introduced === "0" ? "0.0.0" : baseVersion(ev.introduced);
        if (ev.fixed !== undefined) {
          const fixed = baseVersion(ev.fixed);
          if (
            introduced &&
            fixed &&
            compareVersions(introduced, version) <= 0 &&
            compareVersions(version, fixed) < 0
          ) {
            candidates.push({ raw: ev.fixed, base: fixed });
          }
          introduced = null;
        }
        if (ev.last_affected !== undefined) introduced = null;
      }
    }
  }
  return candidates.sort((a, b) => compareVersions(a.base, b.base))[0]?.raw ?? null;
}

function severityOf(v: OsvVuln): string {
  const fromGitHub = v.database_specific?.severity;
  if (fromGitHub) return fromGitHub;
  const cvss = v.severity?.find((s) => s.score)?.score;
  return cvss ? cvss : "UNKNOWN";
}

async function advisoriesFor(packages: PackageVersion[], deps: Deps, report: StackReport) {
  const body = JSON.stringify({
    queries: packages.map((p) => ({ package: { name: p.name, ecosystem: "npm" }, version: p.version })),
  });
  const batch = JSON.parse(
    await get(OSV_BATCH_URL, deps, { method: "POST", headers: { "content-type": "application/json" }, body }),
  ) as { results?: { vulns?: { id: string }[] }[] };
  const hits = packages.flatMap((p, i) => (batch.results?.[i]?.vulns ?? []).map((v) => ({ p, id: v.id })));

  const ids = [...new Set(hits.map((h) => h.id))];
  const looked = ids.slice(0, MAX_ADVISORY_DETAILS);
  if (ids.length > looked.length) {
    report.errors.push({
      source: "OSV advisories",
      error: `${ids.length - looked.length} advisory detail(s) not fetched (limit ${MAX_ADVISORY_DETAILS}); listed by id only`,
    });
  }
  const details = new Map<string, OsvVuln | string>();
  await Promise.all(
    looked.map(async (id) => {
      try {
        details.set(id, JSON.parse(await get(osvVulnUrl(id), deps)) as OsvVuln);
      } catch (e) {
        details.set(id, `details unavailable (${errorMessage(e)})`);
      }
    }),
  );

  // Every hit is reported, with or without details; aliases of one advisory are reported once per package.
  const seen = new Map<string, Set<string>>();
  for (const { p, id } of hits) {
    const key = `${p.name}@${p.version}`;
    const known = seen.get(key) ?? new Set<string>();
    seen.set(key, known);
    const d = details.get(id);
    const vuln = typeof d === "object" ? d : undefined;
    const names = [id, ...(vuln?.aliases ?? [])];
    if (names.some((n) => known.has(n))) continue;
    names.forEach((n) => known.add(n));
    report.advisories.push({
      pkg: p.name,
      version: p.version,
      id,
      aliases: vuln?.aliases ?? [],
      severity: vuln ? severityOf(vuln) : "UNKNOWN",
      fixed: vuln ? fixedVersion(vuln, p.name, p.version) : null,
      summary: vuln ? cut(vuln.summary ?? "") : typeof d === "string" ? d : "details not fetched",
      url: `https://osv.dev/vulnerability/${id}`,
    });
  }
  const affected = new Set(hits.map((h) => h.p));
  report.clean = packages.filter((p) => !affected.has(p));
}

export async function stackReport(since: string, packages: PackageVersion[], deps: Deps): Promise<StackReport> {
  const report: StackReport = {
    since,
    releases: [],
    advisories: [],
    clean: [],
    checked: 0,
    osvFailed: false,
    failedRepos: 0,
    errors: [],
  };
  const sinceMs = Date.parse(since);
  const checkable = new Map<string, PackageVersion>();
  for (const p of packages) {
    const version = exactVersion(p.version);
    if (version) checkable.set(`${p.name}@${version}`, { name: p.name, version });
    else report.errors.push({ source: `${p.name}@${p.version}`, error: "not an exact version (x.y.z), not checked" });
  }
  report.checked = checkable.size;

  const feeds = Object.entries(STACK).map(async ([pkg, repo]) => {
    try {
      const feed = parseReleases(await getWithRetry(releasesFeedUrl(repo), deps), pkg, repo, since);
      report.releases.push(...feed.releases);
      if (feed.badDates) {
        report.errors.push({ source: repo, error: `${feed.badDates} entr(y/ies) with an unreadable date skipped` });
      }
      if (feed.entries >= FEED_SIZE && feed.oldest !== null && feed.oldest > sinceMs) {
        report.errors.push({
          source: repo,
          error: `feed holds only the latest ${FEED_SIZE} releases, all newer than ${since}; older stable releases may be missing`,
        });
      }
    } catch (e) {
      report.failedRepos++;
      report.errors.push({ source: repo, error: errorMessage(e) });
    }
  });
  const osv = checkable.size
    ? advisoriesFor([...checkable.values()], deps, report).catch((e) => {
        report.osvFailed = true;
        report.errors.push({ source: "OSV advisories", error: errorMessage(e) });
      })
    : Promise.resolve();
  await Promise.all([...feeds, osv]);

  report.releases.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  return report;
}

export function formatStack(r: StackReport): string {
  const repos = Object.keys(STACK).length;
  const lines = [`Stable releases at or after ${r.since} (${repos - r.failedRepos}/${repos} repos read):`];
  if (!r.releases.length) lines.push("  none");
  for (const rel of r.releases) {
    const flags = rel.flags.length ? ` · ${rel.flags.join(", ")}` : "";
    lines.push(`${rel.pkg} ${rel.version} · ${rel.published.slice(0, 10)}${flags} — ${rel.url}`);
    if (rel.summary) lines.push(`    notes: ${rel.summary}`);
  }
  if (r.checked) {
    lines.push("", `Advisories (OSV) for ${r.checked} package version(s):`);
    if (r.osvFailed) lines.push("  unavailable (see the errors below)");
    for (const a of r.advisories) {
      const ids = [a.id, ...a.aliases.filter((x) => x !== a.id)].slice(0, 3).join(", ");
      const fix = a.fixed ? `fixed in ${a.fixed}` : "no fixed version listed";
      lines.push(`${a.pkg} ${a.version} · ${ids} · ${a.severity} · ${fix} — ${a.url}`);
      if (a.summary) lines.push(`    summary: ${a.summary}`);
    }
    for (const c of r.clean) lines.push(`${c.name} ${c.version} · no known advisories`);
  }
  if (r.errors.length) lines.push("", ...r.errors.map((e) => `! ${e.source}: ${e.error}`));
  return lines.join("\n");
}
