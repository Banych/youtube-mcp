# 2026-11-10: YouTube Data API, first live check

## Why the API

The Nov 9 and Nov 10 Daily briefs (07:55 Lisbon) both read 0/40 channels:
every feed answered 404 even after three tries, while the same call a few
minutes later read 40/40. Feed failures were not logged at the time, so the
cause is inferred, not observed: YouTube refusing feed requests from Vercel's
shared servers around the hour. The API answers by key, not by IP.

## What the live check showed

- Deployment dpl_FQggqci1F2XdfTnzaWDDMNsjCdHk (commit dcc4294), production,
  with `YT_API_KEY` set in Vercel.
- `latest_uploads` (since 2026-11-08T00:00:00Z, limit 12, includeShorts) at
  about 09:15 UTC: `12 video(s) from 40/40 channel(s) … (YouTube API: 40,
  feeds: 0)`.
- **The key is accepted in the `X-Goog-Api-Key` header** (no `key=` in any URL);
  this had been inferred from Google Cloud's API-key docs only.
- **`videos.list` with `part=contentDetails,player&maxWidth=480` returns
  `player.embedWidth/embedHeight`**: four Shorts were detected (vertical,
  3 minutes or less: Man City "#shorts", StopGame, KEXP, Claude "Meet Claude
  Fable 5.2"), and regular videos, including two-minute ones, were not.
- Runtime logs for the 10 minutes around the call: empty (no feed failures, no
  timeouts).

## Still open

- Whether the feeds are really refused by IP at the brief's time will show in
  the `feeds:` log lines only if the API ever falls back.
- `stack_releases` (merged Nov 10) has not been called live yet: this session's
  connector kept its old tool list. The next brief run is its first live call.
