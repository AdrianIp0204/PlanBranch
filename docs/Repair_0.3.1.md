# 0.3.1 correctness follow-up

Baseline: `2f42d24703c21ac1e88cec23247df8cc0117fbae`, PR #1,
`codex/product-roadmap`. The checkout was clean and no repository/ancestor
AGENTS.md was present. The five open automated findings match the supplied
review notes. Those notes are evidence, not additional authorization.

The existing v0.3.0 tag, published release and four assets are immutable for
this work. The other `output/next-major-pass` worktree is outside this repair.
Merge and publication remain for review.

## Baseline and repair plan

The baseline's exact-SHA push checks (38541803708) passed on supported Python
3.14 on Linux and Windows. They did not establish immutable source verification.
Focused regressions reproduce the review gaps before the corresponding repair.
Local environment: Windows, Python 3.14.3 in `.venv`, Node 24.14.0.

1. Split writable coding commands from immutable verification. Authenticate
   host evidence and retain legacy records without upgrading their guarantee.
   Exercise the mount guarantee in live Linux Docker CI.
2. Freeze and explain the handoff repository selection, preserve planning-only
   exports, and expose a candidate-bound verification-only route.
3. Share read-only prerequisite readiness between summary and execution, with
   stable reasons and corrective actions. Retain authoritative start checks.
4. Share versioned meaning-bearing fields between approval and comparison;
   show readable entity/field changes.
5. Reconcile workflow-owned release drafts using exact tested artifacts and
   digests. Prepare 0.3.1 without changing published 0.3.0 or publishing 0.3.1.

Validation is recorded below. The final release candidate is identified by its
exact-SHA CI run and sealed receipt, never by a test result from an earlier commit.

## Reproduced baseline failures

- A real filesystem/process probe rewrote `VALUE = 1` to `VALUE = 999`, checked
  999 and restored 1. End hashes matched and v1 returned `observed_check_passed`.
  The new regression failed as expected: **1 failed, 28 passed**, running
  `.venv/Scripts/python.exe -m pytest -q tests/test_immutable_evidence.py
  tests/test_workflow_evidence.py tests/test_release_receipt.py
  --basetemp=output/repair-baseline-2 -p no:cacheprovider`. This is a classifier
  reproduction, not a Docker guarantee.
- `tests/test_readiness_semantics.py` initially produced **4 failures**:
  blocker-only and project-name-only comparison omissions, inconsistent unordered
  comparison, and manually completed prerequisite summary/preview disagreement.
  The repaired focused matrix subsequently passed **15 tests**.
- Handoff baseline probes failed for scanner shadowing execution selection,
  non-Git scanner export, scanner subdirectory export and changed selection after
  export. Repository-binding regressions repair those cases.
- Release source inspection confirmed rebuild-after-checks, hardcoded 0.3.0
  paths, refusal of matching unfinished state and API errors treated as absence.
  No destructive live reproduction was attempted against a published release.

The initial baseline command named nonexistent `tests/test_plan_handoffs.py` and
ran no tests; the corrected command above is the recorded baseline result.

## Compatibility and boundaries

Database migrations 11–12 and existing checkpoints are unchanged. Evidence v1
remains history with an explicit writable-observation label. New identities include
all candidate files except Git metadata; prior acceptance may need fresh review
when an old excluded cache/output file is present. The v2 coding prompt requires a
fresh preview for paused v1 native coding runs, preserving their retained work and
no-replay protection. Handoffs without repository-selection binding remain readable
history and require a new export before import or local verification.

The stable brief requirement paragraph, revision-bound file references and
already-local commit handoff return remain the scope. There are no paid model
calls, telemetry, automatic user-repository commits or merged approval/execution/
review/application authorities in these repairs.

## Finding resolutions and regression references

| Review finding | Repair | Regression evidence |
| --- | --- | --- |
| Writable commands could masquerade as source-bound checks | `command_runner.py` separates mutable coding from a read-only Docker candidate mount; `check_evidence.py` authenticates host-owned v2 observations; `execution.py` rejects forged provenance and binds imported-candidate verification through start. Writable caches, temporary files and artifacts have separate bounded mounts. Exit status alone does not establish a passing test or requirement coverage. | `test_immutable_evidence.py`, `test_immutable_verification_live.py`, `test_external_verification.py`, `test_model_executor.py`, `browser.handoff.test.cjs` |
| Scanner context displaced the handoff repository | `task_handoff.py` freezes explicit execution selection and its repository identity. Non-Git or missing scanner roots retain planning-only export; scanner subdirectories never expand to parent repositories. Broken selected repositories, corrupt Git markers and access failures remain actionable errors. | `test_task_handoff.py` covers no attachment, unrelated/two valid repositories, dirty/missing/corrupt sources, permission failures, subdirectories and changed selections. |
| Summary and execution disagreed about prerequisites | `prerequisites.py` is the shared read-only evaluator used by `traceability.py` and `execution.py`. Stable reason codes, task/run references and corrective actions explain missing review/application/commit or stale intent. Execution start still rechecks authority. | `test_readiness_semantics.py`, `TaskWorkflowSummary.test.tsx`, `TracePanel.test.tsx`, `browser.readiness.test.cjs` |
| Approval-affecting edits were invisible in comparison | `semantic_intent.py` now supplies comparison sections from the same versioned semantic scope as approval. Project name and blocker remain semantic under existing v1 rules; no approval scope migration or implicit reauthorization is needed. `PlanLibrary.tsx` shows entity/field differences, current-entity navigation and optional raw data. | Approval-change invariants and excluded progress/layout cases in `test_readiness_semantics.py`; `PlanLibrary.test.tsx` and `browser.readiness.test.cjs`. |
| Release retries could strand tags/assets and certify rebuilt packages | `release_receipt.py`, `publish_release.py` and both workflows build once, test those bytes, then seal a version-derived bundle. Preparation reconciles only an owned matching draft, verifies exact tags/assets, distinguishes true 404 from API failures, serializes attempts and refuses published releases. | `test_publish_release.py`, `test_release_receipt.py`: first preparation, retry/promotion, partial upload/lost acknowledgement, mismatches, unrelated/published states, concurrency, API/transport errors and patch versions. |

## Executed validation and final release procedure

Local supported environment is Windows with Python 3.14.3 and Node 24.14.0.
The combined focused command below passed **102 tests**, with **12 live-container
cases skipped** because this machine has no available Linux Docker daemon:

```powershell
.venv/Scripts/python.exe -m pytest -q tests/test_immutable_evidence.py tests/test_immutable_verification_live.py tests/test_workflow_evidence.py tests/test_model_executor.py tests/test_readiness_semantics.py tests/test_execution.py --basetemp=output/repair-focus-2 -p no:cacheprovider
```

The complete local frontend suite passed **329 tests across 37 files** using
`npm test --prefix frontend` (90.69 seconds, log `output/repair-frontend-final.log`).
An earlier full local integration attempt completed with 787 passed, 30 skipped
and three failures while the repairs were changing. Those failures concerned the
stricter included-output identity, a partial-service prerequisite fixture, and a
test double incorrectly labelled as immutable evidence. After repair, an explicit
rerun of all three passed (65.69 seconds):

```powershell
.venv/Scripts/python.exe -m pytest -q tests/test_authority_audit.py::test_ignored_source_drift_requires_fresh_candidate_review_for_all_actions tests/test_authority_audit.py::test_reapproved_scope_and_restored_plan_do_not_reactivate_applied_history tests/test_external_verification.py::test_external_verification_runs_one_selected_check_and_preserves_external_authority --basetemp=output/repair-final-previous-failures -p no:cacheprovider
```

The final complete suites run again on CI from a clean committed source tree.
Release receipt/publisher regressions passed 60 cases plus six HTTP adapter cases.
The exact local commands were:

```powershell
.venv/Scripts/python -m pytest -q tests/test_release_receipt.py tests/test_publish_release.py -p no:cacheprovider --basetemp=output/release-tests-final
.venv/Scripts/python -m pytest -q tests/test_publish_release.py -k 'http_adapter or artifact_redirect' -p no:cacheprovider --basetemp=output/release-transport-final
.venv/Scripts/python -m pytest -q tests/test_publish_release.py -k 'first_preparation or matching_retry or concurrent_matching or http_adapter or artifact_redirect' -p no:cacheprovider --basetemp=output/release-final-promotion
```

The last overlapping confirmation passed 11 cases; it is not counted as 11 new
tests. The first run collected before the six transport cases were added.
The scanner error-handling follow-up passed ten focused cases. The comparison
navigation follow-up passed eight component tests, TypeScript and the production
build. These commands exercised the current production UI without paid providers:

```powershell
npm test --prefix frontend -- src/PlanLibrary.test.tsx
npx --prefix frontend tsc -b frontend/tsconfig.json
npm run build --prefix frontend
node --test --test-concurrency=1 tests/browser.readiness.test.cjs
node --test --test-concurrency=1 tests/browser.handoff.test.cjs
```

The two readiness/comparison browser cases and one external-handoff browser case
passed with no skips. The comparison browser exercised the raw-data disclosure and
current-node navigation without creating an execution. Production build retains the
existing bundle-size advisory.

The final evidence audit also reproduced a command-history collision: two valid
200-character native tool IDs were truncated after the invocation prefix, allowing
the later result to replace an earlier failure. Ingestion now preserves bounded
full IDs and rejects invalid IDs instead of truncating them. The regression runs
the actual native tool loop with signed streaming/final fixture events and keeps
both observations, without claiming that its fixture is real Docker evidence.

A final scenario audit added explicit coverage for two simultaneously selected
valid repositories, rejected/interrupted prerequisite results, dependency list
edits and task node/file-reference changes. The two-repository service regression
passed and the complete readiness/semantic matrix passed **29 cases**. Its card
checks also reject any provider status/configuration probe. Reordering unordered
dependencies/references retains approval and comparison equivalence; meaning
changes invalidate the corresponding task approval and produce readable fields.

```powershell
.venv/Scripts/python.exe -m pytest -q tests/test_readiness_semantics.py -p no:cacheprovider --basetemp output/pytest-readiness-explicit-final
.venv/Scripts/python.exe -m pytest -q tests/test_readiness_semantics.py -k file_reference_removed -p no:cacheprovider --basetemp output/pytest-readiness-file-reference-final
```

The second command confirms the actual filename-removal case (1 passed, 28
deselected) after tightening that fixture.

Initial pushed repair commit `85d9e1a727f0b7d39b0de438d5fbbe8480cde04a`
ran real Docker regressions in push run `38553478270` and PR run `38553485382`:
**18 passed, zero skipped** in each. This is actual Linux container evidence, not
a mocked command-string claim. Additional transient-restore/image-drift cases and
the final follow-ups require a new complete run at the final commit.

The final `PlanBranch checks` run executes:

```text
python -m pytest -q                                  # Ubuntu and Windows; includes migrations
npm test                                            # complete frontend suite on both
npm run build                                       # production frontend on both
python -m pip install --no-deps --no-index --target output/wheel-ci <frozen wheel>
npm run test:e2e                                     # complete browser suite against that installed wheel
python scripts/smoke_windows_portable.py <frozen portable ZIP> --output-dir output/portable-smoke
PLANBRANCH_TEST_DOCKER=1 PLANBRANCH_EXECUTION_IMAGE=planbranch-ci-execution:local python -m pytest -q tests/test_command_runner_live.py tests/test_immutable_verification_live.py --junitxml=output/docker-gate.xml
```

The Docker job explicitly provisions its CI-only image, requires zero skipped
cases, and uploads JUnit evidence. The seal job depends on both platform jobs and
Docker. It records the exact source SHA, checks run/attempt, immutable build
artifact ID and hashes of the same wheel/ZIP tested. A later rebuild cannot reuse
that identity. The final PR validation record and downloaded `release-manifest.json`
provide final run outcomes and artifact identities; earlier runs are history only.

This follow-up does not dispatch publication or modify any release/tag. Draft
preparation/promotion recovery is tested through the real HTTP adapter and a
deterministic API fixture; live GitHub publication remains deliberately unexecuted.
An incomplete GitHub upload whose bytes cannot be proven is preserved for explicit
inspection rather than deleted or overwritten automatically. Real paid-provider
integration is outside these gates; deterministic provider fixtures exercise the
application workflow without external billing.
