import { XMLParser } from "fast-xml-parser";
import { oneLine } from "./http";

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
  /** Entries dropped because their video id was malformed. */
  skipped: number;
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
const TITLE_MAX = 200;
/** YouTube video ids: 11 characters in practice; letters, digits, - and _. */
const VIDEO_ID = /^[A-Za-z0-9_-]{1,32}$/;
/** Feed dates are ISO 8601; Date.parse alone also accepts free text such as "Oct 29 2026 (anything)". */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A strict ISO date re-written as UTC ("2026-10-29T09:00:00Z"), or "" when it isn't one. */
export function isoUtc(raw: string): string {
  const t = ISO_DATE.test(raw) ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? "" : new Date(t).toISOString().replace(".000Z", "Z");
}

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

  const channelId = oneLine(channelIdOf(feed["yt:channelId"]), 40);
  const channelTitle = oneLine(text(feed.title), TITLE_MAX);
  const entries = (feed.entry as AtomEntry[] | undefined) ?? [];

  let skipped = 0;
  const videos = entries.flatMap((entry): Video[] => {
    const id = text(entry["yt:videoId"]);
    // Everything printed is rebuilt or cleaned here: ids must look like ids, URLs are built from
    // the id, and text is one line with invisible characters removed (see oneLine).
    if (!VIDEO_ID.test(id)) {
      skipped++;
      return [];
    }
    const isShort = !!entry.link?.find((l) => l["@_rel"] === "alternate")?.["@_href"]?.includes("/shorts/");
    return [
      {
        id,
        title: oneLine(text(entry.title), TITLE_MAX) || "(untitled)",
        url: isShort ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
        channelId: oneLine(channelIdOf(entry["yt:channelId"]), 40) || channelId,
        channelTitle: oneLine(text(entry.author?.name), TITLE_MAX) || channelTitle,
        published: isoUtc(text(entry.published)),
        isShort,
        description: oneLine(cleanDescription(text(entry["media:group"]?.["media:description"])), DESCRIPTION_MAX + 1),
      },
    ];
  });

  return { channelId, channelTitle, videos, skipped };
}
