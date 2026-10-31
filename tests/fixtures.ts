export const CHANNEL_A = "UCaaaaaaaaaaaaaaaaaaaaaa";
export const CHANNEL_B = "UCbbbbbbbbbbbbbbbbbbbbbb";

type Entry = { id: string; title: string; published: string; short?: boolean; desc?: string };

/**
 * Builds a feed shaped like youtube.com/feeds/videos.xml?channel_id=…
 * Like the real feeds (seen live on 2026-10-29), <yt:channelId> carries the
 * ID without its "UC" prefix.
 */
export function feedXml(channelId: string, channelTitle: string, entries: Entry[]): string {
  const items = entries
    .map(
      (e) => `
 <entry>
  <id>yt:video:${e.id}</id>
  <yt:videoId>${e.id}</yt:videoId>
  <yt:channelId>${channelId.slice(2)}</yt:channelId>
  <title>${e.title}</title>
  <link rel="alternate" href="https://www.youtube.com/${e.short ? "shorts/" : "watch?v="}${e.id}"/>
  <author>
   <name>${channelTitle}</name>
   <uri>https://www.youtube.com/channel/${channelId}</uri>
  </author>
  <published>${e.published}</published>
  <updated>${e.published}</updated>
  <media:group>
   <media:title>${e.title}</media:title>
   <media:description>${e.desc ?? ""}</media:description>
  </media:group>
 </entry>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=${channelId}"/>
 <id>yt:channel:${channelId.slice(2)}</id>
 <yt:channelId>${channelId.slice(2)}</yt:channelId>
 <title>${channelTitle}</title>
 <link rel="alternate" href="https://www.youtube.com/channel/${channelId}"/>
 <published>2015-01-01T00:00:00+00:00</published>${items}
</feed>`;
}

export const FEED_A = feedXml(CHANNEL_A, "Alpha &amp; Co", [
  { id: "a3", title: "Third", published: "2026-10-29T09:00:00+00:00", desc: "A deep dive into the new feature.\n\nLinks: https://example.com/x\n#tips #claude" },
  { id: "a2", title: "Second &lt;draft&gt;", published: "2026-10-28T09:00:00+00:00" },
  { id: "aS", title: "A short", published: "2026-10-29T10:00:00+00:00", short: true },
]);

export const FEED_B = feedXml(CHANNEL_B, "Bravo", [
  { id: "b1", title: "Bravo new", published: "2026-10-29T08:00:00+00:00" },
  { id: "b0", title: "Bravo old", published: "2026-10-20T08:00:00+00:00" },
]);

/** A fake fetch that serves fixed bodies by URL and records calls. */
export function fakeFetch(routes: Record<string, string | number>) {
  const calls: { url: string; headers: Headers }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    const body = routes[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    if (typeof body === "number") return new Response("error", { status: body });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const feedUrl = (id: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
