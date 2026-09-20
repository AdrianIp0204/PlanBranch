# FlowDesk

A local programming planner: diagram the logic, record intended variables, write code in your own editor, then compare the plan with a read-only Python scan. Projects are stored locally. The editor, scans, and exports work offline. Optional planning chat uses your existing Codex CLI ChatGPT sign-in and sends the manual plan and discussion to Codex; FlowDesk does not require or store an API key.

## Initial setup

Use Python 3.14 and Node 24. Installation downloads dependencies; editing, scanning, and exports work offline after building. Planning chat requires a separately installed, signed-in Codex CLI and internet access.

Clone the repository first:

```sh
git clone https://github.com/AdrianIp0204/FlowDesk.git
cd FlowDesk
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

Open [FlowDesk](http://127.0.0.1:4310). The Python process serves the built frontend and API. No Node process or frontend development server is needed for normal use. Stop the server with Ctrl+C. Run the same command to reopen saved work.

Choose a different port or data directory:

```powershell
.\.venv\Scripts\python.exe -m flowdesk --port 4311 --data-dir .local-data
```

The service binds only to `127.0.0.1`. Debug mode is disabled. If assets have not been built, the launcher page explains the build step.

## Workspace

Create a project or explicitly load the removable example. A project contains multiple named diagrams. Use the palette to add start/end, process, decision, input/output, and note nodes. Drag nodes and connect their handles, or use the Connect controls. Branches, merges, and cycles are valid. Select a connection to label it; double-click a node to inspect it.

The inspector holds description, notes, pseudocode, target file/scope, a checklist, status, blocker details, and decision reasoning. Notes are plain text, rendered without HTML execution. Completion checkboxes update status; checklist items do not. Task totals exclude note nodes.

Use the navigation button beside FlowDesk to hide or show projects and diagrams. Add nodes from the palette or the **Add node** menu above the canvas. The **Inspector** button shows or hides details. Title, status, description, and blockers stay at the top; expand the named sections for checklists, notes, pseudocode, targets, decisions, and links. Section indicators show existing content and checklist counts.

Drag the divider beside the right dock or above the catalogue to resize it. A focused divider supports arrow keys, Shift for larger steps, and Home/End for size limits. Panel dividers also support Enter to collapse; the chat composer divider preserves the input area. **Layout → Restore default layout** resets panel sizes and visibility. Chat width, inspector width, and composer height are remembered independently in this browser, outside project content and undo history. In narrow windows or at high browser zoom, use the Canvas/Chat focus controls to work in one area while retaining the other area’s state.

The variable panel supports plans for files that do not exist yet. A planned variable's type, scope, expression, purpose, notes, and status are yours to edit. Expressions are text and never evaluated. Linking a variable to a node records a user-authored reads/writes/creates relationship; it does not prove program data flow.

## Plan with Codex

Open **Chat** in the workspace controls. The right dock spans the workspace height; opening the variable catalogue beside it keeps the conversation and composer available. Switch between chat and the inspector without losing selection, view, or edits. Drag the divider above the composer to change the balance between message history and input. Describe a goal or correction and press **Send** (Ctrl/Cmd+Enter). You can continue editing while the agent replies. If you scroll up to read earlier messages, **Jump to latest** returns to new replies.

- **Node comments:** select a node and open **Comments**, or choose **Discuss this node** in the inspector. Comments keep their original node identity across renaming and undo. If a node is deleted, its discussion remains visible with an unavailable-node label. Resolve comments when addressed; sending a chat message asks Codex to consider them.
- **Changes:** inspect each proposed addition, removal, and field change before **Accept changes** or **Reject changes**. Acceptance is one normal undoable edit, with stable IDs and existing variable links preserved except links to explicitly removed nodes. Proposals based on a different plan cannot overwrite later edits; request an updated proposal instead.
- **Questions:** when a consequential decision is missing, choose an answer or **Something else**, then explicitly continue. Recommendations are never submitted automatically. Longer sets show one question at a time. Submitted answers survive restart and do not change the diagram. If you edit the plan while questions are open, **Ask again using this plan** requests an updated set. Sending a **Change direction** message replaces the pending questions.
- **Approval:** answer applicable open questions, resolve open comments and review pending proposals, then choose **Approve plan**. Approval records an exact saved snapshot. Content changes need review again; viewport or layout changes do not. **Reopen plan** explicitly withdraws approval. Approval does not start execution; running project steps is outside this release.

The composer footer offers **Model** and **Reasoning effort**. Choices come from your installed CLI's catalogue and vary by model; a catalogue entry does not guarantee account access. **CLI default** remains available if discovery fails. An unavailable saved selection requires an explicit replacement. Preferences are local to this browser and apply to the next request, including a question continuation. Use the help/details control to refresh the catalogue and inspect the latest request's settings.

Choose a named model to enable its supported reasoning levels. **CLI default** leaves both settings to Codex. If chat asks you to restart FlowDesk, stop and restart the Python server with the same data directory, then reload the browser; refreshing the browser alone cannot update a running server. The draft is retained in this tab. This can happen after rebuilding the frontend while an older server is still running. A missing model catalogue now shows recovery guidance directly in chat.

Ordinary **Retry** keeps the original context, model, reasoning level, and versioned instructions. To use changed settings or a changed plan, send a new request explicitly. After an uncertain answer submission, **Retry answers** resends the same receipt without starting a second continuation. If the answers were saved but the next agent reply fails, retry that reply; you do not need to answer again. Legacy requests without a recorded instruction contract require a new message.

Install Codex CLI separately using [OpenAI's CLI instructions](https://developers.openai.com/codex/cli/), sign in with `codex login`, then restart FlowDesk if it was already running. FlowDesk checks availability when opening chat. Missing login, limits, failed requests, and interrupted replies are shown with retry actions. Retry reuses the request identity to avoid duplicate messages or history. This integration was verified with Codex CLI 0.144.1; older versions lacking the isolation flags are rejected with an update message. FlowDesk does not read, copy, or modify your credentials.

**What is shared:** manual project content (including authored notes, variable plans and target paths), the active diagram, recent conversation, node comments, planning questions, and submitted answers. Scanner observations, source-folder permissions, and attached source files are excluded. Keep sensitive information out of authored text you send. The connector prioritizes the full manual plan, open comments, and confirmed answers within a 500 KB context budget, removing older conversation/resolved comments when needed; oversized context is rejected with an explanation. Replies have a three-minute deadline. A failed request retains its original context for retry; send a new message to use a changed plan.

Requests run in a disposable working directory with command execution, integrations, plugins, web search, and agent delegation disabled. The CLI uses a read-only sandbox with approvals disabled; it cannot execute plan steps or apply diagram changes itself. This is not a guarantee against every filesystem read: Codex 0.144.1 retains a built-in image-reading helper, although the planning instruction forbids tool use and no source root is provided. No project execution controls are included.

FlowDesk explicitly loads packaged, versioned planner instructions as developer instructions on every new request. The response schema and server validation enforce the review and question contracts. Automatic skill discovery is not required, and no `SKILL.md` is needed for normal use. Mandatory behavior does not depend on the model choosing a skill.

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

Use the Backup action or the command below for a consistent SQLite backup. Backups appear in the data directory's `backups` subfolder.

```powershell
.\.venv\Scripts\python.exe -m flowdesk backup
```

To restore, stop FlowDesk, keep a copy of the existing data directory, then put the backup **inside a new data directory as `flowdesk.sqlite3`** and launch with `--data-dir` pointing there. This avoids mixing a restored database with an old SQLite WAL file. Backups include local source attachment settings; portable JSON exports do not.

Startup applies numbered database migrations. Database version 2 adopts existing version-1 scanner tables and normalizes current content and every retained undo/redo checkpoint together. Database version 3 adds the separate planning conversation, comments, proposal, approval, and retry tables. Version 4 adds durable question sets and answers without rewriting existing history. Manual content and portable JSON remain at schema version 1. Before an upgrade that rewrites existing data, FlowDesk creates and verifies a SQLite backup, including committed data still in the WAL. Backup failure stops the upgrade. A migration failure rolls back schema, content, and history together. IDs, redo position, links, and source attachment settings are preserved. Stop other FlowDesk servers before upgrading; if the database changes during backup, startup stops and asks you to retry. An unknown newer schema is rejected.

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

Exports intentionally preserve human-authored notes; review any secrets you manually typed into notes before sharing. FlowDesk does not add stored tokens or credentials to exports.

Portable JSON is limited to 20,000 evidence records and 10 MiB of UTF-8 JSON, including formatting. Oversized exports are rejected with an explanation instead of producing a file that cannot be imported. A full SQLite backup remains available for larger evidence catalogues. Manual project content is limited to 2 MB; undo retains up to 100 actions rather than unlimited history.

## Development and tests

Python owns validation, persistence, scanning, reconciliation, and portable exports. The frontend owns interactive draft state, checkpoint grouping, save scheduling, and diagram image rendering.

The UI/UX pass follows [UI_UX_Improvement_Prompt.md](docs/UI_UX_Improvement_Prompt.md). The observed issues, interaction decisions, and before/after review are recorded in [UI_UX_Review.md](docs/UI_UX_Review.md).

The agent workspace extends that work with a resizable conversation dock, model controls, and durable clarification cards. Its approved scope is in [Agent_Workspace_Improvement_Prompt.md](docs/Agent_Workspace_Improvement_Prompt.md); implementation and verification evidence is in [Agent_Workspace_Validation.md](docs/Agent_Workspace_Validation.md).

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

Browser acceptance tests use Playwright with uniquely named disposable databases and source fixtures. They cover the editor, mouse/keyboard movement, catalogue, and planning review workflows. Planning browser tests inject a deterministic test-only provider into the real API; they never invoke Codex or use personal data. The production connector is separately covered by subprocess tests and a synthetic live smoke check. All external browser HTTP requests are blocked and checked. Artifacts are saved in `output/playwright/<suite>-<unique-id>/`. Install its browser once, then run the test command:

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

Install `dist/flowdesk-0.1.0-py3-none-any.whl` in a Python 3.14 environment with `python -m pip install path/to/flowdesk-0.1.0-py3-none-any.whl`, then run `python -m flowdesk`. Node and the source checkout are unnecessary for this installed application. Installing Python dependencies requires internet access unless you provide a local package cache; using the installed application does not.

Dependency versions are recorded in `requirements.lock`, `pyproject.toml`, and `frontend/package-lock.json`. Runtime/test results and platform limitations are recorded in [VALIDATION.md](VALIDATION.md). The Windows/Linux CI workflow builds a wheel and runs the browser suites against that installed package.
