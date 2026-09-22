"""Native stream fixtures, including deliberately interrupted tool JSON."""
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time

import pytest

from flowdesk import providers as api
from flowdesk.provider_protocols import make_request, parse_response
from flowdesk.provider_streams import StreamDecoder
from flowdesk.provider_transport import request_json
from test_providers import selection, response, TOOLS, isolated_keys


def sse(value):
    kind = value.get("type", value.get("event_type", ""))
    return ("event: " + kind + "\ndata: " + json.dumps(value, ensure_ascii=False) + "\n\n").encode()


def stream(provider, *, tool=False, text="Hello 世界"):
    if provider == "openai":
        # Partial calls are deliberately unusable until response.completed.
        return [sse({"type": "response.created", "response": {"status": "in_progress"}}),
                sse({"type": "response.function_call_arguments.delta", "delta": '{"path":'}),
                sse({"type": "response.completed", "response": response(provider, text, calls=tool)})]
    if provider == "anthropic":
        records = [
            {"type": "message_start", "message": {"id": "msg_1", "role": "assistant", "content": [], "stop_reason": None, "usage": {"input_tokens": 10}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "private-thinking"}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "private-signature"}},
            {"type": "content_block_stop", "index": 0},
        ]
        if tool:
            records.extend([
                {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "call_1", "name": "read_file", "input": {}}},
                {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"path":'}},
                {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '"a.py"}'}},
            ])
        else:
            records.extend([
                {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
                {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": text}},
            ])
        records.extend([
            {"type": "content_block_stop", "index": 1},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use" if tool else "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 20}},
            {"type": "message_stop"},
        ])
        return [sse(record) for record in records]
    if provider == "gemini":
        records = [
            {"event_type": "interaction.created", "interaction": {"id": "interaction_1", "status": "in_progress"}},
            {"event_type": "step.start", "index": 0, "step": {"type": "thought", "signature": "", "summary": []}},
            {"event_type": "step.delta", "index": 0, "delta": {"type": "thought_summary", "content": {"type": "text", "text": "private-thinking"}}},
            {"event_type": "step.delta", "index": 0, "delta": {"type": "thought_signature", "signature": "private-signature"}},
            {"event_type": "step.stop", "index": 0},
        ]
        if tool:
            records.extend([
                {"event_type": "step.start", "index": 1, "step": {"type": "function_call", "id": "call_1", "name": "read_file", "arguments": {}}},
                {"event_type": "step.delta", "index": 1, "delta": {"type": "arguments_delta", "arguments": '{"path":'}},
                {"event_type": "step.delta", "index": 1, "delta": {"type": "arguments_delta", "arguments": '"a.py"}'}},
            ])
        else:
            records.extend([
                {"event_type": "step.start", "index": 1, "step": {"type": "model_output", "content": []}},
                {"event_type": "step.delta", "index": 1, "delta": {"type": "text", "text": text}},
            ])
        records.extend([
            {"event_type": "step.stop", "index": 1},
            {"event_type": "interaction.completed", "interaction": {"id": "interaction_1", "status": "requires_action" if tool else "completed", "usage": {"total_input_tokens": 10, "total_output_tokens": 20}}},
        ])
        return [sse(record) for record in records]
    records = [{"done": False, "message": {"role": "assistant", "thinking": "private-thinking"}}]
    records.append({"done": False, "message": {"role": "assistant", "tool_calls": [{"function": {"name": "read_file", "arguments": {"path": "a.py"}}}]}} if tool else
                   {"done": False, "message": {"role": "assistant", "content": text}})
    records.append({"done": True, "done_reason": "stop", "message": {"role": "assistant", "content": ""}, "prompt_eval_count": 10, "eval_count": 20})
    return [(json.dumps(record, ensure_ascii=False) + "\n").encode() for record in records]


def generation(tmp_path, provider):
    if provider != "ollama":
        return api.ProviderRegistry(tmp_path).configure(selection(provider), "coding")
    # Exercise native local protocol without any local-service discovery.
    return {"provider": "ollama", "selection": selection("ollama"), "instructions": "One task only",
            "modelIdentity": {"tools": True}, "limits": {"maxOutputTokens": 4096, "contextWindow": 32768, "inputByteBudget": 27648}}


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini", "ollama"])
@pytest.mark.parametrize("tool", [False, True])
def test_stream_chunk_boundaries_and_private_continuation(tmp_path, provider, tool):
    decoder = StreamDecoder(provider)
    packets = stream(provider, tool=tool)
    prefix = b"".join(packets[:-1])
    for i in range(0, len(prefix), 3):
        decoder.feed(prefix[i:i+3])
    assert not decoder.terminal
    assert decoder.result is None
    with pytest.raises(api.ProviderError, match="stream"):
        decoder.finish()
    # Include splitting within UTF-8 characters and JSON string escapes.
    final = packets[-1]
    for i in range(0, len(final), 3):
        decoder.feed(final[i:i+3])
    frozen = generation(tmp_path, provider)
    reply = parse_response(frozen, decoder.finish())
    assert reply["text"] == ("" if tool else "Hello 世界")
    assert reply["done"] is (not tool)
    assert "private-" not in json.dumps({k: v for k, v in reply.items() if k != "continuation"})
    if tool:
        assert reply["toolCalls"][0]["arguments"] == {"path": "a.py"}
        messages = [{"role": "user", "content": "Read a.py"},
                    {"role": "assistant", "content": "", "toolCalls": reply["toolCalls"], "continuation": reply["continuation"]},
                    {"role": "tool", "toolCallId": reply["toolCalls"][0]["id"], "content": "print('ok')"}]
        _, body = make_request(frozen, messages, TOOLS)
        assert "private-" in json.dumps(body)
        assert body["stream"] is True


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini", "ollama"])
def test_stream_requires_terminal_not_just_a_completed_tool_block(provider):
    decoder = StreamDecoder(provider)
    decoder.feed(b"".join(stream(provider, tool=True)[:-1]))
    with pytest.raises(api.ProviderError):
        decoder.finish()
    assert decoder.result is None


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
def test_stream_rejects_malformed_argument_fragments(provider):
    packets = stream(provider, tool=True)
    joined = b"".join(packets).replace(b'a.py', b'a.py\\')
    decoder = StreamDecoder(provider)
    with pytest.raises(api.ProviderError):
        decoder.feed(joined)
    assert not decoder.terminal


def test_gemini_status_then_done_is_supported(tmp_path):
    decoder = StreamDecoder("gemini")
    decoder.feed(b"".join(stream("gemini", tool=True)[:-1]))
    decoder.feed(sse({"event_type": "interaction.status_update", "status": "requires_action"}))
    assert not decoder.terminal
    decoder.feed(b"event: done\ndata: [DONE]\n\n")
    assert parse_response(generation(tmp_path, "gemini"), decoder.finish())["toolCalls"]


def test_stream_size_event_and_utf8_errors_are_safe(monkeypatch):
    from flowdesk import provider_streams
    monkeypatch.setattr(provider_streams, "MAX_STREAM_BYTES", 20)
    with pytest.raises(api.ProviderError, match="size"):
        StreamDecoder("openai").feed(b"x" * 21)
    with pytest.raises(api.ProviderError, match="stream"):
        StreamDecoder("openai").feed(b"data: \xff\n\n")
    monkeypatch.setattr(provider_streams, "MAX_STREAM_BYTES", 4000000)
    monkeypatch.setattr(provider_streams, "MAX_EVENTS", 1)
    with pytest.raises(api.ProviderError):
        StreamDecoder("openai").feed(b"".join(stream("openai")))


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini", "ollama"])
def test_http_native_stream_and_cancellation(tmp_path, provider):
    started = threading.Event()
    finish = threading.Event()
    packets = stream(provider, tool=True)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson" if provider == "ollama" else "text/event-stream")
            self.end_headers()
            try:
                self.wfile.write(b"".join(packets[:-1])); self.wfile.flush()
                started.set()
                finish.wait(2)
                self.wfile.write(packets[-1]); self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    endpoint = f"http://127.0.0.1:{server.server_port}"
    cancel = threading.Event()
    result = []
    def call():
        try:
            result.append(request_json(endpoint, "/native", data={"stream": True}, cancel=cancel, stream_parser=StreamDecoder(provider)))
        except api.ProviderError as exc:
            result.append(exc)
    caller = threading.Thread(target=call); caller.start()
    try:
        assert started.wait(1)
        assert result == []  # Parsed argument fragments have not escaped.
        cancel.set()
        caller.join(1)
        assert not caller.is_alive()
        assert len(result) == 1 and isinstance(result[0], api.ProviderCancelled)
        finish.set()
        complete = request_json(endpoint, "/native", data={"stream": True}, stream_parser=StreamDecoder(provider))
        normalized = parse_response(generation(tmp_path, provider), complete)
        assert normalized["toolCalls"][0]["arguments"] == {"path": "a.py"}
    finally:
        cancel.set(); finish.set(); caller.join(2)
        server.shutdown(); server.server_close(); worker.join(2)
