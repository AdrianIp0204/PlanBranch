# Engineering and first-use audit — 26 October 2026

Baseline: `60fc36b4f8a0f0d14e2c5137b77f05e9f5d8d665`, initially a clean checkout on `codex/release-artifact-download`. Work uses `codex/portfolio-engineering-audit`. The public v0.3.1 release points to merge commit `a433fe1c08c254001d5a93681e0ea3064dc59514`; a checkout version string alone is not release provenance.

This is a representative engineering audit, not a penetration test, accessibility certification or observed novice-user study. Existing private databases and projects were not opened. All runtime checks use new data directories and disposable repositories.

## Capability assessment

| Area | Implemented mechanism | Evidence and qualification |
| --- | --- | --- |
| Visual intent | React Flow diagrams, briefs, variables, task links | [models](../../frontend/src/types.ts), [validation](../../flowdesk/validation.py). Diagrams may loop; prerequisites must be acyclic. |
| Persistent state | SQLite, numbered migrations, revisioned history and drafts | [storage](../../flowdesk/storage.py), [migrations](../../flowdesk/migrations/__init__.py). No schema change in this audit. |
| AI planning | Provider adapters and structured proposal review | [providers](../../flowdesk/providers.py), [planning](../../flowdesk/planning.py). Paid/live provider quality was not measured. |
| Selected source context | Preview and consent for bounded source packages | [repository context](../../flowdesk/repository_context.py). Repository attachment alone is not permission to transmit. |
| Task authority | Semantic approval scope plus exact run preview | [semantic intent](../../flowdesk/semantic_intent.py), [execution](../../flowdesk/execution.py). Progress and authority are separate. |
| Code editing | Committed-source Git worktrees and bounded executors | [Git workspace](../../flowdesk/execution_git.py), [model executor](../../flowdesk/model_executor.py). A worktree is not an OS sandbox. |
| Verification | Candidate identity, host-observed evidence and immutable verification | [evidence](../../flowdesk/check_evidence.py), [verification executor](../../flowdesk/verification_executor.py). A reported command or zero exit alone is insufficient. |
| Human review/application | Separate acceptance, completion and conflict-checked Apply | [execution](../../flowdesk/execution.py), [traceability](../../flowdesk/traceability.py). No automatic commit/push/merge. |
| Recovery and sharing | Checkpoints, alternatives, portable project/handoff import | [plan branches](../../flowdesk/plan_branches.py), [exports](../../flowdesk/exports.py), [handoff](../../flowdesk/task_handoff.py). Historical content does not grant new authority. |
| Distribution | Wheel/portable builds and sealed CI candidate workflow | [checks](../../.github/workflows/checks.yml), [release receipts](../../scripts/release_receipt.py). Local checks do not replace release gates. |

The main contribution is the combination of versioned intent, source-bound records and distinct human decisions, rather than any individual diagram or chat feature. See the [technical case study](TECHNICAL_CASE_STUDY.md) for the relevant data structures and trade-offs.

## Prioritised findings and actions

1. **High priority: readiness could change during worktree preparation.** Semantic approval intentionally excludes progress, so a blocked task or reopened prerequisite required a separate pre-launch check. Corrected with focused regression coverage; see [boundary audit](BOUNDARY_AUDIT.md). This is a demonstrated timing gap, not a claim of unrestricted execution.
2. **High evidence gap: no empirical workflow comparison.** Historical green tests and simulated agents cannot support productivity or model-quality claims. Added a three-task protocol, fixed independent checks, machine-readable fixture outcomes and explicit “not yet conducted” status. Human timing and model sampling remain future work.
3. **Medium first-use friction: partial example could appear complete.** The walkthrough request includes validation and counting, but its sample diff implements only validation. The implementation-task screen now names the dependent counting task and explains the incomplete scope. The sample remains non-authoritative.
4. **Medium navigation burden: detailed documentation lacks a short evidence-led entry.** Added a portfolio index, two-minute script, case studies and evidence register; linked them near the README's start without removing installation/security/release instructions.
5. **Medium operational complexity remains.** Users must distinguish plan approval, Run, Accept, Complete, Apply and a manual Git commit. Docker/native sandbox setup and committed prerequisites add effort. Existing workflow cards and recovery guidance help, but comprehension has not been tested with novices.
6. **Low performance/maintainability concern.** The production build reports a JavaScript chunk above 500 kB; core UI/service files are large. No measured startup regression or justified rewrite was established. Measure cold-start and large-plan behaviour before splitting modules.

**Additional high-priority finding during browser validation:** a backend run succeeded while its dialog still showed Running. Each two-second poll advanced the request ticket, so detail reads taking more than two seconds could be discarded repeatedly. Background polls are now serialized while selection and mutation guards remain intact. A deterministic three-second-response regression failed before the fix; all 29 execution-dialog tests passed afterward, including late-selection and cancellation controls. See [the component](../../frontend/src/ExecutionDialog.tsx) and [regressions](../../frontend/src/ExecutionDialog.test.tsx). The original installed-wheel browser attempt predates this repair and is retained as such in validation.

## First-use and recovery assessment

| User goal | Inspection outcome / next action |
| --- | --- |
| Understand purpose | README opening states the intent-to-application chain. Portfolio entry explains its testable hypothesis. |
| Open the app offline | Portable and source paths are documented; use `--data-dir` with a new folder for demos. Python 3.14/Node 24 are source-build requirements. |
| Complete a walkthrough | Guided example is visible before model setup; browser capture exercises actual UI with no provider generation or repository grant. |
| Create meaningful work | Brief, design decision, criteria and dependent tasks exist in the guided sample. Blank-project usability is not a measured novice outcome. |
| Know when AI is involved | Manual planning works offline; provider setup and selected source consent are distinct. Walkthrough output says illustrative/not observed. |
| Decide what can be applied | Inspect candidate diff, evidence and uncertainty; accept, complete and Apply separately. Acceptance does not establish correctness. |
| Recover from blockers | Use the task-specific correction action; re-preview after source/policy drift; retain interrupted worktree; resolve conflicting edits manually. Never clear a blocker by inventing evidence. |
| Recover saved state | Use checkpoints/alternatives for design recovery and full stopped-data-directory copies for worktrees. A database backup alone does not preserve worktree files. |

Representative genuine captures are linked in [DEMO](DEMO.md). Prior [usability work](../UI_UX_Review.md) includes historical viewport/contrast observations; this audit does not repeat or recertify those measurements. Current test outcomes, environmental failures and omissions belong in [VALIDATION](VALIDATION.md).

## Deliberate limits

No training, fine-tuning, multi-user collaboration service, autonomous whole-plan execution, automatic conflict resolution or measured productivity gain is claimed. The current traceability model gives the brief's requirements paragraph one identity; it does not prove per-requirement satisfaction. Expected file lists assist review but do not infer whether a change was requested. AI summaries and generated judgments remain untrusted evidence inputs. The audit adds no new authority through sample data and does not publish a release.
