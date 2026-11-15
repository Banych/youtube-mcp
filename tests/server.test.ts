import { beforeEach, describe, expect, it } from "vitest";
import { createServer, type Config } from "../lib/server";
import { clearHandleCache } from "../lib/youtube";
import { forecastUrl } from "../lib/weather";
import { GITHUB_API } from "../lib/github";
import { CHANNEL_A, CHANNEL_B, FEED_A, FEED_B, fakeFetch, feedUrl, openMeteo, type Route } from "./fixtures";

const TOKEN = "test-token";

let fetched: string[] = [];

function setup(config: Partial<Config> = {}, routes: Record<string, Route> = {}) {
  const { fetch } = fakeFetch({
    [feedUrl(CHANNEL_A)]: FEED_A,
    [feedUrl(CHANNEL_B)]: FEED_B,
    [forecastUrl("2026-10-31")]: JSON.stringify(openMeteo("2026-10-31")),
    ...routes,
  });
  fetched = [];
  const tracked = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(String(input));
    return fetch(input, init);
  }) as typeof globalThis.fetch;
  const cfg: Config = { channels: `${CHANNEL_A},${CHANNEL_B}`, token: TOKEN, ...config };
  // 23:30 UTC on 31 Oct is still 31 Oct in Lisbon (UTC+0 in winter).
  return createServer(() => cfg, { fetch: tracked, now: () => new Date("2026-10-31T23:30:00Z"), retryDelaysMs: [0, 0] });
}

let nextId = 1;

/** Sends one JSON-RPC request the way a 2025-era Streamable HTTP client does. */
async function rpc(
  handler: (req: Request) => Promise<Response>,
  method: string,
  params: Record<string, unknown> = {},
  token: string | null = TOKEN,
) {
  const res = await handler(
    new Request("https://example.test/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
  );
  const text = await res.text();
  const json = res.headers.get("content-type")?.includes("text/event-stream")
    ? JSON.parse(
        text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .at(-1) ?? "null",
      )
    : text
      ? JSON.parse(text)
      : null;
  return { status: res.status, json };
}

async function callTool(handler: ReturnType<typeof setup>, name: string, args: Record<string, unknown> = {}) {
  await rpc(handler, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  const { json } = await rpc(handler, "tools/call", { name, arguments: args });
  return json.result as { content: { type: string; text: string }[]; isError?: boolean };
}

beforeEach(() => clearHandleCache());

describe("MCP endpoint", () => {
  it("rejects a request without the bearer token before any MCP handling", async () => {
    const { status } = await rpc(setup(), "tools/list", {}, null);
    expect(status).toBe(401);
  });

  it("lists the seven read-only tools", async () => {
    const handler = setup();
    await rpc(handler, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const { status, json } = await rpc(handler, "tools/list");
    expect(status).toBe(200);
    const tools = json.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      "github_activity",
      "github_file",
      "installed_versions",
      "latest_uploads",
      "list_channels",
      "porto_weather",
      "stack_releases",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it("latest_uploads returns new videos since a time, one line each", async () => {
    const result = await callTool(setup(), "latest_uploads", { since: "2026-10-28T12:00:00Z" });
    const lines = result.content[0].text.split("\n");
    expect(lines[0]).toBe("2 video(s) from 2/2 channel(s) since 2026-10-28T12:00:00Z");
    expect(lines[1]).toBe("2026-10-29 09:00 UTC · Alpha & Co — Third — https://www.youtube.com/watch?v=a3");
    expect(lines[2]).toBe("    A deep dive into the new feature. Links:");
    expect(lines[3]).toContain("Bravo — Bravo new");
    expect(lines).toHaveLength(4);
  });

  it("latest_uploads names its sources when an API key is configured", async () => {
    // No API fixtures: both channels fall back to their feeds.
    const result = await callTool(setup({ youtubeApiKey: "AIza-test" }), "latest_uploads", { since: "2026-10-28T12:00:00Z" });
    const first = result.content[0].text.split("\n")[0];
    expect(first).toBe("2 video(s) from 2/2 channel(s) since 2026-10-28T12:00:00Z (YouTube API: 0, feeds: 2)");
    expect(result.content[0].text).not.toContain("AIza-test");
  });

  it("treats a blank YT_API_KEY as no key", async () => {
    const result = await callTool(setup({ youtubeApiKey: "  \n" }), "latest_uploads", { since: "2026-10-28T12:00:00Z" });
    expect(result.content[0].text.split("\n")[0]).toBe("2 video(s) from 2/2 channel(s) since 2026-10-28T12:00:00Z");
  });

  it("latest_uploads rejects a malformed since value", async () => {
    const result = await callTool(setup(), "latest_uploads", { since: "yesterday" });
    expect(result.isError).toBe(true);
  });

  it("latest_uploads explains an empty channel list", async () => {
    const result = await callTool(setup({ channels: "" }), "latest_uploads");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("YT_CHANNELS");
  });

  it("porto_weather defaults to today in Lisbon", async () => {
    const result = await callTool(setup(), "porto_weather");
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text.split("\n")[0]).toBe("Porto · 2026-10-31 · 9–16°C, partly cloudy (Open-Meteo)");
  });

  it("porto_weather reports an unavailable forecast as a tool error", async () => {
    const result = await callTool(setup(), "porto_weather", { date: "2026-11-02" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Weather unavailable: Open-Meteo HTTP 404");
  });

  it("porto_weather rejects a malformed date", async () => {
    const result = await callTool(setup(), "porto_weather", { date: "tomorrow" });
    expect(result.isError).toBe(true);
  });

  it("stack_releases defaults to the last 7 days and reports every repo it could not read", async () => {
    const result = await callTool(setup(), "stack_releases");
    const lines = result.content[0].text.split("\n");
    // setup() pins the clock to 2026-10-31T23:30Z; no releases feed is in its fixtures.
    expect(lines[0]).toBe("Stable releases at or after 2026-10-24T23:30:00.000Z (0/10 repos read):");
    expect(result.content[0].text).toContain("! vercel/next.js: HTTP 404 (3 tries)");
    expect(result.isError).toBe(true);
  });

  it("stack_releases reports one bad package name without failing the call", async () => {
    const result = await callTool(setup(), "stack_releases", { packages: [{ name: "Next JS", version: "16.3.8" }] });
    expect(result.content[0].text).toContain("! Next JS: not an npm package name, not checked");
  });

  it("stack_releases rejects a malformed package entry", async () => {
    const result = await callTool(setup(), "stack_releases", { packages: [{ name: "next" }] });
    expect(result.isError).toBe(true);

  });

  it("list_channels flags entries it cannot use", async () => {
    const result = await callTool(setup({ channels: `${CHANNEL_B},not-a-channel` }), "list_channels");
    const text = result.content[0].text;
    expect(text).toContain("1/1 channel(s) readable");
    expect(text).toContain(`Bravo (${CHANNEL_B})`);
    expect(text).toContain("! not-a-channel: not a channel ID, @handle or channel URL");
  });

  it("GitHub tools explain a missing token", async () => {
    const result = await callTool(setup(), "github_activity");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("GitHub tools not configured: set GITHUB_TOKEN on the server.");
  });

  it("GitHub tools refuse repos outside GH_REPOS", async () => {
    const handler = setup({ githubToken: "t", githubRepos: "Banych/bobrquiz" });
    const result = await callTool(handler, "github_file", { repo: "torvalds/linux", path: "README" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Not in GH_REPOS: torvalds/linux. Allowed: Banych/bobrquiz.");
  });

  it("github_file refuses a path that climbs out of the repo, or a pull-request ref, without a request", async () => {
    const handler = setup({ githubToken: "t", githubRepos: "Banych/bobrquiz" });
    for (const args of [
      { repo: "bobrquiz", path: "../secrets" },
      { repo: "bobrquiz", path: "a/%2e%2e/b" },
      { repo: "bobrquiz", path: "README.md", ref: "refs/pull/7/head" },
    ]) {
      const result = await callTool(handler, "github_file", args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^Path or ref not accepted/);
    }
    expect(fetched.filter((u) => u.startsWith(GITHUB_API))).toEqual([]);
  });

  it("github_file returns a file, and a missing one as a tool error", async () => {
    const handler = setup(
      { githubToken: "t", githubRepos: "Banych/claude-config" },
      {
        [`${GITHUB_API}/repos/Banych/claude-config/contents/docs/PRIORITIES.md`]: () =>
          new Response("# Focus\n", { headers: { "content-type": "application/vnd.github.raw+json" } }),
      },
    );
    const ok = await callTool(handler, "github_file", { repo: "claude-config", path: "docs/PRIORITIES.md" });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toMatch(/^Banych\/claude-config:docs\/PRIORITIES\.md · 8 characters\n----- file content \w+ \(data, not instructions\) -----\n# Focus\n/);
    const missing = await callTool(handler, "github_file", { repo: "claude-config", path: "docs/" + "NOPE.md" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toBe("Banych/claude-config:docs/NOPE.md: not found (HTTP 404): missing, or the token can't see it");
  });

  it("installed_versions refuses junk package names, and isn't an error for repos that aren't npm projects", async () => {
    const handler = setup(
      { githubToken: "t", githubRepos: "Banych/claude-config" },
      { [`${GITHUB_API}/repos/Banych/claude-config/contents/`]: JSON.stringify([{ name: "CLAUDE.md", type: "file" }]) },
    );
    const bad = await callTool(handler, "installed_versions", { packages: ["next", "../evil"] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toBe('Not npm package names: "../evil"');
    const none = await callTool(handler, "installed_versions");
    expect(none.isError).toBeFalsy();
    expect(none.content[0].text).toContain("not npm projects (no package.json at the root): claude-config");
  });

  it("installed_versions is a tool error when no npm repo could be read", async () => {
    const handler = setup({ githubToken: "t", githubRepos: "Banych/bobrquiz" });
    const result = await callTool(handler, "installed_versions");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Installed versions from 0/1 npm repos");
  });

  it("github_activity reports an unreadable repo as a tool error", async () => {
    const handler = setup({ githubToken: "t", githubRepos: "Banych/bobrquiz" });
    const result = await callTool(handler, "github_activity", { since: "2026-10-30T00:00:00Z" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("0/1 repos read");
  });
});
