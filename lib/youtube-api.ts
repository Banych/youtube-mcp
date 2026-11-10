import { cleanVideo, type Feed, type Video } from "./feed";
import { get, oneLine, type Deps } from "./http";
import { arr, obj, str } from "./json";

/**
 * The YouTube Data API v3, used first when YT_API_KEY is set: it answers by key, not by the
 * caller's IP, so it keeps working when the feeds refuse Vercel's shared servers. Costs per call
 * of latest_uploads or list_channels: 1 unit per channel (its uploads playlist) plus 1 per 50
 * videos for the Shorts check, against a free 10,000 units a day.
 *
 * The key is a query parameter, so URLs from here are never printed or logged: errors carry the
 * HTTP status only (see HttpError and errorMessage).
 */
export const API_BASE = "https://www.googleapis.com/youtube/v3";
export const UPLOADS_PER_CHANNEL = 15;
/** Shorts can run up to 3 minutes; the API has no Shorts flag, so length decides. */
export const SHORT_MAX_SECONDS = 180;

const UC_ID = /^UC[\w-]{22}$/;

/** A channel's uploads playlist is its id with "UC" replaced by "UU". */
export function uploadsUrl(channelId: string, key: string): string {
  const params = new URLSearchParams({
    part: "snippet,contentDetails",
    maxResults: String(UPLOADS_PER_CHANNEL),
    playlistId: `UU${channelId.slice(2)}`,
    key,
  });
  return `${API_BASE}/playlistItems?${params}`;
}

export function videosUrl(ids: string[], key: string): string {
  const params = new URLSearchParams({ part: "contentDetails", id: ids.join(","), maxResults: "50", key });
  return `${API_BASE}/videos?${params}`;
}

export async function fetchUploads(channelId: string, key: string, deps: Deps): Promise<Feed> {
  if (!UC_ID.test(channelId)) throw new Error("not a UC… channel id");
  const items = arr(obj(JSON.parse(await get(uploadsUrl(channelId, key), deps))).items);
  let channelTitle = "";
  let skipped = 0;
  const videos = items.flatMap((item): Video[] => {
    const snippet = obj(obj(item).snippet);
    const details = obj(obj(item).contentDetails);
    channelTitle ||= str(snippet.channelTitle) ?? "";
    const video = cleanVideo(
      {
        id: str(details.videoId) ?? str(obj(snippet.resourceId).videoId) ?? "",
        title: str(snippet.title) ?? "",
        description: str(snippet.description) ?? "",
        channelId: str(snippet.channelId) ?? channelId,
        channelTitle: str(snippet.channelTitle) ?? "",
        // When the video went public; private and deleted uploads have none and are dropped later.
        published: str(details.videoPublishedAt) ?? "",
        isShort: false,
      },
      { channelId, channelTitle: "" },
    );
    if (!video) skipped++;
    return video ? [video] : [];
  });
  return { channelId, channelTitle: oneLine(channelTitle, 200), videos, skipped, source: "api" };
}

/** "PT1M30S" → 90; anything else → null. */
export function durationSeconds(iso: string): number | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m || iso === "P" || iso === "PT") return null;
  const [d, h, min, s] = m.slice(1).map((x) => Number(x ?? 0));
  return ((d * 24 + h) * 60 + min) * 60 + s;
}

/** Marks the API's videos that are Shorts by length, 50 per request; mutates them in place. */
export async function markShorts(videos: Video[], key: string, deps: Deps): Promise<void> {
  for (let i = 0; i < videos.length; i += 50) {
    const batch = videos.slice(i, i + 50);
    const items = arr(obj(JSON.parse(await get(videosUrl(batch.map((v) => v.id), key), deps))).items);
    const seconds = new Map<string, number | null>();
    for (const item of items) {
      const id = str(obj(item).id);
      const duration = str(obj(obj(item).contentDetails).duration);
      if (id && duration) seconds.set(id, durationSeconds(duration));
    }
    for (const v of batch) {
      const s = seconds.get(v.id);
      if (s != null && s > 0 && s <= SHORT_MAX_SECONDS) {
        v.isShort = true;
        v.url = `https://www.youtube.com/shorts/${v.id}`;
      }
    }
  }
}
