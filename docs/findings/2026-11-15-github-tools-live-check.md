# 2026-11-15: GitHub tools, first live check

Branch `feat/github-tools` (pull request 1), local dev server (`npm run dev`,
port 3107) with `GITHUB_TOKEN` and `GH_REPOS` in `.env.local`, called over
JSON-RPC like the connector does. `GH_REPOS`: bobrquiz, bedtime-bloopers,
money-manager, claude-config, youtube-mcp (bedtime-bloopers and claude-config
are private). Not yet run on Vercel.

## Results, final token

- `github_activity` (default window, last 24 h): **5/5 repos read in 6.1 s**,
  no `!` part failures. Earlier runs on the same day took 5.5–6.2 s.
  Counts matched `gh`: bobrquiz 31 open issues, money-manager 10.
- `github_file` on claude-config `PRIORITIES.md` and `TASTE.md`: 0.34 s and
  0.30 s, 2056 and 4468 characters (GitHub's `size`: 2058 and 4475 bytes; the
  gap is multi-byte characters).
- `installed_versions`: 0.84 s, 3/3 npm repos; bedtime-bloopers and
  claude-config correctly reported as "not npm projects". money-manager's
  versions come from `yarn.lock` (next 15.5.29, matching the file).
- The token appeared in no tool response and no dev-server log line.

## What GitHub actually does (each observed, not inferred)

- **A fine-grained token needs Contents: read for commits, branches and files
  of a private repo.** Without it those calls answered 403, and the response
  header `x-accepted-github-permissions: contents=read` named the missing
  permission. Without access to the repo at all, every call answered 404.
- **Check runs on a private repo need `checks=read`.** With Actions, Commit
  statuses, Contents, Dependabot alerts, Issues, Pull requests and Metadata
  set, `commits/{sha}/check-runs` still answered 403 "Resource not accessible
  by personal access token", header `x-accepted-github-permissions:
  checks=read`. The same call on a public repo answered 200. Commit statuses
  and workflow runs answered 200 on both private repos. Effect: on a private
  repo, a pull request's CI comes from commit statuses only, and the activity
  report shows `! checks: no access (HTTP 403)`. Neither private repo had an
  open pull request today, so this did not show in the run. Whether the
  fine-grained token page offers a Checks permission is not yet known.
- **"Dependabot alerts are disabled for this repository."** is a 403 with that
  message when alerts are off in the repo's settings (youtube-mcp,
  bedtime-bloopers, claude-config). It is not a missing permission; the tool
  now says "off in this repo's settings".
- **Vercel reports through commit statuses, not check runs**: money-manager
  pull request 21 showed `CI failing ("quality", "Vercel")` only once statuses
  were read. A commit with no statuses still answers `state: "pending"`.
- **GraphQL `refs(orderBy: TAG_COMMIT_DATE)` does not sort branches** by their
  last commit; the tool sorts locally after fetching up to 100.
- **Aliased GraphQL `compare` counts match REST `compare`**, and a missing
  branch gives partial data plus an error rather than failing the query.
  Large counts are real: bedtime-bloopers `milestone-1` is 1105 ahead / 0
  behind `main` (same in REST compare), since work merges there, not to main.
- **The contents API with `?ref=refs/heads/<sha>` answers "No commit found"**,
  so qualifying the ref (heads, then tags) is what stops a commit SHA from
  reaching a fork's or a pull request's files.
- **Raw content types**: with `Accept: application/vnd.github.raw+json`, a
  file answers `application/vnd.github.raw+json` and a directory answers
  `application/json` (a listing), which is how the tool tells them apart.
- **`actions/runs?branch=…&exclude_pull_requests=true` still returns runs
  started by pull requests**; the tool keeps only push, schedule,
  workflow_dispatch and merge_group runs from the repo itself (`event` and
  `head_repository`).

## Token mix-ups on the way

1. A classic token (`ghp_…`, scopes including `repo`, `delete_repo`,
   `workflow`) was put in first. Not used: replaced by a fine-grained one.
2. The first fine-grained token had no access to the private repos (404) and
   no Dependabot alerts permission (403 on bobrquiz and money-manager).
3. After it was edited, the private repos still answered 403 (no Contents).
4. A new fine-grained token with the permissions above read everything except
   private check runs. GitHub sent no `github-authentication-token-expiration`
   header for it.

## Still open

- Checks permission for the private repos (see above).
- The tools have not been called on Vercel; that needs `GITHUB_TOKEN` and
  `GH_REPOS` in Production and the merge.
