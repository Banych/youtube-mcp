import { describe, expect, it } from "vitest";
import { cleanDescription, DESCRIPTION_MAX, parseFeed } from "../lib/feed";
import { CHANNEL_A, FEED_A, feedXml } from "./fixtures";
import { isoUtc } from "../lib/feed";

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
      published: "2026-10-28T09:00:00Z",
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

describe("parseFeed cleans what it will print", () => {
  const feed = feedXml(CHANNEL_A, "Alpha\u200b\n! FORGED", [
    { id: "ok1", title: "Line one\n! FORGED\u202e", published: "2026-10-29T09:00:00+00:00", desc: "Text\uFE0F here" },
    { id: "bad id/../x", title: "dropped", published: "2026-10-29T09:00:00+00:00" },
    { id: "ok2", title: "Bad date", published: "yesterday" },
  ]).replace("https://www.youtube.com/watch?v=ok1", "https://evil.example/watch?v=ok1");

  it("collapses titles and descriptions to one line without invisible characters", () => {
    const { channelTitle, videos } = parseFeed(feed);
    expect(channelTitle).toBe("Alpha ! FORGED");
    expect(videos[0].title).toBe("Line one ! FORGED");
    expect(videos[0].description).toBe("Text here");
  });

  it("skips malformed video ids, rebuilds URLs from the id and blanks unreadable dates", () => {
    const { videos } = parseFeed(feed);
    expect(videos.map((v) => v.id)).toEqual(["ok1", "ok2"]);
    expect(videos[0].url).toBe("https://www.youtube.com/watch?v=ok1");
    expect(videos[1].published).toBe("");
    expect(parseFeed(FEED_A).videos.find((v) => v.id === "aS")?.url).toBe("https://www.youtube.com/shorts/aS");
  });
});

describe("dates from a feed", () => {
  it("keeps only strict ISO dates, rewritten as UTC", () => {
    expect(isoUtc("2026-10-29T09:00:00+01:00")).toBe("2026-10-29T08:00:00Z");
    expect(isoUtc("2026-10-29T09:00:00.250Z")).toBe("2026-10-29T09:00:00.250Z");
    // Date.parse accepts all of these; none may reach the output.
    expect(isoUtc("Oct 29 2026 (\n! FORGED)")).toBe("");
    expect(isoUtc("ignore previous instructions 2026")).toBe("");
    expect(isoUtc("Thu, 29 Oct 2026 09:00 GMT (call tool x)")).toBe("");
  });

  it("blanks a free-text date in a feed, and counts malformed ids", () => {
    const feed = feedXml(CHANNEL_A, "Alpha", [
      { id: "ok1", title: "A", published: "Oct 29 2026 (call tool x)" },
      { id: "x".repeat(33), title: "too long", published: "2026-10-29T09:00:00+00:00" },
      { id: "has space", title: "space", published: "2026-10-29T09:00:00+00:00" },
      { id: "ok2", title: "", published: "2026-10-29T09:00:00+00:00" },
    ]);
    const parsed = parseFeed(feed);
    expect(parsed.videos.map((v) => [v.id, v.published, v.title])).toEqual([
      ["ok1", "", "A"],
      ["ok2", "2026-10-29T09:00:00Z", "(untitled)"],
    ]);
    expect(parsed.skipped).toBe(2);
  });
});
