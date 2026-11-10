import { XMLParser } from "fast-xml-parser";
import { errorMessage, get, type Deps } from "./http";

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
  /** Packages passed in that came back clean. */
  clean: PackageVersion[];
  errors: { source: string; error: string }[];
};

export const releasesFeedUrl = (repo: string) => `https://github.com/${repo}/releases.atom`;
export const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
export const osvVulnUrl = (id: string) => `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`;

const SUMMARY_MAX = 200;
/** OSV detail lookups per call; each is one request. */
const MAX_ADVISORIES = 20;

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
  typeof v === "string" ? v : v && typeof v === "object" && "#text" in v ? String((v as { "#text": unknown })["#text"]) : "";

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

const cut = (s: string) => (s.length <= SUMMARY_MAX ? s : s.slice(0, s.lastIndexOf(" ", SUMMARY_MAX) || SUMMARY_MAX) + "…");

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * A stable release of this package: "v16.4.1" or "16.4.1", or "<pkg>@16.4.1" in a monorepo.
 * Canary, beta, rc and other packages' tags (e.g. vite's "create-vite@7.0.0") are skipped.
 */
export function stableVersion(tag: string, pkg: string): string | null {
  const bare = tag.startsWith(`${pkg}@`) ? tag.slice(pkg.length + 1) : tag.replace(/^v/, "");
  return VERSION.test(bare) ? bare : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function flagsFor(version: string, notes: string): string[] {
  const flags: string[] = [];
  if (/^\d+\.0\.0$/.test(version)) flags.push("major");
  if (/breaking change/i.test(notes)) flags.push("breaking");
  if (/\bsecurity\b|CVE-\d{4}-\d+|GHSA-[\w-]+/i.test(notes)) flags.push("security");
  if (/deprecat/i.test(notes)) flags.push("deprecation");
  return flags;
}

export function parseReleases(xml: string, pkg: string, repo: string, since: string): Release[] {
  const doc = parser.parse(xml) as { feed?: { entry?: AtomEntry[] } };
  if (!doc.feed) throw new Error("not a releases feed");
  return (doc.feed.entry ?? []).flatMap((e) => {
    const url = e.link?.find((l) => l["@_href"]?.includes("/releases/tag/"))?.["@_href"] ?? "";
    const tag = decodeURIComponent(url.split("/releases/tag/")[1] ?? "");
    const version = stableVersion(tag, pkg);
    const published = e.updated ?? "";
    if (!version || !published || published < since) return [];
    const notes = plainText(text(e.content));
    return [{ pkg, repo, tag, version, published, url, flags: flagsFor(version, notes), summary: cut(notes) }];
  });
}

/** "^16.3.8", "~15.3.3" or "16.3.8" → "16.3.8"; anything else is not checkable. */
export function exactVersion(raw: string): string | null {
  const v = raw.trim().replace(/^[\^~=v]+/, "");
  return VERSION.test(v) ? v : null;
}

type OsvVuln = {
  id: string;
  summary?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { events?: { fixed?: string }[] }[] }[];
};

/** The smallest version that fixes this package above the one in use, if OSV lists one. */
export function fixedVersion(vuln: OsvVuln, pkg: string, version: string): string | null {
  const fixes = (vuln.affected ?? [])
    .filter((a) => a.package?.name === pkg && a.package?.ecosystem === "npm")
    .flatMap((a) => a.ranges ?? [])
    .flatMap((r) => r.events ?? [])
    .map((ev) => ev.fixed)
    .filter((f): f is string => !!f && VERSION.test(f) && compareVersions(f, version) > 0)
    .sort(compareVersions);
  return fixes[0] ?? null;
}

async function advisoriesFor(packages: PackageVersion[], deps: Deps) {
  const body = JSON.stringify({
    queries: packages.map((p) => ({ package: { name: p.name, ecosystem: "npm" }, version: p.version })),
  });
  const batch = JSON.parse(
    await get(OSV_BATCH_URL, deps, { method: "POST", headers: { "content-type": "application/json" }, body }),
  ) as { results?: { vulns?: { id: string }[] }[] };
  const hits = packages.flatMap((p, i) => (batch.results?.[i]?.vulns ?? []).map((v) => ({ p, id: v.id })));
  const ids = [...new Set(hits.map((h) => h.id))].slice(0, MAX_ADVISORIES);
  const details = new Map<string, OsvVuln>();
  await Promise.all(
    ids.map(async (id) => details.set(id, JSON.parse(await get(osvVulnUrl(id), deps)) as OsvVuln)),
  );
  const advisories: Advisory[] = hits
    .filter((h) => details.has(h.id))
    .map(({ p, id }) => {
      const v = details.get(id)!;
      return {
        pkg: p.name,
        version: p.version,
        id,
        aliases: v.aliases ?? [],
        severity: v.database_specific?.severity ?? "UNKNOWN",
        fixed: fixedVersion(v, p.name, p.version),
        summary: cut(v.summary ?? ""),
        url: `https://osv.dev/vulnerability/${id}`,
      };
    });
  const affected = new Set(hits.map((h) => h.p));
  return { advisories, clean: packages.filter((p) => !affected.has(p)) };
}

export async function stackReport(
  since: string,
  packages: { name: string; version: string }[],
  deps: Deps,
): Promise<StackReport> {
  const report: StackReport = { since, releases: [], advisories: [], clean: [], errors: [] };
  const checkable: PackageVersion[] = [];
  for (const p of packages) {
    const version = exactVersion(p.version);
    if (version) checkable.push({ name: p.name, version });
    else report.errors.push({ source: `${p.name}@${p.version}`, error: "not an exact version (x.y.z), not checked" });
  }

  const feeds = Object.entries(STACK).map(async ([pkg, repo]) => {
    try {
      report.releases.push(...parseReleases(await get(releasesFeedUrl(repo), deps), pkg, repo, since));
    } catch (e) {
      report.errors.push({ source: repo, error: errorMessage(e) });
    }
  });
  const osv = checkable.length
    ? advisoriesFor(checkable, deps).then(
        (r) => Object.assign(report, r),
        (e) => report.errors.push({ source: "OSV advisories", error: errorMessage(e) }),
      )
    : Promise.resolve();
  await Promise.all([...feeds, osv]);

  report.releases.sort((a, b) => b.published.localeCompare(a.published));
  return report;
}

export function formatStack(r: StackReport, packagesChecked: number): string {
  const repos = Object.keys(STACK).length;
  const failedRepos = r.errors.filter((e) => Object.values(STACK).includes(e.source)).length;
  const lines = [`Stable releases since ${r.since} (${repos - failedRepos}/${repos} repos read):`];
  if (!r.releases.length) lines.push("  none");
  for (const rel of r.releases) {
    const flags = rel.flags.length ? ` · ${rel.flags.join(", ")}` : "";
    lines.push(`${rel.pkg} ${rel.version} · ${rel.published.slice(0, 10)}${flags} — ${rel.url}`);
    if (rel.summary) lines.push(`    ${rel.summary}`);
  }
  if (packagesChecked) {
    lines.push("", `Advisories (OSV) for ${packagesChecked} package version(s):`);
    for (const a of r.advisories) {
      const ids = [a.id, ...a.aliases.filter((x) => x !== a.id)].slice(0, 3).join(", ");
      lines.push(
        `${a.pkg} ${a.version} · ${ids} · ${a.severity} · ${a.fixed ? `fixed in ${a.fixed}` : "no fixed version listed"} — ${a.url}`,
      );
      if (a.summary) lines.push(`    ${a.summary}`);
    }
    for (const c of r.clean) lines.push(`${c.name} ${c.version} · no known advisories`);
  }
  if (r.errors.length) lines.push("", ...r.errors.map((e) => `! ${e.source}: ${e.error}`));
  return lines.join("\n");
}
