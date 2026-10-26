# Current-source validation — 26 October 2026

This audit uses Windows, Python 3.14.3, Node 24.14.0 and npm 11.9.0. The portable candidate bundles its pinned Python 3.14.7 runtime. All databases, execution repositories and browser data used here are disposable. No paid provider calls were made. No user's normal PlanBranch data directory was opened.

Source identification: baseline `60fc36b4f8a0f0d14e2c5137b77f05e9f5d8d665` plus the feature-branch changes identified in [source-manifest.json](evidence/source-manifest.json). The fixture receipt separately fingerprints its inputs before and after execution. The local wheel and portable package are validation candidates with unchanged package version, not new release artifacts.

## Local results

| Check | Recorded result | Scope |
| --- | --- | --- |
| Frontend suite after both fixes | **366 passed**, 37 files | 187.93 seconds; includes three new slow-poll/selection/cancellation regressions. |
| TypeScript and production build | **Passed** | Final main asset `index-K7Yc3ku9.js`; existing >500 kB chunk warning retained. |
| New backend readiness race tests | **4 passed** | 52.60 seconds; three denied-launch cases and a harmless-edit control. |
| Migration compatibility and onboarding | **19 passed** | 10.82 seconds on final backend source; initial/brief/build/execution migration fixtures and authority-free onboarding. |
| Evaluation instrument tests | **5 passed** | 78.67 seconds; negative candidates, authority-free import and changed-source receipt rejection. |
| Final-source evaluation CLI | **Passed** | 32/32 boundary observations. Candidate criteria: 3/3, 3/3 with an unwanted file, and 2/3 for interrupted work. |
| Genuine offline UI capture | **Passed** | One capture scenario, four screenshots; no model generation, repository or execution record. |
| Final-source wheel and offline portable builds | **Passed** | Separate audit candidates; existing `dist/` untouched. |
| Focused final installed-wheel browser checks | **5 passed**, 0 failed/skipped | 511.42 seconds; complete execution/review/application, cancellation/restart, failed checks/stale approval, offline walkthrough and alternatives. |
| Local broad backend and installed-wheel browser suites | **Incomplete / not passing** | Storage exhaustion interrupted validation; completed remote CI results are recorded separately below. |
| Final portable smoke | **Passed** | Rebuilt candidate includes the polling repair; bundled imports, launch/restart, durable history, scanner, backup and worker cancellation checked. |
| Local live Docker isolation/immutable verification | **Not run** | Daemon probe timed out; execution image unset. |

Logs are retained locally under ignored `output/portfolio-audit/`; sanitized [check results](evidence/validation.json), [source identity](evidence/source-manifest.json) and [artifact preservation](evidence/preservation.json) are public. No aggregate pass is inferred from an incomplete log or from a shell wrapper's exit status when its output could not be written.

## Remote CI results

The [completed push check run](https://github.com/AdrianIp0204/PlanBranch/actions/runs/40305680461) passed every job on commit `77a9678f89aec4232bb28af3025dfc8fd8cecd14`, Git tree `2ad66c571713cb7928b61bd2e7f2170d6e26499e`. The parallel PR integration commit `5caf5b8da2b263f4410ee757aee4aaa374737d72` has the same tree; this equality was checked directly. The [CI receipt](evidence/ci-validation.json) records job identities and actual outcomes separately from the local attempts. The final follow-up changes only portfolio documentation/evidence; application, tests, fixtures and build source remain those of the tested commit.

| CI gate | Observed result |
| --- | --- |
| Build | Production frontend, wheel and Windows portable candidate built successfully. |
| Linux | 889 backend tests passed, 22 skipped; 366 frontend tests passed; 105 installed-wheel browser tests passed with no failures or skips. Candidate integrity checked before and after testing. |
| Live Docker | 19 passed, zero failures/skips, in 17.76 seconds. Actual container isolation and immutable-verification tests ran on Linux. |
| Windows | 884 backend tests passed, 27 skipped; 366 frontend tests passed; 105 installed-wheel browser tests passed with no failures or skips. Standalone portable smoke and candidate integrity checks passed. |
| Final candidate seal | Passed after build, both platform jobs and Docker completed. The tested candidate remains a CI artifact, not a published release. |

Linux's 22 skips are consistent with the configured 19 opt-in Docker cases and three Windows-only cases. Windows's 27 skips include 19 Docker and five POSIX cases statically gated in source; the quiet CI log does not name the three additional environment-dependent skips individually. The Docker cases ran in the separate required job. Skips are reported, not counted as passes, and overlapping platform counts are not summed. These observations do not erase the earlier local failures, and no CI artifact was published as a release.

## Environment failures retained in the record

- The first broad backend attempt was interrupted after concurrent test work filled C:. Its partial output contains failures/errors and is not a passing run.
- A subsequent broad backend attempt reached disk exhaustion again and could not finish its JUnit report (38 bytes, invalid/incomplete). It has no trustworthy aggregate result and is not a passed suite.
- The first installed-wheel browser attempt recorded **84 passed, 12 failed** across 96 tests. It ran before the polling repair and while the disk filled. The execution-dialog failure exposed the reproduced source defect; other failures include explicit `ENOSPC` and timeouts under resource exhaustion. They are not silently relabelled as passes or all assumed to share one cause. Final-source reruns determine their current status.
- A final-source broad retry was stopped when the drive filled again after several GB had become available. Its partial backend/browser logs are not aggregate results. The audit output folder itself measured approximately 113 MB; the cause of the wider space fluctuation was not established. Focused final-source checks and package smoke results remain separate observations.
- The first readiness-race run intentionally reproduced the defect: **3 failed, 1 passed**. The initial repaired-source rerun encountered **1 passed, 3 setup errors** from disk exhaustion. A later focused rerun passed **4/4 in 52.60 seconds**.
- The first evaluation attempt failed with `sqlite3.OperationalError: database or disk is full` and produced no usable result receipt. Later completed fixture results are separately identified.
- Existing `.pytest_cache` permissions prevented cache writes. Subsequent backend runs use `-p no:cacheprovider`; this disables optional caching, not test collection or assertions. `tmp_path_retention_policy=failed` limits storage for successful new test fixtures.
- Git rejected the checkout's different owner. Commands use a per-invocation `-c safe.directory=<absolute-checkout>` exception scoped to this known workspace. Global Git trust configuration was not changed.
- Some historical local release artifacts and the old packaged static folder were unreadable. They were not modified. Packaging instead copied current tracked runtime source and fresh frontend assets into a new directory under ignored `output/portfolio-audit/`.
- Automatic approval review rejected cleanup of this audit's completed temporary pytest directories and a narrower completed portable-smoke scratch folder with “blocked by policy”. Those directories were left in place. The user subsequently freed disk space, allowing final-source validation to resume; existing user files were not deleted by the audit.

## Reproduction

Use the locked source environment described in the [README](../../README.md). The standard source checks are:

```powershell
.\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider --tb=short -o tmp_path_retention_policy=failed
npm test --prefix frontend
npm run build --prefix frontend
node --test scripts/capture_portfolio.cjs
.\.venv\Scripts\python.exe scripts/portfolio_evaluation.py --output output/portfolio-evaluation.json
```

For packaged browser checks, install a candidate wheel with `pip --no-index --no-deps --target` into a **new** folder, set `FLOWDESK_APP_ROOT` to that absolute folder, and run `npm run test:e2e --prefix frontend`. The test harness selects disposable ports and stores, blocks external browser requests and records runtime errors. On Windows it can use installed Edge when Playwright Chromium is absent. No browser installation was needed for this audit.

For portable checks, supply an explicit new output location to `scripts/build_windows_portable.py`, an explicit candidate `--wheel`, and `--offline` to reuse the pinned hash-checked cache. Run `scripts/smoke_windows_portable.py` against that candidate with another new output directory. Do not overwrite the repository's existing `dist/` for portfolio validation. The audited wheel build used a separate source staging directory so inaccessible historical assets were not replaced.

## Preservation and limits

No database schema, migration, import version, provider consent policy, sandbox policy, automatic execution mode or release workflow was changed. Existing user databases were not opened or migrated by the audit. Compatibility evidence concerns disposable historical-schema fixtures and package restart/backup checks; it does not claim to examine private saved projects.

Live Docker isolation was unavailable locally: `docker info` timed out after 15 seconds and `PLANBRANCH_EXECUTION_IMAGE` was unset. The separate remote CI job subsequently ran all 19 live cases successfully; deterministic fixtures do not substitute for them. No real model execution, paid model calls, human review-time observation, multi-user study or new accessibility certification is claimed here. Linux observations come from CI, not the local Windows host.

The public v0.3.1 release and its asset digests are compared without publishing or editing a release. Readable pre-existing local `dist/` files are also hash-compared; unreadable historical files are outside byte-verification coverage. The package smoke and browser checks use newly built audit candidates only. See the [evidence register](EVIDENCE_REGISTER.md) for claim-level limits.
