import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { authorize } from "./auth";
import { parseChannelList } from "./channels";
import type { Video } from "./feed";
import { formatForecast, getForecast, localDate, PORTO } from "./weather";
import { describeChannels, latestUploads, type ChannelError, type Deps } from "./youtube";

export type Config = {
  /** Raw YT_CHANNELS value: channel IDs, @handles or channel URLs. */
  channels: string | undefined;
  /** Bearer token clients must send. */
  token: string | undefined;
};

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

function formatVideo(v: Video): string {
  const when = v.published.slice(0, 16).replace("T", " ");
  const line = `${when} UTC · ${v.channelTitle} — ${v.title}${v.isShort ? " (Short)" : ""} — ${v.url}`;
  return v.description ? `${line}\n    ${v.description}` : line;
}

function formatErrors(errors: ChannelError[], invalid: string[]): string[] {
  return [
    ...errors.map((e) => `! ${e.channel}: ${e.error}`),
    ...invalid.map((entry) => `! ${entry}: not a channel ID, @handle or channel URL`),
  ];
}

export function createServer(getConfig: () => Config, deps: Deps) {
  const mcp = createMcpHandler(
    (server) => {
      server.registerTool(
        "latest_uploads",
        {
          title: "Latest uploads",
          description:
            "New videos from the configured YouTube channels, newest first, each with the start of its description on the next line. " +
            "Pass `since` (ISO 8601) to get only videos published after that time.",
          inputSchema: z.object({
            since: z.iso
              .datetime({ offset: true })
              .optional()
              .describe("Only videos published after this time, e.g. 2026-10-29T07:47:00Z"),
            limit: z.number().int().min(1).max(50).default(10),
            includeShorts: z.boolean().default(false),
          }),
          annotations: readOnly,
        },
        async ({ since, limit, includeShorts }) => {
          const { channels, invalid } = parseChannelList(getConfig().channels);
          if (channels.length === 0) {
            return {
              isError: true,
              content: [{ type: "text", text: "No channels configured: set YT_CHANNELS on the server." }],
            };
          }
          const { videos, errors } = await latestUploads(
            channels,
            { since: since ? new Date(since) : undefined, limit, includeShorts },
            deps,
          );
          const lines = [
            `${videos.length} video(s) from ${channels.length - errors.length}/${channels.length} channel(s)` +
              (since ? ` since ${since}` : ""),
            ...videos.map(formatVideo),
            ...formatErrors(errors, invalid),
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        },
      );

      server.registerTool(
        "list_channels",
        {
          title: "List channels",
          description:
            "The configured YouTube channels with their resolved IDs, titles and latest upload time. " +
            "Use it to check the channel list.",
          inputSchema: z.object({}),
          annotations: readOnly,
        },
        async () => {
          const { channels: refs, invalid } = parseChannelList(getConfig().channels);
          const { channels, errors } = await describeChannels(refs, deps);
          const lines = [
            `${channels.length}/${refs.length} channel(s) readable`,
            ...channels.map(
              (c) => `${c.title} (${c.id}) from "${c.channel}" — latest upload ${c.latest ?? "none"}`,
            ),
            ...formatErrors(errors, invalid),
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        },
      );

      server.registerTool(
        "porto_weather",
        {
          title: "Porto weather",
          description:
            "Porto's forecast for one day from Open-Meteo, in Lisbon time: the day's range and condition, then one line per " +
            "day-strip slot (08:00–12:00, 12:00–18:00, 18:00 →) with the temperature at its middle hour, the condition and " +
            "the highest chance of rain in the slot.",
          inputSchema: z.object({
            date: z.iso
              .date()
              .optional()
              .describe("Local date, YYYY-MM-DD; defaults to today in Lisbon. Up to about two weeks ahead."),
          }),
          annotations: readOnly,
        },
        async ({ date }) => {
          const day = date ?? localDate((deps.now ?? (() => new Date()))(), PORTO.timezone);
          try {
            return { content: [{ type: "text", text: formatForecast(await getForecast(day, deps)) }] };
          } catch (e) {
            return {
              isError: true,
              content: [{ type: "text", text: `Weather unavailable: ${e instanceof Error ? e.message : String(e)}` }],
            };
          }
        },
      );
    },
    { serverInfo: { name: "youtube-uploads", version: "1.0.0" } },
  );

  return async (req: Request): Promise<Response> =>
    authorize(req, getConfig().token) ?? mcp(req);
}
