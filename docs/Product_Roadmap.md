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

- `python -m pytest -q`: running; `roadmap-baseline-pytest.log`.
- `npm test --prefix frontend`: running; `roadmap-baseline-frontend.log`.
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

Implementation underway. Parallel owners: workflow/evidence; repository consent;
checkpoints/handoff. Primary owner: onboarding, integration, documentation,
validation and release. Update this section at each tested milestone.
