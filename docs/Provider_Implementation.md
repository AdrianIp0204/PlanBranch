# Provider-independent implementation sequence

This pass starts from `main` at `4ecc14b` on `codex/provider-independent`.

1. Add provider contracts, native discovery, separate planning/coding preferences,
   and Ollama planning while preserving legacy Codex requests and receipts.
2. Add an application-owned bounded coding loop, durable tool journals, and a
   Docker command runner independent of Codex. Preserve existing worktree,
   approval, review and checkout-application controls.
3. Verify native OpenAI, Anthropic and Gemini contracts against deterministic
   fixtures. No live paid API calls or credential discovery for testing.
4. Run regression, disposable Ollama/browser and package checks; update user
   documentation and record actual limitations. Commit usable increments locally.

Only disposable databases, ports and repositories are used. The installed Ollama
may be used for bounded local inference. Model downloads and changes to user
projects, global configuration or the existing daemon are excluded.

Initial environment inspection found Docker installed but its daemon unavailable.
The command runner must fail closed when isolation is unavailable; worktree
separation and process supervision alone are not command isolation.
