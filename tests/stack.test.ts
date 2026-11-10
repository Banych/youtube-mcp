import { describe, expect, it } from "vitest";
import {
  exactVersion,
  fixedVersion,
  formatStack,
  OSV_BATCH_URL,
  osvVulnUrl,
  parseReleases,
  plainText,
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
    expect(parseReleases(NEXT_FEED, "next", "vercel/next.js", SINCE)).toEqual([
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
    const [v8] = parseReleases(VITE_FEED, "vite", "vitejs/vite", SINCE);
    expect(v8.version).toBe("8.0.0");
    expect(v8.flags).toEqual(["major", "breaking", "deprecation"]);
  });

  it("rejects a page that is not a feed", () => {
    expect(() => parseReleases("<html><body>rate limited</body></html>", "next", "vercel/next.js", SINCE)).toThrow(
      "not a releases feed",
    );
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
    const vuln = JSON.parse(GHSA);
    expect(fixedVersion(vuln, "next", "16.3.8")).toBe("16.4.1");
    expect(fixedVersion(vuln, "next", "15.3.3")).toBe("15.5.28");
    expect(fixedVersion(vuln, "react", "19.0.0")).toBeNull();
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
      { fetch },
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
    expect(report.errors).toContainEqual({ source: "facebook/react", error: "HTTP 404" });
    expect(report.errors.filter((e) => e.source.includes("/"))).toHaveLength(Object.keys(STACK).length - 2);

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
    await stackReport(SINCE, [], { fetch });
    expect(calls.some((c) => c.url.startsWith("https://api.osv.dev"))).toBe(false);
  });

  it("reports OSV failing without losing the releases", async () => {
    const { fetch } = fakeFetch({ ...routes, [OSV_BATCH_URL]: 503 });
    const report = await stackReport(SINCE, [{ name: "next", version: "16.3.8" }], { fetch });
    expect(report.releases).toHaveLength(2);
    expect(report.errors).toContainEqual({ source: "OSV advisories", error: "HTTP 503" });
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
    const text = formatStack(await stackReport(SINCE, packages, { fetch }), packages.length);
    const lines = text.split("\n");
    expect(lines[0]).toBe(`Stable releases since ${SINCE} (1/${Object.keys(STACK).length} repos read):`);
    expect(lines[1]).toBe("next 16.4.2 · 2026-11-05 · security — https://github.com/vercel/next.js/releases/tag/v16.4.2");
    expect(text).toContain(
      "next 16.3.8 · GHSA-aaaa-bbbb-cccc, CVE-2026-12345 · CRITICAL · fixed in 16.4.1 — https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc",
    );
    expect(text).toContain("react 19.2.0 · no known advisories");
    expect(text).toContain("! facebook/react: HTTP 404");
  });
});
