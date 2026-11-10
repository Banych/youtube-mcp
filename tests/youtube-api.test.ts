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

const DURATIONS = JSON.stringify({
  items: [
    { id: "vidLong0001", contentDetails: { duration: "PT14M3S" } },
    { id: "vidShort001", contentDetails: { duration: "PT58S" } },
  ],
});

describe("fetchUploads", () => {
  it("reads a channel's uploads playlist through the same cleaning as the feeds", async () => {
    const { fetch, calls } = fakeFetch({ [uploadsUrl(CHANNEL_A, KEY)]: API_A });
    const feed = await fetchUploads(CHANNEL_A, KEY, { fetch });
    expect(new URL(calls[0].url).searchParams.get("playlistId")).toBe(`UU${CHANNEL_A.slice(2)}`);
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
    expect(durationSeconds("3 minutes")).toBeNull();
  });

  it("marks videos of 3 minutes or less as Shorts and points them at /shorts/", async () => {
    const { fetch } = fakeFetch({
      [uploadsUrl(CHANNEL_A, KEY)]: API_A,
      [videosUrl(["vidLong0001", "vidShort001", "vidPrivate1"], KEY)]: DURATIONS,
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
    [uploadsUrl(CHANNEL_A, KEY)]: API_A,
    [videosUrl(["vidLong0001", "vidShort001", "vidPrivate1"], KEY)]: DURATIONS,
    [uploadsUrl(CHANNEL_B, KEY)]: 403,
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
    const { fetch } = fakeFetch({ [uploadsUrl(CHANNEL_A, KEY)]: API_A });
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
