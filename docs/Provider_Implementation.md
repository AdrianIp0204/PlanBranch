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

Only disposable databases, ports and repositories are used. After initial inspection found Ollama absent, the user explicitly authorized reinstalling it and downloading a reasonable model. Ollama 0.34.2, qwen3:4b and qwen3:4b-instruct were installed for bounded local verification. No real projects, global provider configuration or existing user server were changed; no paid API requests were made.

Initial environment inspection found Docker installed but its daemon unavailable.
The command runner must fail closed when isolation is unavailable; worktree
separation and process supervision alone are not command isolation.
