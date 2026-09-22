# Model connections and controlled coding

PlanBranch can plan and build with Ollama, OpenAI API, Anthropic API, Gemini API, or the optional Codex CLI. Manual diagrams, briefs, Build tasks, scanning, and exports require no model connection.

## Choose a connection

Open **Settings → Agent**. **Use for** selects independent defaults for Planning chat and Coding steps. Each provider remembers its model and supported reasoning option in this browser. Chat and Run previews share the corresponding default. Existing requests, question continuations, and retries retain their original settings; changing a default never switches an active run.

| Provider | Setup | Processing destination |
| --- | --- | --- |
| Ollama | Separately install/run Ollama and a generation-capable model. Default endpoint: `http://127.0.0.1:11434`. | Loopback Ollama server; cloud-backed models reported by Ollama are excluded from this local connector. |
| OpenAI API | Set `OPENAI_API_KEY` in the environment that starts PlanBranch. | `https://api.openai.com` using Responses. |
| Anthropic API | Set `ANTHROPIC_API_KEY`. | `https://api.anthropic.com` using Messages. |
| Gemini API | Set `GEMINI_API_KEY`. | `https://generativelanguage.googleapis.com` using Interactions. |
| Codex CLI | Separately install Codex and sign in using its existing flow. | Codex's configured service and existing account. |

Restart PlanBranch after changing environment variables. API keys remain in the server environment; PlanBranch stores no key values in browser preferences, SQLite, exports, request snapshots, or command environments. A Codex/ChatGPT sign-in does not provide API credentials or API billing. The app does not edit global provider configuration.

Cloud model suggestions describe documented capabilities, not your account's entitlements. Enter an explicit model ID if needed; undocumented models expose only model-default reasoning. Missing saved models remain visible until you choose a replacement. A configured key is not a successful connection check. Explicit API checks request model metadata without generation; even successful metadata access does not guarantee a particular model supports structured planning or tools. No checks send project context automatically.

For another local Ollama port, set `PLANBRANCH_OLLAMA_URL` before starting PlanBranch. Only loopback HTTP(S) origins are supported; credentials, paths, query strings, redirects and proxy inheritance are rejected. A localhost address alone cannot prove inference is local: PlanBranch rejects models whose metadata identifies cloud backing, but relies on the server's metadata. Do not point this connector at an untrusted proxy.

Installed Ollama models are discovered through the native API. Embedding-only models are excluded. Planning needs generation and valid structured output; coding additionally requires advertised tool support. No software or model is installed, downloaded, deleted, or silently substituted by the app. Setup links are optional.

## Planning and review

All providers use the same project context, clarification cards, visual proposals, brief and Build task review. Context includes the durable brief and relevant discussion, plus the visible candidate when revising it. Read-only scanner observations, filesystem permissions and attached source files are excluded.

Models cannot change saved plans directly. **Apply changes** is one undoable project edit. **Approve plan** records agreement on that saved plan and does not authorize coding. Manual proposal drafts and unsent writing retain their existing recovery and conflict controls.

Packaged, versioned instructions are the runtime source of truth; a global skill is unnecessary. Instructions distinguish program flow from Build work, request structured clarification for consequential uncertainty, and preserve assumptions as assumptions. Instructions are not permissions. Backend validation rejects malformed, incomplete, mixed or oversized replies without applying partial edits.

Requests freeze provider/model identity, instruction text/hash, context and supported settings. Ollama also freezes the model digest and checks it before and after inference. Replacing a model tag requires a new request. Input limits stop oversized context instead of silently truncating it. New Ollama requests default to a 24,576-token context window. Set `PLANBRANCH_OLLAMA_CONTEXT_WINDOW` to an integer from 2,048 to 32,768 before starting PlanBranch to fit available memory; the effective limit also respects the model maximum. The chosen cap is frozen into each request. Earlier version-1 requests retain their original 32,768-token profile. The byte-based input guard is conservative and is not a tokenizer. Small models may fail to produce a valid proposal, skip requested checks, or run out of context on larger projects. A model capability flag is not a guarantee that it will follow every instruction. Such failures remain explicit and retryable.

## Coding with Ollama or an API model

Select an execution repository explicitly in **Build → Run step**. Scanner attachment never grants execution permission. Review the approved task, relevant requirements, source revision, model and command policy, then explicitly choose **Run step**. A Git worktree is created from the committed revision, preserving your original checkout and uncommitted changes.

One shared execution harness serves all four native model adapters. Its tools list/search/read bounded files, write validated content with expected hashes, inspect changes, run isolated commands, or pause for a structured question. Calls are validated and mutations serialized. File tools reject traversal, `.git`, symlink and junction escapes. Provider tool IDs and opaque continuation data stay associated with the correct native protocol; internal reasoning is never displayed.

The harness journals intent before each tool and records its observed result afterward. It stops on cancellation, uncertainty, repeated tool failures or bounded turn/call/time/output limits. Each run has at most 24 model turns, 80 tool calls and 20 minutes of active work across clarification continuations; time waiting for your answer does not count. Older development journals without an elapsed-time record remain available for review but require a newly previewed run rather than receiving another time budget. An unanswered execution question pauses the run. Answering explicitly resumes the same frozen task in a new model context containing its prior visible evidence; restart never automatically repeats a pending effect.

### Independent command runtime

Native-provider commands require a separately installed local Docker engine with Linux containers and seccomp enabled. Docker Desktop supplies this on supported Windows systems; a local Docker Engine supplies it on Linux. Codex CLI is not involved in this runner. Choose an **already prepared, trusted local image** with the language/runtime and dependencies needed for the task:

```powershell
$env:PLANBRANCH_EXECUTION_IMAGE = "your-existing-image:tag"
python -m flowdesk
```

On Linux, use `export PLANBRANCH_EXECUTION_IMAGE=your-existing-image:tag` before launch. The image must provide `/usr/bin/env`, `/bin/sh`, `cp`, `chmod`, `tar`, `sleep` and `sed`, and cannot declare writable Docker volumes. The default local Docker endpoint is Docker Desktop's Linux named pipe on Windows, or `/var/run/docker.sock` on Linux; `PLANBRANCH_DOCKER_HOST` can select another local named pipe or Unix socket. Remote Docker endpoints are unsupported. Preview freezes the local daemon and image identity; later preference/environment changes cannot redirect an existing run.

Commands run as UID/GID 65534 with no effective capabilities, no network, no new privileges, a read-only root, capped CPU/memory/process counts, and a bounded writable tmpfs workspace. They receive a read-only copy of permitted files, without Git metadata, host directories, credentials or Docker sockets. The trusted collection process stops model descendants before collecting output. The entire returned archive is checked for path/link/type/size violations before files are copied to the isolated worktree. The host process supervisor controls lifetime; Docker provides command isolation.

There are no image pulls, dependency installations or network grants during runs. Prepare necessary dependencies separately and deliberately. If the runner or image is unavailable, safe file tools remain usable and checks are explicitly **not run**. There is no unrestricted host-command fallback. This mode is not equivalent to tested execution.

Normal cancellation/timeout attempts to collect validated partial output, removes the owned container and preserves worktree edits. A watchdog removes the container after server death. A hard crash can lose changes still inside the command's temporary filesystem; earlier worktree edits and the pending command journal remain recoverable. Uncertain commands are never replayed automatically. Cancelling a cloud request locally cannot guarantee remote generation or billing stops.

### Review the result

Provider usage is shown when returned; missing usage and monetary cost remain unknown. **Agent report** is a claim. **Observed commands** records actual command text, exit codes and bounded output. A completed response does not mean tests passed.

**Accept changes**, **Complete task**, and **Apply to checkout** remain separate deliberate actions. Application checks the reviewed diff, source baseline and approval freshness; conflicts stop it. The app never automatically accepts, commits, merges, pushes, or starts another task. Review and commit applied work yourself before starting a dependent task.

Codex CLI retains its separate existing planner, executor and native sandbox settings. Its availability is optional; it is never a fallback for another provider.

## Recovery, backups and packaging

Database migration 10 adds provider attribution to planning messages without rewriting historical requests or manual content. Records without provider metadata remain Codex records. Existing request receipts, proposal drafts, unsent writing, Undo/Redo and approval freshness are preserved.

SQLite backup alone does not contain worktrees, diffs or tool journals. Stop PlanBranch and back up its entire data directory and the source repositories for coding recovery. Portable JSON excludes machine permissions, credentials and run data. API keys must be configured separately on the destination machine.

The wheel and Windows portable ZIP contain all adapter code and packaged instructions, with no provider SDK runtime dependency. They do not bundle Ollama, models, Codex, Docker, Git, credentials or container images. Manual planning works with none of those installed; optional provider/runtime requirements are checked when used.

See [validation](../VALIDATION.md) for the exact automated/live checks and platform limitations, and [provider protocol sources](Provider_Catalogue_Sources.md) for native API references.
