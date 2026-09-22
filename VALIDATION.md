# Provider-independent planning and coding verification — 23 September 2026

This pass starts from `main` at `4ecc14b` on local branch `codex/provider-independent`. Native Ollama, OpenAI Responses, Anthropic Messages and Gemini Interactions share validated planning contracts and one application-owned coding harness. Codex CLI remains optional. Planning and Coding defaults are separate; provider/settings/instructions, context limits and execution policies are frozen into requests and runs. SQLite migration 10 adds planning-message attribution without rewriting older Codex requests.

All application data, source repositories, browser ports and execution workspaces used below were disposable. The existing user server and projects were left untouched. The user subsequently authorized reinstalling Ollama and reasonable models; that authorization did not extend to paid cloud calls. No cloud generation or real cloud-credential testing was performed. Nothing was pushed or published.

## Automated regression coverage

- **Frontend:** 299 tests passed across 32 files; TypeScript and production build passed. Final UI assets are `index-D0G-4YYa.js` and `index-D3oYGWAP.css`.
- **Backend:** the full Ubuntu/WSL2 suite recorded 609 passed, 10 skipped and two historical-fixture failures. Both failures arose from calling the current PlanningService against a deliberately unmigrated schema-7 fixture. The fixture now inserts the historical approval/receipt directly and explicitly verifies receipt preservation; both corrected cases passed. The final changed native-provider/stream/service gate passed **104/104** on Windows. These are broad-plus-focused results, not a claim that the original broad log was failure-free.
- **Execution core:** Windows focused core gate passed 31 with one unavailable symlink check; the combined service gate passed 33 with one skip. Native Linux core passed 33/33, including POSIX execute-bit copy-back and symlink containment. The full Windows backend run was stopped during severe subprocess contention and is not reported as passing.
- **Final execution hardening:** the cumulative active-time budget and transient Windows record-lock fixes passed 53 focused cases on Windows with one symlink-permission skip, and 55 on native Linux. These checks cover multiple clarification continuations, cancellation/errors, unavailable elapsed records, invalid saved values, unchanged original records on persistent lock failures and exact prepared-byte replacement without tool replay.
- **Real command isolation:** seven disposable Docker cases passed on Docker Desktop Linux containers, covering command/test output, isolation, unsafe archive rejection, cancellation/timeouts, cleanup and file-mode behavior. The native Ubuntu environment had no Docker socket, so native Linux Docker integration was unavailable.
- **Provider contracts:** deterministic native HTTP/SSE/NDJSON fixtures cover protocol formats, terminal-stream checks, tool/result sequencing, private continuation data, questions, malformed replies, missing models, authentication/rate errors, cancellation, credential redaction and frozen retries. No paid APIs were called. Model capability suggestions are not live account-entitlement verification.

The full browser suite recorded **98/99 passed**. Its remaining failure was a setup race that inspected the repository field before execution settings loaded. A readiness-only fixture correction retained the original assertions, and the cancellation/restart case passed its focused rerun. All 84 full-run/corrected browser reports contain **zero runtime errors and zero external requests**. The dedicated native-provider browser gate passed 2/2 with Codex unavailable, including questions, visual review, Apply, restart and Undo.

The browser checks cover light/dark at 1280 × 800 and 1440 × 900, a narrow window and actual 200% zoom, long model names, keyboard/focus, reduced motion, proposal highlights, execution diffs and full-diagram light PNG bounds. The visual index and report inventory are `output/provider-visual-review.md` and `output/provider-browser-report-audit.json`. These checks are not a full accessibility certification.

## Release and installed-package checks

The production wheel and Windows portable package were rebuilt from the final source. All **seven standalone portable checks passed**, including packaged startup from an unrelated directory, durable history/restart, the scanner worker, HTTP/CLI backups and observed/cancelled execution-worker output. The final **installed-wheel provider browser gate passed 2/2**, with Codex discovery disabled, external requests blocked and no source-checkout imports. Native provider planning/review/restart, dark Settings, narrow layout and true 200% zoom were exercised.

The package audit verifies 56 application/resource files against the source and all 305 portable manifest entries. The installer includes the versioned prompts, migration 10, shared runner and watchdog. Final receipts: `output/provider-package-integrity.json`, `output/provider-wheel-installed-integrity.json`, `output/provider-wheel-browser-result.json` and `output/provider-portable-smoke/portable smoke 計劃 s6xe103e/result.json`.

| Local development artifact | SHA-256 |
| --- | --- |
| `dist/flowdesk-0.2.0-py3-none-any.whl` | `d17cd26613ede3724eb9a9c6c7a594312fc940191385bf5c8e23c26258400435` |
| `dist/PlanBranch-0.2.0-windows-x64.zip` | `20b93690418a77a8660b371c840232a8f33aed55e9cf19cea0f3fddbae2101c7` |

These are local artifacts, not a published release. No push or release publication was performed. The Linux source/core checks ran in Ubuntu under WSL2; the final wheel install and browser gate ran on Windows. A fresh installed Linux wheel/browser check was not repeated in this pass.


## Live local-model checks

Ollama 0.34.2 was installed from the verified official Windows installer. The laptop reports an RTX 4060 Laptop GPU with 8 GB VRAM and approximately 24 GB system memory. The initial `qwen3:4b` tag resolves to the thinking variant. It returned a valid structured clarification question and a valid minimal node/Build-task proposal; the proposal was applied, then restored exactly through restart and Undo/Redo with Codex discovery disabled. Larger attempts produced invalid references/duplicate IDs and were rejected without application.

A 32,768-token context allocated about 7.95 GB and spilled into CPU memory. New version-2 requests default to 24,576, configurable through `PLANBRANCH_OLLAMA_CONTEXT_WINDOW`; the observed 24,576 allocation fit on the GPU at about 6.32 GB. Version-1 retries retain their original profile. These are measurements on this fixture and machine, not a performance guarantee. A malformed coding tool call was stopped before command execution and retained as an interrupted run; it was not silently replayed.

The final live coding gate used the separately installed **qwen3:4b-instruct** (2.5 GB) with Codex discovery disabled. The first instruct attempt edited correctly but omitted the test; the app recorded that no tests ran and did not mark the task complete. After the disposable task was explicitly refined and approved to require an observed command, the final run created only `sum.cjs`, executed `node --test test.cjs` in the reviewed local `node:22.16.0-bookworm-slim` Docker image, and recorded exit 0 with TAP output (one passing test covering three sums). The test separately accepted the diff, completed the task, and applied it to the disposable checkout, checking that the original checkout stayed unchanged until Apply and an unrelated uncommitted file survived.

The final live receipt is `output/ollama-live-final-receipt.json`, run `f9461b7f-1542-47ea-85ec-a92aa89aed16`. Planning/restart receipts remain under `output/ollama-live-ba9ae600`; live logs are `output/provider-ollama-minimal.log` and `output/provider-ollama-coding-final.log`. A preceding run stopped on a transient Windows atomic-file replacement failure under OneDrive, preserving its changes without replay. The final live data used an unrelated temporary directory; a bounded Windows file-replacement retry is covered separately without retrying any tool effect. Ollama and its two models remain installed; no existing model was removed and global provider configuration was unchanged.

## Boundaries and remaining limitations

Model file tools reject paths outside the worktree, Git metadata, links and stale write hashes. Independent native-provider commands use a local, explicitly selected Docker image with no network, a read-only root/input copy, non-root model process, bounded tmpfs and resource limits. The collector validates the complete output before copy-back. Host process supervision and Git worktrees alone are not described as sandboxes. Missing isolation leaves constrained file editing available and commands/tests honestly marked not run.

Normal cancellation preserves validated worktree changes. A hard server crash can lose changes still inside a command's temporary filesystem; pending tool effects are never replayed automatically. No owned command containers remained after final live verification. No real cloud billing/cancellation behavior, other browser engines, screen readers or native Linux desktop UI was verified. Native Codex sandbox enforcement was not reverified. Small local models remain fallible, and larger projects may exceed the conservative input budget. The production bundle-size advisory remains non-failing.

The [provider guide](docs/Providers.md) documents environment configuration, optional runtime requirements, frozen requests, credentials and backup/recovery. The package contains no Ollama/models, Codex, Docker/images, Git or credentials.

---

# Workspace simplification verification — 22 September 2026

The UI simplification builds on the completed quality-of-life pass on local branch `codex/ui-simplification`. A single header now contains Diagram/Build navigation, save feedback and panel controls. Project groups the brief, manual save, scanner, exports, import, example and backup actions. The sidebar contains projects and diagrams without a duplicate node palette. Chat keeps model/reasoning and Send together, with writing recovery and help in a compact footer.

The existing handlers, history, preferences and persistence contracts are retained. Review keeps project replacement actions disabled, and compact Diagram/Build switches reveal the selected workspace while retaining drafts. No backend, schema, dependency or permission changes were made.

Verification on Windows: **279 frontend tests passed**, TypeScript and production build passed, the affected-workflow browser regression passed **80/80**, and the focused simplification gate passed **2/2**. The browser checks cover light/dark, 1280×800 and 1440×900, narrow windows, larger text, reduced motion and genuine 200% zoom. They exercise menu keyboard access and scrolling, dialog focus restoration, compact view switching, retained selection/viewport, autosave and recovery, history/restart, proposal guards, model retries, Build tasks, scan/catalogue navigation, notifications and full-diagram light PNG bounds. Browser fixtures block external requests and use disposable data and deterministic agents. The 63 captured browser reports contain zero runtime errors and zero external requests; see `output/ui-simplify-browser-audit.json`.

The first focused visual attempt incorrectly inspected retained layout rectangles inside closed native details menus; it now tests visible controls, while preserving strict viewport and keyboard assertions. No application behavior was weakened. The passing final build uses `index-buf8YXLV.js` and `index-CjC4QQJX.css`. Logs: `output/ui-simplify-frontend.log`, `output/ui-simplify-build.log`, `output/ui-simplify-browser.log` and `output/declutter-browser-final.log`.

Before/after index: `output/ui-simplification-review.md`. Baseline captures are in `output/playwright/qol-baseline-QbtETZ`; final theme/zoom/menu captures are in `output/playwright/declutter-xtvYV5`, and chat captures are in `output/playwright/agent-workspace-after-olKQgh`. The README screenshot and user guide reflect the new controls.

This pass did not restart the existing server, open existing user data, push or publish. Linux, backend and release-package suites were not repeated for these frontend-only changes; the completed earlier pass remains recorded below. Existing portable artifacts predate this UI update. The production bundle-size advisory remains non-failing.

---

# PlanBranch quality-of-life verification — 22 September 2026

The five quality-of-life milestones are implemented on local branch `codex/quality-of-life`, based on `main` at `ef431b6`: shared Settings and themes; workspace resume and durable unsent writing; guarded quick jump; workspace presets; and quiet operation notices. Application source is committed through `d7e0543`, with final browser regressions in `e94d153`. SQLite migration 9 is additive; appearance and layout remain browser preferences, separate from manual history, portable content and approval. No user database, source attachment, execution repository or running server was used. No changes have been pushed or published.

## Current verification

| Check | Windows | Linux (Ubuntu under WSL2) |
| --- | --- | --- |
| Backend full suite | 488 passed, 9 platform/configuration skips; final changed writing gate 19/19 and activity gate 6/6 passed | 495 passed, 3 Windows-specific skips; final changed writing gate 19/19 passed |
| Frontend full suite | 278 passed across 31 files on the final compact-layout source | 275 passed across 31 files in the broad run; final changed behavior covered by the installed gates |
| TypeScript / production build | Passed | Passed |
| Release wheel and installed application byte audit | Passed | Passed, all 44 application/resource files match |
| Standalone Windows portable smoke | All 7 checks passed on the final package using bundled Python 3.14.7 | Windows package is not a Linux distribution |
| Final source browser gates | Activity geometry at desktop/narrow/200% zoom passed; delayed reading and review/history gates 2/2 | Covered by installed gates below |
| Full installed browser regression | Initial broad run: 90/93 passed; final affected eight-file gate 49/49 passed | Initial broad run: 85/93 passed; affected eight-file gate 49/49 passed; final compact-layout gate 26/26 passed |

These browser results combine the broad runs with passing focused reruns after fixes; the original broad logs were not failure-free. No unresolved failures remain in the tested workflows. The final Windows gate ran all 49 cases against the frozen portable package and produced 49 reports with no runtime errors or external requests. Its receipt is `output/qol-delivery-windows-exit.json`. `output/qol-package-integrity.json` verifies all 44 application/resource files and all 293 portable manifest hashes against the tested package.

The broad backend runs preceded the final writing fixes; focused tests cover those final changed paths. Windows source checks used Python 3.14.3 and Node 24.14.0. Linux uses isolated source/runtime dependencies, a separately installed wheel and an unrelated working directory. All browser fixtures use disposable data, deterministic agents and blocked external requests. The final Linux gate has 26 browser reports with no runtime errors or external requests; all 44 application/resource files match the final source and both platform wheels. Its final gate log is `output/qol-composer-linux.log` and its byte/browser audit is `output/qol-linux-final-audit.json`.

## Fixes found during final verification

The installed browser check exposed a real Comments composer overflow at 200% zoom after adding writing-save feedback. Reserving actual control height fixes it; the original strict geometry assertion now passes. The broad installed runs also exposed notification overlays intercepting proposal review controls. A transient reserved Activity row replaces the overlays, retaining named Open/Dismiss actions without covering chat questions, review controls or the composer. Checks cover non-overlap and keyboard access at both desktop sizes, narrow width and true 200% zoom. Screenshot review caught a compressed message field at 200%: composer sizing now measures its actual controls and preserves a readable writing area. When space is insufficient, Chat and Comments scroll between a readable history/list and the full writing controls. The final stress gate includes larger text, a long revision title, node context, three notices, and keyboard access to history, Cancel revision and Send.

The final recovery audit found that a lost legacy-import acknowledgement followed by another tab discarding the copy could recreate that copy on retry. Migration and Load other writing now preserve the original request identity and read fresh state after the immutable receipt. Tests cover retry and fresh initialization after discard. Retired version tokens, cleared comment entries and empty answer maps are pruned while preserving uncertain-submission tokens; regressions exceed 500 distinct targets.

The unchanged clarification browser regression also found reload inside the writing debounce restored answers only as a saved copy. Dirty cached generations now resume their original conditional save even before the first request exists, including an intentionally cleared draft. A different server revision still produces recoverable conflict copies. Three added hook regressions and the 68-case focused frontend gate pass; installed follow-up results are recorded below.

The Linux run exposed a delayed-send reading-position race: waiting for the writing save could overwrite a later decision to scroll upward. Send intent is now recorded before awaited saves, so subsequent reader movement wins. A deterministic browser regression holds the staged writing request while the user types and reads older messages. Other browser failures were stale navigation-error wording or checks acting before model discovery/manual-canvas initialization; readiness waits retain the original behavior assertions.

Earlier failures remain in the logs: obsolete historical-schema test fixtures were corrected without changing migration expectations; four frontend timing failures under unrestricted concurrency passed with two workers, now the test default. The Linux repeated-build byte audit caught stale generated files after importing a timestamp-normalized source archive. Removing only that disposable generated build directory and rebuilding/reinstalling restored exact source/wheel/install equality. The failing audit is retained in `output/qol-linux-final-refresh.log`; corrected evidence is in `output/qol-linux-clean-package.log`.

## Visual evidence and artifacts

Comparable light baseline/after captures cover 1280×800 and 1440×900. Additional captures cover dark appearance, larger text, compact density, Settings, long content, inspector/catalogue, proposal highlights, execution output/diffs, narrow layout and real 200% zoom. Reduced-motion and keyboard/focus checks passed. PNG exports use the explicit light palette independently of dark workspace appearance, with full-diagram bounds/pixel checks. Execution contrast measured 11.12:1; proposal badge contrast ranged 6.82–7.72:1. These are focused checks, not a full accessibility certification.

The screenshot index is `output/quality-of-life-review.md`. Final compact-layout captures include `output/playwright/qol-notification-placement-j8hY2f/` (including larger-text revision and focused-action captures). Final logs include `output/qol-final-backend.log`, `output/qol-frontend-final.log`, `output/qol-compact-composer-build.log`, `output/qol-compact-final-geometry.log`, `output/qol-delivery-release.log`, `output/qol-delivery-portable-build.log` and `output/qol-delivery-portable-smoke.log`. Installed browser logs include `output/qol-delivery-windows-browser.log`, `output/qol-delivery-linux.log` and `output/qol-composer-linux.log`. Linux final high-zoom captures are also copied to `output/qol-final-linux-screenshots`.

| Local artifact | Size / SHA-256 |
| --- | --- |
| `dist/PlanBranch-0.2.0-windows-x64.zip` | 13,737,543 bytes; `1428a21d7e792f2234276887c21f5aa6cca7074d4175bd47c25e3b37f87b1b3e` |
| `dist/flowdesk-0.2.0-py3-none-any.whl` | 346,758 bytes; `e6b4ef32dce61ea68726c879af6324e29d8447646314c16187c226aacaf02f4f` |
| `output/qol-linux-verification/planbranch-qol.kOfiGQ/flowdesk-0.2.0-final-py3-none-any.whl` | `87f80b99d5ae883bd4d322740315b609d1f89e2e25df2355ffdca5817282cfef` |

These are local development artifacts, not a published release. Final frontend assets are `index-D4Atb7vf.js`, `index-BYHYdR4Y.css` and `png-BnJPrvVN.js`. The Windows smoke receipt is `output/qol-portable-smoke/portable smoke 計劃 gi6ek7st/result.json`.

## Remaining limits

Notifications monitor the open project. Optional sound and desktop delivery depend on browser/OS support and permission; real OS delivery was not verified. Browser preferences belong to the server address/port and may not survive restricted browser storage. Acknowledged unsent writing is durable; forced termination before its save acknowledgement cannot guarantee the last edit. Recovery never sends it automatically.

Linux verification uses WSL2, not a native Linux desktop. Other browser engines, screen readers and touch devices were not verified. Execution uses deterministic disposable repositories; no live agent ran against user code and native Codex sandbox enforcement was not reverified. The existing production bundle-size advisory remains. No runtime dependencies, cloud services, automatic acceptance or execution permissions were added.

The dated records below describe milestone-time checks and previous releases. This quality-of-life record supersedes their pending checks only where a completed result is explicitly recorded above.

---

## Previous major-pass release verification — 21 September 2026

This pass implements all seven requested milestones: explicit Tidy previews and pins; database-backed proposal drafts; guided review; the project brief; separate Build tasks; deliberate one-step execution; and a Windows portable package with a read-only first-run Codex check. Work is isolated on `codex/next-major-pass` in `output/next-major-pass`. The original checkout remains clean. No user database, attached source folder, existing server, or real execution repository was used; nothing was pushed or published.

## Final build and backend checks

| Check | Windows | Linux (Ubuntu under WSL2) |
| --- | --- | --- |
| Backend | Broad run: 467 passed, 9 platform skips, one fixture-readiness failure; corrected execution-adapter file: 20/20 passed | 474 passed, 3 Windows-specific skips; final changed adapter/smoke gate: 34 passed, 1 Windows-only skip |
| Frontend | 219 tests passed across 22 files | 219 tests passed across 22 files |
| TypeScript / production build | Passed | Passed |
| Release wheel / isolated installation | Passed; also installed inside the portable package | Passed from an unrelated installed-package directory |
| Portable builder and helper tests | 21 builder tests and 15 smoke-input tests passed | Included in the backend gate |
| Standalone portable smoke | All seven checks passed with bundled Python 3.14.7 | Windows package is not a Linux distribution |

The Windows backend failure was a test fixture that let its parent exit after a fixed 150 ms, before the child necessarily wrote its readiness marker. It now waits for the first heartbeat with a bounded deadline; the original process-cleanup assertion is unchanged. The final 20-case adapter rerun passes. An earlier backend run collected packaging fixtures before their final corrections; its obsolete CRLF and ZIP-name fixture failures are retained in the logs and superseded by the frozen-source run and focused gates above.

Production assets are `index-DiIQadbT.js` and `index-DwWJ11p3.css`. All 40 application/resource files in the Windows wheel match the source/build bytes, and all 289 file hashes in the portable manifest match the ZIP. Version metadata, both console aliases, required workers, frozen prompts, migrations and license bytes were checked. Two offline portable builds produced identical archives. The bundle includes CPython, the production frontend and eight runtime dependencies; it includes no Node, Git, Codex, credentials, user data, pip or test dependencies.

The standalone smoke starts both actual `.cmd` aliases from an unrelated directory with spaces and Unicode in its paths, poisoned host Python settings and fake host modules/commands. It verifies bundled imports, production assets, persisted edits and Undo/Redo after restart, a read-only scanner worker, valid HTTP/CLI SQLite backups, observed command output and execution cancellation. A blocked-start Windows job owns each fixture server before launch and verifies its socket closes on cleanup. Its seven-check receipt is `output/portable-smoke/portable smoke 計劃 ny0dtwp1/result.json`.

## Installed browser and visual checks

Both final installed-package runs exercised **71 browser cases** with external requests blocked: the Windows portable runtime from an unrelated working directory, and the Linux wheel installation from its separate directory. Each initial run passed 69 cases and exposed two test synchronization assumptions, corrected without changing application bytes. On Windows the affected zoom case passed its focused rerun, and the final planning file passed 3/3. On Linux both affected files passed 16/16, followed by the final planning-file revision passing 3/3.

The fixtures now wait for a restored proposal before selecting its saved canvas, bind replies to exact request/proposal identities, wait for retry route completion, and observe both the scheduled autosave failure and explicit Send-flush failure before testing recovery. This removes duplicate-canvas selection, previous-request polling and a disappearing Retry control from the test procedure; assertions about retained drafts, explicit recovery and one-action application remain intact. The original failure logs and corrected reruns are retained.

Coverage includes all milestone acceptance paths, save/conflict/restart recovery, cancellation and stale execution approvals, immutable diff review, separate acceptance/completion/checkout Apply, migrations and portable relationships, scan evidence, native input behavior, pointer/keyboard panel resizing, focus, reduced motion and full-diagram PNG bounds. Production views were captured at 1280×800 and 1440×900, narrower windows and genuine 200% browser zoom. The portable fixture audit records 59 browser reports, zero runtime errors and zero external requests, with target-size and full-diagram export images. Baseline captures remain under `output/playwright/ux-before-QyiP8e`; final captures include `ux-after-D27J6N`, `agent-workspace-after-sFFMk6`, `execution-ZKAhVe` and the final Tidy directories. Representative screenshots and the refreshed README image were visually inspected.

Receipts include `output/final-browser-audit.json`, `output/windows-planning-final-rerun.log` and Linux `verification-summary.json`, `changed-browser.log`, `planning-final-browser.log`, source/test-delta manifests and captured-artifact archives. No pending application failures remain in the checked workflows. These results are combined full-run and focused-rerun evidence, not a claim that the initial broad logs were failure-free.

## Artifacts and evidence

| Artifact | Size / SHA-256 |
| --- | --- |
| `dist/PlanBranch-0.2.0-windows-x64.zip` | 13,712,958 bytes; `dcabbb1b8666a6b40df582bd7436e9137fed2b6c0b9adda12d6a54c4ef5f6b1d` |
| `dist/flowdesk-0.2.0-py3-none-any.whl` (Windows build) | `5aa84cec45174442a734ef1246edc4a46b9b70bbbbefd303be70201d1a7a90f9` |
| Linux wheel in `output/linux-major-verification/planbranch-major.eOfL3r/` | `df440847ab88f9e122305012f3afa8d7bda3c0c027ed01bf8a234e36929c0620` |

The portable receipt is adjacent to the ZIP. Source/package matching is recorded in `output/final-package-verification.json`; Windows logs include `output/final-windows-backend-frozen.log`, `output/final-release-build.log` and `output/final-portable-browser.log`. Linux source hashes, test-only deltas, runtime versions, phase logs, wheel and browser captures are retained under `output/linux-major-verification/`. Linux used Python 3.14.3, Node 24.14.0, Git 2.43.0 and Chromium 153 in an isolated `/var/tmp/planbranch-major.*` tree. Windows source checks used Python 3.14.3 and Node 24.14.0; the portable runtime is Python 3.14.7.

## Boundaries and remaining limitations

Execution tests use deterministic agents and disposable repositories. Real processes verify observed command results, Windows job cleanup and Linux process-group cleanup; no live coding agent ran. Native Codex sandbox enforcement remains unverified: the earlier direct Windows sandbox probe returned CreateRestrictedToken error 87. The application requests the documented elevated Windows sandbox and does not fall back or install it. CLI connection readiness is not proof of OS sandbox enforcement. The setup-guide links resolve to the current official Codex CLI documentation.

Linux checks ran under WSL2, not a native Linux desktop. Other browser engines, screen readers and touch input were not verified. The existing Vite chunk-size advisory remains; a non-failing React warning is isolated to a BuildTasksEditor unit-test harness, with no browser runtime errors in the recorded workflows. Tidy does not promise globally optimal edge routing or move already-overlapping fixed nodes. Documented repository/file/output limits remain in effect. CI now generates wheels and Windows portable artifacts, but its updated workflow has not been run on GitHub because this pass is local only.

The dated entries below describe milestone-time checks and earlier releases; this release record supersedes their pending platform checks.

---

## Controlled one-step execution — 21 September 2026

Milestone 6 adds explicit execution-repository selection, frozen Run previews, one owned execution at a time, isolated Git worktrees, durable run records, cancellation/restart recovery, observed command evidence, immutable diffs, separate code acceptance/task completion/checkout Apply, and a recovery journal. Migration 8 keeps these permissions and machine-specific records outside manual history and portable exports. The planning connector remains read-only. Git preparation avoids repository hooks and filters; checkout application leaves the index and unrelated edits untouched.

Windows verification: the broad backend run completed **406 passing tests and 5 platform skips**; its two failing historical migration fixtures were corrected to remove newly added tables, and the six-case migration rerun passed. Final execution/service/adapter/journal changes have additional passing focused gates (20 adapter tests; 14 service cases and 2 migration cases; 18 final journal/identity checks). The full frontend suite passed **210 tests**, followed by the expanded **32-test** execution/control gate. TypeScript and production build passed. Three disposable real-browser workflows passed, including restart/cancellation, lost-state recovery, explicit accept/complete/apply, conflicting checkout recovery, Undo, failed command evidence, stale approval, keyboard/focus, both target desktop sizes, narrow layout and actual 200% zoom with reduced motion. Artifacts include `output/playwright/execution-92EtEF`, `execution-424QyP` and `execution-vlJciX`; external requests were blocked and runtime-error reports are empty. Final installed/platform checks are recorded in the release gate below when completed.

Codex CLI 0.144.1 help and current official non-interactive/security/configuration documentation were inspected. The execution path uses separate frozen executor-v1 instructions, strict configuration, workspace-write, explicit untrusted repository configuration, no approval escalation, disabled integrations and sandbox network access. Windows requests the elevated Codex sandbox. Deterministic real processes verified Windows job ownership, cancellation and descendant cleanup on server death. No live coding agent ran. Native Codex sandbox enforcement was not verified: the earlier direct sandbox probe reported CreateRestrictedToken error 87. A connection/capability check is not proof of OS enforcement. Linux and packaged execution remain final-gate work. Repository/file/output limits and backup recovery requirements are documented in the user guide.

## Build tasks — 21 September 2026

Milestone 5 adds a separate Build workspace, stable task/check identities, explicit deliverables/areas/status, live and missing diagram links, ordering and acyclic prerequisites. Program loops remain valid. Reviewed task changes use the existing proposal workspace and durable candidates; graph-only proposals expose derived missing-link effects without granting task editing. Migration 7 upgrades retained snapshots to content version 3 while preserving frozen planner-v4 records and interrupted Apply intents; new requests use planner-v5/protocol4.

Windows verification: **357 backend tests passed, 2 existing platform skips; 187 frontend tests passed**. The expanded six-file focused frontend gate also passed **106 tests**. TypeScript/production build passed. Four disposable browser scenarios passed, followed by the authoring rerun for the inspector-visibility polish. Coverage includes create/reorder/link/navigation, cycle prevention, independent status and real scanner evidence, delete/relink/remove, restart/Undo, portable remapping, reviewed task revisions and one-action Apply, keyboard, both desktop sizes, narrow view and actual 200% zoom. A focused unit test found and fixed loss of implicit task selection during reorder. Screenshots inspected: `output/playwright/build-authoring-9Qz8H6`, `build-review-ZNURTt`, `build-responsive-btTS43`. Reports show no browser errors or external requests. All repositories, data and servers remain disposable; Linux/installed checks are reserved for the final gate.

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


## Quality-of-life pass — milestone 1 (2026-09-22)

Shared browser preferences, Settings, semantic System/Light/Dark themes, fixed canvas geometry through interface size/density changes, and an explicit light PNG export palette are implemented. Settings startup is functional with validated last-project/diagram/Build-view restoration. Existing model choices migrate and synchronize with chat; requests/retries retain their captured settings.

Windows: production build passed; full frontend suite passed **223 tests**, plus **2 workspace-memory tests**. Four focused browser scenarios passed across initial run and affected-fixture rerun: preference persistence and unchanged history/approval, model synchronization, system appearance, contrast/graph dimensions, narrow/real 200% keyboard access, and light full-diagram PNG from dark mode. Existing fixture assumptions were updated to explicitly select the requested project after reload. External browser requests were blocked; all data was disposable.

Baseline images: `output/playwright/qol-baseline-8xmPUw`; comparable light images: `output/playwright/qol-after-xkUpjR`; dark/light images: `output/playwright/qol-settings-vnmxd3`; narrow/zoom: `output/playwright/qol-settings-access-jblwxQ`; PNG: `output/playwright/qol-light-export-zGYBiE`. Browser logs: `output/qol-m1-browser*.log`. Later milestone and package checks follow below.


## Quality-of-life milestone 2 — durable unsent writing (2026-09-22)

SQLite schema 9 stores unsent chat, node comments and partially answered questions independently of manual history, approvals and proposal drafts. Conditional saves and receipts preserve concurrent copies and newer typing; legacy session drafts import conservatively. Submission retires the captured writing version only after its existing receipt is acknowledged.

Verified on disposable Windows data: 56 focused frontend tests and 21 backend writing/migration tests passed. Five production-browser recovery scenarios passed across initial and corrected targeted runs: browser/server restart, orphan recovery, delayed/failed saves with guarded navigation, conflicting tabs/copy retirement, and lost submission acknowledgement with newer text retained. Browser reports recorded zero external requests and zero page errors. Evidence: `output/qol-writing-navigation-rerun.log` and writing fixture folders under `output/playwright/`.

The first full backend run found three outdated historical-schema fixture expectations (480 passed, 9 skipped, 3 failed). Fixtures now construct the correct old schema and target migration 8 explicitly; all affected tests passed on rerun. Final full-suite results are recorded below when complete.


## Quality-of-life milestone 3 — quick jump (2026-09-22)

Nine focused palette/shortcut tests passed. Production browser checks passed for grouped node/task/planned/evidence navigation, distinguishing duplicate file/scope observations, keyboard focus and failed-save guards, narrow width, actual 200% browser zoom, reduced motion and open-dialog shortcut protection. The initial search fixture selected both current and stale observations; it now selects the intended current record without hiding either result.

A separate timing regression passed: hold a plan-save acknowledgement, navigate, enter newer writing, hold that writing save, and verify navigation waits until both queues are current. A fresh tab recovers the exact latest text and no agent request is created. Cancellation remains independent of draft recovery. Logs: `output/qol-navigation-browser.log`, `output/qol-navigation-browser-rerun.log`; writing race evidence is under `output/playwright/writing-navigation-race-*`.


## Quality-of-life milestone 4 — workspace presets (2026-09-22)

Two preset storage/bounds unit tests passed. The production preset browser workflow passed, then passed again after strengthening it to open Chat for the first time through a preset. Planning, Review, Build and personal layouts preserve exact selection, canvas transform, manual content and retained history. Personal layout survives reload; narrow layouts retain reachable toolbar controls. Evidence: `output/qol-navigation-browser-rerun.log`, `output/playwright/navigation-layouts-5LfZok/`.


## Quality-of-life milestone 5 — completion notices (2026-09-22)

Six backend activity tests passed, including project scoping, bounded metadata, exact response targeting, failed retry association, request protection and logical database non-mutation. Settings/operation tests passed for explicit permission gestures, denied/unsupported environments, sound opt-in, accurate outcome wording and deduplication. Exact historical execution and planning focus tests also passed.

Four production-browser notification scenarios passed: completion/failure/cancellation while typing, no unsolicited sound/desktop permission or delivery, silent reload, exact older planning reply, exact older scan and exact historical coding result with its recorded failed check still visible. An initial fixture incorrectly expected superseded questions to remain open; corrected assertions verify navigation preserves the actual before/after state. No browser or source execution is triggered by notification navigation.

The full Windows backend run passed **488 tests, 9 platform/configuration skips** in 659.88 s. The full frontend run passed **268 tests across 31 files** with two workers; TypeScript and the production build passed. Earlier unrestricted frontend concurrency produced four timing failures; all affected cases passed when rerun with bounded workers, now the default test setting.

Dark proposal and execution browser checks passed 2/2. Both 1280×800 and 1440×900 captures show added/changed/removed highlights and expanded execution output/diff. Measured execution contrast was 11.12:1; proposal badge contrast ranged 6.82–7.72:1. Evidence: `output/qol-final-backend.log`, `output/qol-final-frontend.log`, `output/qol-dark-review-browser.log`, `output/playwright/execution-FLBD0G/`, `output/playwright/guided-review-dark-8gZLOL/`.

The production bundler retains its existing large-chunk advisory (about 650 kB before compression). No new runtime dependency, cloud service or execution permission was added. Final installed-package results follow.


Final preference integration: Tidy and read-only proposal previews now use the same grid visibility preference as the editable canvas. A focused production-browser check passed for both previews and live Settings updates, while saved content/history stayed identical (`output/qol-preview-grid.log`). TypeScript and the production build passed again; final asset entry is `index-BkwJDtYJ.js`.
