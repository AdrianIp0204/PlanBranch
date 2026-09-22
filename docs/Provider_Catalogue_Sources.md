# Provider catalogue and native protocol sources

Verified against official documentation on 22 September 2026. No cloud model
requests or account-entitlement probes were made. Built-in catalogue entries are
suggestions based on documentation, not evidence that a user's key can access a
model. Any valid explicit cloud model ID is accepted with model-default reasoning.

| Provider | Suggested IDs and advertised reasoning choices | Official source |
| --- | --- | --- |
| OpenAI | `gpt-6-astra`: low, medium, high, xhigh, max | [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) |
| OpenAI | `gpt-5.6-sol`: none, low, medium, high, xhigh, max | [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) |
| Anthropic | `claude-opus-5`, `claude-sonnet-5`: low, medium, high | [Model overview](https://platform.claude.com/docs/en/models/overview), [effort options](https://platform.claude.com/docs/en/build-with-claude/effort) |
| Gemini | `gemini-3.8-flash`, `gemini-3.1-pro-preview`: low, medium, high | [Thinking levels](https://ai.google.dev/gemini-api/docs/thinking) |

Anthropic's advertised menu is a conservative subset. The adapter does not
advertise every higher effort option supported by every Claude model. Selecting
model default omits the provider's reasoning option, including for unknown IDs.

Wire implementations use [OpenAI Responses function calling](https://developers.openai.com/api/docs/guides/function-calling),
[Anthropic Messages tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
and [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
and [Gemini Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview)
with its [function-calling](https://ai.google.dev/gemini-api/docs/function-calling)
and [structured-output](https://ai.google.dev/gemini-api/docs/structured-output)
contracts. Gemini's Interactions API is the currently recommended native API for
new applications. OpenAI and Gemini requests explicitly use `store: false`.

[Ollama chat](https://docs.ollama.com/api/chat),
[model metadata](https://docs.ollama.com/api/show), and
[thinking controls](https://docs.ollama.com/capabilities/thinking) determine local
choices. Discovery reads installed metadata only. It skips embedding-only models,
remote-backed models, and models without a reported context limit. Thinking models
advertise on/off except GPT-OSS, which advertises low/medium/high. Local inference
freezes the tag's digest, rechecks it before and after a response, explicitly sets
`num_ctx` explicitly and `num_predict` to at most 4,096, and rejects requests
over a conservative UTF-8 byte budget. This byte guard is not a tokenizer or an
inference-quality guarantee. Missing terminal events and reported context-limit
exhaustion are errors, not accepted partial results.

All four adapters request streaming and reconstruct complete native responses.
Private native thinking and signatures stay in memory for tool continuation;
they are excluded from visible text and durable execution records. Partial tool
arguments are never executable. Requests have byte, event, time, and concurrency
limits; cancellation closes the active HTTP connection. Cloud cancellation cannot
guarantee that an already accepted request avoids provider charges.

New requests use generation version 2. Ollama's per-request context cap defaults
to 24,576 and can be set with `PLANBRANCH_OLLAMA_CONTEXT_WINDOW` to an integer from
2,048 through 32,768. Invalid values fail clearly; they never silently select a
fallback. The selected cap and effective limits are frozen in the generation,
with the effective window bounded by the model's discovered maximum. Retries do
not read the current environment. Output allowance is at most 4,096, or one
quarter of the window when smaller; input UTF-8 bytes are bounded by the remaining
window after a 1,024-unit reserve. The complete serialized request, including
instructions, schemas and tools, is checked before any inference. Smaller caps
can reject planning requests with large schemas; no context is silently removed.

This default reduces context allocation compared with 32,768. Local verification
found that a 4B model at 32,768 exceeded the available memory on an 8 GB-class GPU
and used CPU offloading; this is a hardware-specific observation, not a performance
guarantee. The setting affects only PlanBranch requests and does not change global
Ollama configuration. Adjust it for the chosen model and hardware.

Generation version 1 retains its immutable 32,768 maximum, original output/input
budgets, and exact retry behavior. Version 2 retains the same native wire protocol
while freezing its explicit context cap. Catalogue edits
must not alter a retained request's model, options, instructions, or limits. Future
changes to the wire contract or limit profile require a new generation version;
older validators remain available for exact retries. The endpoint is frozen, and
API credentials are looked up only when sending a request; credentials never enter
a saved generation snapshot.


API connection checks are explicit user actions. They perform one bounded metadata
GET using [OpenAI Models](https://developers.openai.com/api/reference/resources/models/methods/list),
[Anthropic Models](https://platform.claude.com/docs/en/api/models/list), or
[Gemini Models](https://ai.google.dev/api/models#method:-models.list). A successful
check verifies that metadata request only; it does not establish generation or
tool access. Returned model IDs are informational, and a pagination flag indicates
when more pages exist. Status, connection settings, and catalogue rendering never
perform these cloud checks automatically.
