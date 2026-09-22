# Workspace simplification

Build on the completed quality-of-life branch; keep all data and agent behavior unchanged.

Visual direction: a quiet editor with a single compact header, plain navigation and the diagram as the main surface.
Content hierarchy: project and view first; canvas actions nearby; export, scan, brief and local data tools in Project; optional details stay in the existing dock.
Interactions: quick hover/focus feedback and native menu disclosure; preserve reduced motion and never animate graph positions.

Sequence:

1. Capture the existing production UI with the disposable browser fixture.
2. Group secondary project actions, remove the duplicate sidebar palette, and combine view navigation into the header.
3. Reduce chat status chrome without obscuring failures, recovery or model controls.
4. Verify keyboard/focus, theme, high zoom, draft recovery and diagram geometry; capture comparable screens and commit locally.

Baseline: output/playwright/qol-baseline-QbtETZ (1280×800 and 1440×900). No existing user server or data is used.

## Delivered

- The single header contains project context, Diagram/Build, save feedback and dock controls. Project groups secondary tools; Search and Settings use named icon controls.
- Navigation shows projects and diagrams without the duplicate six-node palette. The canvas Add node menu remains explicit and keyboard accessible.
- Writing-save status and help occupy a compact chat footer. Recovery remains prominent, and model/reasoning choices remain beside Send.
- Compact view switches reveal the chosen workspace. Proposal review continues to prevent project replacement until returning to the plan.

Production checks use disposable fixture data and deterministic agents. No user server was restarted and no existing user data was opened. Source and tests are kept on codex/ui-simplification; nothing is pushed or published.

Visual review: output/ui-simplification-review.md. Frontend tests: 279 passed; TypeScript and production build passed. The focused browser gate passed 2/2, including both themes, 1280×800, 1440×900, narrow windows, genuine 200% zoom, larger text, menu keyboard access, focus restoration and draft/history preservation. The full result of the broader affected-workflow gate is recorded in VALIDATION.md.
