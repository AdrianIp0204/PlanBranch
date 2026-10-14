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

A source-bearing package requires a clean committed Git baseline. A planning-only
package can be created without a repository, but it cannot accept a returned
commit without creating a new source-bound handoff. Handoff creation reads an
attached repository; it does not grant execution permission.

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

For new local observations, check out the exact candidate cleanly in your own Git
tools, select that same repository for execution, and choose **Preview authorized
local execution**. A read-only preflight validates the candidate before opening
the ordinary Run preview. Execution still needs separate authorization and may
edit files within the approved task scope. Its observations are new local
records; they do not replace or upgrade external provenance.

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
