"""Native wire contracts; private continuation never becomes visible text.

References (verified 2026-09-22):
https://developers.openai.com/api/docs/guides/function-calling
https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
https://ai.google.dev/gemini-api/docs/function-calling
https://docs.ollama.com/api/chat
"""
from __future__ import annotations

from copy import deepcopy
import re
from uuid import uuid4

from .provider_transport import ProviderError, decode_json, encode_json


MAX_TOOL_CALLS = 16
TOOL_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_-]{0,63}\Z")


def _bad():
    return ProviderError("The provider returned an invalid or incomplete response. No further tools were run.")


def _list(value, limit=1000):
    if not isinstance(value, list) or len(value) > limit:
        raise _bad()
    return value


def _string(value, limit=2_000_000, *, empty=True):
    try:
        valid = isinstance(value, str) and len(value.encode("utf-8")) <= limit and (empty or bool(value))
    except UnicodeError:
        valid = False
    if not valid:
        raise _bad()
    return value


def _call(call_id, name, arguments):
    _string(call_id, 200, empty=False)
    if not isinstance(name, str) or not TOOL_NAME.fullmatch(name):
        raise _bad()
    if isinstance(arguments, str):
        arguments = decode_json(arguments)
    if not isinstance(arguments, dict) or len(encode_json(arguments)) > 512_000:
        raise _bad()
    return {"id": call_id, "name": name, "arguments": deepcopy(arguments)}


def _continuation(provider, native):
    return {"version": 1, "provider": provider, "native": deepcopy(native)}


def _native(message, provider):
    continuation = message.get("continuation")
    if continuation is None:
        if message.get("toolCalls"):
            raise ProviderError("Tool continuation is missing. Start a new model context before continuing.")
        return None
    if (not isinstance(continuation, dict) or set(continuation) != {"version", "provider", "native"}
            or type(continuation["version"]) is not int or continuation["version"] != 1
            or continuation["provider"] != provider or len(encode_json(continuation)) > 4_000_000):
        raise ProviderError("The model continuation does not match this provider.")
    return deepcopy(continuation["native"])


def _history(messages, tools):
    if not isinstance(messages, list) or not messages or len(messages) > 1000 or not isinstance(tools, list) or len(tools) > 64:
        raise ProviderError("The model conversation or tool definitions are invalid.")
    seen_tools = set()
    for tool in tools:
        if (not isinstance(tool, dict) or set(tool) != {"name", "description", "parameters"}
                or not isinstance(tool["name"], str) or not TOOL_NAME.fullmatch(tool["name"])
                or tool["name"] in seen_tools or not isinstance(tool["description"], str)
                or not isinstance(tool["parameters"], dict) or tool["parameters"].get("type") != "object"):
            raise ProviderError("The model tool definitions are invalid.")
        seen_tools.add(tool["name"])
    if len(encode_json(tools)) > 200_000:
        raise ProviderError("The model tool definitions are too large.")
    pending, seen_calls, names = set(), set(), {}
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in {"system", "user", "assistant", "tool"}:
            raise ProviderError("The model conversation contains an invalid message.")
        _string(message.get("content"))
        if message["role"] == "tool":
            call_id = message.get("toolCallId")
            if not isinstance(call_id, str) or call_id not in pending:
                raise ProviderError("The conversation contains an unmatched tool result.")
            pending.remove(call_id)
        else:
            if pending:
                raise ProviderError("All tool results must be supplied before the next model turn.")
            if message["role"] == "assistant":
                for entry in _list(message.get("toolCalls", []), MAX_TOOL_CALLS):
                    if not isinstance(entry, dict) or set(entry) != {"id", "name", "arguments"}:
                        raise ProviderError("The conversation contains an invalid tool call.")
                    call = _call(entry["id"], entry["name"], entry["arguments"])
                    if call["id"] in seen_calls:
                        raise ProviderError("The conversation contains repeated tool call IDs.")
                    seen_calls.add(call["id"])
                    pending.add(call["id"])
                    names[call["id"]] = call["name"]
    if pending:
        raise ProviderError("All tool results must be supplied before the next model turn.")
    return names


def make_request(generation, messages, tools, schema=None):
    provider = generation["provider"]
    names = _history(messages, tools)
    system = generation["instructions"] + "".join("\n\n" + message["content"] for message in messages if message["role"] == "system")
    history = [message for message in messages if message["role"] != "system"]
    model, effort = generation["selection"]["model"], generation["selection"]["reasoningEffort"]
    max_tokens = generation["limits"]["maxOutputTokens"]
    if provider == "openai":
        items = []
        for message in history:
            if message["role"] == "tool":
                items.append({"type": "function_call_output", "call_id": message["toolCallId"], "output": message["content"]})
            elif message["role"] == "assistant" and (native := _native(message, provider)) is not None:
                items.extend(_list(native))
            else:
                items.append({"role": message["role"], "content": message["content"]})
        body = {"model": model, "instructions": system, "input": items, "store": False, "stream": True,
                "max_output_tokens": max_tokens, "include": ["reasoning.encrypted_content"]}
        if effort is not None:
            body["reasoning"] = {"effort": effort}
        if tools:
            # Explicit non-strict avoids rewriting optional tool arguments. The
            # application validates every call before it can run a tool.
            body["tools"] = [{"type": "function", **deepcopy(t), "strict": False} for t in tools]
        if schema is not None:
            body["text"] = {"format": {"type": "json_schema", "name": "planbranch_planning", "schema": schema, "strict": True}}
        return "/v1/responses", body
    if provider == "anthropic":
        items = []
        for message in history:
            role = "user" if message["role"] == "tool" else message["role"]
            if message["role"] == "tool":
                content = [{"type": "tool_result", "tool_use_id": message["toolCallId"], "content": message["content"]}]
            elif role == "assistant" and (native := _native(message, provider)) is not None:
                content = _list(native)
            else:
                content = [{"type": "text", "text": message["content"]}]
            if items and items[-1]["role"] == role:
                items[-1]["content"].extend(content)
            else:
                items.append({"role": role, "content": content})
        body = {"model": model, "system": system, "messages": items, "max_tokens": max_tokens, "stream": True}
        if effort is not None:
            body["output_config"] = {"effort": effort}
        if tools:
            body["tools"] = [{"name": t["name"], "description": t["description"], "input_schema": deepcopy(t["parameters"])} for t in tools]
        if schema is not None:
            body.setdefault("output_config", {})["format"] = {"type": "json_schema", "schema": schema}
        return "/v1/messages", body
    if provider == "gemini":
        steps = []
        for message in history:
            role = message["role"]
            if role == "tool":
                steps.append({"type": "function_result", "name": names[message["toolCallId"]], "call_id": message["toolCallId"],
                              "result": [{"type": "text", "text": message["content"]}]})
            elif role == "assistant" and (native := _native(message, provider)) is not None:
                steps.extend(_list(native))
            else:
                steps.append({"type": "user_input" if role == "user" else "model_output", "content": [{"type": "text", "text": message["content"]}]})
        body = {"model": model, "system_instruction": system, "input": steps, "store": False, "stream": True,
                "generation_config": {"max_output_tokens": max_tokens}}
        if effort is not None:
            body["generation_config"]["thinking_level"] = effort
        if tools:
            body["tools"] = [{"type": "function", **deepcopy(t)} for t in tools]
        if schema is not None:
            body["response_format"] = {"type": "text", "mime_type": "application/json", "schema": schema}
        return "/v1beta/interactions", body
    if provider == "ollama":
        items = [{"role": "system", "content": system}]
        for message in history:
            if message["role"] == "tool":
                items.append({"role": "tool", "tool_name": names[message["toolCallId"]], "content": message["content"]})
            elif message["role"] == "assistant" and (native := _native(message, provider)) is not None:
                if not isinstance(native, dict):
                    raise _bad()
                items.append(native)
            else:
                items.append({"role": message["role"], "content": message["content"]})
        body = {"model": model, "messages": items, "stream": True,
                "options": {"num_predict": max_tokens, "num_ctx": generation["limits"]["contextWindow"]}}
        if effort is not None:
            body["think"] = {"on": True, "off": False}.get(effort, effort)
        if tools:
            if generation["modelIdentity"]["tools"] is False:
                raise ProviderError("This local model does not support coding tools.")
            body["tools"] = [{"type": "function", "function": deepcopy(t)} for t in tools]
        if schema is not None:
            body["format"] = schema
        return "/api/chat", body
    raise ProviderError("Unsupported provider.")


def _usage(value, mapping):
    if not isinstance(value, dict):
        return {}
    result = {}
    for source, destination in mapping.items():
        number = value.get(source)
        if type(number) is int and 0 <= number <= 10**12:
            result[destination] = number
    return result


def parse_response(generation, response):
    if not isinstance(response, dict) or response.get("error"):
        raise _bad()
    provider = generation["provider"]
    text, calls = [], []
    if provider == "openai":
        if response.get("status") != "completed":
            raise _bad()
        native = _list(response.get("output"))
        for item in native:
            if not isinstance(item, dict):
                raise _bad()
            kind = item.get("type")
            if kind == "function_call":
                calls.append(_call(item.get("call_id"), item.get("name"), item.get("arguments")))
            elif kind == "message":
                for part in _list(item.get("content")):
                    if not isinstance(part, dict) or part.get("type") != "output_text":
                        raise _bad()
                    text.append(_string(part.get("text")))
            elif kind != "reasoning":
                raise _bad()
        usage = _usage(response.get("usage"), {"input_tokens": "inputTokens", "output_tokens": "outputTokens", "total_tokens": "totalTokens"})
    elif provider == "anthropic":
        stop = response.get("stop_reason")
        if stop not in ("end_turn", "stop_sequence", "tool_use"):
            raise _bad()
        native = _list(response.get("content"))
        for part in native:
            if not isinstance(part, dict):
                raise _bad()
            kind = part.get("type")
            if kind == "text":
                text.append(_string(part.get("text")))
            elif kind == "tool_use":
                calls.append(_call(part.get("id"), part.get("name"), part.get("input")))
            elif kind not in ("thinking", "redacted_thinking"):
                raise _bad()
        if (stop == "tool_use") != bool(calls):
            raise _bad()
        usage = _usage(response.get("usage"), {"input_tokens": "inputTokens", "output_tokens": "outputTokens",
                       "cache_read_input_tokens": "cachedTokens", "cache_creation_input_tokens": "cacheWriteTokens"})
    elif provider == "gemini":
        if response.get("status") not in ("completed", "requires_action"):
            raise _bad()
        native = _list(response.get("steps"))
        for step in native:
            if not isinstance(step, dict):
                raise _bad()
            kind = step.get("type")
            if kind == "model_output":
                for part in _list(step.get("content")):
                    if not isinstance(part, dict) or part.get("type") != "text":
                        raise _bad()
                    text.append(_string(part.get("text")))
            elif kind == "function_call":
                calls.append(_call(step.get("id"), step.get("name"), step.get("arguments")))
            elif kind != "thought":
                raise _bad()
        if (response["status"] == "requires_action") != bool(calls):
            raise _bad()
        usage = _usage(response.get("usage"), {"total_input_tokens": "inputTokens", "total_output_tokens": "outputTokens",
                       "total_tokens": "totalTokens", "total_cached_tokens": "cachedTokens", "total_thought_tokens": "reasoningTokens"})
    elif provider == "ollama":
        if response.get("done") is not True or response.get("done_reason") not in (None, "stop"):
            raise _bad()
        prompt_count = response.get("prompt_eval_count")
        if type(prompt_count) is int and prompt_count >= generation["limits"]["contextWindow"] - generation["limits"]["maxOutputTokens"]:
            raise ProviderError("The local model reached its context budget. The result was rejected to avoid accepting truncated context.")
        native = response.get("message")
        if not isinstance(native, dict) or native.get("role") != "assistant":
            raise _bad()
        text.append(_string(native.get("content", "")))
        for item in _list(native.get("tool_calls", []), MAX_TOOL_CALLS):
            function = item.get("function") if isinstance(item, dict) else None
            if not isinstance(function, dict):
                raise _bad()
            calls.append(_call("ollama_" + uuid4().hex, function.get("name"), function.get("arguments")))
        usage = _usage(response, {"prompt_eval_count": "inputTokens", "eval_count": "outputTokens"})
    else:
        raise _bad()
    if len(calls) > MAX_TOOL_CALLS or len({call["id"] for call in calls}) != len(calls):
        raise _bad()
    visible = "".join(text)
    if not visible.strip() and not calls:
        raise ProviderError("The provider returned no usable text or tool calls. No changes were applied.")
    if len(encode_json(native)) > 4_000_000:
        raise ProviderError("The model continuation exceeded the supported size.")
    return {"text": visible, "toolCalls": calls, "continuation": _continuation(provider, native), "usage": usage, "done": not calls}
