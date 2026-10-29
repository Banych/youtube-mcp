import { describe, expect, it } from "vitest";
import { parseFeed } from "../lib/feed";
import { CHANNEL_A, FEED_A } from "./fixtures";

describe("parseFeed", () => {
  it("reads channel and entries, decoding XML entities", () => {
    const feed = parseFeed(FEED_A);
    expect(feed.channelId).toBe(CHANNEL_A);
    expect(feed.channelTitle).toBe("Alpha & Co");
    expect(feed.videos).toHaveLength(3);
    expect(feed.videos[1]).toEqual({
      id: "a2",
      title: "Second <draft>",
      url: "https://www.youtube.com/watch?v=a2",
      channelId: CHANNEL_A,
      channelTitle: "Alpha & Co",
      published: "2026-10-28T09:00:00+00:00",
      isShort: false,
    });
  });

  it("marks entries whose link points at /shorts/ as Shorts", () => {
    const short = parseFeed(FEED_A).videos.find((v) => v.id === "aS");
    expect(short?.isShort).toBe(true);
  });

  it("handles a channel with no uploads", () => {
    const xml = FEED_A.replace(/<entry>[\s\S]*<\/entry>/, "");
    expect(parseFeed(xml).videos).toEqual([]);
  });

  it("rejects a document that is not a feed", () => {
    expect(() => parseFeed("<html><body>consent</body></html>")).toThrow("not a YouTube channel feed");
  });
});
