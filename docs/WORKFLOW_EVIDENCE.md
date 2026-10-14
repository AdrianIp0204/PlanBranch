# Task workflow and evidence

Open **Build**, select a task, and follow its task workflow guidance. The primary
states distinguish planning, run preparation, running, waiting for an answer,
review, rejection, acceptance without application, and application. The underlying
run's failed, interrupted, or cancelled state remains visible alongside the review
action. Closing the dialog does not cancel a run.

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

## Approval scope version 1

New approvals use a versioned, explicit semantic scope. Project brief fields and
project notes are shared intent. Each task's scope includes its deliverable, file
areas, node associations, dependencies and acceptance-check text; transitive
prerequisite intent; connected diagram nodes and relationships (including decision
handles); and related planned variables and associations.

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

The application-owned Docker runner records host-observed process metadata: base
revision, candidate identity before/after, command, relative working directory,
runtime/image, timestamps, exit status and bounded output. Candidate identities
include uncommitted source bytes and executable bits within the execution worktree.
The existing bounded file reader refuses symlinks, junctions and special files.

Identity excludes Git internals, Python `__pycache__` directories, `.pytest_cache`
directories, and the explicit root `.planbranch-results` output directory. Other
uncommitted files count as source even if Git ignores them. Put generated check
artifacts in `.planbranch-results`; modifying other source while checking it marks
the observation stale. Host changes during an isolated command prevent copy-back
and mark the check stale. If source changes after a check, the old observation
remains historical and cannot certify the new candidate.

Acceptance, completion, continuation and a new checkout Apply also require the
captured candidate to remain unchanged, including ignored source files. Refreshing
a changed candidate withdraws its active acceptance even when its Git-visible diff
is identical; review and accept it again. Earlier decision receipts remain history.
Recover an interrupted Apply before refreshing. Older interrupted Applies without
a candidate snapshot retain only their existing artifact-bounded recovery, never
new source provenance or permission to execute again.

For structured test counts, ask the authorized command to write JUnit XML to
`.planbranch-results/junit.xml` (for example, pytest's
`--junitxml=.planbranch-results/junit.xml`). The bounded XML reader counts actual
testcase elements and distinguishes failures, skipped-only runs and no tests.
An unchanged pre-existing report is labelled `unchanged report`, requiring human
review. Unreadable or oversized reports are retained as identified artifacts but
are not treated as successful test evidence. JUnit output is produced by the code
under test: it is supporting evidence, not independent authentication.

Codex-stream command reports and historical records without captured source
provenance are labelled as executor/external reports. Agent prose cannot become
host-observed evidence. A zero process exit is only an observed successful process;
it does not prove that the intended tests ran, or that a natural-language requirement
is satisfied. A content hash identifies bytes, not correctness or authenticity.

## Cumulative limits

Expand **Execution limits and cumulative usage** in a run. The shared model harness
shows consumed, remaining and maximum turns, tool calls and active seconds from its
persisted journal. Waiting for a user answer and server downtime do not consume
active time. During execution the saved elapsed value is a lower bound; it is not a
live timer. Counts remain cumulative across valid answers and resumptions. Missing
or invalid historical time is unavailable, never zero. Executors that do not expose
these measurements say so. Provider token counts retain their reported provenance;
the application does not infer monetary costs.
