import { describe, expect, it } from "vitest";
import { parseChannelList } from "../lib/channels";
import { durationSeconds, fetchUploads, markShorts, uploadsUrl, videosUrl } from "../lib/youtube-api";
import { latestUploads } from "../lib/youtube";
import { CHANNEL_A, CHANNEL_B, FEED_B, fakeFetch, feedUrl } from "./fixtures";

const KEY = "AIza-test-key-123";
const refs = (s: string) => parseChannelList(s).channels;

/** Shaped like GET /youtube/v3/playlistItems?part=snippet,contentDetails for an uploads playlist. */
function playlist(channelId: string, title: string, items: { id: string; title: string; published?: string; desc?: string }[]) {
  return JSON.stringify({
    kind: "youtube#playlistItemListResponse",
    items: items.map((v) => ({
      kind: "youtube#playlistItem",
      snippet: {
        publishedAt: v.published ?? "2026-11-09T10:00:00Z",
        channelId,
        title: v.title,
        description: v.desc ?? "",
        channelTitle: title,
        playlistId: `UU${channelId.slice(2)}`,
        resourceId: { kind: "youtube#video", videoId: v.id },
      },
      contentDetails: { videoId: v.id, ...(v.published ? { videoPublishedAt: v.published } : {}) },
    })),
  });
}

const API_A = playlist(CHANNEL_A, "Alpha & Co", [
  { id: "vidLong0001", title: "Long talk", published: "2026-11-09T10:00:00Z", desc: "Notes\n\nhttps://x.example\n#tag" },
  { id: "vidShort001", title: "Quick tip", published: "2026-11-09T12:00:00Z" },
  { id: "vidPrivate1", title: "Private video" },
]);

/** Shaped like GET /youtube/v3/videos?part=contentDetails,player&maxWidth=480. */
const sized = (id: string, duration: string, w: number, h: number) => ({
  id,
  contentDetails: { duration },
  player: { embedHtml: "<iframe…>", embedWidth: String(w), embedHeight: String(h) },
});
const DURATIONS = JSON.stringify({
  items: [sized("vidLong0001", "PT14M3S", 480, 270), sized("vidShort001", "PT58S", 270, 480)],
});

describe("fetchUploads", () => {
  it("reads a channel's uploads playlist through the same cleaning as the feeds", async () => {
    const { fetch, calls } = fakeFetch({ [uploadsUrl(CHANNEL_A)]: API_A });
    const feed = await fetchUploads(CHANNEL_A, KEY, { fetch });
    expect(new URL(calls[0].url).searchParams.get("playlistId")).toBe(`UU${CHANNEL_A.slice(2)}`);
    expect(calls[0].headers.get("x-goog-api-key")).toBe(KEY);
    expect(calls.every((c) => !c.url.includes(KEY))).toBe(true);
    expect(feed.source).toBe("api");
    expect(feed.channelTitle).toBe("Alpha & Co");
    expect(feed.videos.map((v) => [v.id, v.published, v.description])).toEqual([
      ["vidLong0001", "2026-11-09T10:00:00Z", "Notes"],
      ["vidShort001", "2026-11-09T12:00:00Z", ""],
      ["vidPrivate1", "", ""],
    ]);
  });

  it("refuses an id that is not a UC channel id", async () => {
    await expect(fetchUploads("@handle", KEY, { fetch: fakeFetch({}).fetch })).rejects.toThrow("not a UC… channel id");
  });
});

describe("Shorts by length", () => {
  it("reads ISO 8601 durations", () => {
    expect(durationSeconds("PT58S")).toBe(58);
    expect(durationSeconds("PT3M")).toBe(180);
    expect(durationSeconds("PT1H2M3S")).toBe(3723);
    expect(durationSeconds("P1DT1S")).toBe(86401);
    expect(durationSeconds("PT")).toBeNull();
    expect(durationSeconds("P0D")).toBe(0);
    expect(durationSeconds("3 minutes")).toBeNull();
  });

  it("keeps a short horizontal video as a regular video (\"X in 100 Seconds\")", async () => {
    const { fetch } = fakeFetch({
      [videosUrl(["hundredSec1"])]: JSON.stringify({ items: [sized("hundredSec1", "PT1M40S", 480, 270)] }),
    });
    const v = [{ id: "hundredSec1", title: "", url: "https://www.youtube.com/watch?v=hundredSec1", channelId: "", channelTitle: "", published: "", isShort: false, description: "" }];
    await markShorts(v, KEY, { fetch });
    expect(v[0].isShort).toBe(false);
  });

  it("checks batches of 50 in parallel", async () => {
    let inFlight = 0,
      max = 0;
    const fetch = (async (input: RequestInfo | URL) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const ids = new URL(String(input)).searchParams.get("id")!.split(",");
      return new Response(JSON.stringify({ items: ids.map((id) => sized(id, "PT30S", 270, 480)) }));
    }) as typeof globalThis.fetch;
    const videos = Array.from({ length: 120 }, (_, i) => ({ id: `v${i}`, title: "", url: "", channelId: "", channelTitle: "", published: "", isShort: false, description: "" }));
    await markShorts(videos, KEY, { fetch });
    expect(max).toBe(3);
    expect(videos.every((v) => v.isShort)).toBe(true);
  });

  it("marks videos of 3 minutes or less as Shorts and points them at /shorts/", async () => {
    const { fetch } = fakeFetch({
      [uploadsUrl(CHANNEL_A)]: API_A,
      [videosUrl(["vidLong0001", "vidShort001", "vidPrivate1"])]: DURATIONS,
    });
    const { videos } = await fetchUploads(CHANNEL_A, KEY, { fetch });
    await markShorts(videos, KEY, { fetch });
    expect(videos.map((v) => [v.id, v.isShort, v.url])).toEqual([
      ["vidLong0001", false, "https://www.youtube.com/watch?v=vidLong0001"],
      ["vidShort001", true, "https://www.youtube.com/shorts/vidShort001"],
      ["vidPrivate1", false, "https://www.youtube.com/watch?v=vidPrivate1"],
    ]);
  });
});

describe("latestUploads with an API key", () => {
  const routes = {
    [uploadsUrl(CHANNEL_A)]: API_A,
    // The private upload has no date, so it is never sent to the Shorts check.
    [videosUrl(["vidLong0001", "vidShort001"])]: DURATIONS,
    [uploadsUrl(CHANNEL_B)]: 403,
    [feedUrl(CHANNEL_B)]: FEED_B,
  };

  it("uses the API first, falls back to the feed per channel, and counts the sources", async () => {
    const lines: string[] = [];
    const { fetch } = fakeFetch(routes);
    const { videos, errors, sources } = await latestUploads(
      refs(`${CHANNEL_A},${CHANNEL_B}`),
      { limit: 10, includeShorts: false },
      { fetch, youtubeApiKey: KEY, retryDelaysMs: [0, 0], log: (l) => lines.push(l) },
    );
    expect(sources).toEqual({ api: 1, feed: 1 });
    expect(errors).toEqual([]);
    // The Short and the private (undated) upload are left out; channel B's videos come from its feed.
    expect(videos.map((v) => v.id)).toEqual(["vidLong0001", "b1", "b0"]);
    expect(lines).toEqual(["youtube api: 1/2 failed (HTTP 403 ×1)"]);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("names both reasons when the API and the feed fail, without the key", async () => {
    const lines: string[] = [];
    const { fetch } = fakeFetch({ ...routes, [feedUrl(CHANNEL_B)]: 404 });
    const { errors } = await latestUploads(
      refs(CHANNEL_B),
      { limit: 10, includeShorts: false },
      { fetch, youtubeApiKey: KEY, retryDelaysMs: [0, 0], log: (l) => lines.push(l) },
    );
    expect(errors).toEqual([{ channel: CHANNEL_B, error: "API: HTTP 403; feed: HTTP 404 (3 tries)" }]);
    expect(JSON.stringify(errors) + lines.join("\n")).not.toContain(KEY);
  });

  it("keeps the API's videos when the Shorts check fails, and says so", async () => {
    const lines: string[] = [];
    const { fetch } = fakeFetch({ [uploadsUrl(CHANNEL_A)]: API_A });
    const { videos } = await latestUploads(
      refs(CHANNEL_A),
      { limit: 10, includeShorts: true },
      { fetch, youtubeApiKey: KEY, retryDelaysMs: [0, 0], log: (l) => lines.push(l) },
    );
    expect(videos.map((v) => v.id)).toEqual(["vidShort001", "vidLong0001"]);
    expect(lines).toEqual(["youtube api: Shorts check failed (HTTP 404); Shorts may be listed as videos"]);
  });

  it("never calls the API without a key", async () => {
    const { fetch, calls } = fakeFetch({ [feedUrl(CHANNEL_B)]: FEED_B });
    const { sources } = await latestUploads(refs(CHANNEL_B), { limit: 10, includeShorts: false }, { fetch });
    expect(calls.some((c) => c.url.includes("googleapis.com"))).toBe(false);
    expect(sources).toEqual({ api: 0, feed: 1 });
  });
});

describe("API cost and time", () => {
  const routes = {
    [uploadsUrl(CHANNEL_A)]: API_A,
    [videosUrl(["vidShort001"])]: DURATIONS,
  };

  it("checks Shorts only for videos inside the since window", async () => {
    const { fetch, calls } = fakeFetch(routes);
    const { videos } = await latestUploads(
      refs(CHANNEL_A),
      { since: new Date("2026-11-09T11:00:00Z"), limit: 10, includeShorts: true },
      { fetch, youtubeApiKey: KEY },
    );
    const checks = calls.filter((c) => c.url.includes("/videos?"));
    expect(checks.map((c) => new URL(c.url).searchParams.get("id"))).toEqual(["vidShort001"]);
    expect(videos.map((v) => [v.id, v.isShort])).toEqual([["vidShort001", true]]);
  });

  it("does not check Shorts for list_channels", async () => {
    const { describeChannels } = await import("../lib/youtube");
    const { fetch, calls } = fakeFetch(routes);
    await describeChannels(refs(CHANNEL_A), { fetch, youtubeApiKey: KEY });
    expect(calls.some((c) => c.url.includes("/videos?"))).toBe(false);
  });

  it("takes the title from the feed when the API lists no public uploads", async () => {
    const { describeChannels } = await import("../lib/youtube");
    const { fetch } = fakeFetch({
      [uploadsUrl(CHANNEL_B)]: JSON.stringify({ items: [] }),
      [feedUrl(CHANNEL_B)]: FEED_B,
    });
    const { channels } = await describeChannels(refs(CHANNEL_B), { fetch, youtubeApiKey: KEY });
    expect(channels[0].title).toBe("Bravo");
  });

  it("skips the feed fallback and the Shorts check when the call is out of time", async () => {
    const lines: string[] = [];
    const { fetch, calls } = fakeFetch({ [uploadsUrl(CHANNEL_B)]: 403, [feedUrl(CHANNEL_B)]: FEED_B });
    const { errors } = await latestUploads(
      refs(CHANNEL_B),
      { limit: 10, includeShorts: false },
      { fetch, youtubeApiKey: KEY, deadline: Date.now() + 5_000, log: (l) => lines.push(l) },
    );
    expect(errors).toEqual([{ channel: CHANNEL_B, error: "API: HTTP 403; feed: skipped, out of time" }]);
    expect(calls.some((c) => c.url === feedUrl(CHANNEL_B))).toBe(false);
  });

  it("does not start a request after the deadline", async () => {
    const { get } = await import("../lib/http");
    const { fetch, calls } = fakeFetch({ "https://x.test/": "ok" });
    await expect(get("https://x.test/", { fetch, deadline: Date.now() - 1 })).rejects.toThrow("out of time");
    expect(calls).toHaveLength(0);
  });
});
