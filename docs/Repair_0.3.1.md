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

Validation results and remaining gates are recorded below as work completes.

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
