# Task workflow and evidence

Open **Build**, select a task, and follow its task workflow guidance. The primary
states distinguish planning, run preparation, running, waiting for an answer,
review, rejection, acceptance without application, and application. The underlying
run's failed, interrupted, or cancelled state remains visible alongside the review
action. Closing the dialog does not cancel a run.

The dialog waits for each background status refresh to finish before starting
another, so slow responses can still update the result. Older responses do not
replace a newly selected run or an acknowledged cancellation.

## Decisions remain separate

1. Approve the saved task intent in Planning.
2. Open **Run step**, select an execution repository, and review **Preview run**.
   This freezes the source commit, model, task scope and execution policies.
3. Explicitly authorize **Run step**. Work remains in its isolated worktree.
4. Review the diff and evidence. **Accept changes** accepts that exact diff and
   captured candidate source;
   **Reject result** retains the result without applying it.
5. **Complete task** records progress. **Apply to checkout** is a separate action
   and retains the existing conflict, dirty-file and recoverable-apply protections.
6. Commit applied changes yourself in your editor or terminal. PlanBranch does
   not create a Git commit automatically.

A dependent task checks both progress and the prerequisite's accepted, completed,
applied result. Its accepted changed files must exist with the expected bytes and
modes in the selected repository's HEAD. An unapplied or uncommitted prerequisite
produces a task-specific blocker. A manual or agent-authored “done” field without a
reviewed execution result cannot unlock dependent execution. For external or
manually implemented work, reopen the task and review an authorized local run
against the committed implementation before using it as a prerequisite. A no-op
result can be deliberately reviewed and completed. This initial workflow does not
provide a separate human-only prerequisite attestation mechanism.

The workflow card and Run preview use the same read-only prerequisite evaluator.
Both return the same issue codes, task/result references and corrective actions
for incomplete work, missing review, incomplete progress, unapplied changes,
changes missing from committed HEAD, stale plan/scope, and unavailable evidence.
Correction buttons open the relevant task or exact recorded result; they do not
accept, apply, complete, commit or execute anything. Execution checks these facts
again when a reviewed run is started, then rechecks task progress and prerequisites
after preparing the worktree, before the agent starts. If readiness changed,
resolve the blocker and review a new preview. Verification-only runs never replace
the latest implementation result used to establish prerequisite completion.

## Approval scope version 1

New approvals use a versioned, explicit semantic scope. Project name, brief fields
and project notes are shared intent. Each task's scope includes its deliverable, file
areas, node associations, dependencies and acceptance-check text; transitive
prerequisite intent; connected diagram nodes and relationships (including decision
handles and blocker text); and related planned variables and associations.

Progress statuses, checklist checked flags, node placement and pinning do not
change approved intent. Checklist text, decision handles and acceptance criteria
do. Editing an unrelated task or disconnected diagram can make the overall plan
approval out of date while leaving unaffected task scopes approved. A changed
requirement or shared constraint invalidates all affected task scopes. Open
planning review conversations still require resolution before execution.

Execution previews remain exact reviewed requests. Saving after a preview may
require a new preview even when intent approval remains current. Source identity,
provider/runtime policy and selected alternative are checked independently of
semantic intent. Selecting or restoring a plan increments its selection epoch;
historical run authority and prerequisite evidence cannot be revived by returning
to identical content.

Historical approvals retain their original strict scope. Migration does not
silently widen them. Deliberately approve a current plan to use version 1 scopes.

## Requirement → task → code → check

Expand **Requirement, code and acceptance evidence** in Build or the execution
review dialog. A diagram node's **Implementation and evidence** section links to
its related tasks and the same evidence view.

The first traceability slice treats the existing brief's Requirements paragraph as
one stable requirement record. Its identity is stable within the project; its
meaning hash changes when its text changes. Existing acceptance-check UUIDs remain
stable, with separate meaning hashes. This does not split prose into independently
managed individual requirements. Requirement-to-task association is labelled as
project context, not a user-confirmed proof of satisfaction.

Changed files are associated with the task that produced the diff. File references
carry the source base commit, candidate source identity and individual file hash;
they are revision-bound files, not guessed symbols or floating line numbers.
Choose a criterion, supporting command and changed files, then write what you
reviewed and what remains uncertain. **Confirm human review** records this explicit
mapping. It grants no execution, acceptance or application permission. Editing code
or criterion meaning makes that review stale. Refresh the execution diff before
reviewing a changed candidate. Evidence JSON exports omit machine repository paths,
provider instructions and unrelated tasks; review command/output text before
sharing because commands can themselves print sensitive material.

## What was actually observed

Version 2 separates **mutable implementation commands** from
**verify without editing**. A coding command may change its isolated workspace;
its exit is labelled **Writable command observed (not source-bound)**. Comparing
hashes at its endpoints cannot prove what bytes a check exercised: a command can
rewrite source, check it and restore it before exit.

Verification mounts a fresh, host-created candidate snapshot at `/workspace`
using a Docker read-only bind mount with recursive mounts disabled. The command
runs without effective capabilities as UID 65534. The mount, rather than file
permissions owned by the command, prevents edits, chmod, deletion and substitution
throughout the check. The host checks the mounted image and read-only flag before
launch. Network access, host credentials and Git metadata remain unavailable.
The local Docker daemon and selected image remain part of the trusted runtime.
See [Docker bind-mount semantics](https://docs.docker.com/engine/storage/bind-mounts/).

Writable verification locations are separate bounded tmpfs mounts: `/tmp` (32
MiB), `/cache` (32 MiB), and `/artifacts` (16 MiB). Set compiler/build outputs there;
checks that insist on editing source must use mutable commands and cannot receive
source-bound evidence. `PYTHONPYCACHEPREFIX` and `XDG_CACHE_HOME` point to `/cache`.
No verification outputs are copied into the candidate. Links, hard links, unsafe
paths, special files and oversized output are refused during collection.

Candidate identity v2 covers all candidate bytes and executable bits, including
ignored files, existing Python caches and old `.planbranch-results` contents.
Only Git metadata is excluded. On Windows, Git execute bits are not represented
by the ordinary checkout filesystem; the identity describes the materialized
candidate. A changed candidate withdraws acceptance even if its Git-visible diff
is identical. Historical identities are not silently recomputed into stronger
observations. Recovery of an already interrupted legacy Apply remains limited to
its originally accepted artifact.

The host records mode, candidate identity, command, daemon/image identity,
timestamps, timeout, structured outcomes and bounded output. A local host-only
seal binds command evidence to its run at ingestion. Provider JSON, Codex-stream
reports and imported reports cannot assign trusted provenance or a verification
mode. Historical v1 observations are labelled **Historical writable command (not
source-bound)**; they do not acquire the new guarantee.

Write JUnit XML to `/artifacts/junit.xml`, for example
`pytest -o cache_dir=/cache/pytest --junitxml=/artifacts/junit.xml`. The bounded
parser counts actual testcase elements and identifies failures, skipped-only
runs, no tests and unreadable reports. A zero exit without structured test results
is **Immutable command exit observed (coverage unverified)**. A passing JUnit
observation says the immutable check reported passing cases; the report is still
command-produced and does not prove requirement coverage. Human criterion review
remains separate.

For an imported local-commit candidate, choose **Verify without editing**, enter
a check, review its preflight and explicitly authorize it. The selected repository,
external result, plan, candidate commit and candidate bytes are bound through
preview and start. Drift is refused; PlanBranch does not switch your checkout or
substitute a newer candidate. Local checks become new observations and leave the
original external report external. Verification-only runs cannot accept, apply or
complete implementation changes. Their observations remain available after reload.

The v2 coding instruction contract adds the same verification tool to native
execution. Paused v1 coding sessions remain historical and cannot resume under a
changed instruction contract; review retained work and create a fresh preview.
Cumulative budgets, durable no-replay intents, cancellation and owned-container
cleanup still apply. The Linux CI gate runs actual Docker integration tests;
without that gate, unit tests alone establish no container guarantee.

## Cumulative limits

Expand **Execution limits and cumulative usage** in a run. The shared model harness
shows consumed, remaining and maximum turns, tool calls and active seconds from its
persisted journal. Waiting for a user answer and server downtime do not consume
active time. During execution the saved elapsed value is a lower bound; it is not a
live timer. Counts remain cumulative across valid answers and resumptions. Missing
or invalid historical time is unavailable, never zero. Executors that do not expose
these measurements say so. Provider token counts retain their reported provenance;
the application does not infer monetary costs.
