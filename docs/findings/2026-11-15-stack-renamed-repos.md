# 2026-11-15: React and Prisma releases skipped because both repos were renamed

## Symptom

Vercel production runtime log, 2026-11-15T16:58:55Z, deployment
`dpl_GDCDNdD4W8RVgWHRMWZyGi8pTLCJ`:

```
stack: 2/11 failed (prisma/prisma: 10 of 10 entr(y/ies) had no link into this
repo's releases and were skipped ×1, facebook/react: 10 of 10 entr(y/ies) had
no link into this repo's releases and were skipped ×1)
```

The other eight repo feeds and the OSV call were fine. The tool still printed
"10/10 repos read" because a skipped entry was not counted as a failed repo,
and the Daily brief marked Stack news "ok". React and Prisma releases were
missing without anything saying so.

## Cause (observed with curl from CachyOS, 2026-11-15)

Both repos were renamed on GitHub, and GitHub redirects the old feed URLs:

| `STACK` entry | `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}'` |
|---|---|
| `facebook/react` | `301 https://github.com/react/react/releases.atom` |
| `prisma/prisma` | `301 https://github.com/prisma/orm/releases.atom` |
| the other eight | `200` |

`fetch` follows the redirect, so the call succeeds, but every link in the
feed names the new repo. The feed head from `facebook/react`:

```
<id>tag:github.com,2008:https://github.com/react/react/releases</id>
<link type="text/html" rel="alternate" href="https://github.com/react/react/releases"/>
...
<link rel="alternate" type="text/html" href="https://github.com/react/react/releases/tag/v19.3.1"/>
```

`parseReleases` keeps only entries whose link starts with
`https://github.com/<STACK repo>/releases/tag/`. That guard keeps a feed from
pointing the output at another repo. So all 10 entries counted as `badLinks`.
The feeds themselves are well-formed. The parser did what it was written to do.

## Fix (branch `fix/stack-renamed-repos`)

- `STACK` now uses `react/react` and `prisma/orm`.
- `parseReleases` reads the repo the feed names in its own
  `<link rel="alternate" href="https://github.com/<owner>/<name>/releases">`.
  When that is a different, well-formed `owner/name`, it returns it as
  `movedTo`. The entry-link guard is unchanged.
- `stackReport` reports a moved feed as `N of N entr(y/ies) skipped: the feed
  now belongs to <owner/name> (repo renamed or moved); update STACK`. It also
  counts any feed where every entry was skipped as a failed repo, so the
  heading shows "9/10 repos read" instead of "10/10". `isError` is still set
  only when all repos fail.
- The test fixture is the real head and first entry of the `facebook/react`
  feed as fetched on 2026-11-15.

## Live check after the fix (2026-11-15, real GitHub and OSV, `since` 2026-10-01)

`stackReport` run from a scratch vitest file with the real `fetch`:

- `failedRepos 0`, heading `(10/10 repos read)`.
- React: 19.3.1, 19.2.9, 19.1.10 and 19.0.9 (all 2026-10-14) are now listed
  with `https://github.com/react/react/releases/tag/...` URLs.
- `parseReleases` on the old names' feeds returned
  `{"entries":10,"badLinks":10,"movedTo":"react/react"}` and
  `{"entries":10,"badLinks":10,"movedTo":"prisma/orm"}`.

## Also learned: Prisma's feed holds only prereleases

The `prisma/orm` feed's 10 entries, 2026-11-06 to 2026-11-13, are all
prereleases: `8.1.0-dev.10` to `8.1.0-dev.12` and `v8.0.0-rc.23` with
`v8.0.0-rc.23-dev.2` to `-dev.7`. Note the mixed tag styles: some have a `v`,
some don't. So even under the right name, no stable Prisma release appears,
and the run prints `! prisma/orm: feed holds only the latest 10 releases, all
newer than ...`. Next.js has the same problem with its canaries. The feed has
no way to page back. Reading stable Prisma releases would need another source,
such as the GitHub REST releases API or the npm registry. Not done here.
