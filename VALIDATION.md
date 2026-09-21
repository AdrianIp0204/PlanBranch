## Project brief — 21 September 2026

Milestone 4 adds seven explicit brief fields, direct editing, reviewed agent updates, durable candidate drafts, manual history and portable JSON/Markdown. Migration 6 upgrades retained manual snapshots while preserving frozen requests, receipts, approvals and prepared Apply payloads. Empty schema defaults preserve older approval freshness; substantive brief changes require review and renewed approval.

Windows verification: **331 backend tests passed, 2 existing platform skips; 164 frontend tests passed**; TypeScript and production build passed. Four disposable browser cases passed across the initial lifecycle/conflict run and focused dialog rerun. They cover manual history/restart, approval freshness, long-lived planning context, reviewed brief-only edits, database draft recovery, stale rejection, old/current imports and exports, keyboard focus, both target sizes, narrow layout and actual 200% zoom with reduced motion. Visual inspection found and fixed an outer-dialog width constraint; the final regression checks field bounds and horizontal overflow. Captures: `output/playwright/brief-manual-13g3V9` and `brief-responsive-adKF94`. External browser requests were blocked; no user data, live agent or existing server was used. Linux and installed-package verification remain part of the final release gate.

## Guided proposal review — 21 September 2026

Review now provides stable item navigation, compact added/changed/removed counts and optional navigable hints. Removed nodes and connections open in Before; other targets open in Proposed. Manual edits retain the current item when possible and native field navigation. Hints check substantive checklist criteria, decision labels and weakly connected flow components while excluding notes and accepting cycles. They never gate Apply. The canvas retains a 220 px minimum height with workspace scrolling at high zoom.

Verification: full frontend suite **149 passed**, expanded focused review/workspace suites **31 passed**, TypeScript and production build passed. Three new browser scenarios passed: all seven fixture changes (nodes and connections), focus/keyboard/fit, manual-edit continuity, optional hints and intentional exceptions, 1280×800, 1440×900, narrow and genuine 200% zoom with reduced motion. Captures are under `output/playwright/guided-review-*`; zero runtime errors or external browser requests. A further restart regression confirms an open window reconnects and saves newer draft edits without reload; two API retry tests pass. This milestone changes no backend schema. All data and servers were disposable.

## Durable proposal drafts — 21 September 2026

Database migration 5 adds separate proposal candidates, revision checks, recovery copies, tombstones and immutable operation receipts. Preparing Apply persists its intent before the project-history transaction; retries retain identity across browser/server restart. Draft writes leave saved content, history and approval untouched. The old session-storage candidate is imported only when no database draft record exists.

Verification in the isolated major-pass checkout: full backend suite **308 passed, 2 Windows skips**; full frontend suite **135 passed**, then the expanded draft/workspace suites **34 passed**; TypeScript and production build passed. Five new durable-draft browser scenarios and all four existing proposal scenarios passed (the reload test now waits for the database save acknowledgement). Browsers blocked external requests and reported zero runtime errors. Fixtures cover close/restart, delayed acknowledgements, failed-save retry, conflicting tabs, interrupted/committed Apply retry, discard/late writes, both target sizes, narrow layout and actual 200% zoom. No user data or running server was used. Linux and live Codex generation were not tested in this milestone. Existing Vite chunk-size advisory remains.

# Validation

## Next major pass — milestone 1, 21 September 2026

Tidy provides an explicit isolated preview with both orientations, whole/selected scope and optional persisted pins. Apply changes positions in one manual-history action; Cancel has no effect on project content or view. A deterministic SCC/ranking and obstacle-clearance algorithm handles cycles without adding dependencies. Existing overlap between fixed nodes and globally optimal edge routing remain outside its guarantee.

Windows: 125 frontend tests and production build passed; 66 focused backend tests passed. Four disposable browser scenarios passed for both arrangements, preview/cancel, pins, selection, links/metadata and restart-safe Undo/Redo. Default Vertical preview measurement was fixed after visual checks exposed a blank initial preview. Comparable Tidy captures are in `output/playwright/tidy-preview-sizes-ucQ8of` at both target sizes. The existing connection-label browser regression passed through movement, proposal review and full-diagram PNG export. External browser requests were blocked. Further milestone and final release checks are recorded below as completed; previous results are historical, not rerun claims.

The isolated checkout is `output/next-major-pass`. Baseline artifacts are under its `output/playwright/ux-before-QyiP8e`. All app instances used new data directories/random ports; the existing running user service and data were untouched.

# PlanBranch validation

## Connection-label overlap fix — 21 September 2026

Connection labels now use their measured size and the rendered node bounds. A label that would cover a node moves to a nearby clear point on its connection; if no segment has enough room, it moves into clear space with a small dashed leader. Proposal badges reserve space too. The same renderer handles the editor, Before/Proposed previews and PNG export. This changes no node positions, saved edge data, viewport or history.

Windows verification: **117 frontend tests passed**, including five placement regressions. Production and release builds passed; a fresh offline wheel installation matched all 27 application/resource files. The focused browser regression passed against both source and the installed package. It checks horizontal bottom-to-top connections, unrelated nodes, multiline labels, keyboard/pointer label selection, movement, proposal badges, Before view and the final temporary PNG surface. Label rectangles clear every node, and exported content fits within the image. Nine existing editor/export scenarios also passed against the installed wheel, including full-diagram PNG pixels, save recovery and durable history. All test fixtures are disposable and record zero runtime errors or external HTTP requests.

Screenshots and PNGs were visually inspected; the README sample capture was refreshed. Installed overlap artifacts are in `output/playwright/edge-labels-DrMS27`, including `export-layout.json`. Logs: `output/edge-labels-frontend.log`, `edge-labels-build.log`, `edge-labels-release.log`, `edge-labels-installed-browser.log`, and `edge-labels-core-browser.log`. The new browser regression is included in the normal browser test command. Backend code, dependencies and schema are unchanged; backend and Linux suites were not rerun locally for this renderer-only fix.

## PlanBranch public release polish — 21 September 2026

FlowDesk is now branded as **PlanBranch — Visual planning for AI-assisted coding**. The app, favicon, README, repository metadata, and MIT license use the new identity. Existing Python imports, distribution name, data directories, database name, browser preferences, API header, export format, and immutable planner instruction versions remain compatible. Installed packages add a `planbranch` command alongside `flowdesk`.

The focused interaction changes clarify recovery after an interrupted Apply and disable navigation until Retry confirms its result. Opening proposal Details by keyboard moves focus into the panel; Escape, Close details, and separator collapse restore focus to its toggle while preserving edits. Four new frontend regressions cover these behaviors.

| Check | Windows result |
| --- | --- |
| Backend | 280 passed, 2 Windows symlink-permission skips |
| Frontend | 112 passed |
| Production build | Passed |
| Release wheel and offline installation | Passed; 27 application/resource files match source and build bytes |
| Installed-package browser suite | 45 passing runner results (42 scenarios), no failures |

The browser suite uses disposable databases, random ports, temporary source files and separate browser profiles, with external HTTP requests blocked. It covers model/reasoning controls, structured questions, proposal review and recovery, autosave, durable history, scanning, catalogue evidence, keyboard/focus behavior, resizing, narrow layouts, genuine 200% zoom and full-diagram PNG export. Browser fixture records report zero runtime errors and zero external HTTP requests. MIT license bytes, wheel metadata, both console aliases, favicon and page branding were checked in the built wheel.

The public README screenshot shows only a disposable sample project and a deterministic test-provider conversation, never a user's project or live model output. Recreate it with `node --test scripts/capture_readme.cjs` after the frontend build. It was captured at 1440 × 900 and visually inspected. Detailed operating instructions now live in [the user guide](docs/User_Guide.md).

Logs: `output/branding-backend-final.log`, `planbranch-frontend.log`, `planbranch-build.log`, `planbranch-release.log`, `planbranch-browser.log`, and `planbranch-capture-final.log`. The release/source receipt is `output/planbranch-package.json`; the isolated wheel and installation are under `output/planbranch-release-2ro_6803`. Generated test data, logs and packages remain outside Git.

The existing idle local service was backed up and restarted with the same data directory. Hashes confirmed all 23 existing data tables were unchanged; no proposal was applied or discarded. Existing browser tabs were left unreloaded to protect possible unsaved drafts.

This pass adds no runtime dependency or database migration. Vite's existing large-chunk advisory remains. Linux, other browser engines, screen readers, touch input and live model generation were not rerun locally for this pass; historical results below are dated separately. GitHub's workflow runs both Windows and Linux after publication; its live status is shown by the repository badge. Approval still records a plan and does not execute code.

## Visual proposal review — 20 September 2026

Agent proposals now open on an isolated canvas with Before/Proposed views and explicit added, changed, and removed markers. Users can apply the candidate, ask Codex to revise it, edit nodes/connections and metadata manually, or discard it with confirmation. The saved plan remains unchanged until Apply; applying produces one durable undo action. Draft selection, viewport, and local undo do not enter project history. Unapplied manual drafts recover best-effort from this tab's session storage, with a leave/switch guard if storage fails.

| Check | Windows result |
| --- | --- |
| Backend | 280 passed, 2 platform skips |
| Frontend | 108 passed |
| Production build | Passed |
| Release wheel and fresh offline installation | Passed; 26 application/resource files match source and build bytes |
| Installed-package browser suite | 45 passing runner results (42 scenarios), no failures |

All automated applications use disposable databases, random ports, temporary Python sources, and separate browser profiles. All 26 browser fixture records report zero runtime errors and zero external HTTP requests. Coverage includes candidate-only editing, draft reload recovery, manual title/node/connection changes, Before/Proposed comparison, one-step apply/undo, discard isolation, stale conflicts, revision context, and narrow-window/actual 200% zoom access. The existing catalogue, scanning, durable history, model/reasoning selection, structured questions, approval, save recovery, and full-diagram PNG checks also pass.

Recovery regressions cover an Apply that commits but loses its response, followed by a planning refresh showing Accepted: Retry apply replays the original receipt and synchronizes without a duplicate action. Changing the model after a failed revision retains the manually edited candidate. Browser draft validation accepts the backend's 5,000-node, 10,000-edge and 128-character-ID limits. Proposal switching cannot silently lose edits when storage fails or an Apply is unresolved. An existing chat layout fixture now explicitly selects Chat after zoom switches the workspace into its compact Canvas/Chat view; its layout assertions remain intact.

The backend exposes immutable proposal content, its available original snapshot and a content hash. Manual application is limited to the target diagram's nodes/edges; current unrelated content and surviving manual links are preserved. Candidate revision context survives retry and clarification continuation. New requests use packaged `planner-v3.md`; old frozen instruction versions remain supported. This pass adds no dependency or schema migration.

Logs: `output/proposal-frontend-final.log`, `proposal-production-final.log`, `proposal-release-final.log`, and `proposal-browser-final.log`. Package/source receipts are in `output/proposal-package.json`; browser records are collected in `output/proposal-browser-evidence.json`. The final wheel and installation are under `output/proposal-release-9h1sm6ut`. An isolated release directory was used after the Windows sandbox account became unavailable and its earlier generated package files were inaccessible; application sources and final artifacts were compared byte for byte.

Final captures include `output/playwright/proposal-workspace-jrOg8g`, `proposal-responsive-8IgtWU` (1280 × 800, 1440 × 900, narrow view and genuine 200% zoom), `agent-workspace-after-6llH5V`, and `ux-after-fsHbUd`. Generated artifacts remain outside Git. The build retains Vite's advisory about a JavaScript chunk larger than 500 KB.

After verification, the existing idle local service was backed up and restarted with the same data directory. Hashes confirmed all 23 existing data tables were unchanged. The user's existing 10-node/12-connection proposal now displays in both open browsers; no proposal was applied or discarded, and the Chrome composer draft was preserved. No live model request was sent. Agent-generation tests use the deterministic test provider, so real generation under the new revision instructions remains unverified. Linux, other browser engines, screen readers, and touch input were not rerun for this pass. The original brief's SHA-256 remains `A45D6A4ACAE38EB65981322D700D8365EC7499EE0B631163C029C8F79063027E`. No push or publication was performed.

## Chat/server compatibility fix — 20 September 2026

The reported `Unexpected fields in planning message: selection.` failure came from new frontend assets served by an older, still-running Python process. Its model catalogue endpoint returned 404. Chat now distinguishes this mismatch from ordinary CLI catalogue discovery failure, shows restart/reload guidance, and blocks message, retry, keyboard, and question-answer submissions while incompatible. A legacy validation rejection enters the same recovery state without silently dropping settings or resending. Ordinary discovery failure still permits CLI default. Drafts, preferences, and uncertain answer receipts are preserved.

The updated local service recognizes the existing Codex sign-in and returns seven catalogue models. Model and reasoning changes were verified in the user's browser and the original CLI-default preference restored; the unsent message remains present. A SQLite backup was created before startup, and hashes confirmed all 22 existing data tables were unchanged after migration added `planning_question_sets`. No message was sent to a live model during this fix.

Windows verification: 89 frontend tests passed, production assets and release wheel built, and four focused browser scenarios passed against both source and the freshly installed wheel. The scenarios cover missing endpoints, the legacy validation rejection, preserved drafts/preferences, recovery to an explicit model/effort, normal default fallback, and immutable retry settings. Each browser fixture uses disposable data and blocks external HTTP requests. Backend code was unchanged; the previous backend and Linux results below were not rerun for this frontend-only patch. The installed-package log is `output/chat-fix-installed-browser.log`.

## Agent workspace — 20 September 2026

This pass adds the full-height resizable chat dock, compact model/reasoning controls, explicit versioned planner instructions, and durable structured clarification. Schema version 4 stores question sets and answers separately from graph history. Answer submission, its readable conversation summary, and its continuation request commit together; retries preserve original settings and context. Existing edit review and exact-snapshot approval remain explicit.

All test applications use disposable databases, source folders, ports, and browser profiles. The user's running server, projects, and source attachments were not used. Both platforms use Python 3.14.3 and Node 24.14.0. Windows browser: Edge 153.0.4234.32; Linux: Playwright Chromium under Ubuntu/WSL2. No runtime dependencies were added.

| Check | Windows | Linux (WSL2) |
| --- | --- | --- |
| Backend | 252 passed, 2 skipped | 252 passed, 2 skipped |
| Frontend | 83 passed | 83 passed |
| Production assets and release wheel | Passed | Passed |
| Fresh offline package installation | Passed | Passed |
| Final installed-package browser acceptance | 35 scenarios passed (38 runner results), plus corrected-helper check | 35 scenarios passed across full run and final 10-case agent rerun |

Backend checks cover protected endpoints, semantic response validation, model/effort validation, bounded capability discovery, ignored inherited configuration, immutable retry contracts, legacy-request behavior, historical question context, atomic answer rollback, repeated/lost answer acknowledgements, competing clients, restart recovery, stale/superseded questions, and migration from version 3. Submitted questions and answers survive backups but remain outside portable exports. The Windows skips require symlink permission; Linux skips Windows npm-shim and junction behavior.

Frontend and browser checks cover pointer/keyboard resizing, reset and local preferences, preserved drafts/selection/viewport/history, following or reading older messages, supported and unavailable model choices, frozen request retries, structured choice/custom/text answers, keyboard validation, recommendation labels, pending-question access, change of direction, and answer continuation recovery. Legal object-like IDs such as `constructor` and `__proto__` cannot pick up inherited draft values. Existing editor, catalogue, scanner, save/conflict, proposal, approval, and full-diagram PNG coverage remains in the full browser run.

Comparable captures cover 1280 x 800 and 1440 x 900 with the catalogue open, plus review, request failure, question cards, 720 x 700, and actual 200% browser zoom. At default 1280 x 800, the dock has 740 px of height, including 495 px of transcript and a 150 px composer. At 1440 x 900, the transcript has 595 px. Catalogue opening does not consume chat height. At 200% zoom, the browser verifies a 640 x 400 CSS viewport and device pixel ratio 2. Sampled text contrast reaches at least 5.10:1. These are focused checks, not an accessibility certification.

Integration checks caught a missing catalogue accessible name and a sticky header covering rows in very short panes. The toggle now includes its visible label and open action in its accessible name. Short result panes scroll their headings, while taller panes retain sticky headings. The existing browser helper uses the visible List control before choosing another variable in the responsive detail view; real clicks and assertions remain intact. Its delayed scan-poll fixture now drains its own handlers before teardown. A deliberately delayed Send acknowledgement also reproduced unwanted focus restoration that closed an opened Layout menu; the regression covers respecting the user's subsequent focus.

Baseline captures: `output/playwright/agent-workspace-baseline-KkaT0q`. Final Windows captures: `agent-workspace-after-kvY0Dx`, `agent-questions-layout-nw8WD6`, and `ux-after-BdSkeY` under `output/playwright`. The final Windows package is installed in `output/wheel-agent-workspace-windows-5b52a7c5`; its full log is `output/agent-workspace-verification/windows-browser-release.log`. All 19 fixture records report zero runtime errors and zero external browser requests.

Linux final build, installation, logs, source hashes, and browser archive are in `output/agent-workspace-verification/flowdesk-agent-workspace.0ZUPi8`. Its final frontend run passed all 83 tests. The earlier full Linux backend run passed 252 tests; before reusing that result, the final run verified that every backend module, migration, instruction, dependency definition, and Python test had identical source hashes. Both release wheels contain 25 byte-identical application, migration, instruction, and frontend files. Wheel/installation/source and source-distribution resource checks are recorded in `windows-package.json`, `windows-sdist.json`, and `cross-platform-package.json`.

Linux initially passed 37 of 38 runner results. The remaining question-layout test sent a key before the next question heading received its scheduled focus. The helper now waits for that exact focus destination and asserts the radio is checked before typing. All 10 agent-workspace cases then passed against the same installed package; the corrected Windows case also passed. No application bytes changed. Rerun evidence: `linux-agent-focus-fixed-browser.log`, `linux-agent-focus-fixed-summary.json`, `linux-agent-focus-fixed-artifacts.tar`, and `windows-question-focus-fixed.json`. The rerun records report zero runtime errors and external browser requests.

The detailed audit and remaining artifact paths are in [Agent_Workspace_Validation.md](docs/Agent_Workspace_Validation.md). Generated verification artifacts are excluded from Git. The original build brief retains SHA-256 `A45D6A4ACAE38EB65981322D700D8365EC7499EE0B631163C029C8F79063027E`.

Live integration evidence is limited: installed Codex CLI 0.144.1 returned a seven-model catalogue. One synthetic version-2 generation smoke stopped at the connector's sign-in check after 7.57 seconds; **zero model requests were sent**, and there were no retries. Real model generation with the new protocol/settings remains unverified in this environment. Browser fixtures use a deterministic test-only provider, with external browser requests blocked; production has no simulated assistant fallback. Earlier successful version-1 smoke results below are historical only.

Both planner instruction versions are packaged as explicit developer resources in the wheel and source distribution. No optional `SKILL.md` invocation is needed for mandatory behavior. Tests verify the application contract and instruction delivery, not guaranteed model compliance. The CLI's retained image-reading helper means the connector is not a blanket filesystem-read guarantee. Native Linux desktops, screen readers, touch devices, other browser engines, and other Python/Node versions remain unverified. This pass does not execute plan steps or publish/push the repository.

## Previous planning collaboration — 20 September 2026

This earlier verification covered the Codex planning conversation, node comments, explicit proposal acceptance/rejection, and approval of an exact saved snapshot. All fixtures used new disposable databases and random ports. The user's running application and data directory were not used.

Both platforms used Python 3.14.3 and Node 24.14.0. Windows browser: Edge 153.0.4234.32; Linux: Playwright Chromium under Ubuntu 24.04/WSL2. No runtime dependencies were added.

| Check | Windows | Linux (WSL2) |
| --- | --- | --- |
| Backend | 149 passed, 2 skipped | 149 passed, 2 skipped |
| Frontend | 50 passed | 50 passed |
| Production assets and release wheel | Passed | Passed |
| Fresh offline package installation | Passed | Passed |
| Installed-package browser acceptance | 25 scenarios passed across the full run and focused UX rerun | 25 scenarios passed (28 runner results) |

The Windows full run passed all new planning scenarios and the editor/scanner/export regressions. An existing UX setup helper tried to double-click an offscreen node after returning from another diagram; this also prevented the next scenario from finding its inspector. The helper now uses the real Fit view control before selecting the fixture. All six UX scenarios then passed against the same unchanged installed application. The final helper was also rerun on Linux. No browser interaction was forced or bypassed.

Final Windows installation: `output/planning-wheel-windows`. Logs: `output/planning-verification/windows-browser.log` and `windows-ux-final.log`; package/source byte checks: `windows-release.json`. Planning screenshots and records are in `output/playwright/planning-review-k0YdhI`, `planning-stale-KEEYni`, `planning-layout-Ih5f3L`, and `planning-visual-cXFUsZ`; the final UX run is `ux-after-2wcYcO`. The browser records report zero external browser HTTP requests and zero runtime errors. The live Codex smoke is separate from those blocked-network browser fixtures.

Linux evidence, source hashes, wheel, logs, and browser archive: `output/planning-linux-verification/flowdesk-planning.ZCGCZh`. Linux ran from a new isolated checkout and wheel installation, reusing only previously verified runtimes and dependency bytes. The Windows skips require symlink creation permission; Linux skips the Windows junction and npm-shim-layout tests. Live Codex authentication/generation was verified only on Windows; Linux connector behavior was checked through subprocess/unit tests. Native Linux desktop, screen readers, touch devices, other engines, and other Python/Node versions remain unverified.

Screenshots cover 1280 × 800 and 1440 × 900, populated proposal review, and the catalogue-open compact layout with Send reachable by scrolling. Browser checks also cover reduced motion, narrow access, the existing actual 200% zoom workflow, readable controls, and full-diagram PNG output. The final asset rebuild was byte-identical to the tested Windows wheel. All three SQL migrations are present in the package. No application data was imported into tests, and no publishing or pushing was performed.

The live connector smoke used Codex CLI 0.144.1 and the existing ChatGPT sign-in, sending only a disposable request for a two-step tea-making plan. It returned two nodes and one edge in 19.52 seconds; the response passed normal graph validation. No user project, attached source file, or credential was read by FlowDesk. Separate offline provider probes verified that command/integration tools are disabled and a synthetic file patch is rejected by the read-only sandbox. The CLI retains an image-reading helper, so this is not a blanket filesystem-read guarantee.

Browser tests inject a deterministic test-only provider into the real Flask application; production has no simulated assistant fallback. These tests exercise inert replies, node comments, explicit rejection/acceptance, retry after a lost committed response, durable history and approval, outdated proposals, save failure recovery, keyboard navigation, resizing and per-project composer drafts. The connector has separate real-subprocess tests for time/output limits and cancellation cleanup.

New schema version 3 stores planning records independently of graph projection and undo history. Tests cover version-2 migration, backups, atomic rollback, stable IDs, source-context exclusion, project ownership, conflicting saves, repeated approval/reopen, stale worker results after restart, bounded context, and export separation.

## Previous UI/UX verification — 10 September 2026

Verification date: 10 September 2026, following the UI/UX pass. Tested on Windows and Ubuntu 24.04 under WSL2, using Python 3.14.3, Node 24.14.0, and npm 11.9.0 on both. Windows browser: installed Edge 152.0.4191.66. Linux browser: Playwright Chromium 153.0.8010.12. Dependencies remain pinned; this pass adds no runtime dependency or backend/schema change.

## Executed checks

| Check | Windows | Linux (WSL2) |
| --- | --- | --- |
| Backend: `python -m pytest -q -rs` | 94 passed, 2 skipped | 95 passed, 1 skipped |
| Frontend: `npm test` | 33 passed | 33 passed |
| Production assets: `npm run build` | TypeScript and Vite passed | TypeScript and Vite passed |
| Release: `python scripts/build_release.py` | Wheel built and installed | Wheel built and installed |
| Installed-package browser acceptance: `npm run test:e2e` | 22 scenarios passed | 22 scenarios passed |

The four browser suites report 25 passing runner results, including three parent tests, representing 22 scenarios. Each platform used a newly built wheel installed with `pip install --no-deps --no-index --target ... dist/flowdesk-0.1.0-py3-none-any.whl`. Windows used `output/ui-wheel-windows`; Linux used `output/wheel-ui-linux` inside a fresh `/var/tmp/flowdesk-ui.*` checkout. `FLOWDESK_APP_ROOT` pointed at that installation. The application and scanner worker ran through `python -m flowdesk`, with bundled assets and no frontend server. Every fixture owned its random port, database, temporary Python files, and browser context. All external browser HTTP requests were blocked; none were attempted. All six fixture reports on each platform record zero runtime errors.

Browser coverage includes metadata and inert text; mouse/keyboard movement and multi-selection; save/restart/undo/redo with stable IDs; native text and checkbox behavior; independent checklist status; cross-diagram variable links; filtering; deletion/save/restart/undo; real scans; confirm/reject/relink decisions; stale, missing, ambiguous, and imported evidence; delayed source/preview/save responses; conflicts; and failed saves blocking project switches. Full-diagram PNG exports measured 9,080 × 1,760 pixels. Pixel checks verified actual diagram ink, the distant node, its connection/label, and unclipped padding. The exported diagram and workspace screenshots were also visually inspected.

Six added UX scenarios cover pointer and keyboard separators, collapse/reset and local preferences, unchanged content/history/viewport during layout changes, disclosures and modal focus, both directions of catalogue navigation, explicit match confirmation, save retry after layout changes, background planning and scan cancellation, empty-state actions, and centered node creation at 250% diagram zoom. A focus assertion initially read the DOM before the scheduled animation frame. A throttled probe confirmed correct focus arrival; the test now waits for the exact destination before sending subsequent keys. The full Windows suite passed afterward. Linux's full suite passed, followed by another successful six-scenario UX run using the final test bytes and the same unchanged installed application.

Comparable screenshots cover 1280 × 800 and 1440 × 900 with inspector and catalogue open, plus 800 × 700 and actual 200% browser zoom. The zoom check uses a disposable extension/profile to set per-tab zoom, confirms a factor of 2 and a 640 CSS-pixel viewport, and verifies essential actions remain reachable without horizontal page overflow. Reduced-motion behavior and essential control sizes of at least 13 px pass. Ten sampled text/background pairs meet 4.5:1; the minimum measured contrast is approximately 5.10:1. These are focused checks, not a full accessibility certification. See [UI_UX_Review.md](docs/UI_UX_Review.md) for the observed issues, changes, measurements, and remaining layout limits.

Final Windows artifacts are in `output/playwright/acceptance-krNzwK`, `movement-caLn9e`, `catalogue-links-83SqlB`, `catalogue-relink-k44f5p`, `catalogue-trust-GJU53M`, and `ux-after-91580c`. The complete run log is `output/ui-windows-browser-final.log`. Baseline screenshots remain in `output/playwright/ux-before-b5SPFj`. Linux logs, source hashes, wheel, and browser archive are in `output/ui-linux-verification/flowdesk-ui.JbzNrs`; its final UX rerun is in `ux-rerun.dwWwkj`. These generated files are excluded from Git.

The two Windows skips require symbolic-link creation permission; both passed on Linux. Linux skipped the Windows junction test, which passed on Windows. WSL verification used isolated runtimes and dependencies, without installing system packages or using a personal browser profile. Remote CI, a native Linux desktop session, other browsers, touch devices, screen readers, and other Python/Node versions were not tested. No publishing or pushing was performed for this UI pass.

The rebuilt Windows wheel includes both numbered SQL migrations and their package initializer. Its Python/SQL files and frontend assets match the source build and tested installation byte for byte. An installed-application fixture database has migration ledger entries 1 and 2 and passes integrity and foreign-key checks. Its checksum and PNG dimensions are recorded in `output/ui-release-verification.json`; previous release evidence is retained separately.

## Acceptance coverage

1. **Persisted planning editor:** relational graph restoration, all node categories, branches and loops, metadata/checklists, multiple diagrams, saved viewports, restart-safe undo/redo, history grouping/branching/retention, preserved IDs and relationships, transaction rollback on injected failure, idempotent retries, stale revision rejection, and valid SQLite backup restoration. Frontend tests cover save ordering, failure recovery, draft retention, and safe history navigation.
2. **Manual variable catalogue:** incomplete plans and nonexistent target files, inert expression text, filtering, multiple node relationships across diagrams, navigation in both directions, validation and cross-project ownership, deletion/save/restart/undo restoration, and separation of manual state from detected observations. UI comparison state precedence agrees with backend results for missing, stale, ambiguous, and imported evidence. Delayed responses cannot overwrite a newly selected preview or an attachment path being typed.
3. **Python scanning:** distinct same-named bindings, parameters/imports/classes, nested global/nonlocal declarations, comprehension scopes, attribute heuristics, stable identities after line insertion, renamed/removed bindings, ambiguous identities, syntax/encoding failures, stale evidence, limits/cancellation/interruption, ignored paths, path escapes, junctions, unchanged source bytes, preview hash checks, and match suggestions/confirmed/rejected decisions.
4. **Portable export:** JSON round-trip and ID remapping, graph/checklist/variable relationships, atomic corrupt-import rejection, historical imported evidence without source permissions, removal of machine metadata, Markdown escaping, and consistent evidence-count/UTF-8 byte limits. PNG is checked through the browser against actual image pixels, including a distant node and its connection.

Security checks reject invalid hosts, origins, tokens, graph references, and ownership. Hostile-looking notes remain inert. Package staging tests verify stale assets are replaced, existing source is preserved, and failed staging does not destroy the previous release.

Numbered migration regressions cover fresh databases, version-1 databases with and without the old runtime-created scanner tables, normalization of every retained checkpoint, preserved redo cursor/IDs/metadata/links/source permissions, verified pre-upgrade backups, committed live-WAL data, backup failure/corruption, invalid redo content, concurrent writes during backup, future schema rejection, and rollback of schema/current/history/attachment writes after an injected later-migration failure. The original brief's SHA-256 remains `A45D6A4ACAE38EB65981322D700D8365EC7499EE0B631163C029C8F79063027E`; verification did not target `.local-data` or the user's running server.

## Practical limits

- Ordinary operation is local. Installation/building needs dependency downloads unless a package cache is supplied.
- Manual content is limited to 2 MB; project history retains 100 undoable actions and a baseline. Unsaved drafts cannot be guaranteed after forced browser termination.
- JSON is limited to 20,000 evidence records and 10 MiB including formatting. Larger catalogues retain the full database-backup option. Exports do not silently drop observations.
- PNG exports are bounded to a 16,000-pixel side and 64 million pixels overall. Very widely spread diagrams must be brought closer together.
- Python scanning is static and bounded; wildcard imports and PEP 695 type-parameter scopes are explicitly unsupported. It does not infer runtime values or prove correctness.
- Imported evidence and evidence from a replaced source root require manual relinking to fresh scan results. Attaching a directory never retroactively grants trust to imported observations.
- There is no automatic conflict merge; the second draft can be kept as a new project or explicitly discarded.
