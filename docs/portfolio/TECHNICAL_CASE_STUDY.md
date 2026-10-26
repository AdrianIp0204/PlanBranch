# PlanBranch: retaining human control over AI-assisted implementation

Source review: 26 October 2026. The audit began at `60fc36b` (package version
`0.3.1`). This document describes executable mechanisms, not a claim that they
improve developer productivity. Current checks and their limitations belong in the
[evidence register](EVIDENCE_REGISTER.md); comparison methodology belongs in
[evaluation](EVALUATION.md).

## The engineering problem

A coding agent can produce plausible prose, edit files and report success while
leaving several different questions unanswered: Was this the requested work? Was
this plan approved? Which source did the agent use? Did a check actually run? What
did the human accept? Has that exact result reached the original checkout?

PlanBranch's central contribution is a persistent workflow that keeps those facts
distinct and relates them to a visual plan. It combines an editable intent model
with explicit execution requests, captured changes, evidence provenance and
separate human decisions. The diagram provides navigable context; the backend
enforces the consequential boundaries. This is more than a diagram editor because
approval freshness and repository state are checked when execution and application
are requested. It is more than a chat transcript because a provider's response
cannot itself become execution authority or trusted verification evidence.

## Architecture and representation

The React/TypeScript client uses React Flow for diagrams. A local Flask API serves
both the built client and application services. SQLite holds project snapshots,
relational projections, conversation and proposal records, approvals, execution
records, review records and action receipts. Execution worktrees and their
artifacts live alongside the database in the application's data directory, not
inside SQLite. See the [architecture diagram](ARCHITECTURE.md),
[application composition](../../flowdesk/app.py), [store](../../flowdesk/storage.py)
and [schema migrations](../../flowdesk/migrations/__init__.py).

The manual content schema is version 3. Versions 1 and 2 remain readable through
pure upgrades that add missing brief/task defaults. The database migration ledger
is separately versioned through 12. Frozen requests and approval records are not
silently rewritten to obtain newer authority. Destructive migrations verify a
SQLite backup before the transaction, reject concurrent changes detected while
preparing it, and roll back on failure. This distinction between display upgrades
and historical records is essential to interpreting old approvals honestly.

| Representation | Meaning and boundary |
| --- | --- |
| Project brief | Goal, audience, requirements, constraints, exclusions, decisions and assumptions: human-editable intent. |
| Diagrams | Stable node/edge IDs, node types, decision ports, labels, notes, checklists and implementation targets. Program-flow cycles are permitted. |
| Build tasks | Deliverable, linked nodes, expected files, acceptance checks, prerequisite IDs and progress. Prerequisites must form a directed acyclic graph. |
| Planned variables and scanned symbols | Separate planned records and static Python observations; matching them is explicit, not proof of implementation correctness. |
| Approval | A versioned semantic fingerprint and task scopes; not a command permission. |
| Execution preview/run | A frozen request and its observed lifecycle, independently retaining acceptance, completion and application facts. |
| Candidate/evidence/review | Source identity, command provenance and human mappings; none is interchangeable with the others. |

[Content upgrades](../../flowdesk/content_versions.py) and
[validation](../../flowdesk/validation.py) define these structures. Task validation
uses an iterative indegree traversal to reject cycles without recursive traversal
of long prerequisite chains. Missing diagram links retain their last-known title
and diagram so deletion does not silently erase task context. Expected files are
declared review scope; they should not be described as an exhaustive filesystem
allowlist or an automatic detector of all unrequested behavior.

## Approval is about meaning, not progress

[`semantic_intent.py`](../../flowdesk/semantic_intent.py) explicitly enumerates
approval-relevant fields. A task's scope includes its own intent, transitive
prerequisite intent, the connected diagram component reached from linked nodes,
related planned variables and shared brief information. Collection ordering is
normalized before hashing.

Moving a node, pinning it or marking progress does not change meaning. Editing
acceptance text, decision handles or blockers does. An unrelated task can change
without invalidating an unaffected task's approval, while shared requirement
changes invalidate affected scopes. This is a deliberate usability/safety
trade-off: hashing every UI field creates needless reapproval; ignoring too many
fields risks retaining approval for changed intent. New meaning-bearing fields
must update this explicit policy and its version.

An execution preview remains stricter than semantic approval: it binds the saved
project revision, approved task, selected repository, source commit, model and
runtime policy. Starting a preview rechecks those facts. A still-approved task can
therefore require a new preview after a save. The frontend exposes separate
**Approve plan**, **Preview run** and **Run step** interactions in
[planning](../../frontend/src/PlanningPanel.tsx) and
[execution review](../../frontend/src/ExecutionDialog.tsx).

## Execution and application are distinct operations

[`ExecutionService`](../../flowdesk/execution.py) records lifecycle values such as
`queued`, `running`, `failed`, `cancelled` and `interrupted`. Acceptance is an
`accepted_digest`, completion has its own history cursor, and application has its
own recorded state. These are separate fields and actions, not synonyms for a
single `done` status. A verification-only run explicitly refuses acceptance,
completion and application actions.

Each mutation has a request identity and payload hash. Repeating an acknowledged
request returns its recorded outcome; reusing that identity for different content
is rejected. A unique active-run constraint and an OS-owned execution lock prevent
two servers from independently taking over the same execution store. On restart,
unfinished run states become interrupted and retain their work; the application
does not automatically rerun the agent.

This audit found a narrower readiness race: task progress is intentionally absent
from semantic approval, so a task becoming blocked, or a prerequisite reopening,
during worktree preparation was not caught by the semantic recheck alone. The
worker now rereads progress and prerequisite readiness before invoking the
executor. The [boundary audit](BOUNDARY_AUDIT.md) records the reproduction and
[`test_execution_readiness_races.py`](../../tests/test_execution_readiness_races.py)
includes negative cases plus a layout/progress control. This guard does not freeze
the project throughout execution; later review checks still have to detect drift.

A second debugging example concerns observation rather than execution authority.
The [execution dialog](../../frontend/src/ExecutionDialog.tsx) polled every two
seconds and used request tickets to ignore superseded responses. When detail reads
took longer than the interval, each new poll could invalidate the preceding
response indefinitely: the backend had succeeded while the dialog still displayed
Running. Background polls now finish before another starts. Selection and explicit
action guards remain intact, so a delayed response cannot replace a newly selected
run or overwrite cancellation. Three focused
[dialog regressions](../../frontend/src/ExecutionDialog.test.tsx) exercise a
three-second response, selection change and cancellation; the focused dialog suite
passed 29 tests. Final browser/package results belong in the
[validation record](VALIDATION.md). The fix changes status refresh behavior and
does not accept or apply a result.

[`GitWorkspace`](../../flowdesk/execution_git.py) registers a locked detached
worktree from a committed revision using `--no-checkout`, then materializes bounded
Git blobs itself. This avoids repository checkout hooks and smudge filters. Git
commands suppress network protocols and configured helpers relevant to this flow.
Path validation rejects unsafe names, links and unsupported tree entries. A
worktree separates candidate edits from the user's working files; it is **not an
OS command sandbox**.

The service captures a diff artifact and complete candidate identity. Human
acceptance binds those captured bytes. Completing a task changes progress through
an undoable history entry. Applying changes separately checks the accepted
artifact, current plan and checkout conflicts; a durable per-file application
journal supports recovery across the SQLite/filesystem boundary. It preserves
unrelated edits and the original index. PlanBranch does not stage, commit, merge or
push this result.

A dependent task needs more than a manually set `done` flag. The shared
[prerequisite evaluator](../../flowdesk/prerequisites.py) requires a current
reviewed, completed and applied implementation result whose accepted changed files
are present with the expected bytes/modes in committed `HEAD`. The user must make
that commit through existing Git tools. Verification-only runs do not replace the
implementation result used for this decision. There is currently no separate
human-only prerequisite attestation for work completed outside this flow.

## Verification identifies the observation and its source

A command that exits successfully may have run no tests. A writable command may
temporarily change source, test that different source and restore the original
bytes. Equal hashes before and after such a command do not establish what it
tested. PlanBranch consequently distinguishes writable implementation commands
from immutable verification.

The [Docker command runner](../../flowdesk/command_runner.py) mounts a host-created
candidate read-only for verification, checks the mount, and executes the requested
command as an unprivileged user. Writable temporary, cache and result locations
are separate bounded mounts. Network access and Git metadata are unavailable.
The local Docker daemon, image and host remain trusted. Live container tests are
required to support OS-isolation claims; mocked configuration checks cannot
establish that guarantee.

[`check_evidence.py`](../../flowdesk/check_evidence.py) computes a versioned identity
over candidate paths, file hashes, lengths and executable bits, excluding Git
metadata but including ignored files and pre-existing caches. A local HMAC seal
authenticates host evidence at ingestion and binds it to a run. Provider JSON
cannot gain trusted provenance by asserting `origin: host`. Historical writable
observations retain their weaker label. On Windows, executable identity describes
the materialized candidate because ordinary checkout permissions do not represent
Git's execute bit in the same way as POSIX.

The bounded JUnit parser counts actual test cases, distinguishes failed, empty,
skipped-only and unreadable reports, and rejects unsupported XML constructs. A
passing report remains command-produced data. It does not prove that acceptance
criteria are complete, that tests are independent, or that the command is honest.

[`TraceabilityService`](../../flowdesk/traceability.py) connects the brief's
requirements paragraph, task, acceptance criterion, candidate, changed files,
optional command and human review note. The current implementation has one stable
requirement record for the entire requirements paragraph, not individually modeled
requirements. Meaning hashes invalidate reviews when relevant text or candidate
bytes change. The [trace panel](../../frontend/src/TracePanel.tsx) makes these links
inspectable. A human mapping records judgment; it neither certifies correctness nor
authorizes execution or application.

## Provider and recovery boundaries

[Provider adapters](../../flowdesk/providers.py) support Ollama, OpenAI, Anthropic,
Gemini and the separate Codex CLI path. The native-provider
[model executor](../../flowdesk/model_executor.py) offers bounded read/write,
diff, command, verification and question tools. The file-edit tool requires the
hash returned by the prior read when changing an existing file. Its journal retains
cumulative turn, tool-call and active-time budgets across question continuations.
Uncertain pending effects are not silently
replayed. Native commands require a configured local Docker runtime; unavailable
isolation does not trigger a host-shell fallback. Codex has its own executor and
native sandbox policy, whose enforcement also needs platform-specific validation.

Planning source disclosure is separately controlled by
[`repository_context.py`](../../flowdesk/repository_context.py). A read-only
attachment does not transmit code. A concrete source package is previewed and
bound to the recipient and selected content; changing the selection or recipient
requires new consent. Source-bearing requests exclude old conversation history,
and later restricted requests cannot replay that old source implicitly.

[Checkpoints and alternatives](../../flowdesk/plan_branches.py) save logical plans,
not Git branches. Restore first saves a recovery checkpoint, resets progress,
revokes approvals/previews and increments a selection epoch. Returning to identical
text cannot reactivate an old run's authority. Active execution or unfinished
application blocks a plan switch.

[Portable imports](../../flowdesk/exports.py) validate bounded content and remap
identities into a new project. Machine permissions and execution records are not
portable fields. [External handoffs](../../flowdesk/task_handoff.py) instead bind a
task and baseline to a local candidate commit; imported reports remain external
claims. Local immutable verification creates new observations rather than
retroactively trusting the imported report. Database backup alone omits worktrees;
recovery needs the whole data directory and the associated source repositories.

## Testing, trade-offs and alternatives

Representative executable specifications include:

- [Workflow semantics](../../tests/test_workflow_evidence.py): progress versus
  meaning, legacy approval behavior, candidate identity and criterion review.
- [Execution](../../tests/test_execution.py) and
  [Git application](../../tests/test_execution_git.py): stale previews, separate
  accept/complete/apply, interrupted work, conflicts and partial-application recovery.
- [Execution dialog](../../frontend/src/ExecutionDialog.test.tsx): slow background
  polling, changed selection and explicit actions retain correct response ordering.
- [Authority audit](../../tests/test_authority_audit.py),
  [immutable evidence](../../tests/test_immutable_evidence.py) and
  [live verification](../../tests/test_immutable_verification_live.py): forged
  provenance, source drift and actual container restrictions where available.
- [Plan restoration](../../tests/test_plan_branches.py),
  [handoffs](../../tests/test_task_handoff.py),
  [repository context](../../tests/test_repository_context.py) and
  [migrations](../../tests/test_migrations.py): authority revocation, consent and
  backward compatibility.

These links identify coverage; they do not assert that every test ran on the
current source or platform. See the evidence register for the actual final run.
The [checks workflow](../../.github/workflows/checks.yml) builds a frozen package
candidate and defines Windows/Linux test gates; configured CI is not itself a
passing CI result.

The implementation favors explicit, inspectable decisions over autonomous
throughput. That creates extra steps, Git knowledge requirements, storage for
recovery, and deployment complexity for Docker checks. One active execution per
data store simplifies ownership but limits parallelism. Current bounds include
1,000 tasks, 5,000 candidate files, a 128 MiB tree and a 512-file/16 MiB changed
artifact; these are limits, not demonstrated scalability measurements. Large
connected diagrams also broaden semantic approval scope.

A simpler alternative is an issue checklist plus Git pull requests: less custom
state, but less integrated intent-to-candidate provenance. A fully autonomous
planner/executor could reduce interaction cost while making the human review
boundary harder to inspect. A formal specification system could offer stronger
properties for narrowly modeled requirements, with substantially greater authoring
cost. PlanBranch occupies a practical middle ground; whether that trade-off helps
users remains an empirical question.
