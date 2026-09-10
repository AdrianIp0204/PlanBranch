# FlowDesk validation

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
