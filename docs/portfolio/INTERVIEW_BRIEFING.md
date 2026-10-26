# PlanBranch interview briefing

Use this as a technical study guide, not a script claiming personal authorship of
every implementation detail. The source review began at `60fc36b` on 26 October
2026. Confirm personal history and contributions before using first-person answers.
Use the [evidence register](EVIDENCE_REGISTER.md) for current test results and
[evaluation](EVALUATION.md) for what has and has not been measured.

## Problem, contribution and AI systems

**What specific problem are you trying to solve?**

An AI coding conversation can mix requirements, suggested plans, claimed progress
and actual changes. PlanBranch makes those different objects inspectable: a
human-authored brief, visual design, implementation tasks, approved scope, a frozen
execution request, a captured candidate, evidence and separate review decisions.
The hypothesis is that this structure makes oversight clearer. It has not yet
established a productivity or correctness advantage in a controlled user study.

**What does this add beyond a coding agent with a plan mode?**

The contribution is the persisted relationship between intent, authorized work,
source identity and human review, including freshness checks and recovery. A
provider saying “done” cannot complete a task or apply code. The diagram is a
navigation and reasoning surface backed by workflow enforcement, rather than a
picture of a chat transcript. Other tools can offer overlapping capabilities;
do not claim that these ideas are unique inventions.

Read: [`execution.py`](../../flowdesk/execution.py),
[`traceability.py`](../../flowdesk/traceability.py).
Concepts: provenance, authorization, state machines, human-in-the-loop systems.

**Is PlanBranch an AI model you trained?**

No. It integrates existing local/cloud models and Codex CLI. The AI-systems work
is in orchestration, constrained tools, context selection, persistence, source
binding and the human decision boundary. Model-quality evaluation is separate from
testing this orchestration software.

Read: [`providers.py`](../../flowdesk/providers.py),
[`model_executor.py`](../../flowdesk/model_executor.py).

## Graphs, data and approval

**Why have both a diagram and a task graph?**

They describe different relationships. Program flow can contain loops and
branches. Implementation prerequisites express a partial order and cannot contain
cycles. Build tasks link to diagram nodes but have their own IDs, deliverables,
criteria and prerequisites. This prevents a loop in the program from being
mistaken for an impossible build schedule.

**How do you detect prerequisite cycles? What is the complexity?**

Validation computes indegrees, repeatedly removes zero-indegree tasks and counts
visited nodes. If fewer tasks are visited than exist, a cycle remains. For that
cycle-detection pass, time and space are proportional to tasks plus dependency
edges. The complete validation path has additional work and fixed size limits;
do not claim a measured scalability result from the algorithm alone.

Read: `validate_build_tasks` in [`validation.py`](../../flowdesk/validation.py);
[`test_build_tasks.py`](../../tests/test_build_tasks.py).
Concepts: directed acyclic graph, topological order, referential integrity.

**What invalidates approval? Why not hash the whole project JSON?**

Approval uses an explicit versioned semantic scope: shared brief content, task
deliverable/criteria/dependencies, related diagram semantics and planned variables.
Node placement and progress are excluded. Hashing all UI state would demand
reapproval for layout edits; excluding meaning-bearing fields would be unsafe.
Task scopes include transitive prerequisite intent and connected diagram context,
so relevant edits invalidate approval while some unrelated edits do not.

An execution preview also binds the exact saved revision and runtime/source
selection. Its freshness is intentionally stricter than semantic approval. A
still-approved task may need a new execution preview.

Read: [`semantic_intent.py`](../../flowdesk/semantic_intent.py),
[`test_workflow_evidence.py`](../../tests/test_workflow_evidence.py).
Concepts: canonical serialization, versioned policy, hash identity versus meaning.

**Can a user mark a prerequisite done and bypass review?**

Manual progress is not execution evidence. The evaluator checks for a current
accepted, completed and applied implementation result and verifies its changed
files in the selected repository's committed `HEAD`. A manually set `done` field
does not establish these facts. This conservative design also inconveniences users
whose work was completed elsewhere; there is no separate human-only attestation
mechanism in the current workflow.

Read: [`prerequisites.py`](../../flowdesk/prerequisites.py),
[`test_readiness_semantics.py`](../../tests/test_readiness_semantics.py).

## Source identity, isolation and review

**Does a Git worktree sandbox an untrusted command?**

No. It provides a separate checkout for candidate changes. Native-provider commands
need the separately configured local Docker runtime; Codex uses its own execution
sandbox. The runtime must be tested on the platform in use. A filesystem location
alone cannot stop a process reading another directory or using the network.

**Why materialize blobs instead of using an ordinary checkout?**

Repository checkout can invoke configured filters or hooks. PlanBranch creates a
locked detached worktree without checkout, validates bounded tree entries, and
writes Git blobs itself. It rejects unsupported links/submodules and unsafe paths.
This reduces host-side effects before the agent runs but imposes repository and
size restrictions.

Read: `GitWorkspace.create` in [`execution_git.py`](../../flowdesk/execution_git.py);
`test_no_repository_filters_or_hooks_are_executed` in
[`test_execution_git.py`](../../tests/test_execution_git.py).
Concepts: capability boundaries, untrusted repository configuration, path traversal.

**Why is a successful test command not sufficient evidence?**

Exit zero can mean no tests ran. A writable command might test temporarily modified
source then restore it. Immutable verification therefore uses a read-only candidate
mount, separately writable cache/results directories and a host-recorded candidate
identity. Structured JUnit parsing distinguishes actual cases from a claimed count.
Even a passing report cannot prove that the tests cover the requirement.

**What does a source hash prove?**

It identifies a particular collection of materialized file bytes and executable
bits. It detects relevant drift against that identity. It does not prove code is
correct, a test is independent, a model understood the requirement, or an arbitrary
external report is authentic. Ignored files are included because they can affect
checks; Git metadata is excluded. Windows permission representation has a documented
limit.

**Could an agent forge host evidence in JSON?**

The ingestion boundary strips untrusted provenance unless the host evidence seal
authenticates the payload and its run. A local HMAC key stays outside the worktree
and container. External reports remain external even when they claim to be host
observations. This assumes the trusted host and key are not compromised; it is not
a third-party attestation system.

Read: [`check_evidence.py`](../../flowdesk/check_evidence.py),
[`test_immutable_evidence.py`](../../tests/test_immutable_evidence.py),
[`test_immutable_verification_live.py`](../../tests/test_immutable_verification_live.py).
Concepts: TOCTOU, immutability, HMAC, provenance, test-oracle limitations.

**What is traceability here, and how complete is it?**

The requirements paragraph has one stable project-level ID and a meaning hash.
Acceptance criteria have stable IDs and changing meaning hashes. A human can map
a criterion to changed files, an optional command and a candidate-specific note.
The requirement-to-task association is context, not automatic proof of satisfaction.
The current model does not split prose into independently managed requirements or
prove symbol-level links. Expected file areas help review but are not a complete
unrequested-change detector.

Read: [`traceability.py`](../../flowdesk/traceability.py),
[`TracePanel.tsx`](../../frontend/src/TracePanel.tsx).

**Can someone accept a result with incomplete checks?**

Human acceptance is its own explicit judgment. The system keeps missing or weak
evidence visible rather than treating process success as test completion. Acceptance
must match the current captured candidate, but it is not a theorem that all criteria
are satisfied. Do not claim that PlanBranch forces complete test coverage before
every human decision.

Read: `accept`, `complete` and `_current_artifact` in
[`execution.py`](../../flowdesk/execution.py).

## Failure, recovery and trust

**What happens if the app dies halfway through a run or application?**

Run intent is persisted before work begins. On restart, unfinished runs become
interrupted, retaining the worktree without automatically restarting the agent.
Application crosses SQLite and filesystem boundaries, so it uses a persisted
request plus a per-file journal. A retry with the original identity can recover
the same operation; newer conflicting user edits are not silently overwritten.
This is recovery logic, not a globally atomic transaction over Git and SQLite.

Read: [`execution.py`](../../flowdesk/execution.py),
[`execution_git.py`](../../flowdesk/execution_git.py),
[`test_execution.py`](../../tests/test_execution.py).
Concepts: idempotency, write-ahead intent, crash consistency, partial failure.

**What concrete defect did the portfolio audit find?**

The worker already rechecked semantic approval and source after preparing a
worktree, but progress is deliberately excluded from semantic scope. A task could
become blocked, or its prerequisite could reopen, during that preparation without
stopping launch. The repair rereads current progress and prerequisite readiness
before invoking the executor. Negative regression cases are paired with a control
showing that a harmless layout/progress edit remains allowed. This is a useful
example of why two valid state policies can still leave a gap at their boundary.
Do not attribute this diagnosis personally to the owner without confirmation.

Read: [boundary audit](BOUNDARY_AUDIT.md),
[`test_execution_readiness_races.py`](../../tests/test_execution_readiness_races.py).
Concepts: time-of-check/time-of-use, independent invariants, regression controls.

**How can the backend finish while the interface stays “Running”?**

This audit reproduced a response-ordering defect in the execution dialog. Every
two seconds, polling advanced a request ticket used to discard older responses.
If a detail request took three seconds, the next poll could make its response
obsolete before it arrived, repeatedly hiding the completed backend state.
Serializing background polls lets a valid response arrive without discarding the
existing guards for changed run selection or explicit actions such as cancellation.
Three regression tests cover those cases; the focused dialog suite passed 29 tests.
This is a UI freshness repair, not a new execution permission or proof that the
candidate is correct. Consult the final validation record for browser coverage.

Read: polling effect and `loadRun` in
[`ExecutionDialog.tsx`](../../frontend/src/ExecutionDialog.tsx),
[`ExecutionDialog.test.tsx`](../../frontend/src/ExecutionDialog.test.tsx).
Concepts: asynchronous response ordering, starvation, request identity and
separating observed state from authority. Confirm personal contribution before
claiming this diagnosis as the owner's own work.

**Can restoring an old plan restore old execution permission?**

No. Restore first preserves the current design as a recovery checkpoint, resets
progress, revokes approval/previews and increments a selection epoch. Identical
restored text therefore does not recreate the authority of an earlier selected
plan. Portable imports create new identities and do not include machine permissions.

Read: [`plan_branches.py`](../../flowdesk/plan_branches.py),
[`exports.py`](../../flowdesk/exports.py),
[`test_plan_branches.py`](../../tests/test_plan_branches.py).
Concepts: monotonic epochs, replay prevention, history versus authority.

**What are the most important remaining security assumptions?**

The application is a local single-user service, not an authenticated multi-user
server. The host, Docker daemon/image and Codex sandbox implementation are trusted.
Selected context can leave the computer after explicit provider consent; a provider
may quote it in stored responses. Tests and command-produced reports can be weak or
misleading. Path limits and runtime controls reduce particular risks, without
eliminating malicious software or prompt injection in general.

Read: [`app.py`](../../flowdesk/app.py),
[`repository_context.py`](../../flowdesk/repository_context.py),
[`command_runner.py`](../../flowdesk/command_runner.py).

## Evaluation, scalability and trade-offs

**How would you show the tool helps rather than just looks structured?**

Compare direct-agent and PlanBranch-assisted workflows from identical committed
task sources with the same specification, model/configuration, tools, permissions
and acceptance tests. Predefine coverage, unrequested modifications, test outcomes,
evidence completeness, review time, unresolved decisions and recovery measurements.
Counterbalance task order, record failures, retain raw artifacts and have humans
review ambiguous cases using a documented rubric. Report sample size and uncertainty.
Deterministic fixtures test the harness and workflow boundaries; they do not
measure AI coding performance or human productivity.

**What result would challenge the project hypothesis?**

If review takes longer without better detection of missing requirements or
unrequested changes, the extra workflow may not be worthwhile for those tasks.
Other possibilities include increased setup failures, decisions deferred rather
than resolved, or confidence inflated by evidence labels. The comparison should
measure costs as well as successful cases.

Read: [evaluation protocol and actual evidence](EVALUATION.md).
Concepts: controlled comparison, confounding, counterbalancing, independent test
oracles, missing data, small-sample limits.

**Where will the system struggle to scale?**

It currently allows one active execution per data store, preserves recovery
artifacts, and enforces bounds on tasks/files/bytes. Large connected diagrams can
expand approval scope and review burden. Concurrent collaboration and unbounded
monorepo processing are not demonstrated capabilities. Parallel execution would
require explicit ownership, scheduling, dependency and conflict policies; removing
the single-run restriction alone would not be sufficient.

**What simpler alternative did you consider?**

A written issue checklist plus a Git pull request offers a smaller maintenance
surface. PlanBranch adds integrated visual intent, source freshness, evidence
provenance and durable decision history, at the cost of more state and user actions.
Do not claim the owner considered a particular alternative historically unless
they confirm it; this is an engineering comparison available now.

## Personal contribution and honest presentation

**Which parts did you personally design or implement?**

This requires the owner's factual account. Prepare a contribution ledger with:
(1) the problem and requirements the owner defined, (2) design choices they made,
(3) code they wrote directly, (4) code generated with AI, (5) defects they diagnosed,
and (6) tests/reviews they personally performed. Link each concrete example to a
commit, issue, design note or reproducible explanation where available. Repository
authorship alone does not show who originated a design or typed every line.

**How did you use AI coding tools responsibly?**

Describe only the actual workflow: what was delegated, how proposals were checked,
which failures prompted revisions and which decisions stayed with the owner. Be
ready to explain a source-level mechanism without asking a model to answer for you.
For this portfolio audit, AI assistance produced documentation, fixtures and
targeted engineering work; the owner should review and understand it before
presenting it as part of the project.

**What should you be able to demonstrate live?**

Trace one acceptance criterion from brief to task to candidate and review. Explain
why a changed criterion invalidates evidence, why moving a node does not invalidate
intent, and why a restored plan needs fresh approval. Show an interrupted or stale
result without suggesting that it is verified. Use the disposable
[demo](DEMO.md), and distinguish recorded checks from simulated agent edits.

Before an interview, confirm the owner's original motivation, project dates,
decision ownership, personally understood fixes and actual user feedback. Do not
invent adoption, university endorsement, model benchmarks or measured gains.
