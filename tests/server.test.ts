import { beforeEach, describe, expect, it } from "vitest";
import { createServer, type Config } from "../lib/server";
import { clearHandleCache } from "../lib/youtube";
import { forecastUrl } from "../lib/weather";
import { CHANNEL_A, CHANNEL_B, FEED_A, FEED_B, fakeFetch, feedUrl, openMeteo } from "./fixtures";

const TOKEN = "test-token";

function setup(config: Partial<Config> = {}) {
  const { fetch } = fakeFetch({
    [feedUrl(CHANNEL_A)]: FEED_A,
    [feedUrl(CHANNEL_B)]: FEED_B,
    [forecastUrl("2026-10-31")]: JSON.stringify(openMeteo("2026-10-31")),
  });
  const cfg: Config = { channels: `${CHANNEL_A},${CHANNEL_B}`, token: TOKEN, ...config };
  // 23:30 UTC on 31 Oct is still 31 Oct in Lisbon (UTC+0 in winter).
  return createServer(() => cfg, { fetch, now: () => new Date("2026-10-31T23:30:00Z") });
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

  it("lists the three read-only tools", async () => {
    const handler = setup();
    await rpc(handler, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const { status, json } = await rpc(handler, "tools/list");
    expect(status).toBe(200);
    const tools = json.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    expect(tools.map((t) => t.name).sort()).toEqual(["latest_uploads", "list_channels", "porto_weather"]);
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

  it("list_channels flags entries it cannot use", async () => {
    const result = await callTool(setup({ channels: `${CHANNEL_B},not-a-channel` }), "list_channels");
    const text = result.content[0].text;
    expect(text).toContain("1/1 channel(s) readable");
    expect(text).toContain(`Bravo (${CHANNEL_B})`);
    expect(text).toContain("! not-a-channel: not a channel ID, @handle or channel URL");
  });
});
