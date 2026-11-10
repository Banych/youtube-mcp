import { extractChannelId, type ChannelRef } from "./channels";
import { parseFeed, type Feed, type Video } from "./feed";
import { fetchUploads, markShorts } from "./youtube-api";
import { errorMessage, get, getWithRetry, logFailures, type Deps } from "./http";

export type ChannelError = { channel: string; error: string };

const FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=";

/** Handle → channel ID, kept for the life of the server instance. */
const handleCache = new Map<string, string>();

export function clearHandleCache(): void {
  handleCache.clear();
}

export async function resolveChannelId(ref: ChannelRef, deps: Deps): Promise<string> {
  if (ref.kind === "id") return ref.id;

  const key = ref.handle.toLowerCase();
  const cached = handleCache.get(key);
  if (cached) return cached;

  // Non-Latin handles (e.g. @Котокраб) must be percent-encoded; the @ stays literal.
  const html = await get(`https://www.youtube.com/@${encodeURIComponent(ref.handle.slice(1))}`, deps, {
    headers: {
      "Accept-Language": "en",
      // Skips the EU cookie-consent interstitial, which has no channel ID in it.
      Cookie: "SOCS=CAI",
    },
  });
  const id = extractChannelId(html);
  if (!id) throw new Error(`no channel ID found on the ${ref.handle} page`);
  handleCache.set(key, id);
  return id;
}

/** YouTube's feeds intermittently answer 404 for channels that exist, sometimes all at once. */
export async function fetchFeed(channelId: string, deps: Deps): Promise<Feed> {
  return parseFeed(await getWithRetry(FEED_URL + channelId, deps));
}

/** API first when a key is set, the channel's feed when the API fails or there is no key. */
async function fetchChannel(ref: ChannelRef, deps: Deps, apiErrors: string[]): Promise<Feed> {
  const id = await resolveChannelId(ref, deps);
  const key = deps.youtubeApiKey;
  if (!key) return fetchFeed(id, deps);
  try {
    return await fetchUploads(id, key, deps);
  } catch (apiError) {
    apiErrors.push(errorMessage(apiError));
    try {
      return await fetchFeed(id, deps);
    } catch (feedError) {
      throw new Error(`API: ${errorMessage(apiError)}; feed: ${errorMessage(feedError)}`);
    }
  }
}

async function fetchAll(
  refs: ChannelRef[],
  deps: Deps,
): Promise<{ feeds: { ref: ChannelRef; feed: Feed }[]; errors: ChannelError[] }> {
  const apiErrors: string[] = [];
  const results = await Promise.allSettled(refs.map((ref) => fetchChannel(ref, deps, apiErrors)));
  const feeds: { ref: ChannelRef; feed: Feed }[] = [];
  const errors: ChannelError[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") feeds.push({ ref: refs[i], feed: result.value });
    else errors.push({ channel: refs[i].raw, error: errorMessage(result.reason) });
  });
  if (deps.youtubeApiKey) logFailures(deps, "youtube api", refs.length, apiErrors);
  logFailures(deps, "feeds", refs.length, errors.map((e) => e.error));
  const fromApi = feeds.filter((f) => f.feed.source === "api").flatMap((f) => f.feed.videos);
  if (deps.youtubeApiKey && fromApi.length) {
    try {
      await markShorts(fromApi, deps.youtubeApiKey, deps);
    } catch (e) {
      (deps.log ?? console.warn)(`youtube api: Shorts check failed (${errorMessage(e)}); Shorts may be listed as videos`);
    }
  }
  const skipped = feeds.reduce((n, f) => n + f.feed.skipped, 0);
  if (skipped) (deps.log ?? console.warn)(`feeds: ${skipped} video(s) with a malformed id skipped`);
  return { feeds, errors };
}

export type SourceCounts = { api: number; feed: number };

const countSources = (feeds: { feed: Feed }[]): SourceCounts => ({
  api: feeds.filter((f) => f.feed.source === "api").length,
  feed: feeds.filter((f) => f.feed.source === "feed").length,
});

export async function latestUploads(
  refs: ChannelRef[],
  options: { since?: Date; limit: number; includeShorts: boolean },
  deps: Deps,
): Promise<{ videos: Video[]; errors: ChannelError[]; sources: SourceCounts }> {
  const { feeds, errors } = await fetchAll(refs, deps);
  const since = options.since?.getTime();

  const videos = feeds
    .flatMap(({ feed }) => feed.videos)
    .filter((v) => options.includeShorts || !v.isShort)
    // A video without a readable date can be neither placed in time nor filtered by `since`.
    .filter((v) => v.published !== "" && (since === undefined || Date.parse(v.published) > since))
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, options.limit);

  return { videos, errors, sources: countSources(feeds) };
}

export async function describeChannels(
  refs: ChannelRef[],
  deps: Deps,
): Promise<{
  channels: { channel: string; id: string; title: string; latest?: string }[];
  errors: ChannelError[];
}> {
  const { feeds, errors } = await fetchAll(refs, deps);
  const channels = feeds.map(({ ref, feed }) => ({
    channel: ref.raw,
    id: feed.channelId,
    title: feed.channelTitle,
    latest: feed.videos
      .map((v) => v.published)
      .filter(Boolean)
      .sort()
      .at(-1),
  }));
  return { channels, errors };
}
