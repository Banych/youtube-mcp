import { XMLParser } from "fast-xml-parser";

export type Video = {
  id: string;
  title: string;
  url: string;
  channelId: string;
  channelTitle: string;
  published: string;
  isShort: boolean;
};

export type Feed = {
  channelId: string;
  channelTitle: string;
  videos: Video[];
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => name === "entry" || name === "link",
  parseTagValue: false,
  trimValues: true,
});

type AtomLink = { "@_rel"?: string; "@_href"?: string };
type AtomEntry = {
  "yt:videoId"?: string;
  "yt:channelId"?: string;
  title?: string;
  link?: AtomLink[];
  author?: { name?: string };
  published?: string;
};

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "#text" in value) {
    return String((value as { "#text": unknown })["#text"]);
  }
  return value == null ? "" : String(value);
}

/** Parses a YouTube channel Atom feed (youtube.com/feeds/videos.xml?channel_id=…). */
export function parseFeed(xml: string): Feed {
  const doc = parser.parse(xml) as { feed?: Record<string, unknown> };
  const feed = doc.feed;
  if (!feed) throw new Error("not a YouTube channel feed");

  const channelId = text(feed["yt:channelId"]);
  const channelTitle = text(feed.title);
  const entries = (feed.entry as AtomEntry[] | undefined) ?? [];

  const videos = entries.flatMap((entry): Video[] => {
    const id = text(entry["yt:videoId"]);
    if (!id) return [];
    const alternate =
      entry.link?.find((l) => l["@_rel"] === "alternate")?.["@_href"] ??
      `https://www.youtube.com/watch?v=${id}`;
    return [
      {
        id,
        title: text(entry.title),
        url: alternate,
        channelId: text(entry["yt:channelId"]) || channelId,
        channelTitle: text(entry.author?.name) || channelTitle,
        published: text(entry.published),
        isShort: alternate.includes("/shorts/"),
      },
    ];
  });

  return { channelId, channelTitle, videos };
}
