# PlanBranch 0.3.0 — intent, changes and evidence

PlanBranch connects a feature request to its approved task, isolated code changes,
observed checks, human review and explicit checkout application.

## New workflows

- A guided, resettable offline example walks through a brief, proposed design,
  acceptance criteria, illustrative diff and application boundary. Demonstration
  output is labelled and never becomes execution evidence. Capability diagnostics
  explain provider, Git/repository and isolated-runtime setup separately.
- Task workspaces show the next action and approval blockers. Versioned semantic
  approval scopes exclude layout and recorded progress while including task scope,
  dependencies, requirements and connected diagram meaning. Execution authorization
  and source checks remain separate. Review also exposes rejection and budget use.
- Requirement and criterion review connects existing diagram links to changed files,
  candidate source identities and command observations. Human mappings and external
  reports retain their own provenance; changes can make evidence stale.
- Repository context is source-free by default. Explicit bounded file/symbol
  selection produces a provider/model-specific outgoing preview. Consent covers
  that frozen package; source history cannot silently bypass a later selection.
- Named checkpoints and alternative plans survive restart. Compare meaning, select
  deliberately, and restore with a recovery snapshot. Old approvals and runs do not
  reactivate when a plan is restored.
- Export or copy one approved implementation task after inspecting its manifest.
  Return a full local commit ID and optional JSON report, inspect the changes and
  record a human review. Reports stay external; imports do not execute or apply.

## Installation

For Windows x64, extract `PlanBranch-0.3.0-windows-x64.zip` to a new ordinary folder
and launch `planbranch.cmd`. Open `http://127.0.0.1:4310`. Python and the built UI
are included. Git, Codex, model runtimes, Docker, images and credentials are not.
Choose **Guided offline example** without setting up any of those dependencies.

For a wheel installation, use Python 3.14 or newer and install
`flowdesk-0.3.0-py3-none-any.whl`; dependencies must already be available or downloaded
by pip. Run `planbranch`. Node is required only to build from source.

Verify downloaded bytes against `SHA256SUMS.txt`. `release-manifest.json` records
the source commit and successful checks workflow used for these artifacts. A
prepared local artifact or draft is not a public release.

## Upgrade and boundaries

Stop the old application and retain a full data-directory backup including execution
worktrees. Install into a new application folder and reuse the existing data folder.
SQLite migrations 11–12 add scoped approval/review records, immutable plan snapshots,
alternative decisions and external handoffs. Existing content schema and history
remain compatible; historical approvals keep their older strict scope, and missing
historical candidate identities remain unverified.

The first traceability slice treats the brief's requirements paragraph as one stable
requirement record and retains each existing criterion ID. File references identify
the candidate revision; they do not claim symbol-level certainty. Checks cannot prove
an entire natural-language requirement. Source identities establish bytes, not
correctness or independent authenticity.

The first external return route uses a commit already available in the attached local
repository. Fetch it or convert a patch with your own Git tools. PlanBranch does not
fetch or apply imported patches. To run local checks, deliberately check out the
returned commit in your execution repository, use the return's local-run action,
then review and authorize the normal execution preview. New observations do not
rewrite the report's external origin.

No telemetry, compulsory account, paid service or automatic Git commit is added.
See the user guide for consent expiry, recovery and remaining platform limitations.
