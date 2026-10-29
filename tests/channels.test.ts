import { describe, expect, it } from "vitest";
import { extractChannelId, parseChannelList } from "../lib/channels";
import { CHANNEL_A, CHANNEL_B } from "./fixtures";

describe("parseChannelList", () => {
  it("accepts IDs, handles and both URL forms, in any separator", () => {
    const raw = `${CHANNEL_A}, @Fireship\nhttps://www.youtube.com/channel/${CHANNEL_B}  https://youtube.com/@ThePrimeTimeagen/videos`;
    const { channels, invalid } = parseChannelList(raw);
    expect(invalid).toEqual([]);
    expect(channels.map((c) => (c.kind === "id" ? c.id : c.handle))).toEqual([
      CHANNEL_A,
      "@Fireship",
      CHANNEL_B,
      "@ThePrimeTimeagen",
    ]);
  });

  it("drops duplicates, comparing handles case-insensitively", () => {
    const { channels } = parseChannelList(`@Fireship,@fireship,${CHANNEL_A},${CHANNEL_A}`);
    expect(channels).toHaveLength(2);
  });

  it("reports entries it cannot use", () => {
    const { channels, invalid } = parseChannelList("Fireship, UC123, @x");
    expect(channels).toEqual([]);
    expect(invalid).toEqual(["Fireship", "UC123", "@x"]);
  });

  it("returns nothing for an unset or blank setting", () => {
    expect(parseChannelList(undefined).channels).toEqual([]);
    expect(parseChannelList("  \n ").channels).toEqual([]);
  });
});

describe("extractChannelId", () => {
  it("prefers the canonical link", () => {
    const html = `<link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL_A}">"channelId":"${CHANNEL_B}"`;
    expect(extractChannelId(html)).toBe(CHANNEL_A);
  });

  it("falls back to externalId in the page data", () => {
    expect(extractChannelId(`{"externalId":"${CHANNEL_B}"}`)).toBe(CHANNEL_B);
  });

  it("returns undefined when the page has no ID (e.g. a consent wall)", () => {
    expect(extractChannelId("<html>Before you continue to YouTube</html>")).toBeUndefined();
  });
});
