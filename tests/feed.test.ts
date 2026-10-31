import { describe, expect, it } from "vitest";
import { cleanDescription, DESCRIPTION_MAX, parseFeed } from "../lib/feed";
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
      description: "",
    });
  });

  it("restores the UC prefix that the feed's channel ID lacks, and keeps one already present", () => {
    expect(parseFeed(FEED_A).videos.every((v) => v.channelId === CHANNEL_A)).toBe(true);
    const prefixed = FEED_A.replaceAll(`<yt:channelId>${CHANNEL_A.slice(2)}<`, `<yt:channelId>${CHANNEL_A}<`);
    expect(parseFeed(prefixed).channelId).toBe(CHANNEL_A);
  });

  it("reads each video's description, dropping links and hashtag lines", () => {
    expect(parseFeed(FEED_A).videos[0].description).toBe("A deep dive into the new feature. Links:");
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

describe("cleanDescription", () => {
  it("keeps a short description as one line", () => {
    expect(cleanDescription("  Hello\n\n  world  ")).toBe("Hello world");
  });

  it("cuts a long description at a word boundary and marks the cut", () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const out = cleanDescription(long);
    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_MAX + 1);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/);
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
  });

  it("returns an empty string for a missing description", () => {
    expect(cleanDescription("")).toBe("");
  });
});
