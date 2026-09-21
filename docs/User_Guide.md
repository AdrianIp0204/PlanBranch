# PlanBranch user guide

A local programming planner: diagram the logic, record intended variables, write code in your own editor, then compare the plan with a read-only Python scan. Projects are stored locally. The editor, scans, and exports work offline. Optional planning chat uses your existing Codex CLI ChatGPT sign-in and sends the manual plan and discussion to Codex; PlanBranch does not require or store an API key.

PlanBranch was previously named FlowDesk. The `flowdesk` Python module, data directory and export identifiers remain compatible with existing projects.

## Initial setup

Use Python 3.14 and Node 24. Installation downloads dependencies; editing, scanning, and exports work offline after building. Planning chat requires a separately installed, signed-in Codex CLI and internet access.

Clone the repository first:

```sh
git clone https://github.com/AdrianIp0204/PlanBranch.git
cd PlanBranch
```

Windows PowerShell, from this folder:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock
Set-Location frontend
npm ci
npm run build
Set-Location ..
.\.venv\Scripts\python.exe -m flowdesk
```

Linux:

```sh
python3.14 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
cd frontend
npm ci
npm run build
cd ..
.venv/bin/python -m flowdesk
```

Open [PlanBranch](http://127.0.0.1:4310). The Python process serves the built frontend and API. No Node process or frontend development server is needed for normal use. Stop the server with Ctrl+C. Run the same command to reopen saved work.

Choose a different port or data directory:

```powershell
.\.venv\Scripts\python.exe -m flowdesk --port 4311 --data-dir .local-data
```

The service binds only to `127.0.0.1`. Debug mode is disabled. If assets have not been built, the launcher page explains the build step.

## Workspace

Create a project or explicitly load the removable example. A project contains multiple named diagrams. Use the palette to add start/end, process, decision, input/output, and note nodes. Drag nodes and connect their handles, or use the Connect controls. Branches, merges, and cycles are valid. Select a connection to label it; double-click a node to inspect it.

The inspector holds description, notes, pseudocode, target file/scope, a checklist, status, blocker details, and decision reasoning. Notes are plain text, rendered without HTML execution. Completion checkboxes update status; checklist items do not. Task totals exclude note nodes.

Use the navigation button beside PlanBranch to hide or show projects and diagrams. Add nodes from the palette or the **Add node** menu above the canvas. The **Inspector** button shows or hides details. Title, status, description, and blockers stay at the top; expand the named sections for checklists, notes, pseudocode, targets, decisions, and links. Section indicators show existing content and checklist counts.

Drag the divider beside the right dock or above the catalogue to resize it. A focused divider supports arrow keys, Shift for larger steps, and Home/End for size limits. Panel dividers also support Enter to collapse; the chat composer divider preserves the input area. **Layout → Restore default layout** resets panel sizes and visibility. Chat width, inspector width, and composer height are remembered independently in this browser, outside project content and undo history. In narrow windows or at high browser zoom, use the Canvas/Chat focus controls to work in one area while retaining the other area’s state.

The variable panel supports plans for files that do not exist yet. A planned variable's type, scope, expression, purpose, notes, and status are yours to edit. Expressions are text and never evaluated. Linking a variable to a node records a user-authored reads/writes/creates relationship; it does not prove program data flow.

## Tidy a diagram

Choose **Tidy diagram** above the canvas to preview a horizontal or vertical arrangement. Choose the entire diagram or the nodes selected with Ctrl/Cmd+click. **Pin position for Tidy** in a node's inspector keeps that node fixed; dragging it manually is still allowed. Unselected nodes are also fixed in selected scope.

The preview is separate from your working canvas. Cancel changes nothing; **Apply arrangement** changes only positions in one undoable action. Pins, metadata, handles, connections, selection and saved viewports are preserved. Tidy handles branches, merges, disconnected components and loops. It reduces obvious crossings and keeps movable nodes clear of fixed nodes; fixed nodes that already overlap remain as placed. It does not promise optimal connection routing. Existing diagrams are never rearranged automatically.

## Plan with Codex

Open **Chat** in the workspace controls. The right dock spans the workspace height; opening the variable catalogue beside it keeps the conversation and composer available. Switch between chat and the inspector without losing selection, view, or edits. Drag the divider above the composer to change the balance between message history and input. Describe a goal or correction and press **Send** (Ctrl/Cmd+Enter). You can continue editing while the agent replies. If you scroll up to read earlier messages, **Jump to latest** returns to new replies.

- **Node comments:** select a node and open **Comments**, or choose **Discuss this node** in the inspector. Comments keep their original node identity across renaming and undo. If a node is deleted, its discussion remains visible with an unavailable-node label. Resolve comments when addressed; sending a chat message asks Codex to consider them.
- **Changes on the canvas:** new proposals open in the workspace. Switch between **Proposed** and **Before**, with labels for added, changed, and removed nodes and connections. Select a node or connection for details. **Back to plan** returns to the saved diagram; **Changes → Review on canvas** reopens a proposal.
- **Review actions:** **Apply changes** saves the candidate as one undoable edit. **Ask Codex** attaches the visible candidate to your next message, including your manual refinements. **Edit manually** enables the normal node/connection editor, inspector, and separate draft undo/redo. **Discard** asks for confirmation and leaves the saved plan unchanged. Stable IDs and existing variable links survive applying, except links to removed nodes. Outdated proposals cannot overwrite newer work; ask for a revised proposal instead.
- **Questions:** when a consequential decision is missing, choose an answer or **Something else**, then explicitly continue. Recommendations are never submitted automatically. Longer sets show one question at a time. Submitted answers survive restart and do not change the diagram. If you edit the plan while questions are open, **Ask again using this plan** requests an updated set. Sending a **Change direction** message replaces the pending questions.
- **Approval:** answer applicable open questions, resolve open comments and review pending proposals, then choose **Approve plan**. Approval records an exact saved snapshot. Content changes need review again; viewport or layout changes do not. **Reopen plan** explicitly withdraws approval. Approval does not start execution; running project steps is outside this release.

The composer footer offers **Model** and **Reasoning effort**. Choices come from your installed CLI's catalogue and vary by model; a catalogue entry does not guarantee account access. **CLI default** remains available if discovery fails. An unavailable saved selection requires an explicit replacement. Preferences are local to this browser and apply to the next request, including a question continuation. Use the help/details control to refresh the catalogue and inspect the latest request's settings.

Choose a named model to enable its supported reasoning levels. **CLI default** leaves both settings to Codex. If chat asks you to restart PlanBranch, stop and restart the Python server with the same data directory, then reload the browser; refreshing the browser alone cannot update a running server. The draft is retained in this tab. This can happen after rebuilding the frontend while an older server is still running. A missing model catalogue now shows recovery guidance directly in chat.

Ordinary **Retry** keeps the original context, model, reasoning level, and versioned instructions. To use changed settings or a changed plan, send a new request explicitly. After an uncertain answer submission, **Retry answers** resends the same receipt without starting a second continuation. If the answers were saved but the next agent reply fails, retry that reply; you do not need to answer again. Legacy requests without a recorded instruction contract require a new message.

Install Codex CLI separately using [OpenAI's CLI instructions](https://developers.openai.com/codex/cli/), sign in with `codex login`, then restart PlanBranch if it was already running. PlanBranch checks availability when opening chat. Missing login, limits, failed requests, and interrupted replies are shown with retry actions. Retry reuses the request identity to avoid duplicate messages or history. This integration was verified with Codex CLI 0.144.1; older versions lacking the isolation flags are rejected with an update message. PlanBranch does not read, copy, or modify your credentials.

**What is shared:** manual project content (including authored notes, variable plans and target paths), the active diagram, recent conversation, node comments, planning questions, submitted answers, and the visible candidate when you request a proposal revision. Scanner observations, source-folder permissions, and attached source files are excluded. Keep sensitive information out of authored text you send. The connector prioritizes the full manual plan, open comments, and confirmed answers within a 500 KB context budget, removing older conversation/resolved comments when needed; oversized context is rejected with an explanation. Replies have a three-minute deadline. A failed request retains its original context for retry; send a new message to use a changed plan.

Requests run in a disposable working directory with command execution, integrations, plugins, web search, and agent delegation disabled. The CLI uses a read-only sandbox with approvals disabled; it cannot execute plan steps or apply diagram changes itself. This is not a guarantee against every filesystem read: Codex 0.144.1 retains a built-in image-reading helper, although the planning instruction forbids tool use and no source root is provided. No project execution controls are included.

PlanBranch explicitly loads packaged, versioned planner instructions as developer instructions on every new request. The response schema and server validation enforce the review and question contracts. Automatic skill discovery is not required, and no `SKILL.md` is needed for normal use. Mandatory behavior does not depend on the model choosing a skill.

Manual proposal edits stay separate from the saved plan until **Apply changes**. They save to the database, are included in database backups and recover after browser closure or server restart. Draft undo/redo is local to the open review; applying creates one durable project-history action. Failed draft saves remain visible and prevent leaving until saved. Conflicting candidates are kept as separate copies. After an interrupted Apply, **Retry apply** checks its durable request without duplicating the change.

Conversation, comments, proposals, question sets, submitted answers, and approval records live outside diagram undo history. They survive restarts and are included in SQLite backups, but are intentionally omitted from portable JSON and Markdown exports. Accepted edits become ordinary content and are exported normally. Unsent composer and question-answer drafts are kept best-effort in this tab's session storage; they are not database-backed messages and are removed when submitted. Undo does not reopen replaced question sets.

## Saving and durable undo

SQLite is the durable source of truth. Saves are debounced by about 600 ms. The top bar shows unsaved, saving, saved, or failed state and the most recent successful save time. Save also flushes pending text edits.

Undo/redo is chronological across the entire project, including diagrams, notes, checklists, variable plans, and manual links. It survives restarting the browser and Python process. The latest 100 actions plus their baseline are retained. A completed mouse drag, including a multi-node drag, is one action. With a node focused, arrow keys move the selected nodes; repeated movements are grouped until about 600 ms of inactivity. Text is grouped into typing bursts. Arrow keys and text undo inside fields retain their native behavior. A new edit after Undo discards the redo branch. Selection and viewport changes do not consume undo actions. Scanner observations, source-folder permission, and planning discussion/approval records are outside this history.

Saved content and the history cursor commit together. A request retry cannot append the same history twice. Only one save is sent at a time. Another tab's changes produce a visible conflict: keep the draft as a new project, or explicitly discard it and reload. There is no automatic merge. Do not close a tab with pending/failed edits; the browser warns, but unsaved changes are not guaranteed to survive forced termination.

## Data and backups

Default database: `flowdesk.sqlite3` under:

- Windows: `%LOCALAPPDATA%\FlowDesk`
- Linux: `$XDG_DATA_HOME/flowdesk`, or `~/.local/share/flowdesk`

The startup message prints the resolved data directory. `--data-dir` overrides it. The app does not store its database in attached source folders.

Use the Backup action or the command below for a consistent SQLite backup. Backups appear in the data directory's `backups` subfolder. If you use a custom data location, include the same `--data-dir` with the backup command.

```powershell
.\.venv\Scripts\python.exe -m flowdesk backup
```

To restore, stop PlanBranch, keep a copy of the existing data directory, then put the backup **inside a new data directory as `flowdesk.sqlite3`** and launch with `--data-dir` pointing there. This avoids mixing a restored database with an old SQLite WAL file. Backups include local source attachment settings; portable JSON exports do not.

Startup applies numbered database migrations. Database version 2 adopts existing version-1 scanner tables and normalizes current content and every retained undo/redo checkpoint together. Database version 3 adds the separate planning conversation, comments, proposal, approval, and retry tables. Version 4 adds durable question sets and answers without rewriting existing history. Manual content and portable JSON remain at schema version 1. Before an upgrade that rewrites existing data, PlanBranch creates and verifies a SQLite backup, including committed data still in the WAL. Backup failure stops the upgrade. A migration failure rolls back schema, content, and history together. IDs, redo position, links, and source attachment settings are preserved. Stop other PlanBranch servers before upgrading; if the database changes during backup, startup stops and asks you to retry. An unknown newer schema is rejected.

## Read-only Python scanning

In Source settings, enter an explicit local folder and confirm read-only access. A browser directory picker is not required. Attach one root per project. Merely importing a project never authorizes source access. Source attachment is machine-specific and excluded from portable exports.

Choose Scan / Rescan after editing Python externally. The UI reports progress, file results, errors, additions, and symbols no longer detected; a running scan can be cancelled. Nothing in the source project is imported or executed, and no source file is written.

The scanner uses Python AST and compiler symbol tables. Its tested baseline includes assignments and annotations, parameters, import aliases, nested functions, explicit global/nonlocal declarations, ordinary class bindings, comprehension scoping, and labelled `self`/`cls` attribute heuristics. Function and class names are classified separately. A global is module-wide, not project-wide. A binding location is not a claim about runtime object creation.

There is no whole-program reference resolver, runtime-value evaluator, automatic reads/writes analysis, or general type inference. Written annotations are shown separately from intended types. Imports are bindings in the importing scope, not resolved definitions from another file. Wildcard imports and PEP 695 type-parameter scopes are unsupported and produce per-file explanations. Each scan allows up to 2,000 Python files, 20,000 directory entries, 1 MB per file, 10,000 bindings per file, 5 seconds of parsing per file, and 120 seconds overall.

Only `.py` files below the confirmed root are read. Symlinks and Windows junctions are skipped; resolved path escapes are rejected. Default exclusions cover Git, virtual environments, node_modules, caches, builds, and the application's data directory. Additional ignore patterns are relative to the source root. Per-file byte/parse limits and an overall scan limit prevent indefinite parsing; a supervised subprocess handles each file.

Files that fail, are skipped, or are not checked completely leave previous evidence **stale**. Only successfully checked absence becomes **not detected**. Root changes do not silently reassign old links: a different attachment starts new evidence identities, and existing links need explicit review and relinking. Same-named variables in distinct functions have distinct IDs. Simple line insertions preserve IDs. Repeated/ambiguous scopes and renamed/moved symbols require review. Previews recheck the file hash and explicitly identify stale locations.

## Plan versus code

Scans update evidence, never your descriptions, intended types, notes, or completion decisions. Suggested matches need corroborating file/scope information and must be confirmed or rejected. A name coincidence never creates an automatic link. Rejections persist. The comparison view reports unmatched plans and reviewable name/file/scope/annotation differences. Detection does not establish correctness or completion.

Search and filter plans and detected symbols in the variable panel. A variable can link to nodes in several diagrams; use its node links to navigate to a diagram, or a node's inspector to open the linked variable. Comparison states use confirmed matches: proven absence takes precedence, while stale, ambiguous, and imported evidence requires review. Ambiguous bindings show their scope and line to help you choose. Renamed bindings and fresh scans of imported projects require explicit relinking.

The catalogue shows the result count and a clear-filters action. Use arrow keys or Home/End on variable names to browse the list, then use the detail links to jump to node relationships or code review. **Back to variable** returns from a linked node to its variable details. Choosing an exact detected binding only selects it; **Confirm match** records your decision. On smaller panels, **Back to list** returns from details to the results.

Example Python files are in `examples/python`. Explicitly attach that folder to try the sample scanner workflow. The example contains independent scopes and loop logic and can be removed without affecting your own projects.

## Exports and imports

- **JSON:** versioned project content, graph, checklists, variable relationships, and relative source metadata. Import creates a new project and remaps IDs consistently. Invalid imports commit nothing. Imported evidence stays historical/unverified; explicit reattachment and rescan produce fresh evidence that you can review and link. Machine roots, authorization tokens, source excerpts, and undo history are excluded.
- **PNG:** the entire active diagram, including offscreen nodes, edge labels, statuses, and padding. Editor controls are excluded. To bound browser memory, the export surface is limited to 16,000 pixels per side and 64 million pixels overall; move widely separated nodes closer if an export exceeds the limit.
- **Markdown:** implementation notes, tasks, decisions, checklists, connections, and a planned-variable table. User text is escaped for inert rendering.

Exports intentionally preserve human-authored notes; review any secrets you manually typed into notes before sharing. PlanBranch does not add stored tokens or credentials to exports.

Portable JSON is limited to 20,000 evidence records and 10 MiB of UTF-8 JSON, including formatting. Oversized exports are rejected with an explanation instead of producing a file that cannot be imported. A full SQLite backup remains available for larger evidence catalogues. Manual project content is limited to 2 MB; undo retains up to 100 actions rather than unlimited history.

## Development and tests

Python owns validation, persistence, scanning, reconciliation, and portable exports. The frontend owns interactive draft state, checkpoint grouping, save scheduling, and diagram image rendering.

The UI/UX pass follows [UI_UX_Improvement_Prompt.md](UI_UX_Improvement_Prompt.md). The observed issues, interaction decisions, and before/after review are recorded in [UI_UX_Review.md](UI_UX_Review.md).

The agent workspace extends that work with a resizable conversation dock, model controls, and durable clarification cards. Its approved scope is in [Agent_Workspace_Improvement_Prompt.md](Agent_Workspace_Improvement_Prompt.md); implementation and verification evidence is in [Agent_Workspace_Validation.md](Agent_Workspace_Validation.md).

- `flowdesk/app.py`: protected local API and assets.
- `flowdesk/storage.py`, `validation.py`, `migrations/`: transactions, numbered upgrades, normalized records, and durable checkpoints.
- `flowdesk/scanner.py`, `scans.py`, `reconciliation.py`: pure static analysis, supervised jobs/freshness, and suggested matches.
- `flowdesk/exports.py`: portable schema, import remapping, and Markdown.
- `flowdesk/planning.py`, `codex_planner.py`: durable planning review and the restricted Codex CLI connector.
- `frontend/src`: editor, inspector, variable catalogue, history reducer, save queue, and PNG export.
- `tests`: backend, scanner, import/security, and browser acceptance tests.

Run backend tests from the project root:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

Run frontend tests and a production build:

```sh
cd frontend
npm test
npm run build
```

Browser acceptance tests use Playwright with uniquely named disposable databases and source fixtures. They cover the editor, mouse/keyboard movement, catalogue, and planning review workflows. Planning browser tests inject a deterministic test-only provider into the real API; they never invoke Codex or use personal data. The production connector is separately covered by subprocess tests. A historical live smoke check used a disposable plan and an earlier instruction version; live generation with the current revision instructions remains unverified. See [validation notes](../VALIDATION.md). All external browser HTTP requests are blocked and checked. Artifacts are saved in `output/playwright/<suite>-<unique-id>/`. Recreate the public README screenshot with `node --test scripts/capture_readme.cjs`; this uses a disposable project and a deterministic example conversation. Install its browser once, then run the test command:

```sh
cd frontend
npx playwright install chromium
npm run test:e2e
```

The tests use the workspace's Python environment by default. Set `FLOWDESK_PYTHON` for another interpreter, `FLOWDESK_APP_ROOT` to test an installed wheel from its installation directory, or `FLOWDESK_BROWSER_CHANNEL` for another installed Playwright-compatible browser channel. On Windows, the runner falls back to installed Edge if Playwright Chromium has not been downloaded.

## Installable package

After building the frontend, create a wheel containing the Python application and its built browser assets:

```powershell
.\.venv\Scripts\python.exe scripts/build_release.py
```

Install `dist/flowdesk-0.1.0-py3-none-any.whl` in a Python 3.14 environment with `python -m pip install path/to/flowdesk-0.1.0-py3-none-any.whl`, then run `python -m flowdesk`. Node and the source checkout are unnecessary for this installed application. Installing Python dependencies requires internet access unless you provide a local package cache; the editor, scanner, and exports work offline. Optional Codex chat still requires internet access.

Dependency versions are recorded in `requirements.lock`, `pyproject.toml`, and `frontend/package-lock.json`. Runtime/test results and platform limitations are recorded in [VALIDATION.md](../VALIDATION.md). The Windows/Linux CI workflow builds a wheel and runs the browser suites against that installed package.


## Durable proposal drafts

Manual proposal edits save automatically to the project database, separately from the saved plan. **Draft saved** confirms the candidate is durable; it does not mean the changes are applied or the plan is approved. Reopen a proposal after closing the browser or restarting PlanBranch to continue editing.

If another window changes the same draft, both candidates are kept. Choose **Use my copy** to continue with your recovered candidate or **Load other draft** to switch deliberately. The saved-draft selector exposes retained copies. Outdated proposals remain readable and editable; request a revised proposal before applying them to a changed plan.

Apply first records a durable request and then commits the candidate as one project-history action. If the response is interrupted, **Retry apply** checks that same request without applying twice. A pending request may also be cancelled explicitly. Discarding the proposal requires confirmation and retires its drafts. Unsaved failures remain visible with **Retry draft save**; leaving the workspace waits for a successful save.


## Reviewing a proposal

Use **Previous change**, **Next change**, or the **Review change** selector to visit changed nodes and connections. The workspace selects and brings each item into view; removed items open in Before. Arrow keys, Home and End work when a navigation button is focused. Typing in an editable field retains ordinary text navigation. Editing a candidate keeps the current review target when it still exists.

The summary counts added, changed and removed items. **Review hints** offers optional links to tasks without acceptance checklist items, unlabeled decision branches and separate flow components. These are prompts to inspect the plan, not correctness checks. Notes and valid loops do not need fixing; intentional separate flows and unfinished drafts can still be applied.


## Project brief

Open **Brief** in the top bar to edit the goal, intended user, requirements, constraints, exclusions, agreed decisions and assumptions. Changes save automatically and participate in project Undo/Redo. Editing the brief makes an existing plan approval outdated. Keep uncertain assumptions in their own field until you agree to adopt them.

The brief is included in each new planning request, even when older conversation messages are omitted. Codex can propose brief updates, which appear in the existing review workspace alongside any diagram changes. Compare Before and Proposed, edit the candidate, request a revision, Apply or Discard. Saving a proposal draft never changes the saved brief. JSON and Markdown exports include the brief; older project files import with an empty brief.
