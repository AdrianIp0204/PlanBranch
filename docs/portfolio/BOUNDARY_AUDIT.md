# Execution and evidence boundary audit

Audit date: 26 October 2026. Starting source: `60fc36b` (v0.3.1 development checkout). This is a representative source review and deterministic regression investigation, not a penetration-test certificate or a measurement of model safety. Final-source suite results belong in [EVIDENCE_REGISTER.md](EVIDENCE_REGISTER.md).

The central separation is implemented in backend services, not just button labels: semantic plan approval, explicit repository selection, frozen execution preview, run authorization, captured changes, evidence classification, human acceptance, task completion and checkout application have different records and checks. No release, user database or saved workflow was modified by this boundary review.

## Findings, ordered by priority

### BND-01 — Medium: progress changes during worktree preparation were not rechecked (fixed)

**Location:** [`ExecutionService._worker`](../../flowdesk/execution.py#L493), especially the pre-launch checks at lines 515–533; [`semantic_scope`](../../flowdesk/semantic_intent.py#L36). The previous worker rechecked `_plan_current`, `_grant_matches` and `_source_current`, but omitted task progress and prerequisite readiness. Progress is intentionally excluded from semantic intent: moving a task to `blocked` or reopening a completed prerequisite does not itself revoke a meaningful plan approval.

**Reproduction:** create an approved task and ready Run preview; change its progress while the isolated worktree is being prepared. Before this fix, both `blocked` and `done` target states still reached the fixture executor. A dependent task also launched after its previously accepted, applied and committed prerequisite was reopened during preparation. The source revision and semantic approval remained unchanged. This is a timing gap in a previously authorized task, not evidence of arbitrary execution or an import granting permission.

**Repair:** immediately before executor launch, read approval, repository selection, current task status and prerequisite readiness in one SQLite read transaction. Refuse launch for a blocked task, a completed editing task, or an unmet prerequisite; retain the prepared worktree for inspection. Immutable verification may still inspect a completed task. The same worker guard applies to continued question runs. Approval fingerprints, accepted artifacts, persistent schemas and migration formats remain unchanged.

**Regression:** [`test_execution_readiness_races.py`](../../tests/test_execution_readiness_races.py) uses real disposable Git repositories and the deterministic executor already used by the repository. The baseline run recorded **3 failed, 1 passed**: all three negative scenarios incorrectly executed; a layout change combined with `in_progress` correctly remained permitted. The control prevents fixing the gap by indiscriminately invalidating all progress or layout changes. This does not lock the project for the whole agent run: users can still edit intent after launch, and later review/application checks must detect staleness.

**Final focused result:** **4 passed in 52.60 seconds** on the repaired source, Windows/Python 3.14.3, 26 October 2026. An earlier post-fix attempt recorded **1 passed, 3 setup errors** when the host disk became full (SQLite full/I/O errors and failed Git initialization); it was not treated as a source regression or a pass. The final rerun used a separate disposable test directory and short tracebacks. This result certifies these four regression scenarios only; the final evidence register records broader checks separately.

### BND-02 — Validation limitation: runtime enforcement requires the actual runtime

**Locations:** [`DockerCommandRunner`](../../flowdesk/command_runner.py#L66), [`executor_process.py`](../../flowdesk/executor_process.py), [`test_command_runner_live.py`](../../tests/test_command_runner_live.py), [`test_immutable_verification_live.py`](../../tests/test_immutable_verification_live.py).

Source configures no network, no image pull, read-only container root, bounded temporary mounts and resource limits. Immutable verification mounts candidate source read-only and writes artifacts separately; Docker executes model commands as user `65534:65534`. Mocked runner tests and connection discovery do not prove the installed OS/Docker/Codex runtime enforces those restrictions. Report live-runtime tests as passed only when they actually run; retain skipped/unavailable results. This audit did not install a runtime, pull an image or run a paid model.

### BND-03 — Product limitation: evidence remains narrower than requirement correctness

**Locations:** [`observation_state`](../../flowdesk/check_evidence.py#L106), [`TraceabilityService.state`](../../flowdesk/traceability.py#L91), [`requirement_record`](../../flowdesk/traceability.py#L17).

Candidate hashes identify bytes; local seals identify host-created command envelopes; JUnit artifacts describe what a command reported. None establishes the quality of the tests or proves the full natural-language requirement. The requirements paragraph is represented as one stable requirement record, and mappings to criteria are human-confirmed. A reviewer can explicitly accept a result even when checks are missing or failed. Describe that as human authority with visible evidence, not an automatic correctness gate. A future evaluation needs independent acceptance tests and reviewers.

## Representative implemented controls

The following are source-backed controls with existing regression coverage, not claims that every possible attack has been tested.

| Boundary | Implementation and representative tests | Important qualification |
| --- | --- | --- |
| Local browser → backend | [`app.py:29–65`](../../flowdesk/app.py#L29): loopback trusted hosts, same-origin/fetch-site checks, per-server header token and response CSP; [`test_local_request_boundary`](../../tests/test_api_exports.py#L28) | Designed for a local desktop user, not multi-user network deployment. |
| Intent → approval | [`semantic_intent.py`](../../flowdesk/semantic_intent.py), [`test_readiness_semantics.py`](../../tests/test_readiness_semantics.py) | Meaning-bearing changes stale relevant scopes; progress and layout intentionally do not. |
| Approved intent → run | [`execution.py:212–355`](../../flowdesk/execution.py#L212), [`test_execution.py`](../../tests/test_execution.py), new readiness race tests | Source, repository, approval and explicit confirmation are separately checked. A scanner attachment is not an execution grant. |
| Repository/worktree → files | [`execution_git.py`](../../flowdesk/execution_git.py), [`workspace_tools.py`](../../flowdesk/workspace_tools.py), [`test_execution_git.py`](../../tests/test_execution_git.py) | Bounded snapshots; traversal, symlink/junction, submodule and hard-link restrictions. Worktrees isolate changes but are not themselves an OS sandbox. |
| Agent output → evidence | [`check_evidence.py:64–131`](../../flowdesk/check_evidence.py#L64), [`execution.py:450–491`](../../flowdesk/execution.py#L450), [`test_immutable_evidence.py`](../../tests/test_immutable_evidence.py), [`test_authority_audit.py`](../../tests/test_authority_audit.py) | Unsigned provider statements cannot manufacture host provenance; legacy writable observations cannot certify immutable verification. |
| Import → local project | [`exports.py:120–209`](../../flowdesk/exports.py#L120), [`test_api_exports.py`](../../tests/test_api_exports.py), [`test_portable_limits.py`](../../tests/test_portable_limits.py) | Allowlisted portable data is validated before atomic creation, IDs are remapped and detected symbols become historical. Manual progress is not trusted prerequisite evidence. |
| Checkpoint → selected plan | [`plan_branches.py:99–167`](../../flowdesk/plan_branches.py#L99), [`test_plan_branches.py`](../../tests/test_plan_branches.py) | Restore creates recovery history, resets progress, increments plan epoch, revokes approvals and invalidates previews; active runs or unfinished Apply block restore. |
| External result → local review | [`task_handoff.py:199–336`](../../flowdesk/task_handoff.py#L199), [`test_task_handoff.py`](../../tests/test_task_handoff.py) | Commit ancestry, repository selection and bounded diff are checked; imported reports remain external claims. Review alone cannot execute, apply or commit. |
| Selected source → provider | [`repository_context.py:208–324`](../../flowdesk/repository_context.py#L208), [`test_repository_context.py`](../../tests/test_repository_context.py) | Explicit frozen outgoing package, recipient-bound consent, expiry and consumption; old source-bearing history is not silently resent. |
| Accepted result → checkout | [`execution.py:728`](../../flowdesk/execution.py#L728), [`execution_git.py`](../../flowdesk/execution_git.py), [`test_execution.py`](../../tests/test_execution.py) | Exact digest/candidate checks and durable Apply receipts preserve deliberate recovery. Application neither stages nor commits. |
| Existing data → updated schema | [`migrations/__init__.py`](../../flowdesk/migrations/__init__.py), [`test_migrations.py`](../../tests/test_migrations.py) | Numbered schema version 12 remains unchanged by this repair; legacy fixtures are the compatibility evidence, not inspection of private user databases. |

## Reproduction and reporting

From the repository root, using its installed test environment:

```powershell
.\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider --tb=short -o tmp_path_retention_policy=failed tests/test_execution_readiness_races.py
```

The cache plugin is disabled because this checkout's existing cache directory has an ownership/permission conflict; no test or assertion is skipped. All new tests use pytest temporary directories. The baseline run's cache warnings did not cause its three assertion failures.

Then run the normal backend suite on the final source and consult [EVIDENCE_REGISTER.md](EVIDENCE_REGISTER.md) for the actual receipt. Relevant surrounding suites include execution, native model execution, immutable evidence, prerequisite readiness, imports, checkpoints, repository consent and migrations. Existing tests are implementation references until rerun; historical green results do not certify this change.

Review scope excluded private `.local-data`, credentials, personal repositories and production user databases. No critical or high-severity exploit was established in this representative review; that statement is not evidence that none exists. Larger repositories, hostile local processes, platform sandbox enforcement, provider behavior and human review quality require separate investigation.
