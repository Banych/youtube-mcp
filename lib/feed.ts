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
  /** Where the videos came from: the channel's Atom feed or the YouTube Data API. */
  source: "feed" | "api";
};

/** One video as read from a source, before anything is cleaned. */
export type RawVideo = {
  id: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  published: string;
  isShort: boolean;
};

/**
 * The one place a video is built for printing, whatever the source: ids must look like ids,
 * URLs are built from the id, dates must be strict ISO, and text is one line with invisible
 * characters removed (see oneLine). Returns null for a malformed id.
 */
export function cleanVideo(raw: RawVideo, fallback: { channelId: string; channelTitle: string }): Video | null {
  if (!VIDEO_ID.test(raw.id)) return null;
  return {
    id: raw.id,
    title: oneLine(raw.title, TITLE_MAX) || "(untitled)",
    url: raw.isShort ? `https://www.youtube.com/shorts/${raw.id}` : `https://www.youtube.com/watch?v=${raw.id}`,
    channelId: oneLine(raw.channelId, 40) || fallback.channelId,
    channelTitle: oneLine(raw.channelTitle, TITLE_MAX) || fallback.channelTitle,
    published: isoUtc(raw.published),
    isShort: raw.isShort,
    description: oneLine(cleanDescription(raw.description), DESCRIPTION_MAX + 1),
  };
}

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
    const video = cleanVideo(
      {
        id: text(entry["yt:videoId"]),
        title: text(entry.title),
        description: text(entry["media:group"]?.["media:description"]),
        channelId: channelIdOf(entry["yt:channelId"]),
        channelTitle: text(entry.author?.name),
        published: text(entry.published),
        isShort: !!entry.link?.find((l) => l["@_rel"] === "alternate")?.["@_href"]?.includes("/shorts/"),
      },
      { channelId, channelTitle },
    );
    if (!video) skipped++;
    return video ? [video] : [];
  });

  return { channelId, channelTitle, videos, skipped, source: "feed" };
}
