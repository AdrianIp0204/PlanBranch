"""Bounded native stream reconstruction; partial calls never leave this module.

Only complete, terminal provider responses become application tool calls. Native
thinking/signature blocks are retained privately for the next tool turn.
"""
from copy import deepcopy

from .provider_transport import ProviderError, decode_json, encode_json

MAX_STREAM_BYTES = 4_000_000
MAX_EVENTS = 20_000


def invalid():
    return ProviderError("The model stream ended early or returned invalid events. No further tools were run.")


def string(value):
    if not isinstance(value, str):
        raise invalid()
    return value


class StreamDecoder:
    def __init__(self, provider):
        self.provider = provider
        self.buffer = b""
        self.data = []
        self.event_name = ""
        self.size = 0
        self.events = 0
        self.result = None
        self.terminal = False
        self.started = False
        self.blocks = []
        self.open_blocks = set()
        self.fragments = {}
        self.message = {}
        self.ollama_message = {"role": "assistant", "content": ""}

    def feed(self, chunk):
        self.size += len(chunk)
        if self.size > MAX_STREAM_BYTES:
            raise ProviderError("The model stream exceeded the supported size.")
        self.buffer += chunk
        while b"\n" in self.buffer:
            raw, self.buffer = self.buffer.split(b"\n", 1)
            self._line(raw.rstrip(b"\r"))
        if len(self.buffer) > MAX_STREAM_BYTES:
            raise invalid()

    def _line(self, raw):
        if self.provider == "ollama":
            if raw.strip():
                if self.terminal:
                    raise invalid()
                self._consume(decode_json(raw), "")
            return
        try:
            line = raw.decode("utf-8")
        except UnicodeError:
            raise invalid() from None
        if not line:
            if self.data:
                packet = "\n".join(self.data)
                self.data = []
                if packet == "[DONE]":
                    if self.provider == "gemini" and not self.terminal:
                        self._gemini_finish()
                    if not self.terminal:
                        raise invalid()
                elif self.terminal:
                    raise invalid()
                else:
                    self._consume(decode_json(packet), self.event_name)
            self.event_name = ""
        elif line.startswith("data:"):
            self.data.append(line[5:].lstrip(" "))
        elif line.startswith("event:"):
            self.event_name = line[6:].strip()
        elif not (line.startswith(":") or line.startswith("id:") or line.startswith("retry:")):
            raise invalid()

    def _consume(self, event, name):
        self.events += 1
        if self.events > MAX_EVENTS or not isinstance(event, dict):
            raise invalid()
        if self.provider == "ollama":
            self._ollama(event)
        elif self.provider == "openai":
            kind = event.get("type", name)
            if kind in ("error", "response.failed", "response.incomplete"):
                raise invalid()
            if kind == "response.completed":
                result = event.get("response")
                if not isinstance(result, dict) or result.get("status") != "completed":
                    raise invalid()
                self.result, self.terminal = result, True
            elif not isinstance(kind, str) or not kind.startswith("response."):
                raise invalid()
        elif self.provider == "anthropic":
            self._anthropic(event, name)
        elif self.provider == "gemini":
            self._gemini(event, name)
        else:
            raise invalid()

    def _start_block(self, index, block):
        if type(index) is not int or index != len(self.blocks) or len(self.blocks) >= 1000 or not isinstance(block, dict):
            raise invalid()
        self.blocks.append(deepcopy(block))
        self.open_blocks.add(index)

    def _block(self, index):
        if type(index) is not int or index not in self.open_blocks:
            raise invalid()
        return self.blocks[index]

    def _close_block(self, index, argument_field):
        block = self._block(index)
        if index in self.fragments:
            # Ignore only the protocol's initial empty-object placeholder.
            if block.get(argument_field) not in ({}, None):
                raise invalid()
            arguments = decode_json(self.fragments.pop(index))
            if not isinstance(arguments, dict):
                raise invalid()
            block[argument_field] = arguments
        self.open_blocks.remove(index)

    def _anthropic(self, event, name):
        kind = event.get("type", name)
        if kind == "ping":
            return
        if kind == "message_start":
            message = event.get("message")
            if self.started or not isinstance(message, dict) or message.get("content", []) != []:
                raise invalid()
            self.message, self.started = deepcopy(message), True
        elif not self.started:
            raise invalid()
        elif kind == "content_block_start":
            self._start_block(event.get("index"), event.get("content_block"))
        elif kind == "content_block_delta":
            index = event.get("index")
            block = self._block(index)
            delta = event.get("delta")
            if not isinstance(delta, dict):
                raise invalid()
            change = delta.get("type")
            if change == "text_delta" and block.get("type") == "text":
                block["text"] = string(block.get("text", "")) + string(delta.get("text"))
            elif change == "thinking_delta" and block.get("type") == "thinking":
                block["thinking"] = string(block.get("thinking", "")) + string(delta.get("thinking"))
            elif change == "signature_delta" and block.get("type") == "thinking":
                block["signature"] = string(block.get("signature", "")) + string(delta.get("signature"))
            elif change == "input_json_delta" and block.get("type") == "tool_use":
                self.fragments[index] = self.fragments.get(index, "") + string(delta.get("partial_json"))
            else:
                raise invalid()
        elif kind == "content_block_stop":
            self._close_block(event.get("index"), "input")
        elif kind == "message_delta":
            delta = event.get("delta")
            if not isinstance(delta, dict):
                raise invalid()
            for key in ("stop_reason", "stop_sequence"):
                if key in delta:
                    self.message[key] = delta[key]
            if isinstance(event.get("usage"), dict):
                self.message.setdefault("usage", {}).update(event["usage"])
        elif kind == "message_stop":
            if self.open_blocks or self.fragments or not self.message.get("stop_reason"):
                raise invalid()
            self.message["content"] = self.blocks
            self.result, self.terminal = self.message, True
        else:
            raise invalid()

    def _gemini(self, event, name):
        kind = event.get("event_type", name)
        if kind == "interaction.created":
            message = event.get("interaction")
            if self.started or not isinstance(message, dict):
                raise invalid()
            self.message, self.started = deepcopy(message), True
        elif not self.started:
            raise invalid()
        elif kind == "step.start":
            self._start_block(event.get("index"), event.get("step"))
        elif kind == "step.delta":
            index = event.get("index")
            block = self._block(index)
            delta = event.get("delta")
            if not isinstance(delta, dict):
                raise invalid()
            change = delta.get("type")
            if change == "text" and block.get("type") == "model_output":
                content = block.setdefault("content", [])
                if not isinstance(content, list):
                    raise invalid()
                if content and isinstance(content[-1], dict) and content[-1].get("type") == "text":
                    content[-1]["text"] = string(content[-1].get("text", "")) + string(delta.get("text"))
                else:
                    content.append({"type": "text", "text": string(delta.get("text"))})
            elif change == "arguments_delta" and block.get("type") == "function_call":
                self.fragments[index] = self.fragments.get(index, "") + string(delta.get("arguments"))
            elif change == "thought_signature" and block.get("type") == "thought":
                block["signature"] = string(block.get("signature", "")) + string(delta.get("signature"))
            elif change == "thought_summary" and block.get("type") == "thought":
                part = delta.get("content")
                if not isinstance(part, dict):
                    raise invalid()
                block.setdefault("summary", []).append(deepcopy(part))
            else:
                raise invalid()
            metadata = event.get("metadata")
            if isinstance(metadata, dict) and isinstance(metadata.get("total_usage"), dict):
                self.message["usage"] = deepcopy(metadata["total_usage"])
        elif kind == "step.stop":
            self._close_block(event.get("index"), "arguments")
        elif kind == "interaction.status_update":
            status = event.get("status")
            if status not in ("in_progress", "completed", "requires_action"):
                raise invalid()
            self.message["status"] = status
        elif kind == "interaction.completed":
            result = event.get("interaction")
            if not isinstance(result, dict):
                raise invalid()
            self.message.update(result)
            self._gemini_finish()
        else:
            raise invalid()

    def _gemini_finish(self):
        if (not self.started or self.open_blocks or self.fragments
                or self.message.get("status") not in ("completed", "requires_action")):
            raise invalid()
        self.message["steps"] = self.blocks
        self.result, self.terminal = self.message, True

    def _ollama(self, event):
        if event.get("error") or type(event.get("done")) is not bool:
            raise invalid()
        message = event.get("message")
        if not isinstance(message, dict) or message.get("role", "assistant") != "assistant":
            raise invalid()
        for key in ("content", "thinking"):
            if key in message:
                self.ollama_message[key] = string(self.ollama_message.get(key, "")) + string(message[key])
        if "tool_calls" in message:
            calls = message["tool_calls"]
            if not isinstance(calls, list) or any(not isinstance(call, dict) for call in calls):
                raise invalid()
            self.ollama_message.setdefault("tool_calls", []).extend(deepcopy(calls))
            if len(self.ollama_message["tool_calls"]) > 16:
                raise invalid()
        if event["done"]:
            self.result = {**event, "message": self.ollama_message}
            self.terminal = True

    def finish(self):
        if self.provider == "ollama" and self.buffer.strip():
            self._line(self.buffer)
            self.buffer = b""
        if not self.terminal or not isinstance(self.result, dict):
            raise invalid()
        if len(encode_json(self.result)) > MAX_STREAM_BYTES:
            raise ProviderError("The completed model response exceeded the supported size.")
        return self.result
