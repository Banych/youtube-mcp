import { extractChannelId, type ChannelRef } from "./channels";
import { parseFeed, type Feed, type Video } from "./feed";

export type Deps = {
  fetch: typeof fetch;
  timeoutMs?: number;
};

export type ChannelError = { channel: string; error: string };

const FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=";

/** Handle → channel ID, kept for the life of the server instance. */
const handleCache = new Map<string, string>();

export function clearHandleCache(): void {
  handleCache.clear();
}

async function get(url: string, deps: Deps, init?: RequestInit): Promise<string> {
  const res = await deps.fetch(url, {
    ...init,
    signal: AbortSignal.timeout(deps.timeoutMs ?? 8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function resolveChannelId(ref: ChannelRef, deps: Deps): Promise<string> {
  if (ref.kind === "id") return ref.id;

  const key = ref.handle.toLowerCase();
  const cached = handleCache.get(key);
  if (cached) return cached;

  // The handle was validated as @[\w.-]+ by parseChannelList, so it is URL-safe.
  const html = await get(`https://www.youtube.com/${ref.handle}`, deps, {
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

export async function fetchFeed(channelId: string, deps: Deps): Promise<Feed> {
  return parseFeed(await get(FEED_URL + channelId, deps));
}

async function fetchAll(
  refs: ChannelRef[],
  deps: Deps,
): Promise<{ feeds: { ref: ChannelRef; feed: Feed }[]; errors: ChannelError[] }> {
  const results = await Promise.allSettled(
    refs.map(async (ref) => fetchFeed(await resolveChannelId(ref, deps), deps)),
  );
  const feeds: { ref: ChannelRef; feed: Feed }[] = [];
  const errors: ChannelError[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") feeds.push({ ref: refs[i], feed: result.value });
    else errors.push({ channel: refs[i].raw, error: errorMessage(result.reason) });
  });
  return { feeds, errors };
}

export async function latestUploads(
  refs: ChannelRef[],
  options: { since?: Date; limit: number; includeShorts: boolean },
  deps: Deps,
): Promise<{ videos: Video[]; errors: ChannelError[] }> {
  const { feeds, errors } = await fetchAll(refs, deps);
  const since = options.since?.getTime();

  const videos = feeds
    .flatMap(({ feed }) => feed.videos)
    .filter((v) => options.includeShorts || !v.isShort)
    .filter((v) => since === undefined || Date.parse(v.published) > since)
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, options.limit);

  return { videos, errors };
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
    latest: feed.videos.map((v) => v.published).sort().at(-1),
  }));
  return { channels, errors };
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.name === "TimeoutError" ? "timed out" : reason.message;
  }
  return String(reason);
}
