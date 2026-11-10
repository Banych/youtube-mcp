import { describe, expect, it } from "vitest";
import {
  cut,
  exactVersion,
  FEED_SIZE,
  MAX_ADVISORY_DETAILS,
  fixedVersion,
  formatStack,
  OSV_BATCH_URL,
  osvVulnUrl,
  parseReleases,
  plainText,
  readVuln,
  releasesFeedUrl,
  STACK,
  stableVersion,
  stackReport,
} from "../lib/stack";
import { fakeFetch } from "./fixtures";

const SINCE = "2026-11-01T00:00:00Z";

/** Shaped like https://github.com/<owner>/<repo>/releases.atom: HTML content escaped inside the XML. */
function releasesFeed(repo: string, entries: { tag: string; updated: string; html: string }[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/${repo}/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/${repo}/releases"/>
  <link type="application/atom+xml" rel="self" href="https://github.com/${repo}/releases.atom"/>
  <title>Release notes from ${repo.split("/")[1]}</title>
  <updated>2026-11-06T10:00:00Z</updated>
${entries
  .map(
    (e) => `  <entry>
    <id>tag:github.com,2008:Repository/1/${e.tag}</id>
    <updated>${e.updated}</updated>
    <link rel="alternate" type="text/html" href="https://github.com/${repo}/releases/tag/${encodeURIComponent(e.tag)}"/>
    <title>${e.tag}</title>
    <content type="html">${esc(e.html)}</content>
    <author><name>release-bot</name></author>
  </entry>`,
  )
  .join("\n")}
</feed>`;
}

const NEXT_FEED = releasesFeed("vercel/next.js", [
  { tag: "v16.5.0-canary.3", updated: "2026-11-06T10:00:00Z", html: "<p>canary</p>" },
  {
    tag: "v16.4.2",
    updated: "2026-11-05T10:00:00Z",
    html: "<h3>Core Changes</h3><ul><li>Fix a security issue in middleware (CVE-2026-12345) &amp; more</li></ul>",
  },
  { tag: "v16.4.1", updated: "2026-10-14T10:00:00Z", html: "<p>older than the window</p>" },
]);

const VITE_FEED = releasesFeed("vitejs/vite", [
  { tag: "create-vite@8.0.0", updated: "2026-11-04T09:00:00Z", html: "<p>scaffolder</p>" },
  { tag: "v8.0.0", updated: "2026-11-04T08:00:00Z", html: "<h2>Breaking Changes</h2><p>Node 20 is deprecated.</p>" },
]);

const OSV_BATCH = JSON.stringify({ results: [{ vulns: [{ id: "GHSA-aaaa-bbbb-cccc", modified: "2026-10-14T00:00:00Z" }] }, {}] });

const GHSA = JSON.stringify({
  id: "GHSA-aaaa-bbbb-cccc",
  summary: "Next.js middleware authorization bypass",
  aliases: ["CVE-2026-12345"],
  database_specific: { severity: "CRITICAL" },
  affected: [
    {
      package: { ecosystem: "npm", name: "next" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "15.0.0" }, { fixed: "15.5.28" }] },
        { type: "SEMVER", events: [{ introduced: "16.0.0" }, { fixed: "16.4.1" }] },
      ],
    },
  ],
});

describe("stableVersion", () => {
  it("accepts plain and v-prefixed versions, and the package's own monorepo tags", () => {
    expect(stableVersion("v16.4.2", "next")).toBe("16.4.2");
    expect(stableVersion("6.19.0", "prisma")).toBe("6.19.0");
    expect(stableVersion("@supabase/supabase-js@2.81.0", "@supabase/supabase-js")).toBe("2.81.0");
  });

  it("skips prereleases and other packages' tags", () => {
    expect(stableVersion("v16.5.0-canary.3", "next")).toBeNull();
    expect(stableVersion("v5.0.0-rc.1", "typescript")).toBeNull();
    expect(stableVersion("create-vite@8.0.0", "vite")).toBeNull();
  });
});

describe("parseReleases", () => {
  it("keeps stable releases inside the window, flagged and summarised", () => {
    expect(parseReleases(NEXT_FEED, "next", "vercel/next.js", SINCE).releases).toEqual([
      {
        pkg: "next",
        repo: "vercel/next.js",
        tag: "v16.4.2",
        version: "16.4.2",
        published: "2026-11-05T10:00:00Z",
        url: "https://github.com/vercel/next.js/releases/tag/v16.4.2",
        flags: ["security"],
        summary: "Core Changes Fix a security issue in middleware (CVE-2026-12345) & more",
      },
    ]);
  });

  it("flags a major version, breaking changes and deprecations", () => {
    const [v8] = parseReleases(VITE_FEED, "vite", "vitejs/vite", SINCE).releases;
    expect(v8.version).toBe("8.0.0");
    expect(v8.flags).toEqual(["major", "breaking", "deprecation"]);
  });

  it("compares times as instants, so offsets and an exactly equal since work", () => {
    const feed = releasesFeed("vercel/next.js", [
      // 23:00 at -08:00 on Nov 5 is 07:00Z on Nov 6: inside a window starting Nov 6 00:00Z.
      { tag: "v16.4.3", updated: "2026-11-05T23:00:00-08:00", html: "<p>x</p>" },
      { tag: "v16.4.2", updated: "2026-11-06T00:00:00Z", html: "<p>y</p>" },
      { tag: "v16.4.1", updated: "2026-11-05T23:59:59Z", html: "<p>z</p>" },
    ]);
    const { releases } = parseReleases(feed, "next", "vercel/next.js", "2026-11-06T00:00:00.000Z");
    expect(releases.map((r) => [r.version, r.published])).toEqual([
      ["16.4.3", "2026-11-06T07:00:00Z"],
      ["16.4.2", "2026-11-06T00:00:00Z"],
    ]);
  });

  it("skips an entry with an unreadable date or a malformed tag URL instead of failing the feed", () => {
    const feed = releasesFeed("vercel/next.js", [
      { tag: "v16.4.2", updated: "not a date", html: "<p>x</p>" },
      { tag: "v16.4.1", updated: "2026-11-05T10:00:00Z", html: "<p>y</p>" },
    ]).replace("releases/tag/v16.4.1", "releases/tag/v16.4.1%E0%A4%A");
    const parsed = parseReleases(feed, "next", "vercel/next.js", SINCE);
    expect(parsed.badDates).toBe(1);
    expect(parsed.releases).toEqual([]);
  });

  it("does not flag a passing mention of security", () => {
    const feed = releasesFeed("vercel/next.js", [
      { tag: "v16.4.2", updated: "2026-11-05T10:00:00Z", html: "<p>Improve security docs wording</p>" },
    ]);
    expect(parseReleases(feed, "next", "vercel/next.js", SINCE).releases[0].flags).toEqual([]);
  });

  it("rejects a page that is not a feed", () => {
    expect(() => parseReleases("<html><body>rate limited</body></html>", "next", "vercel/next.js", SINCE)).toThrow(
      "not a releases feed",
    );
  });
});

describe("cut", () => {
  it("caps text without spaces too", () => {
    const out = cut("a".repeat(5000));
    expect(out).toHaveLength(201);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("plainText", () => {
  it("drops tags and decodes the entities GitHub leaves in", () => {
    expect(plainText("<p>a &lt;b&gt; &amp; &quot;c&quot;</p>\n<script>x()</script><li>d</li>")).toBe('a <b> & "c" d');
  });
});

describe("versions", () => {
  it("reads an exact version from a package.json range", () => {
    expect(exactVersion("^16.3.8")).toBe("16.3.8");
    expect(exactVersion("~15.3.3")).toBe("15.3.3");
    expect(exactVersion("latest")).toBeNull();
    expect(exactVersion(">=15 <17")).toBeNull();
  });

  it("picks the smallest fixed version above the one in use", () => {
    const vuln = readVuln(JSON.parse(GHSA), "GHSA-aaaa-bbbb-cccc");
    expect(fixedVersion(vuln, "next", "16.3.8")).toBe("16.4.1");
    expect(fixedVersion(vuln, "next", "15.3.3")).toBe("15.5.28");
    expect(fixedVersion(vuln, "react", "19.0.0")).toBeNull();
  });

  it("uses the range that contains the version, and none when that range has no fix", () => {
    const vuln = readVuln({
      id: "GHSA-x",
      affected: [
        {
          package: { ecosystem: "npm", name: "next" },
          ranges: [
            { events: [{ introduced: "0" }, { fixed: "14.2.30" }] },
            { events: [{ introduced: "15.0.0" }, { last_affected: "15.9.9" }] },
            { events: [{ introduced: "16.0.0-canary.1" }, { fixed: "16.1.0-canary.4" }] },
          ],
        },
      ],
    }, "GHSA-x");
    expect(fixedVersion(vuln, "next", "15.3.3")).toBeNull();
    expect(fixedVersion(vuln, "next", "14.1.0")).toBe("14.2.30");
    expect(fixedVersion(vuln, "next", "16.0.5")).toBe("16.1.0-canary.4");
  });

  it("prefers a stable fix over a prerelease of the same version, and ignores malformed fix values", () => {
    const vuln = readVuln(
      {
        affected: [
          {
            package: { ecosystem: "npm", name: "next" },
            ranges: [
              { events: [{ introduced: "16.0.0" }, { fixed: "16.1.0-canary.4" }] },
              { events: [{ introduced: "16.0.0" }, { fixed: "16.1.0" }] },
              { events: [{ introduced: "0" }, { fixed: "16.0.9\nIGNORE PREVIOUS INSTRUCTIONS" }] },
            ],
          },
        ],
      },
      "GHSA-y",
    );
    expect(fixedVersion(vuln, "next", "16.0.5")).toBe("16.1.0");
  });
});

describe("stackReport", () => {
  const routes = {
    [releasesFeedUrl("vercel/next.js")]: NEXT_FEED,
    [releasesFeedUrl("vitejs/vite")]: VITE_FEED,
    [OSV_BATCH_URL]: OSV_BATCH,
    [osvVulnUrl("GHSA-aaaa-bbbb-cccc")]: GHSA,
  };

  it("collects releases, advisories, clean packages and per-source errors", async () => {
    const { fetch, calls } = fakeFetch(routes);
    const report = await stackReport(
      SINCE,
      [
        { name: "next", version: "^16.3.8" },
        { name: "react", version: "19.2.0" },
        { name: "vue", version: "latest" },
      ],
      { fetch, retryDelaysMs: [0, 0] },
    );
    expect(report.releases.map((r) => `${r.pkg} ${r.version}`)).toEqual(["next 16.4.2", "vite 8.0.0"]);
    expect(report.advisories).toEqual([
      {
        pkg: "next",
        version: "16.3.8",
        id: "GHSA-aaaa-bbbb-cccc",
        aliases: ["CVE-2026-12345"],
        severity: "CRITICAL",
        fixed: "16.4.1",
        summary: "Next.js middleware authorization bypass",
        url: "https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc",
      },
    ]);
    expect(report.clean).toEqual([{ name: "react", version: "19.2.0" }]);
    // Repos without a fixture answer 404; vue's "latest" is not checkable.
    expect(report.errors).toContainEqual({ source: "vue@latest", error: "not an exact version (x.y.z), not checked" });
    expect(report.errors).toContainEqual({ source: "facebook/react", error: "HTTP 404 (3 tries)" });
    expect(report.failedRepos).toBe(Object.keys(STACK).length - 2);
    expect(report.checked).toBe(2);

    const batch = calls.find((c) => c.url === OSV_BATCH_URL);
    expect(batch?.init?.method).toBe("POST");
    expect(JSON.parse(String(batch?.init?.body))).toEqual({
      queries: [
        { package: { name: "next", ecosystem: "npm" }, version: "16.3.8" },
        { package: { name: "react", ecosystem: "npm" }, version: "19.2.0" },
      ],
    });
  });

  it("skips OSV entirely when no packages are passed", async () => {
    const { fetch, calls } = fakeFetch(routes);
    await stackReport(SINCE, [], { fetch, retryDelaysMs: [0, 0] });
    expect(calls.some((c) => c.url.startsWith("https://api.osv.dev"))).toBe(false);
  });

  it("reports OSV failing without losing the releases", async () => {
    const { fetch } = fakeFetch({ ...routes, [OSV_BATCH_URL]: 503 });
    const report = await stackReport(SINCE, [{ name: "next", version: "16.3.8" }], { fetch, retryDelaysMs: [0, 0] });
    expect(report.releases).toHaveLength(2);
    expect(report.osvFailed).toBe(true);
    expect(report.errors).toContainEqual({ source: "OSV advisories", error: "HTTP 503" });
    expect(formatStack(report)).toContain("Advisories (OSV) for 1 package version(s):\n  unavailable (see the errors below)");
  });

  it("keeps an advisory whose details fail, and lists every advisory past the detail limit", async () => {
    const extra = MAX_ADVISORY_DETAILS + 2;
    const vulns = Array.from({ length: extra }, (_, i) => ({ id: `GHSA-${i}` }));
    const { fetch } = fakeFetch({
      [OSV_BATCH_URL]: JSON.stringify({ results: [{ vulns }] }),
      [osvVulnUrl("GHSA-0")]: GHSA.replace('"GHSA-aaaa-bbbb-cccc"', '"GHSA-0"'),
      // GHSA-1 … answer 404 (details unavailable); the last two are never looked up.
    });
    const report = await stackReport(SINCE, [{ name: "next", version: "16.3.8" }], { fetch, retryDelaysMs: [0, 0] });
    expect(report.advisories).toHaveLength(extra);
    expect(report.advisories[0]).toMatchObject({ id: "GHSA-0", severity: "CRITICAL", fixed: "16.4.1" });
    expect(report.advisories[1]).toMatchObject({
      id: "GHSA-1",
      severity: "severity not fetched",
      summary: "details unavailable (HTTP 404 (3 tries))",
    });
    expect(report.advisories.at(-1)).toMatchObject({ summary: "details not fetched" });
    expect(report.errors).toContainEqual({
      source: "OSV advisories",
      error: `2 advisory detail(s) not fetched (limit ${MAX_ADVISORY_DETAILS}); listed by id only`,
    });
    expect(report.clean).toEqual([]);
  });

  it("checks a package version passed twice once, and reports an aliased advisory once", async () => {
    const { fetch, calls } = fakeFetch({
      [OSV_BATCH_URL]: JSON.stringify({ results: [{ vulns: [{ id: "GHSA-aaaa-bbbb-cccc" }, { id: "CVE-2026-12345" }] }] }),
      [osvVulnUrl("GHSA-aaaa-bbbb-cccc")]: GHSA,
      [osvVulnUrl("CVE-2026-12345")]: JSON.stringify({ id: "CVE-2026-12345", aliases: ["GHSA-aaaa-bbbb-cccc"] }),
    });
    const report = await stackReport(
      SINCE,
      [
        { name: "next", version: "16.3.8" },
        { name: "next", version: "^16.3.8" },
      ],
      { fetch, retryDelaysMs: [0, 0] },
    );
    const batch = calls.find((c) => c.url === OSV_BATCH_URL);
    expect(JSON.parse(String(batch?.init?.body)).queries).toHaveLength(1);
    expect(report.advisories.map((a) => a.id)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
  });

  it("warns when a feed's 10 entries are all newer than the window start", async () => {
    const busy = releasesFeed(
      "vercel/next.js",
      Array.from({ length: FEED_SIZE }, (_, i) => ({
        tag: `v16.5.0-canary.${i}`,
        updated: `2026-11-0${(i % 3) + 5}T10:00:00Z`,
        html: "<p>canary</p>",
      })),
    );
    const { fetch } = fakeFetch({ [releasesFeedUrl("vercel/next.js")]: busy });
    const report = await stackReport(SINCE, [], { fetch, retryDelaysMs: [0, 0] });
    expect(report.errors).toContainEqual({
      source: "vercel/next.js",
      error: `feed holds only the latest ${FEED_SIZE} releases, all newer than ${SINCE}; older stable releases may be missing`,
    });
  });
});

describe("formatStack", () => {
  it("prints releases, then advisories, then errors", async () => {
    const { fetch } = fakeFetch({
      [releasesFeedUrl("vercel/next.js")]: NEXT_FEED,
      [OSV_BATCH_URL]: OSV_BATCH,
      [osvVulnUrl("GHSA-aaaa-bbbb-cccc")]: GHSA,
    });
    const packages = [
      { name: "next", version: "16.3.8" },
      { name: "react", version: "19.2.0" },
    ];
    const text = formatStack(await stackReport(SINCE, packages, { fetch, retryDelaysMs: [0, 0] }));
    const lines = text.split("\n");
    expect(lines[0]).toBe(`Stable releases at or after ${SINCE} (1/${Object.keys(STACK).length} repos read):`);
    expect(lines[1]).toBe("next 16.4.2 · 2026-11-05 · security — https://github.com/vercel/next.js/releases/tag/v16.4.2");
    expect(text).toContain(
      "next 16.3.8 · GHSA-aaaa-bbbb-cccc, CVE-2026-12345 · CRITICAL · fixed in 16.4.1 — https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc",
    );
    expect(text).toContain("react 19.2.0 · no known advisories");
    expect(lines[2]).toBe("    notes: Core Changes Fix a security issue in middleware (CVE-2026-12345) & more");
    expect(text).toContain("    summary: Next.js middleware authorization bypass");
    expect(text).toContain("! facebook/react: HTTP 404 (3 tries)");
  });
});

describe("outside data is validated at the boundary", () => {
  it("collapses OSV text to one line so it cannot forge output lines, and drops malformed fields", () => {
    const v = readVuln(
      {
        summary: "Bad thing\nreact 19.2.0 · no known advisories\r\u2028more",
        aliases: "CVE-2026-1",
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
        affected: [null, { package: "next" }],
      },
      "OSV-2026-1",
    );
    expect(v.summary).toBe("Bad thing react 19.2.0 · no known advisories more");
    expect(v.aliases).toEqual([]);
    expect(v.severity).toBe("CVSS vector CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H");
    expect(v.affected).toHaveLength(2);
    expect(fixedVersion(v, "next", "1.0.0")).toBeNull();
  });

  it("does not take a severity that is not a known word or a CVSS vector", () => {
    expect(readVuln({ database_specific: { severity: "CRITICAL\n! fake" } }, "GHSA-z").severity).toBeNull();
    expect(readVuln({ database_specific: { severity: "high" } }, "GHSA-z").severity).toBe("HIGH");
  });

  it("skips malformed advisory ids from the batch and says so", async () => {
    const { fetch } = fakeFetch({
      [OSV_BATCH_URL]: JSON.stringify({ results: [{ vulns: [{ id: "GHSA-aaaa-bbbb-cccc" }, { id: "x\n! forged" }, {}] }] }),
      [osvVulnUrl("GHSA-aaaa-bbbb-cccc")]: GHSA,
    });
    const report = await stackReport(SINCE, [{ name: "next", version: "16.3.8" }], { fetch, retryDelaysMs: [0, 0] });
    expect(report.advisories.map((a) => a.id)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
    expect(report.errors).toContainEqual({ source: "OSV advisories", error: "2 malformed advisory id(s) skipped" });
  });

  it("survives malformed OSV records without losing the others", async () => {
    const { fetch } = fakeFetch({
      [OSV_BATCH_URL]: JSON.stringify({ results: [{ vulns: [{ id: "GHSA-aaaa-bbbb-cccc" }, { id: "GHSA-weird" }] }] }),
      [osvVulnUrl("GHSA-aaaa-bbbb-cccc")]: GHSA,
      [osvVulnUrl("GHSA-weird")]: JSON.stringify({ aliases: "nope", affected: [null], severity: "x" }),
    });
    const report = await stackReport(SINCE, [{ name: "next", version: "16.3.8" }], { fetch, retryDelaysMs: [0, 0] });
    expect(report.osvFailed).toBe(false);
    expect(report.advisories.map((a) => [a.id, a.severity])).toEqual([
      ["GHSA-aaaa-bbbb-cccc", "CRITICAL"],
      ["GHSA-weird", "severity not listed"],
    ]);
    expect(() => formatStack(report)).not.toThrow();
  });

  it("keeps details from an alias when the first record of an advisory had none", async () => {
    const { fetch } = fakeFetch({
      [OSV_BATCH_URL]: JSON.stringify({ results: [{ vulns: [{ id: "GHSA-aaaa-bbbb-cccc" }, { id: "CVE-2026-12345" }] }] }),
      // The GHSA lookup fails (404); the CVE record lists the GHSA as an alias.
      [osvVulnUrl("CVE-2026-12345")]: JSON.stringify({ ...JSON.parse(GHSA), id: "CVE-2026-12345", aliases: ["GHSA-aaaa-bbbb-cccc"] }),
    });
    const report = await stackReport(SINCE, [{ name: "next", version: "16.3.8" }], { fetch, retryDelaysMs: [0, 0] });
    expect(report.advisories).toHaveLength(1);
    expect(report.advisories[0]).toMatchObject({ id: "GHSA-aaaa-bbbb-cccc", severity: "CRITICAL", fixed: "16.4.1" });
    expect(report.advisories[0].aliases).toContain("CVE-2026-12345");
  });

  it("ignores a release link that points outside the repo's own releases", () => {
    const feed = releasesFeed("vercel/next.js", [
      { tag: "v16.4.2", updated: "2026-11-05T10:00:00Z", html: "<p>x</p>" },
    ]).replace("https://github.com/vercel/next.js/releases/tag/v16.4.2", "https://evil.example/vercel/next.js/releases/tag/v16.4.2");
    expect(parseReleases(feed, "next", "vercel/next.js", SINCE).releases).toEqual([]);
  });

  it("labels a prerelease fix in the output", async () => {
    const pre = JSON.stringify({
      ...JSON.parse(GHSA),
      affected: [{ package: { ecosystem: "npm", name: "next" }, ranges: [{ events: [{ introduced: "16.0.0" }, { fixed: "16.1.0-canary.4" }] }] }],
    });
    const { fetch } = fakeFetch({
      [OSV_BATCH_URL]: OSV_BATCH,
      [osvVulnUrl("GHSA-aaaa-bbbb-cccc")]: pre,
    });
    const text = formatStack(await stackReport(SINCE, [{ name: "next", version: "16.0.5" }], { fetch, retryDelaysMs: [0, 0] }));
    expect(text).toContain("fixed in 16.1.0-canary.4 (prerelease)");
  });
});
