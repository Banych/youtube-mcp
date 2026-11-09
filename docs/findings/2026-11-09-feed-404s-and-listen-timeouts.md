# 2026-11-09: feed 404s and 30-second function timeouts

## Feed 404s

- **Observed:** the Nov 9 Daily brief (run 07:55 Lisbon) reported "YouTube feeds 404";
  its Off duty block dropped to one pick.
- **Same feeds minutes later:** `latest_uploads` from a Claude session at ~08:00 read
  40/40 channels and returned 15 videos since Nov 6. Nothing in the server changed in
  between.
- **Conclusion:** YouTube's `feeds/videos.xml` endpoint answers 404 intermittently for
  channels that exist, sometimes for all of them at once. The server did not log
  per-channel failures, so the number of channels affected that morning is unknown.
- **Change:** 404, 429 and 5xx feed answers are retried twice (0.5 s, then 1.5 s), and
  the error names the number of tries (`HTTP 404 (3 tries)`). Timeouts are not retried:
  three 8 s attempts would not fit `maxDuration = 30`. (commit 7ddbf09)

## 30-second timeouts on every call

- **Observed:** Vercel runtime logs for production showed `Vercel Runtime Timeout Error:
  Task timed out after 30 seconds` on `POST /api/mcp`, in pairs about every 30 s, even
  with no brief running (e.g. 14:31:00, 14:31:31/34, 14:32:03/05, 14:32:35/37 UTC on
  deployment dpl_94rPjUQTQYM72hhH4v2PDE3DiXPQ). Tool calls still returned results.
- **Local probe:** with protocol 2025-06-18 and 2025-11-25, every request (initialize,
  tools/list, subscriptions/listen) closed within milliseconds, and `subscriptions/listen`
  answered "Method not found". Requests with protocol 2026-07-28 need a per-request
  envelope the probe could not build, so the held stream could not be reproduced in tests.
- **Conclusion (inferred):** clients on protocol 2026-07-28 open a `subscriptions/listen`
  stream that mcp-handler holds until Vercel kills the function at `maxDuration`, and
  reconnect on close.
- **Change:** `maxSubscriptions: 0`, which makes the SDK refuse `subscriptions/listen`
  in-band (`-32603`, HTTP 200, before the ack). This server sends no notifications.
- **Verified on production:** deployment dpl_CMkVscyXx7DTXEr6FpEB3BREaGP7 (commit
  adac574) went live at about 14:31:30 UTC. A `latest_uploads` call at 14:32:55 read
  40/40 channels, and the runtime logs from 14:32:40 to 14:35:13 contain no entries at
  all (the old pattern would have logged about 10 timeouts in that window).
