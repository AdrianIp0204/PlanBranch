# Selected repository context for planning

Planning remains source-free by default. Attaching a repository in Sources or scanning it does not authorize a provider to receive source. An execution repository grants different capabilities and is not used implicitly for planning context.

## Try it

1. In Sources, attach a local Git repository with an existing commit and confirm read-only access. A scan is optional for whole files; scan Python source to make current symbol excerpts available.
2. In planning chat, choose an explicit provider/model, write the request, and enable **Include selected repository context in this request**.
3. Send opens a local selection dialog. Choose files, tests, project instructions, or Python symbol excerpts (up to eight selections). Filter the catalogue to find paths or symbols.
4. **Preview outgoing request** shows the receiving provider/model, selected excerpts, Git revision, file identities, redacted line numbers, package size, and exact source-bearing payload and instructions. No model call has happened yet.
5. Inspect the package, check the confirmation box, then **Confirm and send this package**. Changing the selection clears the preview and consent. Close the dialog or cancel preview to discard it.
6. A proposal's **Inspected source** section lists the files/symbols/ranges used. **Check source freshness** compares current file hashes and Git HEAD with the inspected snapshot and marks drift stale. This is source provenance, not test evidence.

The outgoing package is frozen, including its manual plan and model configuration. Source edits after preview cannot silently alter it: sending uses the previewed bytes. Preview again to include newer changes. Plan revision, repository attachment, recipient, message, or package-identity changes require a new preview. CLI default is unavailable for source sharing because its receiving model cannot be identified in advance.

## History, retries, and retention

Every selected-source request omits earlier conversation and generated questions. After a project has shared source, later requests also omit earlier conversation and generated questions, including for source-free requests. The current manual plan/brief and authored comments still supply the planning intent; save reviewed decisions in the brief. Explicit source previews can include a manually reviewed proposal revision.

Source-derived questions offer **Preview source and answers**. This prepares a new, explicitly reviewed message and replaces the old pending question set when sent. It does not silently replay the old source context. Answers remain in the durable new user message.

Excerpts and concrete previews remain in bounded process memory, expire after ten minutes, and are discarded after sending/cancellation. SQLite stores only the normal planning data plus a versioned sharing receipt with provider/model, revision, hashes, selected paths/ranges, redaction line numbers and proposal association. Preview source is not stored in the request journal or application logs. A provider response can quote source and is retained as ordinary conversation/proposal content; the preview explains this before consent.

Source-bearing requests cannot reuse failed or restarted in-memory consent. Retry prepares a new request and requires another preview. An uncertain delivery can still reconcile the original successful request by its exact mutation receipt; it cannot cause a second transmission. Restart preserves receipts and references, not active source previews.

## Boundaries and limits

- Source is read through the existing scanner's path boundary. Traversal, absolute paths, symlinks/junctions and binary files are rejected; project code is never imported or run.
- Git is queried only for revision and ignore metadata. Git ignore rules, configured Source ignores, Git internals, common credential/environment/key files, private directories, generated dependency directories and oversized files are excluded. A catalogue covers at most 2,000 entries and reports when incomplete.
- At most eight files/excerpts, 64 KB per file, 160 KB of selected source and 500 KB of outgoing package are allowed. Provider-specific input limits can be lower. Preview work has a bounded processing deadline and cancellable preparation; pending jobs, previews and expiry timers are bounded.
- Python symbols reuse scanner identities and current file hashes. Their preview is a small line excerpt around the binding, not a claim to include the whole function or its dependencies. Other text files can be selected as whole files; there is no second indexing platform.
- Likely secret assignments, common token patterns and private-key blocks are redacted. This is heuristic detection, not a guarantee that the selected source is safe to share. Inspect the entire outgoing preview.
- Source, README text and project instructions remain untrusted reference material. They cannot grant tool access, execute commands, edit files, approve a plan or authorize a run. Providers receive no source-directory path or filesystem permission.
- SHA-256 identifies the selected bytes. It does not establish correctness, authenticity, requirement coverage or successful checks.

The implementation uses the existing planning request store and adapters. Receipt schema version 1 is additive JSON metadata; it requires no new database table or source cache. Historical instruction resources remain supported. The new `planner-v6` / `provider-planner-v2` instructions are selected only for explicitly previewed repository context.
