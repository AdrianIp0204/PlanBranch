# Build FlowDesk — a local-first programming planner

Build a working application in the current workspace, not merely a mockup or an architecture proposal. Inspect the repository and its instructions first. Preserve unrelated work and follow existing conventions when they are compatible with this brief.

## 1. Product and boundaries

FlowDesk is a personal, local-first web application for planning programming projects. It combines an editable decision/flowchart canvas, implementation notes and checklists, and a variable catalogue containing both planned variables and symbols detected in existing Python code.

The workflow is: create a project → diagram the logic → record decisions and variables → implement code in an external editor → rescan → compare the plan with the code → resume planning later.

This is a programming workspace, not a landing page, a chatbot, a full IDE, or an automatic code generator. No accounts, cloud database, subscriptions, telemetry, AI API keys, or external services are required. After installation and building local assets, ordinary use must work without internet access.

Use these defaults unless the existing repository provides a compelling alternative:
- Python and Flask for the local backend and application logic.
- SQLite for durable local storage.
- React and TypeScript, built with Vite, for the browser interface.
- The free React Flow package, `@xyflow/react`, for the diagram canvas.
- Python `ast` and `symtable` for static source analysis.

Keep dependencies modest. Verify APIs against the versions actually installed, record dependency versions, and commit a frontend lockfile. Do not invent library methods or depend on paid templates. Keep persistence, scanning and reconciliation in Python rather than moving the entire application into JavaScript.

The built frontend should be served by the Python application. Provide a simple documented launcher, such as `python -m flowdesk`, after initial setup. Bind to loopback only by default. Develop for Windows and Linux; document the Python and Node versions tested. Node may be needed for development/building, but normal use of the built app should not require a separate frontend development server.

## 2. Workspace interface

Create a desktop-first, functional workspace:
- A compact top bar: project name, active diagram, save state, undo/redo, scan and export actions.
- A left sidebar: project/diagram navigation and a node palette.
- A large central canvas.
- A collapsible right inspector: selected node or edge, notes, checklist and linked variables.
- A resizable or collapsible variable panel with search, filters and source details.

Use readable typography, restrained colours, visible focus states, and text/icons in addition to colour for status. Use monospace for identifiers and source snippets. Keep notes and long descriptions in the inspector rather than overcrowding nodes. Provide useful empty states and actionable error messages. Do not implement a decorative dashboard instead of the editor.

## 3. Editable decision diagrams

Support multiple named diagrams within a project. Provide start/end, process, decision, input/output and note nodes. Decisions should look distinct and support labelled outgoing branches such as Yes/No or custom conditions.

The canvas must support creating, moving, renaming, duplicating and deleting nodes; drawing and editing directed connections; editing edge labels; selection; panning; zooming; fit-to-view; and a minimap. Support branching, merging and cycles: programming loops must not be rejected just because the graph is not a tree.

Double-click a node to edit its title or open its inspector. Provide obvious Add and Connect controls as well as direct canvas interaction. Optional grid snapping is useful. Implement undo/redo for diagram edits and node metadata, grouping one completed drag into one undo action.

Do not allow canvas keyboard shortcuts to delete nodes while the user is typing in a text field. Checkboxes and inputs inside nodes must not accidentally initiate dragging. Deleting a node must handle its edges and links consistently.

Each node needs a stable ID and:
- Title, node type and position.
- Optional description, notes and pseudocode.
- User-controlled status: not started, in progress, blocked or done.
- An editable checklist with independently checked items.
- Optional target file and function/scope name.
- Links to relevant variable records.

A convenient completion checkbox may update the status, but do not store contradictory `done` and `status` values. Do not automatically mark a node complete because its checklist is checked or a variable was detected. Checklist completion and implementation status are different signals.

## 4. Notes, reasoning and progress

Support project-level notes and per-node notes/checklists. Plain text is acceptable; Markdown is useful only when rendered safely without arbitrary HTML execution.

Decision nodes should additionally offer small fields for “Why this choice?” and “Alternatives considered.” Keep these optional.

Show an understandable summary of user-recorded node statuses and a filter for blocked or unfinished nodes. Exclude purely decorative notes from task totals and make the counting rule clear. A blocked node may include a blocker explanation.

Do not invent a confidence score or claim the implementation is correct from diagram status.

## 5. Variable catalogue: planning and evidence

This is a central feature. Separate human-authored planned variables from scanner-derived code symbols, and link them explicitly. A scan must never overwrite a user's description, intended type, notes, or completion decision.

For a planned variable, allow:
- Name and description/purpose.
- Intended type as user-entered text.
- Intended file, including a file that does not exist yet.
- Intended scope kind and qualified function/class name, when known.
- Optional initial/default expression, stored as text and never evaluated.
- Implementation notes and user-controlled status.
- Links to one or more diagram nodes.

Permit incomplete plans. Show useful identifier validation, but do not require a real file or fully decided type just to save an idea. Creating a planned variable must not create or modify a source file.

For a detected symbol, show:
- Name and symbol kind: variable, parameter, import, class attribute, etc.
- Project-relative source file.
- Binding/definition location and qualified scope.
- Scope classification, with explicit global/nonlocal declarations when relevant.
- Written annotation, if any, separately from any limited inferred type.
- A short source excerpt or an on-demand read-only preview.
- Scan time and current/stale/not-detected state.

Do not use the bare variable name as its identity. `count` inside two different functions must remain distinct. Track a stable record ID and reconcile using file, qualified scope and binding identity; do not rely on line number alone. Handle ambiguous identities explicitly rather than merging guesses.

Keep “intended type” and “annotation found in code” in separate fields. An unannotated value may display “unknown.” Any simple literal-based type inference must be labelled as an inference, not a guaranteed runtime type.

Use accurate scope terminology: a Python module global belongs to that module, not automatically to the entire project. Distinguish where a name is bound from where it is referenced; do not claim a source binding location proves when an object is created at runtime.

Support searching/filtering by name, file, scope, origin, status and diagram link. Selecting a variable should reveal linked nodes; selecting a node should reveal its variables. Let a node-variable link record a planned relationship such as reads, writes or creates. Clearly label these as user-authored relationships, not automatically proven data flow.

## 6. Read-only Python code scanning

The first automatic analyser targets Python only. Manual planning may be used for other languages, but do not promise automatic analysis for them.

Allow the user to attach an explicit local source directory in project settings by entering a path and confirming read-only access. A native directory chooser is optional. Do not make a browser-only directory picker the sole way to connect a project.

Provide a “Scan / Rescan Python files” action. The user writes code in their normal editor, then rescans to refresh the catalogue. File watching is not required for version 1.

Use AST traversal and compiler symbol information, not regex-only matching. Never import, execute, `eval`, or `exec` the user's code. Static parsing must not cause project scripts or imports to run.

The tested baseline should cover module/function assignments, annotated assignments, parameters, import aliases, nested functions, explicit global/nonlocal declarations, and straightforward class-level bindings. Distinguish attributes such as `self.name` from local names; any heuristic attribute detection must be labelled. Handle or explicitly report unsupported constructs, and test that comprehension variables are not silently leaked into the wrong scope. Do not claim full type inference, runtime values, or whole-program reference resolution.

If reads/writes are displayed, limit them to supported statically resolved cases and mark ambiguous references unresolved. Record an import alias as a binding in the importing scope, separately from the original symbol's definition. Do not claim that the original definition was resolved when it was not. Function and class names may appear as separately classified symbols rather than being mixed indistinguishably with ordinary variables.

Scanning requirements:
- Restrict reads to the explicitly attached root. Resolve paths and reject escapes; skip symlinks for the first version.
- Ignore `.git`, `.venv`, `venv`, `node_modules`, caches, build outputs, the app's data directory and non-Python files by default. Provide additional user ignore patterns.
- Never crawl the entire computer or inspect secret/configuration files unnecessarily.
- Bound file count, file size and parsing work, and report skipped items. Keep large/pathological inputs from blocking the UI indefinitely.
- Handle Python source encodings, syntax errors, unsupported syntax and permission failures per file.
- Show scan results: files analysed, skipped files, errors, additions and symbols no longer detected.

A failed or incomplete scan must not imply that symbols were deleted. Preserve the last successful observations for failed files and mark them stale. Only mark a symbol “not detected” when its relevant file/root was successfully checked and it is genuinely absent from that scan.

Store source hashes or equivalent metadata for freshness. Mark code previews and locations as potentially stale when their source has changed. Do not maintain a hidden full duplicate of the source tree.

## 7. Reconciling the plan with the code

Suggest possible links using name, intended file and scope. Never auto-link by name alone. Let the user confirm or reject a proposed match.

Show separate states such as planned only, linked and detected, linked but not detected, and stale scan. Detection is not proof that a variable behaves correctly, nor that its associated task is complete.

Provide a small plan-versus-code view for unmatched plans and suspected name/file/scope/type-annotation differences. Describe differences as things to review, not automatic errors.

On rescan, refresh scanner-owned facts while preserving manual notes, statuses and confirmed links. A renamed or moved symbol should produce a relinking suggestion or a missing/stale state, never silent reassignment of annotations to a different symbol. Missing symbols must not make their planning records disappear.

## 8. Persistence, recovery and export

Use a local SQLite database as the durable source of truth. Do not rely on browser localStorage or component state as the only storage. The user must be able to close the browser, stop the Python process, restart and continue editing.

Persist project/diagram data, node positions and viewport, edges, notes, checklist states, variables, links and scan metadata. Keep machine-specific source-root settings separate from portable project content.

Provide debounced autosave and an explicit Save action. Show dirty, saving, saved and failed states, with the last successful save time. Serialize or version writes so a late response cannot replace newer edits. Detect stale project revisions from another tab rather than silently losing changes. Flush or warn about pending edits when switching projects.

Validate writes and use transactions. Failed imports or saves must leave the last valid project intact. Document the database location and provide a configurable data-directory option and an explicit backup/export action. Back up before any destructive schema migration.

Required exports:
1. A versioned JSON project file that can be imported and edited again. Preserve graph structure, metadata and internal relationships. Import as a new project by default to avoid overwriting existing work, and remap any conflicting IDs consistently. Validate schema, sizes, IDs and links before committing.
2. A PNG of the full active diagram, not only the currently visible viewport. Include node/edge labels and statuses, with readable padding and without editor controls.
3. A Markdown implementation brief containing the task nodes, decisions, notes, checklists and planned-variable table.

Portable exports must not include credentials, absolute local paths, the entire source tree, or source excerpts by default. Keep useful relative file references. Imported scan metadata must be shown as historical/unverified until the user explicitly reattaches a directory and rescans. Importing a file must never automatically grant filesystem access.

## 9. Local-app security and integrity

Local-only must not mean unrestricted filesystem endpoints. Validate the allowed host/origin and protect mutating or filesystem-access requests with an appropriate same-origin/token mechanism. Do not enable permissive wildcard CORS. Disable debug mode in the normal launcher.

Use parameterized database queries and validate API payloads. Treat project titles, notes, source text and imported JSON as untrusted data; render safely. Do not load arbitrary remote images/scripts from project content.

The application may write its own database/backups and user-requested exports, but must never change attached source projects. Deleting a planning project must not delete its source folder. Require confirmation for destructive actions.

## 10. Architecture and tests

Use straightforward modules for API routes, storage, project validation, graph state, scanning, scan reconciliation and exports. Keep the scanner independently testable. Avoid microservices, plugin systems and unnecessary abstraction.

Write backend tests and appropriate frontend/integration tests. Required acceptance scenarios:
- Create a branching diagram with a loop, add notes/checklist entries, save, restart and restore it accurately.
- Undo/redo graph changes without losing linked metadata.
- Create and persist a variable plan for a nonexistent file, then link it to a node.
- Scan two same-named variables in different functions and keep them distinct.
- Correctly classify module globals, parameters and nested global/nonlocal examples.
- Rescan after inserting lines and preserve existing annotations/links.
- Keep old observations stale, rather than deleted, when a file has a syntax error.
- Detect a genuinely removed symbol without deleting its manual planning information.
- Reject source-root escapes and avoid following symlinks.
- Show save failures and prevent older revisions overwriting newer ones.
- Round-trip JSON without losing diagrams, checklist states or variable links; reject corrupt imports without partial writes.
- Export a diagram extending outside the viewport without clipping it.
- Render hostile-looking notes as inert content.

Include a small sample project and Python fixtures demonstrating a decision, a loop, a blocked node, a planned variable, a detected variable and distinct scopes. Example data must be removable and not masquerade as the user's real data.

Run the actual tests and frontend build. Use browser automation or browser tools for the main workflow when available. Report what was run, what passed, and what remains unverified. Never claim a test passed if it was not executed.

## 11. Priorities and delivery

Build in working increments:
1. Persisted project + diagram editor + notes/checklists.
2. Manual variable catalogue + node links.
3. Read-only Python scan + reconciliation.
4. JSON/PNG/Markdown export + regression tests + usability polish.

Prioritize a coherent working core over partial implementation of many extras. Do not stop at a plan or replace actual functionality with placeholder buttons. Make reasonable low-risk implementation choices and document significant tradeoffs rather than asking a long questionnaire.

Only after the core works, consider: user-triggered automatic layout; diagram templates; graph lint warnings for disconnected nodes or unlabelled decision branches; a linked list of expected tests/edge cases; SVG/Mermaid export; or explicit revision snapshots. Warnings should not reject valid loops or automatically rearrange the user's canvas. Do not add AI, automatic source rewriting or real-time collaboration.

Deliver source code, dependency files, tests, sample data and a README. Explain Windows/Linux setup, the normal launcher, data location, backups, project attachment, exports, scanner limitations and module responsibilities. Finish with an accurate implementation summary and any known limitations.

Success means I can plan a program visually, record my thoughts and intended variables, write code elsewhere, inspect what the code currently contains, and reopen the same editable plan later without losing information.
