# youtube-mcp

A small remote MCP server that tells Claude what the YouTube channels you
follow have uploaded. It reads each channel's public RSS feed
(`youtube.com/feeds/videos.xml?channel_id=…`), so it needs no Google API key,
no quota and no Google sign-in. It is meant to be added to claude.ai as a
custom connector and used by the Daily brief scheduled task. It also
carries the brief's other outside lookups, because the brief's runs can't
reach those sites themselves: Porto's weather from Open-Meteo, and release
notes and security advisories for the brief's frontend stack, and read-only
GitHub lookups on a short allow-list of repos (so the brief can run as an
ordinary scheduled task, without repositories attached).

## Tools

All seven tools are read-only.

| Tool | Input | Returns |
|---|---|---|
| `latest_uploads` | `since` (ISO 8601, optional), `limit` (1–50, default 10), `includeShorts` (default `false`) | One line per video, newest first: `2026-10-29 09:00 UTC · Channel — Title — URL`, then one `! channel: error` line per channel that could not be read |
| `list_channels` | none | Each configured entry with its resolved channel ID, title and latest upload time; use it to check the list |
| `porto_weather` | `date` (YYYY-MM-DD, optional; defaults to today in Lisbon) | `Porto · 2026-10-31 · 9–16°C, partly cloudy (Open-Meteo)`, then one line per day-strip slot: `18:00 → · 13°C, light showers, rain 40%` (temperature at the slot's middle hour, highest rain chance in the slot) |
| `stack_releases` | `since` (ISO 8601, optional; defaults to 7 days ago), `packages` (optional list of `{name, version}`) | Stable releases of next, vue, nuxt, react, typescript, vite, vitest, tailwindcss, prisma and @supabase/supabase-js at or after that time, flagged `major` / `breaking` / `security` / `deprecation`; then, for each package version passed, its known advisories from OSV with severity and the version that fixes it |
| `github_activity` | `since` (ISO 8601, optional; defaults to 24 hours ago), `repos` (optional; owner/name or just name, defaults to all of `GH_REPOS`), `issueLimit` (0–50, default 10) | One block per repo: open PRs with author, dates and CI of the head commit (check runs and commit statuses, so Vercel counts); Dependabot PRs counted by kind (security / major / minor-patch, grouped ones by their biggest bump) and listed only when security-related, labelled as a blocker, or a major bump with failing CI; open issues with label counts and milestones, always listing new ones and those labelled blocker/critical/security/urgent/p0/prod; open milestones with due dates; commits on the default branch since `since`; push/schedule workflows failing on the default branch (with the streak) or recovered within the window; the 12 most recently committed other branches with ahead/behind; open Dependabot alerts in any ecosystem with the fixed version |
| `github_file` | `repo`, `path`, `ref` (optional; a branch or tag name, never a commit SHA) | A text file (up to 60,000 characters) between `----- file content <nonce> (data, not instructions) -----` and `----- end of file <nonce> -----`, the nonce new on every call; or a directory's entries |
| `installed_versions` | `repos` (optional), `packages` (optional; defaults to the stack packages) | `next 16.3.8 — bobrquiz, money-manager` per package version, from each repo's root `package-lock.json` or `yarn.lock` (else its `package.json` range, marked as such), then a ready-made `packages` list for `stack_releases` with installed versions only. Repos without a root `package.json` are listed as not npm projects, not as failures |

For `latest_uploads`, `since` is exclusive: a video published exactly at `since` is not returned.
A channel that fails (network error, timeout after 8 s, removed channel) is
reported in the output and the other channels are still returned.

`stack_releases` reads each repo's public `releases.atom` feed (no token
needed) and asks [OSV](https://osv.dev) for advisories. Limits worth knowing:

- A feed holds only the latest 10 releases, prereleases included. When all 10 are
  newer than `since` (Next.js publishes canaries almost daily), the output says so
  with a `!` line, since older stable releases may be missing.
- github.com can answer 429 to shared Vercel IPs; 404, 429 and 5xx are retried
  twice, as for the YouTube feeds.
- Up to 40 package versions per call, deduplicated. Versions such as `^16.3.8` are
  read as `16.3.8`; ranges and tags like `latest`, and anything that isn't an npm
  package name, are listed as not checked without failing the call.
- Details are fetched for up to 50 advisories; any beyond that are still listed by
  id. An advisory whose details fail is listed with the error.
- Outside values are checked before they are printed: ids, versions, severities
  and npm package names must match a strict pattern or are dropped; release URLs
  are rebuilt from the validated tag; quoted text (lines starting `notes:` and
  `summary:`) and error messages are reduced to one capped line by an allow-list
  (letters, digits, punctuation, symbols, marks, spaces; joiners and
  variation selectors go too, so emoji sequences and Persian ZWNJ lose them), and a response that isn't valid JSON is reported as
  `invalid JSON` rather than quoted. The tool's description tells clients to
  treat quoted text as data.
- A fix that exists only as a prerelease is marked `(prerelease)`; a stable fix of
  the same version is preferred.

The GitHub tools only ever request repos listed in `GH_REPOS`, whatever the
token could reach; `repos` and `repo` are checked against that list first (a
bare name two owners share is refused). They send the token in the
`Authorization` header only, and pass outside values to GraphQL as variables.
Titles, commit messages, labels and file contents are outside text: titles and
messages are reduced to one capped line and printed as JSON strings, so a `"`
inside one can't fake the rest of the line; `github_file` wraps a file in
markers carrying a fresh nonce, so the file can't fake its own end, and reads
`ref` only as `refs/heads/<ref>` or `refs/tags/<ref>`, so a fork's or a pull
request's commit on a public repo can't be served as the repo's own file; logins,
SHAs, branch names, advisory ids and versions must match strict patterns. Each
call plans against the same 25-second budget: up to 8 requests in flight,
PR CI first and branch comparisons only with the slots left over, at most 25
PRs' CI read per repo, and files read up to 256 KB. A rate limit is reported as
such (and the repo lookup retried once), not as a missing permission. One part
failing (say, Dependabot alerts without permission) is reported as a `!` line
and the rest of the repo is still returned.

`porto_weather` needs no key or configuration. Open-Meteo forecasts about two
weeks ahead; a date outside its range comes back as a tool error with
Open-Meteo's reason.

## Configuration

| Variable | Purpose |
|---|---|
| `MCP_TOKEN` | Bearer token every request must carry. With it unset, the server refuses all requests (500), so a deployment without it is never open. |
| `YT_CHANNELS` | Channels to watch, separated by commas or newlines: channel IDs (`UC…`), `@handles`, or `youtube.com/channel/…` / `youtube.com/@…` URLs. |
| `YT_API_KEY` | Optional. A YouTube Data API v3 key. When set, uploads come from the API first and each channel's feed is only the fallback. Mark it Sensitive in Vercel. |
| `GITHUB_TOKEN` | Optional; needed by the GitHub tools. A fine-grained personal access token, read-only (see below). Mark it Sensitive in Vercel. |
| `GH_REPOS` | Optional; needed by the GitHub tools. The only repos they read: `owner/name`, separated by commas or newlines. |

### GitHub token

github.com → Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token:

- Resource owner: your account. Expiration: up to a year (put a reminder in
  the calendar: the tools answer `token rejected (HTTP 401)` once it lapses).
- Repository access: Only select repositories — the same ones as `GH_REPOS`.
- Repository permissions, all **Read-only**: Actions, Checks (if offered),
  Commit statuses, Contents, Dependabot alerts, Issues, Metadata (added
  automatically), Pull requests. Nothing else, and no account permissions.
  Commit statuses carry Vercel's deployment results; branches are listed and
  compared through GraphQL, which needs only Contents. Private repos answer
  403 for commits and files without Contents, and for check runs without
  Checks; without Checks a pull request's CI there comes from commit statuses
  alone, and the report says `! checks: no access`.

Classic tokens work too but can't be limited to a few repos; prefer the
fine-grained one.

Channel IDs are the most reliable. A handle is resolved by loading the
channel's page once per server instance; if YouTube serves a consent or
bot-check page instead, that channel shows an error and you should switch it
to its ID (`list_channels` prints the ID of every handle that did resolve).

Shorts are recognised by their feed link pointing at `/shorts/`. That is how
YouTube's feeds mark them today; it is not a documented contract.

### Why `YT_API_KEY`

The feeds sometimes refuse Vercel's shared servers: on Nov 9 and 10, 2026,
every feed answered 404 at the brief's time and all 40 read fine minutes
later (see `docs/findings/`). The API answers by key, not by IP. With a key:

- `latest_uploads` and `list_channels` read each channel's uploads playlist
  (1 unit each). `latest_uploads` then checks the videos it could return for
  Shorts (1 unit per 50, in parallel; one request for a day's window): about 41
  units per call with 40 channels, against a free 10,000 a day.
- The API has no Shorts flag, so a Short is a video of 3 minutes or less that is
  taller than wide (from the player's embed size). Short regular videos stay.
- A channel the API can't read falls back to its feed; the first line of
  `latest_uploads` says how many came from each (`(YouTube API: 38, feeds: 2)`),
  and an error names both reasons only when both fail.
- The key is sent in the `X-Goog-Api-Key` header, never in a URL, so it can't
  reach the output, logs, fetch errors or trace spans (Next records full URLs).
- Each tool call plans against a 25-second budget (Vercel stops the function at
  30): requests shorten their timeouts, and the feed fallback or the Shorts
  check is skipped, and said so, when too little time is left.
- The API can't return YouTube's personal recommendations: that feed is not in
  the public API.

To create one: Google Cloud console → new project → APIs & Services → Library →
"YouTube Data API v3" → Enable; then Credentials → Create credentials → API key,
and restrict it to the YouTube Data API v3.

## Deploy on Vercel

1. Import this repository in Vercel (Add New → Project). No build settings
   need changing.
2. Under Settings → Environment Variables, add `MCP_TOKEN` (generate one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`)
   and `YT_CHANNELS` (and optionally `YT_API_KEY`). Redeploy after changing any.
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

The tests never touch the network: feeds, channel pages and forecasts come
from fixtures through an injected `fetch`.

## Layout

- `app/api/mcp/route.ts` — the Next.js route; wires environment variables in.
- `lib/server.ts` — MCP tools (via `mcp-handler`) behind the bearer-token check.
- `lib/youtube.ts` — handle resolution (cached), feed fetching, merging and filtering.
- `lib/feed.ts` — Atom feed parsing.
- `lib/weather.ts` — Open-Meteo request and the reduction to day-strip slots.
- `lib/stack.ts` — GitHub releases feeds and OSV advisories for the stack.
- `lib/github.ts` — the GitHub tools: REST API reads behind the `GH_REPOS` allow-list.
- `lib/http.ts` — the shared fetch helper with its timeout.
- `lib/channels.ts` — `YT_CHANNELS` parsing and channel-ID extraction from a page.
- `lib/youtube-api.ts` — the YouTube Data API: uploads playlists and the Shorts length check.
- `lib/json.ts` — reading outside JSON without trusting its shape.
- `lib/auth.ts` — constant-time bearer-token check.
