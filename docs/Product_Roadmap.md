# PlanBranch product roadmap and implementation record

Current roadmap · 14 October 2026. Supersedes the completed `Next_Milestones.md` plan.

## Baseline and scope

Verified checkout: `https://github.com/AdrianIp0204/PlanBranch.git`, clean `main` at
`3ad3eaf`. Work proceeds in this checkout on `codex/product-roadmap`; the existing
`output/next-major-pass` worktree is untouched. No applicable AGENTS.md was found.
Git needs a command-scoped safe-directory exception because the checkout was
created by the former sandbox account; no global Git trust setting was changed.

Existing foundations: Flask/SQLite with numbered atomic migrations; React/Vite;
manual history, persistent briefs and Build tasks with stable criterion IDs;
proposal review, explicit plan approvals, scanner attachment, isolated Git
worktrees, separate execution/acceptance/completion/application, bounded journals,
provider abstractions, JSON/Markdown exports, wheel and Windows portable builders.
Missing vertical workflows: guided example and capability checklist, semantic
approval scope, candidate-bound traceability, source-sharing preview/consent,
named alternatives, and per-task external return review.

Baseline commands (logs under ignored `output/`):

- Backend, immutable `3ad3eaf` source: **654 passed, 18 skipped**;
  `roadmap-baseline-backend-clean.log`. The first attempt hit permissions on the
  former sandbox account's temporary directory; a fresh owned test directory
  resolved this without changing those permissions.
- `npm test --prefix frontend`: **299 passed**; `roadmap-baseline-frontend.log`.
- `npm run build --prefix frontend`: passed; existing bundle-size advisory.
- GitHub authentication: existing repository administrator access. No published
  releases returned by `gh release list`; main branch-protection query says none.
  Publication still requires all release gates on the exact tested commit.

## Milestones and acceptance gates

1. **Foundations and onboarding.** Preserve existing schema/history and runtime
   boundaries; deliver labelled, resettable offline walkthrough, actual capability
   diagnostics and startup troubleshooting. Test without credentials/repository.
2. **Task workflow and evidence.** Separate semantic approval from progress,
   retain source/policy checks; expose task-specific next actions and budgets.
   Add stable requirement mappings, candidate snapshot identity and honest local,
   external, stale and human-review evidence. Test dependent tasks and drift.
3. **Selected repository context.** Source-free default; bounded read-only
   selection, exact outgoing preview, provider/content-bound explicit consent,
   no history bypass. Test paths, exclusions, changed content and cancellation.
4. **Checkpoints and alternatives.** Durable immutable named snapshots, duplicate,
   semantic compare, deliberate select and recovery-first restore. Never restore
   authority or active operations. Test restart and active-run guards.
5. **External handoff and return.** Preview/copy/export one approved task; validate
   portable returned patches/commit references and reports; preserve external
   provenance and require independent review. Test real round trip and unsafe input.
6. **Integration and release.** Wire all controls into the existing UI, document
   actual behavior, run backend/frontend/browser/migration/package checks, build
   wheel/Windows artifacts with checksums from a recorded tested commit. Publish
   only after exact-commit release gates; otherwise retain a complete draft with
   concrete blockers.

## Architecture decisions

- Keep the current execution engine, SQLite store, frontend and numbered migration
  ledger. New durable records live in the same database; preview source should be
  ephemeral where possible. Never manufacture provenance for historical records.
- Approvals, task progress, execution grants, observations, human review and Git
  application remain separate authorities. Restores/imports/demo data grant none.
- Use existing dialogs, native disclosures, keyboard labels and task review.
- All model tests use deterministic fixtures. No paid generation, dependency
  installation into user repositories, automatic commits or history rewriting.

## Progress and remaining gates

All six feature slices are implemented; integration and release validation are in
progress. New code extends the existing foundations rather than replacing them:

| Workstream | Implemented behavior | Focused verification |
| --- | --- | --- |
| Installation/onboarding | Isolated guided sample, capability diagnostics, startup error log, version 0.3.0 notes and release workflow | Offline guide and restart browser checks; startup/setup unit tests |
| Task workflow | Versioned task approval scope, next actions, prerequisite evidence checks, explicit rejection and cumulative usage display | Two dependent tasks through run, review, apply and user commit; progress and semantic drift tests |
| Traceability | Stable requirement/criterion identities, candidate source snapshots, structured check outcomes, human file/check mappings and export | Source drift, forged provenance, no-tests/skips/failure, human review and browser result review |
| Repository planning | Bounded selected file/symbol preview, exact provider request and single-use consent, metadata-only receipts | Exclusions/path aliases, frozen bytes, cancellation, expiry, source-free history after restart, browser consent flow |
| Checkpoints/alternatives | Named immutable snapshots, semantic compare, deliberate select, recovery-first restore with authority revocation | Restart, rollback, active-operation guards, narrow browser flow |
| External handoff | One-task manifest/export, local commit return, external report quarantine, human review, explicit local-run preflight | Real Git round trip, unsafe/mismatched inputs, production browser export/import/review/run |

Database migrations **11–12** are additive. Migration 11 retains legacy approval
scope as version 0 and missing candidate identities as unknown. Migration 12 stores
plan snapshots, selections/epochs, decisions and handoff/review records. Restoring
a snapshot revokes authority and never clones running operations. Existing content
schema and exports remain compatible. Historical migration fixtures now reconstruct
the actual old schema rather than keeping new columns under an old ledger.

The first evidence slice treats the brief's requirements paragraph as one stable
record and uses revision-bound files rather than claiming symbol certainty.
External returns require a commit already present locally; patch conversion/fetch
remain deliberate Git operations outside PlanBranch. Source preview consent is
ephemeral; accepted proposal references retain only identities and locations.

Validation record (logs under ignored `output/`):

- Frontend: **312 passed**, `roadmap-frontend-final.log`.
- Migration/progress regressions: **27 passed**, `roadmap-migration-fix.log`.
- New handoff production browser round trip: **1 passed**, `roadmap-browser-handoff.log`.
- Full backend/browser suites: running; discovered regressions are fixed and
  rerun before the release commit is certified.
- The local Docker Linux daemon is unavailable. Live container checks are not
  claimed; command/runtime regressions use deterministic fixtures without model
  calls. Ordinary release CI and standalone Windows packaging remain required.

Remaining release gates: clean committed source; full backend, frontend and
installed-wheel browser checks on Ubuntu and Windows; standalone Windows portable
smoke (including spaces/Unicode paths); final artifact hashes and source receipt.
Existing generated directories owned by the former sandbox account are left
untouched; local packaging uses a clean archive of the final commit and the normal
builder. The release workflow accepts only a successful same-repository push or
dispatch check run for the exact SHA, creates its tag atomically and refuses to
replace an existing tag or release. No public release is claimed by this record.
