# Quality-of-life pass

Base: `main` at `ef431b6`; work stays on local branch `codex/quality-of-life`.

Visual direction: retain the calm green workspace with restrained light/dark surfaces, readable controls and clear focus.
Content: the diagram stays primary; a temporary Settings dialog groups Appearance, Editor, Agent, and Data & About.
Interaction: immediate preference feedback, existing short focus/hover transitions, no animated graph movement; respect reduced motion.

Implementation sequence:
1. Shared browser preferences, Settings, complete light/dark/system themes, explicit light PNG exports.
2. Restore last workspace; durable unsent prompts, comments and question answers in SQLite, separate from project history and approval.
3. Keyboard quick jump for projects, current-project items and safe actions.
4. Planning/Review/Build presets and one saved personal layout.
5. Quiet operation notifications with optional sound/desktop delivery.

Each milestone receives focused regression checks and its own local commit. Final verification uses existing unit/browser/package harnesses, disposable data and deterministic agents. Existing user servers/data and real execution repositories are excluded.

Draft acceptance contract: browser/server restart recovery; delayed save acknowledgements never replace newer writing; conditional revisions and idempotent retries retain concurrent copies; submission retires only the acknowledged writing version; failed/uncertain submission preserves writing and existing retry semantics. Recover session drafts conservatively, expose copy/discard for orphaned writing, and flush before project navigation. Recovery never sends a request automatically.

Baseline and final evidence will be recorded in VALIDATION.md and output/playwright.
