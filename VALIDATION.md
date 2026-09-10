# FlowDesk validation

Verification date: 10 September 2026. Tested on Windows and Ubuntu 24.04 under WSL2, using Python 3.14.3, Node 24.14.0, and npm 11.9.0 on both. Windows browser: installed Edge 152.0.4191.66. Linux browser: Playwright Chromium 153.0.8010.12. Dependency versions are pinned in the Python lockfile and frontend package lockfile.

## Executed checks

| Check | Windows | Linux (WSL2) |
| --- | --- | --- |
| Backend: `python -m pytest -q -rs` | 94 passed, 2 skipped | 95 passed, 1 skipped |
| Frontend: `npm test` | 23 passed | 23 passed |
| Production assets: `npm run build` | TypeScript and Vite passed | TypeScript and Vite passed |
| Release: `python scripts/build_release.py` | Wheel built and installed | Wheel built and installed |
| Installed-package browser acceptance: `npm run test:e2e` | 16 scenarios passed | 16 scenarios passed |

Each browser run used a freshly built wheel installed with `pip install --no-deps --no-index --target ... dist/flowdesk-0.1.0-py3-none-any.whl`. Windows used `output/reliability-wheel-windows`; Linux used `output/wheel-linux` in the disposable Linux checkout. `FLOWDESK_APP_ROOT` pointed at the installation, and the harness started `python -m flowdesk` from there. The application and scanner worker ran from the installed package with bundled assets and no frontend server. All external browser HTTP requests were blocked; none were attempted. There were no browser runtime errors. The three browser suites report 18 passing runner results including two parent tests, representing 16 scenarios.

Browser coverage includes node metadata and inert text; mouse and keyboard movement; multi-selection and selection-box dragging; save/Python restart/undo/redo with stable IDs and positions; native text and checkbox key behavior; independent checklist status; cross-diagram variable links and navigation; search and filtering; delete/save/restart/undo restoration; real source scans; confirm/reject/relink decisions; stale, missing, ambiguous, and imported evidence; delayed source/preview/save responses; conflicting tabs; failed saves blocking project switches; and full-diagram PNG export. The final Windows PNG was 9,080 × 1,760 pixels. Pixel checks on both platforms verified diagram ink, a distant node, its connection, and padding. The Windows workspace was visually inspected for readable labels and arrowheads.

Final Windows artifacts are in `output/playwright/acceptance-5XvXMv`, `movement-asHBDU`, and `catalogue-{links-mNVDLS,relink-WBWEpw,trust-McVz6N}`. Linux logs are in `output/linux-verification/linux-results/` and browser artifacts in `output/linux-verification/browser-artifacts.tar`. These generated files are excluded from Git.

The Windows skips require symbolic-link creation permission; both ran and passed on Linux. The Linux skip is the Windows junction test, which ran and passed on Windows. WSL verification used isolated runtimes, dependencies, and source/database fixtures under `/var/tmp`; missing Chromium libraries were extracted locally without installing system packages. Remote CI, a native Linux desktop session, other browsers, and other Python/Node versions were not tested. The CI workflow now builds and installs a wheel before running these same browser suites on Windows and Ubuntu.

The rebuilt wheel includes `flowdesk/migrations/__init__.py`, `001_initial.sql`, and `002_scanner.sql`. Its Python/SQL files and frontend assets match the working sources and the tested Windows installation byte for byte. A database created by the installed application has migration ledger entries 1 and 2 and passes integrity and foreign-key checks. Release checksum and PNG dimensions are recorded in `output/release-verification.json`.

## Acceptance coverage

1. **Persisted planning editor:** relational graph restoration, all node categories, branches and loops, metadata/checklists, multiple diagrams, saved viewports, restart-safe undo/redo, history grouping/branching/retention, preserved IDs and relationships, transaction rollback on injected failure, idempotent retries, stale revision rejection, and valid SQLite backup restoration. Frontend tests cover save ordering, failure recovery, draft retention, and safe history navigation.
2. **Manual variable catalogue:** incomplete plans and nonexistent target files, inert expression text, filtering, multiple node relationships across diagrams, navigation in both directions, validation and cross-project ownership, deletion/save/restart/undo restoration, and separation of manual state from detected observations. UI comparison state precedence agrees with backend results for missing, stale, ambiguous, and imported evidence. Delayed responses cannot overwrite a newly selected preview or an attachment path being typed.
3. **Python scanning:** distinct same-named bindings, parameters/imports/classes, nested global/nonlocal declarations, comprehension scopes, attribute heuristics, stable identities after line insertion, renamed/removed bindings, ambiguous identities, syntax/encoding failures, stale evidence, limits/cancellation/interruption, ignored paths, path escapes, junctions, unchanged source bytes, preview hash checks, and match suggestions/confirmed/rejected decisions.
4. **Portable export:** JSON round-trip and ID remapping, graph/checklist/variable relationships, atomic corrupt-import rejection, historical imported evidence without source permissions, removal of machine metadata, Markdown escaping, and consistent evidence-count/UTF-8 byte limits. PNG is checked through the browser against actual image pixels, including a distant node and its connection.

Security checks reject invalid hosts, origins, tokens, graph references, and ownership. Hostile-looking notes remain inert. Package staging tests verify stale assets are replaced, existing source is preserved, and failed staging does not destroy the previous release.

Numbered migration regressions cover fresh databases, version-1 databases with and without the old runtime-created scanner tables, normalization of every retained checkpoint, preserved redo cursor/IDs/metadata/links/source permissions, verified pre-upgrade backups, committed live-WAL data, backup failure/corruption, invalid redo content, concurrent writes during backup, future schema rejection, and rollback of schema/current/history/attachment writes after an injected later-migration failure. The original brief's SHA-256 remains `A45D6A4ACAE38EB65981322D700D8365EC7499EE0B631163C029C8F79063027E`; the existing `.local-data` database was not used or upgraded during verification.

## Practical limits

- Ordinary operation is local. Installation/building needs dependency downloads unless a package cache is supplied.
- Manual content is limited to 2 MB; project history retains 100 undoable actions and a baseline. Unsaved drafts cannot be guaranteed after forced browser termination.
- JSON is limited to 20,000 evidence records and 10 MiB including formatting. Larger catalogues retain the full database-backup option. Exports do not silently drop observations.
- PNG exports are bounded to a 16,000-pixel side and 64 million pixels overall. Very widely spread diagrams must be brought closer together.
- Python scanning is static and bounded; wildcard imports and PEP 695 type-parameter scopes are explicitly unsupported. It does not infer runtime values or prove correctness.
- Imported evidence and evidence from a replaced source root require manual relinking to fresh scan results. Attaching a directory never retroactively grants trust to imported observations.
- There is no automatic conflict merge; the second draft can be kept as a new project or explicitly discarded.
