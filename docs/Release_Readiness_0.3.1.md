# 0.3.1 polling and release readiness

Starting point: PR #1, `codex/product-roadmap`,
`9acbee13101fca0754b846d1977307866c89422b`; main remained
`3ad3eafbee3f43c41872104340166653795acece`. The checkout was clean, no applicable
AGENTS.md was present, and the unrelated `output/next-major-pass` worktree remained
unchanged. Published v0.3.0 and all four assets were rechecked unchanged; 0.3.1 was
unpublished. No branch protection, required independent approval or ruleset was
present. The five earlier review threads were outdated, with no fresh findings.

## Focused repair

The verification status effect consumed its single timeout when a GET failed.
Its catch updated only the error, so its `[projectId, run]` dependencies did not
schedule another request. Manual refresh remained available, but automatic status
could remain stale after the backend finished.

The repair keeps status reads separate from start mutations: bounded automatic
retries, cancellation and identity guards, terminal/permanent-error stopping, and
manual refresh all operate only on GET. A recovered status clears its transient
error; an unavailable observation is not a completed or failed execution. The
original unresolved-start receipt remains the only way to reconcile a lost start
response. Process completion remains separate from check outcomes and human review.

The shared API now carries the request's AbortSignal through token reconnection.
An obsolete status request cannot bootstrap/retry after cancellation or update the
token from a late bootstrap response. Existing one-time token reconnection retains
the original request body and mutation identity.

## Reproductions and checks

API cancellation tests first produced **2 failures, 2 passes** against the baseline,
then **4 passes** after repair:

```powershell
npm test --prefix frontend -- src/api.test.ts
```

The production browser reproduction used the existing `9acbee1` frontend build:

```powershell
Remove-Item Env:FLOWDESK_APP_ROOT -ErrorAction SilentlyContinue
node --test tests/browser.handoff.test.cjs
```

It failed waiting for the terminal observation after the backend had succeeded.
The transport record showed exactly one authorized start with its original
mutation ID and one status GET returning 503, with no subsequent automatic GET.
This browser uses an explicitly labelled deterministic runner fixture; its result
does not certify Docker isolation. The separate real Linux Docker gate does that.

The focused unit reproduction failed against the old effect; after repair,
`npm test --prefix frontend -- --run src/TaskHandoffPanel.test.tsx` passed all 38
cases. The full `npm test --prefix frontend` suite passed 363 tests in 37 files,
and `npm run build --prefix frontend` passed. Local tooling was CPython 3.14.3
and Node 24.14.0 on Windows.

The first local backend invocation encountered an existing access-denied pytest
temporary directory before fixtures ran. Those protected directories were left
untouched. The full rerun uses fresh task-owned temporary and cache directories:

```powershell
.venv/Scripts/python.exe -m pytest -q --basetemp=output/pytest-polling-release-20261014 -o cache_dir=output/pytest-polling-cache-20261014
```

The same production browser command then passed (1 test): its transport record
contained one start POST, the unchanged mutation ID, one 503 and subsequent 200
status responses for the same run. It observed the terminal result and cleared the
error without manual refresh. Exactly one backend run and command were retained;
restarting to view saved history did not execute again.

The matrix exercises transient failure, bounded retry, terminal/unmount/identity
stopping, manual response races and error clearing. Full supported CI includes backend/migrations,
frontend and production builds on Ubuntu/Windows, installed-wheel browser checks,
real Linux Docker with zero skips, and Windows portable spaces/Unicode smoke.
The full local, final PR and merged-main outcomes are recorded in the PR, with
the release gates also recorded in the release receipt;
no earlier green run certifies source changed afterward.

## Merge and distribution procedure

Merge uses the current reviewed PR head without bypassing repository rules.
The actual merged main SHA receives its own full checks run and frozen candidate.
Only its sealed bundle can be used for publication. Preparation first reconciles an
owned draft with `publish=false`; after inspecting its complete matching assets,
promotion uses `publish=true` with the same source and checks-run identity.

After publication, independently compare the public tag, notes, manifest and all
downloaded assets with that tested bundle. Run a disposable clean installation and
startup smoke using the published bytes, including the Windows portable runtime.
No user installation/data or paid provider is involved. A public release is claimed
only after these read-only inspections and smokes succeed.

All five prior safety repairs and six workflows remain in scope. There is no new
database migration or authority grant. Old evidence is not upgraded, and the
documented paused-v1-run/unbound-handoff recovery rules remain. The brief has one
stable requirement paragraph, file references remain revision-bound, and handoff
returns still refer to already-local commits. Any non-blocking polish is deferred.

## Observed release transport repair

PR #1 merged after final-head and integration gates passed. Its actual main commit,
`7bd8d5ea3ec9803883853e44024ceb6e5e41fc27`, independently passed checks run
`38571554348`, attempt 1, including both platform suites, 105 installed-wheel
browser cases per platform, portable smoke and 19 real Docker cases with zero
skips. Draft preparation run `38574521156` then failed before any tag or release
was created: GitHub returned HTTP 415 for the Actions artifact archive request.

The transport had coupled binary response handling to an `application/octet-stream`
Accept header. The Actions archive endpoint negotiates its redirect with
`application/vnd.github+json`; release assets use `application/octet-stream`.
The focused publisher correction separates those endpoint contracts while retaining
binary payload handling, bounded downloads, HTTPS redirects without credentials,
and all exact-source/artifact/ownership checks. Transport regressions cover the
distinction; the recorded live preparation failure is separate from fake-API tests.

A read-only live probe using the repaired HTTP adapter downloaded the earlier
candidate archive `11897828164`, sealed archive `11898771881` and public 0.3.0
wheel asset `639933747`. All three complete payloads matched the API sizes and
SHA-256 digests. It performed GET requests only; no release was prepared or
published by that probe. This validates real content negotiation, not new-source
release certification.

The original publisher tests passed 46 cases; the added preparation regression
then failed against the original transport with the same HTTP 415. After repair,
the publisher and receipt suites passed all 74 cases on local CPython 3.14.3:

```powershell
.venv/Scripts/python -m pytest -q tests/test_publish_release.py tests/test_release_receipt.py --basetemp output/pytest-publisher-accept-full-20261014 -p no:cacheprovider
```

The added coverage exercises first preparation and matching retry through the real
HTTP adapter with a fake server, release-asset fallback without an API digest,
credential-free redirects, rejection of HTTP redirects and bounded direct/redirected
payloads. Existing identity, interruption and publication refusal assertions remain.

This change requires its own reviewed head, integration gates and fresh merged-main
candidate. The successful earlier main run and its sealed artifact `11898771881`
remain historical evidence and cannot certify the changed source or release notes.
The final PR/release receipt records the subsequent source, checks and publication
outcome; version 0.3.1 remains available only while unpublished.
