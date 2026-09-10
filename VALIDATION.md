# FlowDesk validation

Verification date: 10 September 2026. Local environment: Windows, Python 3.14.3, Node 24.14.0, npm 11.9.0. Dependency versions are pinned in the Python lockfile and frontend package lockfile.

## Executed checks

| Check | Result |
| --- | --- |
| Backend: `.venv/Scripts/python.exe -m pytest -q` | 78 passed, 2 skipped |
| Frontend: `npm test` from `frontend` | 17 passed |
| Production assets: `npm run build` | Passed TypeScript checks and Vite build |
| Release: `.venv/Scripts/python.exe scripts/build_release.py` | Built an installable wheel containing Python and browser assets |
| Installed-package browser acceptance: `node --test tests/browser.test.cjs` | 9 scenarios passed (10 runner results including the parent), no failures |

For the final browser run, the wheel was installed with `pip install --no-deps --no-index --target output/wheel-install-final dist/flowdesk-0.1.0-py3-none-any.whl`. `FLOWDESK_APP_ROOT` pointed at that installation, and the test started `python -m flowdesk` from there using the verified Python environment. This confirmed the application and scanner worker run from the installed package, with its own bundled assets and no frontend server. External HTTP requests were blocked; none were attempted.

The browser scenarios covered node metadata and text safety; real drag grouping and undo/save/Python restart/redo; a second diagram and independent checklist status across restart; a planned variable for a nonexistent file and its node link; real source scans and freshness; delayed save responses; conflicting tabs; failed saves blocking project switches; and full-diagram PNG export with no runtime errors. The final PNG was 9,080 × 1,760 pixels. Pixel checks verified diagram ink, a distant node, its connection, and padding; visual inspection confirmed readable labels and arrowheads. Browser artifacts are in `output/playwright/` and are excluded from Git.

The two skipped tests require creating symbolic links, which this Windows account does not permit. The separate Windows junction test ran and passed. Linux instructions and a Windows/Linux CI matrix are included, but Linux and remote CI have not been run in this workspace.

## Acceptance coverage

1. **Persisted planning editor:** relational graph restoration, all node categories, branches and loops, metadata/checklists, multiple diagrams, saved viewports, restart-safe undo/redo, history grouping/branching/retention, preserved IDs and relationships, transaction rollback on injected failure, idempotent retries, stale revision rejection, and valid SQLite backup restoration. Frontend tests cover save ordering, failure recovery, draft retention, and safe history navigation.
2. **Manual variable catalogue:** incomplete plans and nonexistent target files, inert expression text, node relationships, validation and cross-project ownership, deletion/undo restoration, and separation of manual state from detected observations.
3. **Python scanning:** distinct same-named bindings, parameters/imports/classes, nested global/nonlocal declarations, comprehension scopes, attribute heuristics, stable identities after line insertion, renamed/removed bindings, ambiguous identities, syntax/encoding failures, stale evidence, limits/cancellation/interruption, ignored paths, path escapes, junctions, unchanged source bytes, preview hash checks, and match suggestions/confirmed/rejected decisions.
4. **Portable export:** JSON round-trip and ID remapping, graph/checklist/variable relationships, atomic corrupt-import rejection, historical imported evidence without source permissions, removal of machine metadata, Markdown escaping, and consistent evidence-count/UTF-8 byte limits. PNG is checked through the browser against actual image pixels, including a distant node and its connection.

Security checks reject invalid hosts, origins, tokens, graph references, and ownership. Hostile-looking notes remain inert. Package staging tests verify stale assets are replaced, existing source is preserved, and failed staging does not destroy the previous release.

## Practical limits

- Ordinary operation is local. Installation/building needs dependency downloads unless a package cache is supplied.
- Manual content is limited to 2 MB; project history retains 100 undoable actions and a baseline. Unsaved drafts cannot be guaranteed after forced browser termination.
- JSON is limited to 20,000 evidence records and 10 MiB including formatting. Larger catalogues retain the full database-backup option. Exports do not silently drop observations.
- PNG exports are bounded to a 16,000-pixel side and 64 million pixels overall. Very widely spread diagrams must be brought closer together.
- Python scanning is static and bounded; wildcard imports and PEP 695 type-parameter scopes are explicitly unsupported. It does not infer runtime values or prove correctness.
- Imported evidence and evidence from a replaced source root require manual relinking to fresh scan results. Attaching a directory never retroactively grants trust to imported observations.
- There is no automatic conflict merge; the second draft can be kept as a new project or explicitly discarded.
