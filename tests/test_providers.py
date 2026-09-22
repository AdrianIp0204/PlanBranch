"""Provider contract tests use synthetic local HTTP only, never cloud keys/services."""
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time

import pytest

from flowdesk import providers as api
from flowdesk import provider_transport as transport
from flowdesk.provider_protocols import make_request, parse_response


REPLY = {"protocolVersion": 4, "kind": "reply", "message": "A concise plan.", "questions": [], "proposal": None}
TOOLS = [{"name": "read_file", "description": "Read a worktree file", "parameters": {
    "type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False}}]
MODEL = {"openai": "gpt-6-astra", "anthropic": "claude-opus-5", "gemini": "gemini-3.8-flash", "ollama": "local:small"}


@pytest.fixture(autouse=True)
def isolated_keys(monkeypatch):
    # Replace rather than inspect environment credentials. These are fixture values.
    for key in api.KEYS.values():
        monkeypatch.setenv(key, "fixture-not-a-real-key")
    monkeypatch.delenv("PLANBRANCH_OLLAMA_URL", raising=False)


@pytest.fixture
def server():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.handle_request(None)

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            self.handle_request(json.loads(body))

        def handle_request(self, body):
            server.requests.append((self.path, body, dict(self.headers)))
            reply = server.reply(self.path, body)
            if isinstance(reply, tuple):
                status, value = reply
            else:
                status, value = 200, reply
            packet = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(packet)))
            self.end_headers()
            try:
                self.wfile.write(packet)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.requests = []
    server.reply = lambda *_: {}
    server.endpoint = f"http://127.0.0.1:{server.server_port}"
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    yield server
    server.shutdown()
    server.server_close()
    worker.join(2)


@pytest.fixture
def registry(tmp_path, monkeypatch, server):
    # Cloud wire requests retain their real origin contract, then are redirected
    # by this test-only injected function to our disposable fixture server.
    allowed_endpoints = {*api.ENDPOINTS.values(), server.endpoint}
    def local_request(endpoint, path, **kwargs):
        assert endpoint in allowed_endpoints
        return transport.request_json(server.endpoint, path, **kwargs)
    monkeypatch.setattr(api, "request_json", local_request)
    return api.ProviderRegistry(tmp_path, timeout=2)


def selection(provider, model=None, effort=None):
    return {"provider": provider, "mode": "explicit", "model": model or MODEL[provider], "reasoningEffort": effort}


def response(provider, text=None, *, calls=False):
    text = text if text is not None else json.dumps(REPLY)
    if provider == "openai":
        items = [{"type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "private-signature"}]
        if calls:
            items.append({"type": "function_call", "call_id": "call_1", "id": "fc_1", "name": "read_file", "arguments": '{"path":"a.py"}', "status": "completed"})
        else:
            items.append({"type": "message", "id": "msg_1", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": text, "annotations": []}]})
        return {"status": "completed", "model": MODEL[provider], "output": items, "usage": {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30}}
    if provider == "anthropic":
        content = [{"type": "thinking", "thinking": "private-thinking", "signature": "private-signature"}]
        content.append({"type": "tool_use", "id": "call_1", "name": "read_file", "input": {"path": "a.py"}} if calls else {"type": "text", "text": text})
        return {"id": "msg_1", "role": "assistant", "content": content, "stop_reason": "tool_use" if calls else "end_turn", "usage": {"input_tokens": 10, "output_tokens": 20}}
    if provider == "gemini":
        steps = [{"type": "thought", "signature": "private-signature", "summary": [{"type": "text", "text": "private-thinking"}]}]
        steps.append({"type": "function_call", "id": "call_1", "name": "read_file", "arguments": {"path": "a.py"}} if calls else {"type": "model_output", "content": [{"type": "text", "text": text}]})
        return {"id": "interaction_1", "status": "requires_action" if calls else "completed", "steps": steps, "usage": {"total_input_tokens": 10, "total_output_tokens": 20}}
    message = {"role": "assistant", "content": "" if calls else text, "thinking": "private-thinking"}
    if calls:
        message["tool_calls"] = [{"function": {"name": "read_file", "arguments": {"path": "a.py"}}}]
    return {"done": True, "done_reason": "stop", "model": MODEL[provider], "message": message, "prompt_eval_count": 10, "eval_count": 20}


def ollama(server, monkeypatch):
    monkeypatch.setenv("PLANBRANCH_OLLAMA_URL", server.endpoint)
    server.digest = "a" * 64
    def reply(path, body):
        if path == "/api/version":
            return {"version": "0.18.0"}
        if path == "/api/tags":
            return {"models": [{"name": "local:small", "digest": server.digest}, {"name": "embed:latest", "digest": "b" * 64}, {"name": "plain:latest", "digest": "c" * 64}]}
        if path == "/api/show":
            return {"capabilities": ["embedding"] if body["model"].startswith("embed") else ["completion", "tools", "thinking"] if body["model"].startswith("local") else ["completion"],
                    "details": {"family": "qwen3"}, "model_info": {"qwen3.context_length": 262144}}
        return response("ollama")
    server.reply = reply


def test_legacy_selection_identity_and_laziness(tmp_path, monkeypatch):
    from flowdesk import codex_planner
    def forbidden(*_, **__):
        raise AssertionError("Codex must remain lazy")
    monkeypatch.setattr(codex_planner, "CodexPlanner", forbidden)
    for value in [None, {"mode": "default"}, {"mode": "explicit", "model": "custom-model", "reasoningEffort": "low"}]:
        assert api.normalize_selection(value) == codex_planner.normalize_selection(value)
    registry = api.ProviderRegistry(tmp_path)
    registry.configure(selection("openai"))
    registry.connections()
    assert registry._codex is None


@pytest.mark.parametrize("value", [{"provider": "codex", "mode": "default"}, {"provider": "ollama", "mode": "default"},
    {"provider": "other", "mode": "explicit", "model": "x", "reasoningEffort": None},
    {"provider": "openai", "mode": "explicit", "model": "x", "reasoningEffort": None, "apiKey": "unsafe"},
    {"provider": "openai", "mode": "explicit", "model": "x\nheader", "reasoningEffort": None}])
def test_invalid_selections(value):
    with pytest.raises(api.ProviderError):
        api.normalize_selection(value)


def test_cloud_metadata_has_no_secrets_or_network(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "request_json", lambda *_a, **_k: pytest.fail("Metadata must not call cloud APIs"))
    registry = api.ProviderRegistry(tmp_path)
    public = registry.connections()
    assert {entry["id"] for entry in public} == set(api.PROVIDERS)
    assert "fixture-not-a-real-key" not in json.dumps(public)
    for provider in api.KEYS:
        assert registry.status(provider)["verified"] is False
        assert registry.capabilities(provider)["allowsCustomModel"] is True
        frozen = registry.configure(selection(provider, "account-specific-model"))
        assert frozen["modelIdentity"]["tools"] is None
        assert "fixture-not-a-real-key" not in json.dumps(frozen)
        with pytest.raises(api.ProviderError, match="reasoning"):
            registry.configure(selection(provider, "account-specific-model", "high"))


@pytest.mark.parametrize("provider", list(api.KEYS))
def test_generation_freezes_provider_options_and_rejects_mismatch(registry, provider):
    value = registry.configure(selection(provider, effort="low"), purpose="coding")
    assert api.validate_generation(value, "coding") == value
    assert value["protocolVersion"] == 4
    assert value["instructionVersion"] == "provider-coder-v1"
    for field, changed in [("providerGenerationVersion", 2), ("instructionHash", "bad"), ("endpoint", "https://untrusted.invalid"), ("purpose", "planning")]:
        bad = deepcopy(value); bad[field] = changed
        with pytest.raises(api.ProviderError):
            api.validate_generation(bad, "coding")


def test_ollama_metadata_filtering_cache_tools_digest_and_context(registry, server, monkeypatch):
    ollama(server, monkeypatch)
    catalog = registry.capabilities("ollama")
    assert [row["id"] for row in catalog["models"]] == ["local:small", "plain:latest"]
    count = len(server.requests)
    registry.status("ollama")
    registry.capabilities("ollama")
    assert len(server.requests) == count
    assert not any("pull" in path for path, *_ in server.requests)
    with pytest.raises(api.ProviderError, match="tool"):
        registry.configure(selection("ollama", "plain:latest"), "coding")
    frozen = registry.configure(selection("ollama", effort="off"), "coding")
    assert frozen["modelIdentity"]["digest"] == "a" * 64
    assert frozen["limits"] == {"contextWindow": 32768, "maxOutputTokens": 4096, "inputByteBudget": 27648}
    registry.turn(frozen, [{"role": "user", "content": "Read a.py"}], TOOLS)
    body = next(body for path, body, _ in reversed(server.requests) if body is not None and path != "/api/show")
    assert body["options"] == {"num_ctx": 32768, "num_predict": 4096}
    assert body["think"] is False
    server.digest = "d" * 64
    count = sum(path == "/api/chat" for path, *_ in server.requests)
    with pytest.raises(api.ProviderError, match="changed"):
        registry.turn(frozen, [{"role": "user", "content": "Read a.py"}], TOOLS)
    assert sum(path == "/api/chat" for path, *_ in server.requests) == count


@pytest.mark.parametrize("url", ["http://user:secret@127.0.0.1:11434", "http://127.0.0.1:11434/path", "http://127.0.0.1?key=secret", "http://example.com:11434"])
def test_invalid_local_endpoint_never_escapes_in_errors(tmp_path, monkeypatch, url):
    monkeypatch.setenv("PLANBRANCH_OLLAMA_URL", url)
    registry = api.ProviderRegistry(tmp_path)
    metadata = registry.connections()
    assert "secret" not in json.dumps(metadata)
    assert registry.status("ollama")["available"] is False


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini", "ollama"])
def test_native_planning_contract_and_context_allowlist(registry, server, monkeypatch, provider):
    if provider == "ollama":
        ollama(server, monkeypatch)
    else:
        server.reply = lambda *_: response(provider)
    frozen = registry.configure(selection(provider))
    context = {"generation": frozen, "content": {"name": "Synthetic"}, "activeDiagramId": "diagram-1", "messages": [],
               "sourceRoots": ["private-root"], "secret": "do-not-send"}
    assert registry.generate(context) == REPLY
    body = next(body for path, body, _ in reversed(server.requests) if body is not None and path != "/api/show")
    assert "private-root" not in json.dumps(body) and "do-not-send" not in json.dumps(body)
    assert "provider-planner-v1" == frozen["instructionVersion"]
    if provider == "openai":
        assert body["store"] is False and body["text"]["format"]["schema"]["properties"]["protocolVersion"]["enum"] == [4]
    elif provider == "anthropic":
        assert body["output_config"]["format"]["type"] == "json_schema"
    elif provider == "gemini":
        assert body["store"] is False and body["response_format"]["mime_type"] == "application/json"
    else:
        assert isinstance(body["format"], dict)


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini", "ollama"])
def test_native_tool_round_trip_preserves_private_continuation(registry, server, monkeypatch, provider):
    if provider == "ollama":
        ollama(server, monkeypatch)
        original = server.reply
        server.reply = lambda path, body: response(provider, calls=True) if path == "/api/chat" else original(path, body)
    else:
        server.reply = lambda *_: response(provider, calls=True)
    frozen = registry.configure(selection(provider), "coding")
    messages = [{"role": "system", "content": "One task only"}, {"role": "user", "content": "Read a.py"}]
    reply = registry.turn(frozen, messages, TOOLS)
    assert reply["text"] == "" and not reply["done"]
    assert reply["toolCalls"][0]["arguments"] == {"path": "a.py"}
    assert "private-" not in json.dumps({k: v for k, v in reply.items() if k != "continuation"})
    messages.extend([{"role": "assistant", "content": reply["text"], "toolCalls": reply["toolCalls"], "continuation": reply["continuation"]},
                     {"role": "tool", "toolCallId": reply["toolCalls"][0]["id"], "content": "print('hello')"}])
    _, body = make_request(frozen, messages, TOOLS)
    assert "private-" in json.dumps(body)
    native = reply["continuation"]["native"]
    if provider == "openai":
        assert body["input"][1:1+len(native)] == native
        assert body["input"][-1]["call_id"] == "call_1"
    elif provider == "anthropic":
        assert body["messages"][1]["content"] == native
        assert body["messages"][-1]["content"][0]["tool_use_id"] == "call_1"
    elif provider == "gemini":
        assert body["input"][1:1+len(native)] == native
        assert body["input"][-1]["call_id"] == "call_1"
    else:
        assert body["messages"][2] == native
        assert body["messages"][-1]["tool_name"] == "read_file"


@pytest.mark.parametrize("provider", list(api.KEYS))
def test_incomplete_and_malformed_calls_never_return_tools(registry, provider):
    frozen = registry.configure(selection(provider), "coding")
    bad = response(provider, calls=True)
    if provider == "openai":
        bad["status"] = "incomplete"
    elif provider == "anthropic":
        bad["stop_reason"] = "max_tokens"
    else:
        bad["status"] = "incomplete"
    with pytest.raises(api.ProviderError):
        parse_response(frozen, bad)
    bad = response(provider, calls=True)
    native = bad["output"] if provider == "openai" else bad["content"] if provider == "anthropic" else bad["steps"]
    native[-1]["arguments" if provider != "anthropic" else "input"] = '{"path":'
    with pytest.raises(api.ProviderError):
        parse_response(frozen, bad)


def test_local_input_guard_prevents_silent_context_truncation(registry, server, monkeypatch):
    ollama(server, monkeypatch)
    frozen = registry.configure(selection("ollama"), "coding")
    with pytest.raises(api.ProviderError, match="nothing was truncated"):
        registry.turn(frozen, [{"role": "user", "content": "x" * 27648}], TOOLS)
    assert not any(path == "/api/chat" for path, *_ in server.requests)
    bad = response("ollama"); bad["prompt_eval_count"] = frozen["limits"]["contextWindow"]
    with pytest.raises(api.ProviderError, match="context budget"):
        parse_response(frozen, bad)


def test_http_failure_redacts_remote_diagnostics(server):
    server.reply = lambda *_: (401, {"error": "fixture-not-a-real-key at /private/source"})
    with pytest.raises(api.ProviderError) as failure:
        transport.request_json(server.endpoint, "/v1/responses", data={})
    assert "fixture-not-a-real-key" not in str(failure.value)
    assert "/private/source" not in str(failure.value)
    assert len(server.requests) == 1


def test_http_size_deadline_and_cancellation_are_bounded(server):
    server.reply = lambda *_: {"text": "x" * 2000}
    with pytest.raises(api.ProviderError, match="size"):
        transport.request_json(server.endpoint, "/large", max_response_bytes=100)
    started = threading.Event()
    def slow(*_):
        started.set(); time.sleep(.3)
        return {"answer": 1}
    server.reply = slow
    with pytest.raises(api.ProviderError, match="timed out"):
        transport.request_json(server.endpoint, "/slow", timeout=.05)
    event = threading.Event()
    threading.Timer(.05, event.set).start()
    with pytest.raises(api.ProviderCancelled):
        transport.request_json(server.endpoint, "/cancel", cancel=event)
    assert len(server.requests) == 3


def test_cross_provider_continuation_is_rejected(registry):
    frozen = registry.configure(selection("openai"), "coding")
    wrong = {"version": 1, "provider": "gemini", "native": []}
    with pytest.raises(api.ProviderError, match="continuation"):
        make_request(frozen, [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello", "continuation": wrong}, {"role": "user", "content": "Continue"}], [])


@pytest.mark.parametrize("provider", list(api.KEYS))
def test_frozen_retry_survives_catalogue_and_live_default_changes(registry, server, monkeypatch, provider):
    frozen = registry.configure(selection(provider, effort="low"))
    original = deepcopy(frozen)
    monkeypatch.setitem(api.CLOUD_MODELS, provider, [])
    monkeypatch.setitem(api.INSTRUCTIONS, "planning", "provider-planner-v2")
    monkeypatch.setitem(api.ENDPOINTS, provider, "https://future.invalid")
    monkeypatch.setattr(api, "MAX_OUTPUT_TOKENS", 1024)
    monkeypatch.setattr(api, "OLLAMA_CONTEXT_LIMIT", 8192)
    server.reply = lambda *_: response(provider)
    assert api.validate_generation(frozen, "planning") == original
    assert registry.generate({"generation": frozen, "content": {"name": "Synthetic"}, "activeDiagramId": "diagram-1"}) == REPLY
    assert frozen == original
    body = server.requests[-1][1]
    if provider == "openai":
        assert body["reasoning"]["effort"] == "low" and body["max_output_tokens"] == 16384
    elif provider == "anthropic":
        assert body["output_config"]["effort"] == "low" and body["max_tokens"] == 16384
    else:
        assert body["generation_config"] == {"thinking_level": "low", "max_output_tokens": 16384}


def test_ollama_tag_replaced_during_generation_rejects_calls(registry, server, monkeypatch):
    ollama(server, monkeypatch)
    frozen = registry.configure(selection("ollama"), "coding")
    original = server.reply
    def changed(path, body):
        if path == "/api/chat":
            server.digest = "e" * 64
            return response("ollama", calls=True)
        return original(path, body)
    server.reply = changed
    with pytest.raises(api.ProviderError, match="changed"):
        registry.turn(frozen, [{"role": "user", "content": "Read a.py"}], TOOLS)


def test_unknown_tool_request_is_not_returned_for_execution(registry, server):
    frozen = registry.configure(selection("openai"), "coding")
    server.reply = lambda *_: response("openai", calls=True)
    with pytest.raises(api.ProviderError, match="not offered"):
        registry.turn(frozen, [{"role": "user", "content": "Say hello"}], [])


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini"])
def test_explicit_connection_check_only_reads_one_model_metadata_page(registry, server, provider):
    metadata = ({"models": [{"name": "models/account-model"}, {"name": "models/account-model"}], "nextPageToken": "private-pagination"}
                if provider == "gemini" else
                {"data": [{"id": "account-model"}, {"id": "account-model"}], "has_more": True, "last_id": "private-pagination"})
    server.reply = lambda *_: metadata
    checked = registry.check_connection(provider)
    assert checked["provider"] == provider
    assert checked["available"] and checked["verified"]
    assert checked["modelIds"] == ["account-model"] and checked["modelsPartial"]
    assert checked["checkedAt"]
    assert "Generation and tool access have not been tested" in checked["reason"]
    assert "first model page" in checked["reason"]
    assert "fixture-not-a-real-key" not in json.dumps(checked)
    assert "private-pagination" not in json.dumps(checked)
    assert len(server.requests) == 1
    path, body, headers = server.requests[0]
    assert body is None
    assert path == ("/v1beta/models" if provider == "gemini" else "/v1/models")
    headers = {k.lower(): v for k, v in headers.items()}
    if provider == "openai":
        assert headers["authorization"] == "Bearer fixture-not-a-real-key"
    elif provider == "anthropic":
        assert headers["x-api-key"] == "fixture-not-a-real-key"
        assert headers["anthropic-version"] == "2023-06-01"
    else:
        assert headers["x-goog-api-key"] == "fixture-not-a-real-key"
    # Explicit checks never enable background cloud polling or claim model access.
    registry.connections()
    registry.capabilities(provider, refresh=True)
    assert registry.status(provider, refresh=True)["verified"] is False
    assert len(server.requests) == 1


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini"])
def test_connection_check_missing_key_makes_no_network_request(registry, server, monkeypatch, provider):
    monkeypatch.delenv(api.KEYS[provider])
    checked = registry.check_connection(provider)
    assert checked["available"] is False and checked["verified"] is False
    assert api.KEYS[provider] in checked["reason"]
    assert server.requests == []


def test_connection_check_authentication_error_does_not_expose_response_or_key(registry, server):
    server.reply = lambda *_: (401, {"error": "private-provider-diagnostic fixture-not-a-real-key"})
    checked = registry.check_connection("openai")
    assert checked["available"] is False and checked["verified"] is False
    assert "authentication" in checked["reason"]
    assert "private-provider-diagnostic" not in json.dumps(checked)
    assert "fixture-not-a-real-key" not in json.dumps(checked)
    assert len(server.requests) == 1


@pytest.mark.parametrize("metadata", [{"data": {}}, {"data": [{"id": "bad\nvalue"}]},
    {"data": [None]}, {"data": [{"id": "okay"}], "error": "private-error"},
    {"data": [{"id": "model"}] * 1001}])
def test_connection_check_rejects_invalid_catalogue_atomically(registry, server, metadata):
    server.reply = lambda *_: metadata
    checked = registry.check_connection("openai")
    assert checked["available"] is False and checked["verified"] is False
    assert checked["modelIds"] == []
    assert "invalid model metadata" in checked["reason"]
    assert "private-error" not in json.dumps(checked)


def test_connection_check_empty_catalogue_is_metadata_success_not_model_entitlement(registry, server):
    server.reply = lambda *_: {"data": []}
    checked = registry.check_connection("anthropic")
    assert checked["available"] and checked["verified"]
    assert checked["modelIds"] == [] and checked["modelsPartial"] is False
    assert "Generation and tool access have not been tested" in checked["reason"]


def test_connection_check_uses_metadata_response_size_bound(registry, server):
    server.reply = lambda *_: {"data": [], "unneeded": "x" * 1_000_000}
    checked = registry.check_connection("openai")
    assert checked["available"] is False and checked["verified"] is False
    assert "exceeded the supported size" in checked["reason"]


def test_connection_check_cancelled_before_dispatch_does_not_send_headers(registry, server):
    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(api.ProviderCancelled):
        registry.check_connection("gemini", cancel=cancelled)
    assert server.requests == []
