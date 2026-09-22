"""Provider-independent model boundary and frozen, credential-free selections.

Cloud catalogues describe documented options, not an account's entitlement.
Unknown explicit cloud model IDs remain usable with model-default reasoning.
Native tool continuation is private in-memory data; callers must never journal
it. Legacy Codex resources and serialized selections are left unchanged.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from importlib import resources
import os
from pathlib import Path
import re
import threading
import time
from urllib.parse import urlsplit

from .provider_transport import ProviderError, ProviderCancelled, decode_json, encode_json, request_json


PROVIDERS = ("codex", "ollama", "openai", "anthropic", "gemini")
LABELS = {"codex": "Codex CLI", "ollama": "Ollama", "openai": "OpenAI API", "anthropic": "Anthropic API", "gemini": "Gemini API"}
KEYS = {"openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY", "gemini": "GEMINI_API_KEY"}
_V1_ENDPOINTS = {"openai": "https://api.openai.com", "anthropic": "https://api.anthropic.com", "gemini": "https://generativelanguage.googleapis.com"}
ENDPOINTS = dict(_V1_ENDPOINTS)
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}\Z")
DIGEST = re.compile(r"(?:sha256:)?[a-fA-F0-9]{64}\Z")
INSTRUCTIONS = {"planning": "provider-planner-v1", "coding": "provider-coder-v1"}
_V1_INSTRUCTIONS = {"provider-planner-v1": "planning", "provider-coder-v1": "coding"}
MAX_CONTEXT_BYTES = 500_000
MAX_OUTPUT_TOKENS = 16_384
OLLAMA_CONTEXT_LIMIT = 24_576
MAX_MODELS = 100
CACHE_SECONDS = 300
FAILURE_CACHE_SECONDS = 15
# These profiles are persisted-contract definitions, not live defaults. Add a
# new generation version to change them; never rewrite retained version 1.
_V1_EFFORTS = {"openai": {"none", "minimal", "low", "medium", "high", "xhigh", "max"},
               "anthropic": {"low", "medium", "high", "xhigh", "max"},
               "gemini": {"minimal", "low", "medium", "high"},
               "ollama": {"on", "off", "low", "medium", "high"}}
_V1_LIMITS = {"apiOutput": 16_384, "apiInputBytes": 1_500_000, "localContext": 32_768,
              "localOutput": 4096, "localOverhead": 1024}
_V2_LIMITS = {"apiOutput": 16_384, "apiInputBytes": 1_500_000, "localContext": 32_768,
              "localOutput": 4096, "localOverhead": 1024}
# Deliberately small, documented catalogue. Model-default reasoning is always
# allowed, including for explicitly entered IDs outside these suggestions.
# Sources checked 2026-09-22: OpenAI model pages, Claude effort/model overview,
# https://ai.google.dev/gemini-api/docs/thinking . No key is used for discovery.
CLOUD_MODELS = {
    "openai": [
        ("gpt-6-astra", "GPT-6 Astra", ("low", "medium", "high", "xhigh", "max"), "medium"),
        ("gpt-5.6-sol", "GPT-5.6 Sol", ("none", "low", "medium", "high", "xhigh", "max"), "medium"),
    ],
    "anthropic": [
        ("claude-opus-5", "Claude Opus 5", ("low", "medium", "high"), "high"),
        ("claude-sonnet-5", "Claude Sonnet 5", ("low", "medium", "high"), "high"),
    ],
    "gemini": [
        ("gemini-3.8-flash", "Gemini 3.8 Flash", ("low", "medium", "high"), "medium"),
        ("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", ("low", "medium", "high"), "high"),
    ],
}


def _provider(value):
    if not isinstance(value, str) or value not in PROVIDERS:
        raise ProviderError("Choose a supported provider.")
    return value


def normalize_selection(value):
    """Preserve byte-equivalent legacy dictionaries for retained request hashes."""
    if value is None or value == {"mode": "default"}:
        return {"mode": "default"}
    if not isinstance(value, dict):
        raise ProviderError("Choose a provider and a model.")
    fields = {"mode", "model", "reasoningEffort"}
    provider = value.get("provider", "codex")
    if "provider" in value:
        fields.add("provider")
        if provider == "codex":
            raise ProviderError("Codex selections use CLI default or an explicit CLI model.")
    _provider(provider)
    if set(value) != fields or value.get("mode") != "explicit":
        raise ProviderError("Choose a supported provider and an explicit model.")
    model, effort = value["model"], value["reasoningEffort"]
    if (not isinstance(model, str) or not IDENTIFIER.fullmatch(model)
            or (effort is not None and (not isinstance(effort, str) or not IDENTIFIER.fullmatch(effort)))):
        raise ProviderError("The selected model or reasoning option is invalid.")
    result = {"mode": "explicit", "model": model, "reasoningEffort": effort}
    return {"provider": provider, **result} if provider != "codex" else result


def _ollama_endpoint(value):
    try:
        if not isinstance(value, str) or len(value) > 300 or any(ch.isspace() for ch in value):
            raise ValueError
        parsed = urlsplit(value)
        if (parsed.scheme not in ("http", "https") or parsed.hostname not in ("localhost", "127.0.0.1", "::1")
                or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment
                or parsed.path not in ("", "/") or parsed.port == 0):
            raise ValueError
        host = "[::1]" if parsed.hostname == "::1" else parsed.hostname
        return parsed.scheme + "://" + host + (":" + str(parsed.port) if parsed.port else "")
    except (ValueError, TypeError):
        raise ProviderError("PLANBRANCH_OLLAMA_URL must be a loopback HTTP(S) origin without credentials, path, or query.") from None


def instruction_resource(purpose="planning"):
    if not isinstance(purpose, str) or purpose not in INSTRUCTIONS:
        raise ProviderError("Unsupported model purpose.")
    try:
        return resources.files("flowdesk").joinpath("prompts", INSTRUCTIONS[purpose] + ".md").read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise ProviderError("PlanBranch's provider instructions are missing. Reinstall the application.") from None


def _cloud_model(provider, model):
    return next((row for row in CLOUD_MODELS[provider] if row[0] == model), None)


def validate_generation(value, purpose=None):
    if purpose is not None and (not isinstance(purpose, str) or purpose not in ("planning", "coding")):
        raise ProviderError("Unsupported model purpose.")
    if not isinstance(value, dict):
        raise ProviderError("The saved model configuration is invalid. Start a new request.")
    if "providerGenerationVersion" not in value:
        # Imports alone never launch Codex or require it to be installed.
        if purpose == "coding" or (purpose is None and "protocolVersion" not in value):
            from .codex_executor import validate_generation as legacy_validate
        else:
            from .codex_planner import validate_generation as legacy_validate
        try:
            return legacy_validate(value)
        except RuntimeError as exc:
            raise ProviderError(str(exc)) from None
    fields = {"providerGenerationVersion", "provider", "selection", "purpose", "modelIdentity", "endpoint", "limits",
              "providerVersion", "cliVersion", "instructionVersion", "instructionHash", "instructions", "protocolVersion"}
    generation_version = value["providerGenerationVersion"]
    if type(generation_version) is int and generation_version == 2:
        fields.add("contextWindowCap")
    if (set(value) != fields or type(generation_version) is not int or generation_version not in (1, 2)
            or not isinstance(value["purpose"], str) or value["purpose"] not in ("planning", "coding")
            or (purpose is not None and value["purpose"] != purpose)
            or not isinstance(value["instructionVersion"], str)
            or _V1_INSTRUCTIONS.get(value["instructionVersion"]) != value["purpose"]
            or type(value["protocolVersion"]) is not int or value["protocolVersion"] != 4 or value["cliVersion"] is not None):
        raise ProviderError("This saved provider configuration is unsupported. Start a new request.")
    provider = _provider(value["provider"])
    selection = normalize_selection(value["selection"])
    if provider == "codex" or selection.get("provider") != provider:
        raise ProviderError("The saved provider and model selection disagree. Start a new request.")
    text = value["instructions"]
    try:
        encoded = text.encode("utf-8")
    except (AttributeError, UnicodeError):
        raise ProviderError("The saved provider instructions are invalid.") from None
    if not encoded or len(encoded) > 32_000 or hashlib.sha256(encoded).hexdigest() != value["instructionHash"]:
        raise ProviderError("The saved provider instructions are invalid.")
    identity = value["modelIdentity"]
    if (not isinstance(identity, dict) or set(identity) != {"id", "digest", "tools", "reasoningEfforts", "contextWindow"}
            or identity["id"] != selection["model"] or identity["tools"] not in (True, False, None)
            or type(identity["tools"]) not in (bool, type(None))
            or not isinstance(identity["reasoningEfforts"], list) or len(identity["reasoningEfforts"]) > 20
            or any(not isinstance(e, str) or not IDENTIFIER.fullmatch(e) for e in identity["reasoningEfforts"])
            or len(set(identity["reasoningEfforts"])) != len(identity["reasoningEfforts"])
            or (selection["reasoningEffort"] is not None and selection["reasoningEffort"] not in identity["reasoningEfforts"])):
        raise ProviderError("The saved model capabilities are invalid. Start a new request.")
    version = value["providerVersion"]
    if version is not None and (not isinstance(version, str) or len(version) > 80 or not IDENTIFIER.fullmatch(version)):
        raise ProviderError("The saved provider version is invalid.")
    if provider == "ollama":
        if (_ollama_endpoint(value["endpoint"]) != value["endpoint"] or not isinstance(identity["digest"], str)
                or not DIGEST.fullmatch(identity["digest"]) or type(identity["tools"]) is not bool
                or type(identity["contextWindow"]) is not int or not 2048 <= identity["contextWindow"] <= 100_000_000
                or any(e not in ("on", "off", "low", "medium", "high") for e in identity["reasoningEfforts"])):
            raise ProviderError("The saved local model identity is invalid. Start a new request.")
    else:
        if (value["endpoint"] != _V1_ENDPOINTS[provider] or identity["digest"] is not None or identity["contextWindow"] is not None
                or any(e not in _V1_EFFORTS[provider] for e in identity["reasoningEfforts"])
                or identity["tools"] is False or version is not None):
            raise ProviderError("The saved API model configuration is invalid. Start a new request.")
    cap = None
    if generation_version == 2:
        cap = value["contextWindowCap"]
        if ((provider == "ollama" and (type(cap) is not int or not 2048 <= cap <= _V2_LIMITS["localContext"]))
                or (provider != "ollama" and cap is not None)):
            raise ProviderError("The saved model context cap is invalid. Start a new request.")
    limits = value["limits"]
    if (not isinstance(limits, dict) or set(limits) != {"contextWindow", "maxOutputTokens", "inputByteBudget"}
            or any(type(limits[k]) is not int for k in ("maxOutputTokens", "inputByteBudget"))
            or (limits["contextWindow"] is not None and type(limits["contextWindow"]) is not int)
            or limits != _limits(identity["contextWindow"], version=generation_version, context_cap=cap)):
        raise ProviderError("The saved model context limits are invalid. Start a new request.")
    return deepcopy(value)


def _configured_context_window():
    raw = os.environ.get("PLANBRANCH_OLLAMA_CONTEXT_WINDOW")
    if raw is None:
        return OLLAMA_CONTEXT_LIMIT
    value = raw.strip()
    if not re.fullmatch(r"[0-9]{1,5}", value) or not 2048 <= int(value) <= 32768:
        raise ProviderError("PLANBRANCH_OLLAMA_CONTEXT_WINDOW must be an integer from 2048 to 32768. Fix it outside PlanBranch and start a new request.")
    return int(value)


def _limits(context_window, *, version=1, context_cap=None):
    # Persisted versions never consult current defaults or environment values.
    profile = _V1_LIMITS if version == 1 else _V2_LIMITS
    if context_window is None:
        return {"contextWindow": None, "maxOutputTokens": profile["apiOutput"], "inputByteBudget": profile["apiInputBytes"]}
    window = min(context_window, profile["localContext"] if version == 1 else context_cap)
    output = min(profile["localOutput"], window // 4)
    # UTF-8 bytes are a conservative input-size guard, not a claimed tokenizer.
    # Include the schema, tools and all serialized native history in that guard.
    return {"contextWindow": window, "maxOutputTokens": output, "inputByteBudget": window - output - profile["localOverhead"]}


def _api_headers(provider):
    key = os.environ.get(KEYS[provider], "").strip()
    if not key or len(key) > 8192 or any(ord(ch) < 33 or ord(ch) > 126 for ch in key):
        raise ProviderError(f"Set a valid {KEYS[provider]} outside PlanBranch and restart the application.")
    if provider == "openai":
        return {"Authorization": "Bearer " + key}
    if provider == "anthropic":
        return {"x-api-key": key, "anthropic-version": "2023-06-01"}
    return {"x-goog-api-key": key}

class ProviderRegistry:
    def __init__(self, data_dir, *, timeout=180):
        self.data_dir = Path(data_dir)
        self.timeout = min(timeout, 180)
        self._codex = None
        self._cache = None
        self._cache_at = float("-inf")
        self._cache_endpoint = None
        self._lock = threading.Lock()

    @property
    def codex(self):
        if self._codex is None:
            from .codex_planner import CodexPlanner
            self._codex = CodexPlanner(timeout=self.timeout)
        return self._codex

    def connections(self):
        entries = []
        for provider in PROVIDERS:
            credential = KEYS.get(provider)
            item = {"id": provider, "provider": provider, "label": LABELS[provider],
                    "kind": "cli" if provider == "codex" else "local" if provider == "ollama" else "api",
                    "credentialSource": credential, "credentialConfigured": bool(os.environ.get(credential, "").strip()) if credential else False,
                    "endpoint": ENDPOINTS.get(provider)}
            item["configured"] = item["credentialConfigured"] if credential else True
            if provider == "ollama":
                try:
                    item["endpoint"] = _ollama_endpoint(os.environ.get("PLANBRANCH_OLLAMA_URL", "http://127.0.0.1:11434"))
                except ProviderError as exc:
                    item.update(configured=False, reason=str(exc))
            entries.append(item)
        return entries

    def check_connection(self, provider="codex", cancel=None):
        """Explicit user action; read one metadata page, never run a model.

        Cloud status/capabilities never call this method automatically. Provider
        model lists need not cover all usable IDs, nor prove generation/tool
        entitlement; their returned IDs are informational only.
        """
        _provider(provider)
        result = {"provider": provider, "label": LABELS[provider], "available": False, "verified": False,
                  "checkedAt": datetime.now(timezone.utc).isoformat(), "modelIds": [], "modelsPartial": False}
        if provider not in KEYS:
            state = self.status(provider, refresh=True)
            return {**result, **state, "verified": bool(state["available"])}
        try:
            path = "/v1beta/models" if provider == "gemini" else "/v1/models"
            metadata = request_json(ENDPOINTS[provider], path, headers=_api_headers(provider), timeout=10,
                                    cancel=cancel, max_response_bytes=1_000_000)
            rows = metadata.get("models" if provider == "gemini" else "data")
            if not isinstance(rows, list) or len(rows) > 1000 or metadata.get("error"):
                raise ProviderError("The provider returned invalid model metadata. Generation was not attempted.")
            ids = []
            for row in rows:
                key = row.get("name" if provider == "gemini" else "id") if isinstance(row, dict) else None
                if provider == "gemini" and isinstance(key, str) and key.startswith("models/"):
                    key = key[len("models/"):]
                if not isinstance(key, str) or not IDENTIFIER.fullmatch(key):
                    raise ProviderError("The provider returned invalid model metadata. Generation was not attempted.")
                if key not in ids:
                    ids.append(key)
            partial = bool(metadata.get("nextPageToken") or metadata.get("has_more"))
            reason = "API connection verified using model metadata. Generation and tool access have not been tested."
            if partial:
                reason += " Only the first model page was checked."
            result.update(available=True, verified=True, reason=reason, modelIds=ids, modelsPartial=partial)
        except ProviderCancelled:
            raise
        except ProviderError as exc:
            result["reason"] = str(exc)
        return result

    def status(self, provider="codex", *, refresh=False):
        _provider(provider)
        if provider == "codex":
            return {**self.codex.status(refresh=refresh), "provider": provider}
        if provider == "ollama":
            catalog = self.capabilities(provider, refresh=refresh)
            return {"available": catalog["status"] == "ready", "label": LABELS[provider], "provider": provider,
                    **({"reason": catalog["reason"]} if "reason" in catalog else {})}
        configured = bool(os.environ.get(KEYS[provider], "").strip())
        return {"available": configured, "label": LABELS[provider], "provider": provider,
                "verified": False, "reason": "API key is configured; model access has not been tested." if configured else
                f"Set {KEYS[provider]} outside PlanBranch and restart the application."}

    def connection_status(self, refresh=False):
        return self.status(refresh=refresh)

    def capabilities(self, provider="codex", refresh=False):
        _provider(provider)
        if provider == "codex":
            return {**self.codex.capabilities(refresh=refresh), "provider": provider}
        if provider in CLOUD_MODELS:
            return {"provider": provider, "status": "ready", "source": "builtin_catalogue", "cliVersion": None,
                    "fetchedAt": None, "allowsCustomModel": True,
                    "reason": "Documented suggestions; API key and account model access are not tested.",
                    "models": [{"id": row[0], "label": row[1], "description": "Documented text and tool model; account access varies.",
                        "defaultReasoningEffort": row[3], "reasoningEfforts": [{"id": e, "description": ""} for e in row[2]],
                        "isDefault": i == 0, "tools": True, "capabilitySource": "documentation"}
                        for i, row in enumerate(CLOUD_MODELS[provider])]}
        with self._lock:
            result = {"provider": provider, "status": "unavailable", "source": "ollama_metadata", "cliVersion": None,
                      "providerVersion": None, "fetchedAt": None, "models": []}
            try:
                endpoint = _ollama_endpoint(os.environ.get("PLANBRANCH_OLLAMA_URL", "http://127.0.0.1:11434"))
                ttl = CACHE_SECONDS if self._cache and self._cache["status"] == "ready" else FAILURE_CACHE_SECONDS
                if (not refresh and self._cache_endpoint == endpoint and self._cache is not None
                        and time.monotonic() - self._cache_at < ttl):
                    return deepcopy(self._cache)
                self._cache_endpoint = endpoint
                deadline = time.monotonic() + 25
                def metadata(path, data=None):
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ProviderError("Ollama model discovery timed out. Retry after checking the local service.")
                    return request_json(endpoint, path, data=data, timeout=min(5, remaining), max_response_bytes=1_000_000)
                version = metadata("/api/version").get("version")
                if not isinstance(version, str) or len(version) > 80 or not IDENTIFIER.fullmatch(version):
                    raise ProviderError("Ollama returned an invalid server version. Update or check the local service.")
                tags = metadata("/api/tags").get("models")
                if not isinstance(tags, list) or len(tags) > MAX_MODELS:
                    raise ProviderError("Ollama returned an unsupported model catalogue size.")
                models, seen = [], set()
                for row in tags:
                    if not isinstance(row, dict):
                        raise ProviderError("Ollama returned an invalid model catalogue.")
                    model, digest = row.get("name"), row.get("digest")
                    if (not isinstance(model, str) or not IDENTIFIER.fullmatch(model) or model in seen
                            or not isinstance(digest, str) or not DIGEST.fullmatch(digest)):
                        raise ProviderError("Ollama returned an invalid model identity.")
                    seen.add(model)
                    shown = metadata("/api/show", {"model": model})
                    caps = shown.get("capabilities")
                    if not isinstance(caps, list) or any(not isinstance(v, str) for v in caps):
                        continue  # Older servers do not prove text/tool capability.
                    if "completion" not in caps or row.get("remote_host") or shown.get("remote_host"):
                        continue  # No embedding-only or cloud-backed Ollama models.
                    info = shown.get("model_info", {})
                    windows = [v for k, v in info.items() if k.endswith(".context_length") and type(v) is int
                               and 2048 <= v <= 100_000_000] if isinstance(info, dict) else []
                    if not windows:
                        continue  # Cannot freeze an explicit safe context limit.
                    family = (shown.get("details") or {}).get("family", "") if isinstance(shown.get("details"), dict) else ""
                    efforts = (["low", "medium", "high"] if family == "gptoss" else ["off", "on"]) if "thinking" in caps else []
                    models.append({"id": model, "label": model, "description": "Installed local text model", "digest": digest,
                        "tools": "tools" in caps, "contextWindow": min(windows),
                        "defaultReasoningEffort": "medium" if family == "gptoss" and efforts else None,
                        "reasoningEfforts": [{"id": e, "description": ""} for e in efforts], "isDefault": not models})
                result.update(status="ready" if models else "unavailable", providerVersion=version,
                              fetchedAt=datetime.now(timezone.utc).isoformat(), models=models)
                if not models:
                    result["reason"] = "No installed local text models advertise completion and context limits. Update Ollama or install a suitable model outside PlanBranch."
                self._cache_endpoint = endpoint
            except ProviderError as exc:
                result["reason"] = str(exc)
            self._cache, self._cache_at = result, time.monotonic()
            return deepcopy(result)

    def configure(self, selection=None, purpose="planning"):
        selection = normalize_selection(selection)
        if not isinstance(purpose, str) or purpose not in INSTRUCTIONS:
            raise ProviderError("Unsupported model purpose.")
        provider = selection.get("provider", "codex")
        if provider == "codex":
            if purpose == "coding":
                from .codex_executor import CodexExecutor
                return CodexExecutor().configure(selection)
            return self.codex.configure(selection)
        context_cap = _configured_context_window() if provider == "ollama" else None
        catalog = self.capabilities(provider)
        model = next((m for m in catalog["models"] if m["id"] == selection["model"]), None)
        if provider == "ollama" and (catalog["status"] != "ready" or model is None):
            raise ProviderError("The selected local model is unavailable. Refresh installed models and choose again.")
        efforts = [e["id"] for e in model["reasoningEfforts"]] if model else []
        if selection["reasoningEffort"] is not None and selection["reasoningEffort"] not in efforts:
            raise ProviderError("This reasoning option is not documented for the selected model. Choose model default or a supported option.")
        if purpose == "coding" and model and model.get("tools") is False:
            raise ProviderError("This local model does not advertise tool support. Choose a tool-capable model for coding.")
        endpoint = (_ollama_endpoint(os.environ.get("PLANBRANCH_OLLAMA_URL", "http://127.0.0.1:11434"))
                    if provider == "ollama" else ENDPOINTS[provider])
        instructions = instruction_resource(purpose)
        return validate_generation({"providerGenerationVersion": 2, "contextWindowCap": context_cap, "provider": provider, "selection": selection, "purpose": purpose,
            "modelIdentity": {"id": selection["model"], "digest": model.get("digest") if model else None,
                              "tools": model.get("tools") if model else None, "reasoningEfforts": efforts,
                              "contextWindow": model.get("contextWindow") if model else None},
            "limits": _limits(model.get("contextWindow") if model else None, version=2, context_cap=context_cap),
            "endpoint": endpoint, "providerVersion": catalog.get("providerVersion"), "cliVersion": None,
            "instructionVersion": INSTRUCTIONS[purpose], "instructionHash": hashlib.sha256(instructions.encode()).hexdigest(),
            "instructions": instructions, "protocolVersion": 4}, purpose)

    def _ready(self, generation, cancel):
        provider = generation["provider"]
        if provider == "ollama":
            current = _ollama_endpoint(os.environ.get("PLANBRANCH_OLLAMA_URL", "http://127.0.0.1:11434"))
            if current != generation["endpoint"]:
                raise ProviderError("The local endpoint changed after this request was prepared. Start a new request.")
            tags = request_json(current, "/api/tags", timeout=5, cancel=cancel, max_response_bytes=1_000_000).get("models")
            expected = generation["modelIdentity"]
            if (not isinstance(tags, list) or len(tags) > MAX_MODELS or not any(isinstance(row, dict)
                    and row.get("name") == expected["id"] and row.get("digest") == expected["digest"] for row in tags)):
                raise ProviderError("The selected local model was removed or changed since this request was prepared. Start a new request.")
            return {}
        return _api_headers(provider)

    def generate(self, context, cancel=None):
        if not isinstance(context, dict):
            raise ProviderError("The planning context is invalid.")
        generation = validate_generation(context.get("generation"), "planning")
        if "providerGenerationVersion" not in generation:
            return self.codex.generate(context, cancel=cancel)
        fields = ("content", "activeDiagramId", "nodeId", "messages", "comments", "omittedMessageCount",
                  "omittedResolvedCommentCount", "questionSets", "reviewProposal")
        payload = {key: context[key] for key in fields if key in context}
        encoded = encode_json(payload)
        if len(encoded) > MAX_CONTEXT_BYTES:
            raise ProviderError("This planning context is too large. Shorten the conversation before retrying.")
        # Reuse the immutable protocol-4 schema; this import does not instantiate
        # the optional Codex connector or resolve any executable.
        from .codex_planner import OUTPUT_SCHEMA_V4, _validate_shape
        from .planning_questions import validate_envelope
        reply = self._turn(generation, [{"role": "user", "content": "Planning context (task data):\n" + encoded.decode()}], [], cancel, OUTPUT_SCHEMA_V4)
        if reply["toolCalls"] or not reply["done"]:
            raise ProviderError("The provider did not return a complete planning response. Your plan has not changed.")
        try:
            value = decode_json(reply["text"])
            _validate_shape(value, OUTPUT_SCHEMA_V4)
            validate_envelope(value, 4)
            if value["proposal"] and value["proposal"]["diagramId"] != context.get("activeDiagramId"):
                raise ValueError
            return value
        except (ValueError, TypeError, KeyError, RecursionError, ProviderError):
            raise ProviderError("The provider returned an invalid planning response. Your plan has not changed; try again.") from None

    def turn(self, generation, messages, tools, cancel=None):
        generation = validate_generation(generation, "coding")
        if "providerGenerationVersion" not in generation:
            raise ProviderError("Codex coding uses its separate CLI execution connector.")
        return self._turn(generation, messages, tools, cancel, None)

    def _turn(self, generation, messages, tools, cancel, schema):
        from .provider_protocols import make_request, parse_response
        from .provider_streams import StreamDecoder
        path, body = make_request(generation, messages, tools, schema)
        if len(encode_json(body)) > generation["limits"]["inputByteBudget"]:
            raise ProviderError("This request exceeds the selected model's frozen context budget. Reduce the context or choose a model with a larger context window; nothing was truncated.")
        headers = self._ready(generation, cancel)
        response = request_json(generation["endpoint"], path, data=body, headers=headers, timeout=self.timeout,
                                cancel=cancel, stream_parser=StreamDecoder(generation["provider"]))
        result = parse_response(generation, response)
        if any(call["name"] not in {tool["name"] for tool in tools} for call in result["toolCalls"]):
            raise ProviderError("The model requested a tool that was not offered. No tools were run from this response.")
        if generation["provider"] == "ollama":
            # A tag can change while inference is active. Reject its response
            # before handing any calls to the executor if that happened.
            self._ready(generation, cancel)
        return result
