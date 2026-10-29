# youtube-mcp

A small remote MCP server that tells Claude what the YouTube channels you
follow have uploaded. It reads each channel's public RSS feed
(`youtube.com/feeds/videos.xml?channel_id=…`), so it needs no Google API key,
no quota and no Google sign-in. It is meant to be added to claude.ai as a
custom connector and used by the Daily brief scheduled task.

## Tools

Both tools are read-only.

| Tool | Input | Returns |
|---|---|---|
| `latest_uploads` | `since` (ISO 8601, optional), `limit` (1–50, default 10), `includeShorts` (default `false`) | One line per video, newest first: `2026-10-29 09:00 UTC · Channel — Title — URL`, then one `! channel: error` line per channel that could not be read |
| `list_channels` | none | Each configured entry with its resolved channel ID, title and latest upload time; use it to check the list |

`since` is exclusive: a video published exactly at `since` is not returned.
A channel that fails (network error, timeout after 8 s, removed channel) is
reported in the output and the other channels are still returned.

## Configuration

| Variable | Purpose |
|---|---|
| `MCP_TOKEN` | Bearer token every request must carry. With it unset, the server refuses all requests (500), so a deployment without it is never open. |
| `YT_CHANNELS` | Channels to watch, separated by commas or newlines: channel IDs (`UC…`), `@handles`, or `youtube.com/channel/…` / `youtube.com/@…` URLs. |

Channel IDs are the most reliable. A handle is resolved by loading the
channel's page once per server instance; if YouTube serves a consent or
bot-check page instead, that channel shows an error and you should switch it
to its ID (`list_channels` prints the ID of every handle that did resolve).

Shorts are recognised by their feed link pointing at `/shorts/`. That is how
YouTube's feeds mark them today; it is not a documented contract.

## Deploy on Vercel

1. Import this repository in Vercel (Add New → Project). No build settings
   need changing.
2. Under Settings → Environment Variables, add `MCP_TOKEN` (generate one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`)
   and `YT_CHANNELS`. Redeploy after changing either.
3. The endpoint is `https://<project>.vercel.app/api/mcp`.

## Add it to Claude

1. claude.ai → Customize → Connectors → + Add → Add custom connector.
2. Name: `YouTube uploads`. URL: the endpoint above.
3. Authentication: No sign in. Request headers: `Authorization` =
   `Bearer <MCP_TOKEN>`.
4. In the Daily brief task's Edit dialog → Connectors, include it.

## Develop

```sh
npm install
cp .env.example .env.local   # fill in MCP_TOKEN and YT_CHANNELS
npm run dev                  # http://localhost:3000/api/mcp
npm test                     # unit and endpoint tests, no network
npm run typecheck
npm run build
```

The tests never touch the network: feeds and channel pages come from
fixtures through an injected `fetch`.

## Layout

- `app/api/mcp/route.ts` — the Next.js route; wires environment variables in.
- `lib/server.ts` — MCP tools (via `mcp-handler`) behind the bearer-token check.
- `lib/youtube.ts` — handle resolution (cached), feed fetching, merging and filtering.
- `lib/feed.ts` — Atom feed parsing.
- `lib/channels.ts` — `YT_CHANNELS` parsing and channel-ID extraction from a page.
- `lib/auth.ts` — constant-time bearer-token check.
