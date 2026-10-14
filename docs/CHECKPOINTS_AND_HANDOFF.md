# Checkpoints, alternatives and external coding agents

Named checkpoints preserve the current saved project brief, diagrams, tasks,
dependencies, acceptance criteria, variables and source references. They are
independent of the bounded undo history and persist across restarts. Open
**Checkpoints and alternatives**, enter a name and optional explanation, and
choose **Save named checkpoint**.

Snapshots also retain metadata-only repository inspection references from
accepted proposals: file/range/symbol and content identities, provider/model,
revision, and the package identity. No excerpts or transmission consent are
copied. These are clearly labelled historical inspection references, not current
evidence or permission to send source again.

**Duplicate as alternative** preserves another logical design without selecting
it. Select an alternative to edit it, then use **Compare with current** to review
requirements, diagram semantics, task scope, criteria and references. Canvas
movement and progress are omitted from that comparison. These alternatives do
not create or switch Git branches.

Comparison uses the same versioned semantic policy as approval. It presents each
changed field with its saved and current value, including project names and node
blocker text. Reordering identity-based collections alone does not count as an
intent change. Historical repository-inspection receipts appear separately and
do not affect the semantic comparison or approval fingerprint.

Selecting an alternative or restoring a checkpoint first saves the active design
as an immutable recovery checkpoint. The previous alternative's latest snapshot
is updated to that recovery point. Task, diagram and variable progress is reset;
approvals and execution previews are revoked. A monotonically increasing plan
selection epoch prevents old runs from regaining authority after switching back
to identical content. Historical approvals, runs and evidence remain history.
Active runs and unfinished checkout application block a plan switch until they
are cancelled, finished or recovered. The save queue preserves unsaved local
work before any server-authored plan replacement.

## Handoff and return

Select an approved Build task and expand **Use an external coding agent**.
**Preview implementation handoff** prepares a frozen, versioned package and
shows the exact Markdown brief and JSON manifest. Copy or download only after
reviewing those contents. The package includes the selected task, relevant
diagram references, requirements, decisions, constraints, criteria, original
source commit and content identities. Private planning chat and other tasks are
not included. Repository source is omitted by default. Optional supporting
context is supplied explicitly by pasting selected excerpts into the export
field; it is shown in the preview and covered by the manifest hash. This export
selection is independent of planning-provider source consent.

A source-bound package requires a clean committed Git baseline. The explicitly
selected execution repository takes precedence over the scanner selection. If
that execution selection is broken, repair or deliberately replace it before
exporting. A scanner-only folder that is not itself a Git root produces a
planning-only package with an unavailable base; PlanBranch does not expand a
subfolder selection to its enclosing repository. A planning-only package cannot
accept a returned commit; create a new source-bound handoff first. Handoff
creation reads an attached repository; it does not grant execution permission.
The repository identity and selection are frozen at export. Changing either
requires a new handoff. Older exports without this binding remain readable but
cannot authorize a new commit import or local verification.

To return work, make the external candidate commit available in the local
repository using your existing Git tools. Choose the original handoff, select
**Use return template**, and replace `candidateCommit` with its full commit hash.
An optional JSON report can describe external checks. PlanBranch verifies the
manifest, project, task, base and candidate identities, checks that the base is
an ancestor, and reads bounded Git objects to render the changed files. It does
not fetch, check out, run repository hooks, execute the report, or apply files.
Symlinks, submodules, escaping paths, unsupported portable filenames and
oversized changes are rejected. This release accepts local commit references;
convert a portable patch to a commit in your existing tools before returning it.

The review is part of the selected task workspace. Imported test reports always
remain **External result reported**, even if they contain an `origin: host`
claim. HTML and command strings render as text. Human acceptance records a
review note only; it does not approve execution, certify tests, apply code,
create a commit or mark the task done. Changed task meaning or plan selection
quarantines the result as stale. A clean checkout at either the original base or
the exact returned candidate can be reviewed; another source revision or dirty
working tree is reported as drift. **Export external review JSON** preserves the
candidate, diff, report, human review history and fixed external provenance in a
versioned review document; it is not an execution or application package.

For new local observations, select the execution repository before exporting
the handoff. Check out the exact returned candidate cleanly in your own Git
tools, keep that same selection, and expand **Verify returned
candidate without editing**. Enter a check yourself, then choose **Preview
verification without editing**. The preview binds the returned content hash,
commit, selected repository, command, timeout and runtime. Explicitly authorize
that check before choosing **Run verification without editing**. The service
revalidates the binding at start and before execution. No provider or coding
agent is called. The Docker runtime mounts candidate source read-only, with
separate writable temporary, cache and artifact directories. Unsupported checks
that need to edit source fail rather than gaining write access. These are new
local observations, available in saved local verification history; they never
replace or upgrade the external report. Process success alone does not prove a
requirement, and this verification action cannot apply code or complete a task.

## Persistence and limits

Database migration 12 adds immutable snapshot and handoff records, alternative
selection and decision records, idempotent plan-action receipts, external
results and human reviews. It does not rewrite existing project content or
historical evidence. Existing SQLite transaction and migration conventions are
used; there is no second execution engine or parallel project state store.

Supporting excerpts and external reports are each limited to 64 KB of UTF-8
data. Commit review retains the execution
layer's portable path checks, 512 changed-file limit, 2 MiB per-file limit and
16 MiB aggregate change/diff limit. A content hash establishes byte identity,
not correctness or independent authenticity. Credentials should never be put
in project prose or explicitly selected excerpts.
