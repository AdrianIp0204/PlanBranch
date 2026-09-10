# FlowDesk UI/UX review

## Baseline: 10 September 2026

The existing production wheel was served on a disposable, randomly assigned loopback port with a fresh database and temporary Python source files. The user's running server, database, and source attachments were not used. Browser requests outside the fixture origin were blocked; the baseline reported no attempted external requests or runtime errors.

Representative data includes an empty project, the removable branching/looping example, two diagrams, long titles and notes, planned variables with cross-diagram links, and real current, stale, missing, ambiguous, and imported observations. Imported observations become stale after explicit source attachment; the separate un-attached import remains historical evidence.

Prioritized issues observed in the actual browser:

1. **Readability:** ordinary inspector and catalogue controls are mostly 10–11 px; table headings and supporting scope text reach 8 px. Save feedback is small and low emphasis.
2. **Canvas space:** with inspector and catalogue open, the canvas is 768 × 265 px at a 1280 × 800 viewport, and 928 × 365 px at 1440 × 900. Navigation cannot collapse; panel resizing has no keyboard separator.
3. **Detail hierarchy:** every node field is in a long single scroll. Title, status, and blocker compete with supplemental notes, reasoning, targets, and links. Long navigation and catalogue names are truncated.
4. **Catalogue flow:** filters have no visible labels, active-filter summary, or result count. Linking and matching live below many editable fields; recovering from no results requires manually resetting each filter.
5. **Constrained windows:** at 800 × 700 the open-panel canvas falls to 390 × 190 px. The existing layout has little ability to prioritize the diagram or expose supporting work at enlarged text sizes.

**Visual direction:** retain the lightly tinted diagram workspace, use readable 13–14 px utility text and stronger alignment, and let supporting panels expand only when they help the current action.

Intended interactions: locally remembered collapsible navigation and bounded, keyboard-resizable supporting panels; a default-layout reset; a focused inspector with counted disclosures; searchable, labeled catalogue filters and a connected details/link/review flow; predictable keyboard focus, save recovery, and essential controls in smaller windows.

Baseline artifacts are in `output/playwright/ux-before-b5SPFj/`: `before-1280x800.png`, `before-1440x900.png`, `before-800x700.png`, `before-browser-zoom-200.png`, `measurements.json`, and `browser.json`. A disposable local test extension sets actual per-tab browser zoom to 200% using `chrome.tabs.setZoom`; `getZoom` verifies 2, the 1280-pixel window reflows to 640 CSS pixels, and devicePixelRatio becomes 2. The initial headless Control-plus attempt did not change zoom. The separate `before-css-zoom-200.png` is only a CSS stress check.

## Implementation and verification

The completed pass keeps the existing local application and storage architecture. Ordinary controls and supporting text now use a readable 13–14 px scale. Navigation wraps long project/diagram names and can collapse. Inspector and catalogue separators support pointer dragging, arrow keys, Shift for larger steps, Home/End limits, and Enter to collapse. The Layout menu restores defaults. Preferences live in browser storage and do not enter project history.

The inspector keeps title, status, description, and relevant blocker fields first. Counted native disclosures hold checklist, notes, pseudocode, targets, decision reasoning, and links. Catalogue filters have visible labels, result counts, clearing actions, full location context, and keyboard row navigation. Its detail navigation connects planning fields, linked nodes, and explicit code review; confirming a selected binding requires a separate action. Narrow catalogue views retain filters and offer a List return action.

Save status includes the last successful save time, while error and conflict recovery remain available. Scan progress and cancellation remain accessible after closing the source dialog. Empty projects offer working add-node and planned-variable actions. The browser checks found and resolved two focus defects: React Flow's global Space handler intercepted native disclosures, and modal opening overrode the intended field focus. Creating a node now also centers it correctly when the diagram is zoomed.

Comparable final screenshots and measurements are in `output/playwright/ux-after-91580c/`:

| View                                     | Before                                                        | After                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1440 × 900, inspector and catalogue open | Canvas 928 × 365 px                                           | Canvas 869 × 421 px, with adjustable supporting panels                                   |
| 1280 × 800, inspector and catalogue open | Canvas 768 × 265 px                                           | Canvas approximately 709 × 298 px                                                        |
| 800 × 700                                | Canvas 390 × 190 px                                           | Full-width 800 × 360 px canvas; supporting content stacks and scrolls                    |
| Actual 200% browser zoom                 | Clipped workspace; essential actions outside the visible area | 640 CSS-pixel reflow; essential actions reachable, without page-wide horizontal overflow |

The six focused browser scenarios pass against the final production frontend, with no runtime errors or external requests. They verify panel sizing/collapse, local preference persistence, unchanged history/content/viewport during layout changes, disclosure/menu/modal keyboard focus, native input and checkbox behavior, both directions of variable navigation, explicit match confirmation, retry after a failed save and layout changes, background planning and scan cancellation, empty-state actions, and node placement at 250% diagram zoom. The background scan test deliberately delays a polling response while using real temporary-file scanning, so planning and cancellation remain testable without relying on parser speed.

At both target sizes the inspector and catalogue are open. Additional captures cover 800 × 700, reduced motion, and actual 200% per-tab browser zoom. Ten representative text/background pairs, including save feedback, inspector labels, catalogue headings, node kind/status, and edge labels, meet 4.5:1; the lowest measured ratio is approximately **5.10:1**. This is a sampled contrast check, not a full accessibility certification. Essential control font-size checks pass at 13 px or larger. The existing 16 browser scenarios also pass, including durable movement/history, evidence states, conflict recovery, and unclipped full-diagram PNG export with a distant node and connecting label.

Run `node --test tests/browser.ux.test.cjs` after a frontend build, or point `FLOWDESK_APP_ROOT` at a separately installed package to verify the packaged UI. The reusable fixture is `tests/ux-fixture.cjs`; `tests/browser.ux-baseline.cjs` can recapture the old UI when pointed at a retained baseline package. See `VALIDATION.md` for the final installed-package and platform gates.

Remaining limits: narrow or heavily zoomed windows intentionally use vertical scrolling; large diagrams still require pan, zoom, fit-to-view, or temporarily collapsed panels. Long node titles remain fully editable in the inspector, while diagram shapes retain bounded titles. Layout preferences belong to the current browser and are not portable project data. No screen-reader certification or touch-device testing is claimed. Screenshots are local review artifacts and are excluded from the source commit.
