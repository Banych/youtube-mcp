export type ChannelRef =
  | { kind: "id"; id: string; raw: string }
  | { kind: "handle"; handle: string; raw: string };

const CHANNEL_ID = /^UC[\w-]{22}$/;
const HANDLE = /^@[\w.-]{3,30}$/;

/**
 * Parses the YT_CHANNELS setting: entries separated by commas, newlines or
 * spaces. Each entry is a channel ID (UC…), an @handle, or a youtube.com URL
 * of either form. Unknown entries are reported, not dropped silently.
 */
export function parseChannelList(raw: string | undefined): {
  channels: ChannelRef[];
  invalid: string[];
} {
  const channels: ChannelRef[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const entry of (raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    const ref = toRef(entry);
    if (!ref) {
      invalid.push(entry);
      continue;
    }
    const key = ref.kind === "id" ? ref.id : ref.handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    channels.push(ref);
  }
  return { channels, invalid };
}

function toRef(entry: string): ChannelRef | undefined {
  let value = entry;
  const url = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(channel\/[^/?#]+|@[^/?#]+)/i.exec(entry);
  if (url) value = url[1].replace(/^channel\//, "");
  value = decodeURIComponent(value);

  if (CHANNEL_ID.test(value)) return { kind: "id", id: value, raw: entry };
  if (HANDLE.test(value)) return { kind: "handle", handle: value, raw: entry };
  return undefined;
}

/** Finds the channel ID in the HTML of a youtube.com/@handle page. */
export function extractChannelId(html: string): string | undefined {
  const patterns = [
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
    /"externalId":"(UC[\w-]{22})"/,
    /<meta itemprop="identifier" content="(UC[\w-]{22})"/,
    /"channelId":"(UC[\w-]{22})"/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) return match[1];
  }
  return undefined;
}
