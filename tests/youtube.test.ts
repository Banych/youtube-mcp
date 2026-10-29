import { beforeEach, describe, expect, it } from "vitest";
import { parseChannelList } from "../lib/channels";
import { clearHandleCache, describeChannels, latestUploads, resolveChannelId } from "../lib/youtube";
import { CHANNEL_A, CHANNEL_B, FEED_A, FEED_B, fakeFetch, feedUrl } from "./fixtures";

const refs = (raw: string) => parseChannelList(raw).channels;

beforeEach(() => clearHandleCache());

describe("latestUploads", () => {
  const routes = { [feedUrl(CHANNEL_A)]: FEED_A, [feedUrl(CHANNEL_B)]: FEED_B };

  it("merges channels newest first and leaves Shorts out by default", async () => {
    const { fetch } = fakeFetch(routes);
    const { videos, errors } = await latestUploads(
      refs(`${CHANNEL_A},${CHANNEL_B}`),
      { limit: 10, includeShorts: false },
      { fetch },
    );
    expect(errors).toEqual([]);
    expect(videos.map((v) => v.id)).toEqual(["a3", "b1", "a2", "b0"]);
  });

  it("keeps only videos published after `since`, Shorts included on request", async () => {
    const { fetch } = fakeFetch(routes);
    const { videos } = await latestUploads(
      refs(`${CHANNEL_A},${CHANNEL_B}`),
      { since: new Date("2026-10-29T08:00:00Z"), limit: 10, includeShorts: true },
      { fetch },
    );
    // b1 was published exactly at `since`, so it is not new.
    expect(videos.map((v) => v.id)).toEqual(["aS", "a3"]);
  });

  it("applies the limit after sorting", async () => {
    const { fetch } = fakeFetch(routes);
    const { videos } = await latestUploads(
      refs(`${CHANNEL_A},${CHANNEL_B}`),
      { limit: 2, includeShorts: false },
      { fetch },
    );
    expect(videos.map((v) => v.id)).toEqual(["a3", "b1"]);
  });

  it("reports a failing channel and still returns the others", async () => {
    const { fetch } = fakeFetch({ [feedUrl(CHANNEL_A)]: FEED_A, [feedUrl(CHANNEL_B)]: 500 });
    const { videos, errors } = await latestUploads(
      refs(`${CHANNEL_A},${CHANNEL_B}`),
      { limit: 10, includeShorts: false },
      { fetch },
    );
    expect(videos.map((v) => v.id)).toEqual(["a3", "a2"]);
    expect(errors).toEqual([{ channel: CHANNEL_B, error: "HTTP 500" }]);
  });

  it("names a timeout plainly", async () => {
    const slow = (async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as typeof fetch;
    const { errors } = await latestUploads(
      refs(CHANNEL_A),
      { limit: 10, includeShorts: false },
      { fetch: slow, timeoutMs: 20 },
    );
    expect(errors).toEqual([{ channel: CHANNEL_A, error: "timed out" }]);
  });
});

describe("resolveChannelId", () => {
  const page = `<link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL_A}">`;

  it("resolves a handle once, sends the consent-skip cookie, and caches it", async () => {
    const { fetch, calls } = fakeFetch({ "https://www.youtube.com/@Alpha": page });
    const [ref] = refs("@Alpha");
    expect(await resolveChannelId(ref, { fetch })).toBe(CHANNEL_A);
    expect(await resolveChannelId(refs("@alpha")[0], { fetch })).toBe(CHANNEL_A);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get("cookie")).toBe("SOCS=CAI");
  });

  it("fails clearly when the page has no channel ID", async () => {
    const { fetch } = fakeFetch({ "https://www.youtube.com/@Alpha": "<html>consent</html>" });
    await expect(resolveChannelId(refs("@Alpha")[0], { fetch })).rejects.toThrow(
      "no channel ID found on the @Alpha page",
    );
  });

  it("percent-encodes a non-Latin handle and caches it case-insensitively", async () => {
    const { fetch, calls } = fakeFetch({ "https://www.youtube.com/@%D0%9A%D0%BE%D1%82%D0%BE%D0%BA%D1%80%D0%B0%D0%B1": page });
    expect(await resolveChannelId(refs("@Котокраб")[0], { fetch })).toBe(CHANNEL_A);
    expect(await resolveChannelId(refs("@котокраб")[0], { fetch })).toBe(CHANNEL_A);
    expect(calls.map((c) => c.url)).toEqual([
      "https://www.youtube.com/@%D0%9A%D0%BE%D1%82%D0%BE%D0%BA%D1%80%D0%B0%D0%B1",
    ]);
  });

  it("returns an ID entry without any request", async () => {
    const { fetch, calls } = fakeFetch({});
    expect(await resolveChannelId(refs(CHANNEL_B)[0], { fetch })).toBe(CHANNEL_B);
    expect(calls).toHaveLength(0);
  });
});

describe("describeChannels", () => {
  it("keeps the configured entry next to each resolved channel", async () => {
    const page = `"externalId":"${CHANNEL_B}"`;
    const { fetch } = fakeFetch({
      "https://www.youtube.com/@Bravo": page,
      [feedUrl(CHANNEL_B)]: FEED_B,
      [feedUrl(CHANNEL_A)]: FEED_A,
    });
    const { channels, errors } = await describeChannels(refs(`@Bravo,${CHANNEL_A}`), { fetch });
    expect(errors).toEqual([]);
    expect(channels).toEqual([
      { channel: "@Bravo", id: CHANNEL_B, title: "Bravo", latest: "2026-10-29T08:00:00+00:00" },
      { channel: CHANNEL_A, id: CHANNEL_A, title: "Alpha & Co", latest: "2026-10-29T10:00:00+00:00" },
    ]);
  });
});
