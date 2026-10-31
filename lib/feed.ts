import { XMLParser } from "fast-xml-parser";

export type Video = {
  id: string;
  title: string;
  url: string;
  channelId: string;
  channelTitle: string;
  published: string;
  isShort: boolean;
  /** Start of the video's description, cleaned up; "" when it has none. */
  description: string;
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
  "media:group"?: { "media:description"?: unknown };
};

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "#text" in value) {
    return String((value as { "#text": unknown })["#text"]);
  }
  return value == null ? "" : String(value);
}

export const DESCRIPTION_MAX = 240;

/**
 * Turns a raw description into one readable line: links and hashtag-only
 * lines removed, whitespace collapsed, cut at a word boundary.
 */
export function cleanDescription(raw: string): string {
  const oneLine = raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*(#\S+\s*)+$/.test(line))
    .join(" ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine.length <= DESCRIPTION_MAX) return oneLine;
  const cut = oneLine.slice(0, DESCRIPTION_MAX);
  const space = cut.lastIndexOf(" ");
  return (space > DESCRIPTION_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, "") + "…";
}

/**
 * YouTube's feeds give <yt:channelId> without the "UC" prefix that the
 * channel ID has everywhere else (URLs, YT_CHANNELS). Restore it.
 */
function channelIdOf(value: unknown): string {
  const id = text(value);
  return /^[\w-]{22}$/.test(id) ? `UC${id}` : id;
}

/** Parses a YouTube channel Atom feed (youtube.com/feeds/videos.xml?channel_id=…). */
export function parseFeed(xml: string): Feed {
  const doc = parser.parse(xml) as { feed?: Record<string, unknown> };
  const feed = doc.feed;
  if (!feed) throw new Error("not a YouTube channel feed");

  const channelId = channelIdOf(feed["yt:channelId"]);
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
        channelId: channelIdOf(entry["yt:channelId"]) || channelId,
        channelTitle: text(entry.author?.name) || channelTitle,
        published: text(entry.published),
        isShort: alternate.includes("/shorts/"),
        description: cleanDescription(text(entry["media:group"]?.["media:description"])),
      },
    ];
  });

  return { channelId, channelTitle, videos };
}
