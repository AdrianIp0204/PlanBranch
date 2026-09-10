# FlowDesk UI/UX improvement prompt

Implement one cohesive UI/UX improvement pass for FlowDesk. Keep it a straightforward, local programming planner: diagrams first, supporting details close by, and clear separation between human plans and read-only Python evidence. Improve the working application rather than creating a landing page or mockup.

## Inspect before changing

Read `README.md`, `VALIDATION.md`, and `FlowDesk_Codex_Build_Prompt.md`. Inspect `frontend/src/App.tsx`, `Canvas.tsx`, `Inspector.tsx`, `VariablePanel.tsx`, `styles.css`, `ui.tsx`, and the existing state and browser tests. Preserve the Flask, SQLite, React, TypeScript, Vite, and free React Flow architecture.

Run the current production UI using a fresh disposable data directory and separate port. Do not reuse an existing user's database, projects, attached source folders, or running server. Create representative fixtures: an empty project; a branching, looping diagram; long titles and notes; multiple diagrams; and a catalogue with current, stale, missing, ambiguous, and imported evidence. Use temporary Python files for scanning.

Inspect actual browser behavior and capture baseline screenshots at **1280 × 800 and 1440 × 900**. Check a narrower window and 200% browser zoom for access to essential actions. Record a short prioritized issue list, a one-sentence visual direction, and the intended interaction changes, then proceed with implementation. Resolve routine design choices yourself; do not ask about decisions already established here or in the brief.

## Design and interaction priorities

1. **Readability and hierarchy.** Retain FlowDesk's calm, lightly tinted workspace and restrained accent. Replace tiny interface labels with a coherent, readable type scale; aim for 13–14 px ordinary controls and supporting copy. Use spacing, alignment, and clear section boundaries. Keep status colors meaningful and paired with text or symbols. Avoid decorative cards, gradients, marketing copy, remote fonts, and new dependencies unless necessary. Existing fixed panels and numerous 8–11 px labels are starting points to investigate, not reasons for a wholesale rewrite.

2. **A canvas that remains useful.** Make navigation and inspector collapsible, and provide practical resizing for the inspector and catalogue. Support pointer and keyboard resizing with labeled separators, bounds, and visible focus. Keep essential canvas controls reachable when panels are open. Preserve viewport, selection, and unsaved edits during layout changes. Remember layout preferences locally, outside project content and undo history. Offer a discoverable way to restore the default layout. Long names must remain recoverable without relying only on hover.

3. **A focused inspector.** Keep title, status, description, and relevant blocker information immediately available. Group checklist, notes, pseudocode, implementation targets, decision reasoning, and links into clearly labeled expandable sections. Show useful counts and existing-content indicators so collapsed fields are not forgotten. Separate project, node, and connection context clearly. Preserve every editable field and its save behavior. Keep duplicate/delete actions discoverable and maintain destructive-action confirmation.

4. **A clear catalogue workflow.** Make finding a variable, inspecting its details, linking it, and reviewing code evidence feel like one connected flow. Keep search and active filters visible, show result counts, and provide clear-filter and no-results actions. Distinguish planned variables from detected symbols throughout. Show file, scope, and line context when choosing ambiguous symbols. Make linked nodes navigable across diagrams and provide an obvious route back to the variable. Keep confirm, reject, and relink actions explicit; explain stale, missing, ambiguous, and imported evidence in plain language without implying correctness or completion.

5. **Trustworthy feedback and onboarding.** Keep save state and last successful save time readable. Failed saves and conflicts must remain actionable; preserve retry, keep-draft, and explicit-discard recovery. Expose scan progress and cancellation without blocking unrelated planning work. Empty states should offer the relevant next action: add a node, load the removable example, create a planned variable, or attach a source folder. Explain disabled actions where useful. Use concise utility copy and avoid repeated instructional banners.

6. **Keyboard, focus, and motion.** Give icon controls accessible names and visible focus. Ensure menus, dialogs, disclosures, panel toggles, and catalogue navigation work by keyboard, close predictably, and restore focus to a sensible place. Preserve native text editing, checkbox behavior, canvas arrow movement, multi-selection, and drag grouping. Add only brief transitions that clarify panel changes or selection; respect reduced-motion preferences and never animate graph positions or delay input.

## Verification and delivery

Preserve durable autosave, restart-safe undo/redo, stable IDs, manual links, scanner boundaries, evidence-state semantics, migrations, backups, and JSON/PNG/Markdown exports. Do not add cloud services, accounts, code execution, inference, or a backend redesign.

Run the existing backend and frontend tests, production build, release build, and installed-package browser suites with external requests blocked. Add focused browser coverage for panel resizing/collapse, keyboard focus, progressive disclosure, catalogue find/link/review, and save recovery after layout changes. Use existing harnesses and disposable fixtures.

Capture comparable before/after screenshots at both target sizes, including an open inspector and catalogue. Verify long content, reduced motion, zoom, readable contrast, and full-diagram PNG rendering. Report actual results and any unavailable platform checks accurately. Update relevant documentation, summarize resolved issues and remaining limitations, and provide a reviewable local commit. Do not publish, push, or alter existing user data as part of this UI pass.
