# Agent workspace implementation and verification

Implementation date: 2026-09-20. This record distinguishes deterministic application checks from live model behavior. The user's database, attached folders, browser profile, and running server were not used.

## Baseline (2026-09-20)

Source baseline: `d658d9b`. The only pre-existing untracked change was the approved implementation-prompt document. The user database and running application were not used.

- Windows backend baseline: **149 passed, 2 skipped** (symbolic-link privileges).
- Frontend baseline: **50 passed** across 7 files.
- Production browser baseline: disposable database, source directory, port and browser profile; deterministic test-only planner; external browser HTTP requests blocked.
- 14 screenshots cover empty, branching/populated, long conversation with selected node, open catalogue, review and failed request at 1280 x 800 and 1440 x 900, plus 720 x 700 and genuine 200% browser zoom.
- Artifacts: `output/playwright/agent-workspace-baseline-KkaT0q`; `measurements.json`, `browser.json`, and `server.log` accompany screenshots.

Confirmed issues: the 1280 x 800 empty chat dock has 550 px available height but a 600 px panel; Send extends below its container. Opening the catalogue hides the composer altogether in the initial view. The right dock is compressed by the diagram toolbar and catalogue; repeated help and approval copy further reduces conversation height. Current agent instructions request prose clarification and the output protocol has no question objects.

Visual direction: a quiet editor workspace with a full-height agent dock, compact controls, and one dominant conversation surface.

## Requirement audit

| Area | Required evidence | Current state |
|---|---|---|
| Full-height dock and independent catalogue | Target-size screenshots and measured containment | Implemented; 1280 x 800 dock is 740 px tall, with 495 px of history and a 150 px composer at defaults. At 1440 x 900, history grows to 595 px. Opening the catalogue does not reduce chat height. |
| Composer/dock resizing, reset and persistence | Pointer/keyboard browser checks and layout unit tests | Pointer, arrow keys, Home/End, bounds, reset, local preferences, and collapse covered. Neither resize boundary writes project history. |
| Narrow focus view, true zoom, motion and contrast | Browser geometry/focus checks and screenshots | 720 x 700 focus views and genuine 200% zoom (640 x 400 CSS pixels, device pixel ratio 2); essential actions reachable, reduced motion respected, sampled contrast minimum 5.10:1. |
| Draft, viewport, selection and save/history preservation | State and browser recovery scenarios | Layout changes preserve drafts, selection, positions, viewport, and saved content/history. Auto-follow stops while reading older messages; Jump to latest is explicit. |
| Model/effort capability discovery and isolation | Synthetic-config process checks, bounded adapter tests, live metadata probe | Installed CLI 0.144.1 returned 7 catalogue models. Discovery uses a disposable configuration home, copies no credentials, excludes inherited integrations, and bounds time, pages, entries, and output. Catalogue membership does not prove account access. |
| Model selection and immutable retry settings | API, runner and frontend tests | Typed model/effort selections reach validated CLI arguments. Unsupported saved choices require an explicit change. Retry retains original settings and instructions; a new request uses current preferences. |
| Explicit packaged developer instructions | Installed-wheel resource and request-contract checks | Versioned v1/v2 Markdown resources are loaded as mandatory developer instructions, with recorded version/hash. Both are packaged in wheel and source distribution. No automatic SKILL.md discovery is needed. |
| Structured clarification and keyboard flow | Protocol validation, UI tests and screenshots | Version-2 reply/questions/proposal envelope; 1-3 questions, choices or text, custom answers, unselected recommendations, keyboard validation, Back/Next/Continue, pending access, and inert historical summaries. |
| Durable answers, stale sets, idempotent continuation | Migration, transaction, restart and competing-client tests | Migration 4; atomic answer/summary/request creation; lost acknowledgements replay receipts; continuation retry reuses frozen context; stale and superseded sets remain history; undo never resurrects a superseded set. |
| Existing review/approval boundaries | Existing and extended backend/browser scenarios | Answering never edits the graph or approves a plan. Applicable unanswered questions block approval. Proposals still require explicit review and acceptance; approval remains tied to saved content. |
| Existing editor, scanner and export behavior | Full backend/frontend and installed-package browser suites | Backend and frontend suites pass; final installed-package browser verification is recorded below. |
| Release distribution, Windows/Linux compatibility | Fresh build/install evidence and documented platform limits | Release wheels and isolated installations built on Windows and Ubuntu/WSL2; final run results below. |
| Documentation and local reviewable commit | Updated README/VALIDATION, clean committed diff; no push | README explains sharing, settings, questions, recovery, and schema 4. Approved brief retained as a historical specification. No publishing or pushing. |

## Resolved integration findings

- The original dock's nested outer scroll and oversized permanent instructions hid Send. The dock now fills the workspace height, with one scrolling transcript and a pinned, separately resizable composer.
- The catalogue's compact toggle lost its accessible name when its trailing visual label was hidden. Its explicit name now includes both the visible Variable catalogue label and the Open catalogue action.
- A sticky table header covered the only row in a short catalogue result pane: the viewport measured 52 px, the header 39.5 px, and the button 42 px. Headings now scroll in panes at or below 180 px and remain sticky in taller panes. The unchanged real-click regression confirms the button receives the click.
- Historical question prompts were initially dropped when asking again after edits. Bounded provider context now retains those sets with accurate historical states, without the internal snapshot.
- Legal IDs such as `constructor` and `__proto__` now use own-property draft lookups. Question and comment regression cases prevent inherited values from being rendered or validated as user input.
- A delayed Send acknowledgement could move focus out of an opened Layout menu and close it. A disposable response-delay reproduction proved this was an application race; acknowledgement focus must respect the user's later navigation, rather than being hidden by a test timing delay.
- The responsive catalogue test helper returns through its visible List control when details replace the table. The scan fixture waits for its own delayed poll handlers before teardown, retaining the external-request boundary and all cancellation/editability assertions.

## Verification results

Backend: **252 passed, 2 skipped** on Windows and Linux. Frontend: **83 passed** on both platforms. Production and wheel builds succeed. Windows installed-package browsers pass **35 scenarios (38 runner results)**. Linux verifies the same 35 scenarios across its full run and a final **10/10** agent-workspace rerun against the unchanged installed application. The full run initially passed 37 of 38 runner results; the one keyboard-helper timing issue is explained below.

- Final Windows installation: `output/wheel-agent-workspace-windows-5b52a7c5`. Log: `output/agent-workspace-verification/windows-browser-release.log`.
- Final Windows screenshots: `output/playwright/agent-workspace-after-kvY0Dx`, `agent-questions-layout-nw8WD6`, and `ux-after-BdSkeY`. The question and catalogue views were visually inspected. All 19 fixture records report no runtime errors or external browser requests; see `windows-browser-records.json`.
- Final Linux build/installation and evidence: `output/agent-workspace-verification/flowdesk-agent-workspace.0ZUPi8`. Its final frontend run passes all 83 tests. Its reused 252-pass backend evidence is guarded by matching hashes for all backend code, migrations, instruction resources, dependency definitions, and Python tests from the earlier complete run.
- Windows/Linux wheels contain 25 byte-identical application/resource/asset files. The installed Windows files also match source and wheel bytes. Both instruction versions and all four SQL migrations are verified in the source distribution. Evidence: `windows-package.json`, `windows-sdist.json`, and `cross-platform-package.json`.
- Baseline/current measurements and genuine-zoom captures remain in the artifact folders; full-diagram PNG pixel checks pass. The Vite build retains its advisory for a main chunk above 500 kB; no new dependency was introduced.

The final Linux keyboard failure left the intentional Question 2 heading focused while the helper had already attempted Space on Something else. The helper now waits for the heading's scheduled focus, then selects the option and explicitly asserts it is checked before typing. This fixes test sequencing without changing the application or forcing a click. The corrected case also passes on the installed Windows package.

## Live Codex limit

One synthetic smoke attempt used the discovered `gpt-5.6-sol`/low selection and version-2 instructions. The connector stopped at its sign-in check after 7.57 seconds: **zero model requests were sent**, and it did not retry. Model discovery succeeded, but actual generation with this protocol/settings combination is not verified in this environment. Earlier successful version-1 smoke results are historical evidence, not a new live check.

Deterministic browser fixtures inject a test-only provider; production has no simulated assistant fallback. Tests verify protocol handling and instruction delivery, not guaranteed model compliance or the quality of every clarification. The connector retains the previously documented image-reading helper, so its restrictions are not a blanket filesystem-read guarantee.

Native Linux desktop sessions, screen readers, touch devices, other browser engines, other Python/Node versions, and real model generation on Linux remain unverified. Session-storage drafts are best-effort; submitted answers and conversation records are durable. Step execution remains outside this release.

Final rerun evidence is in `output/agent-workspace-verification/linux-agent-focus-fixed-browser.log`, `linux-agent-focus-fixed-summary.json`, and `linux-agent-focus-fixed-artifacts.tar`; all 10 records report zero runtime errors and external requests. `windows-question-focus-fixed.json` records the corrected Windows case. The final browser test SHA-256 is `e1b65db75f9a5d0f83999c2237cc36520f825fb36f8eb1a114cbabd7346f082a`. The Linux rerun used an adjacent test copy and preserved the original source snapshot and installed package.
