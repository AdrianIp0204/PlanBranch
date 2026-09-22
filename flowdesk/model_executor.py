"""Shared bounded tool loop; provider responses have no filesystem authority."""
from __future__ import annotations

from copy import deepcopy
import hashlib
from importlib.resources import files
import json
import math
from pathlib import Path
import re
import time
from uuid import UUID, uuid4

from .command_runner import DockerCommandRunner
from .execution_git import _atomic_json, _plain, WorkspaceError
from .planning_questions import validate_answers, validate_questions
from .workspace_tools import WorkspaceTools
from .storage import now

VERSION = "model-executor-v1"
MAX_TURNS, MAX_CALLS, MAX_SECONDS, MAX_CONTEXT = 24, 80, 1200, 1_500_000


def harness_policy(value):
    # Earlier records from this same instruction version used this fixed profile.
    value = deepcopy(value) if value is not None else {"version": 1, "maxTurns": 24, "maxCalls": 80, "maxSeconds": 1200, "maxContextBytes": 1_500_000}
    if (not isinstance(value, dict) or set(value) != {"version", "maxTurns", "maxCalls", "maxSeconds", "maxContextBytes"}
            or type(value["version"]) is not int or value["version"] != 1):
        raise WorkspaceError("The frozen harness policy is unsupported. Preview a new Run step.")
    for key, maximum in (("maxTurns", 24), ("maxCalls", 80), ("maxContextBytes", 1_500_000)):
        if type(value[key]) is not int or not 1 <= value[key] <= maximum:
            raise WorkspaceError("The frozen coding limits are invalid.")
    if type(value["maxSeconds"]) not in (int, float) or not math.isfinite(value["maxSeconds"]) or not 0 < value["maxSeconds"] <= 1200:
        raise WorkspaceError("The frozen coding duration is invalid.")
    return value


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def schema(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


TOOLS = [
    {"name": "list_files", "description": "List bounded relative worktree filenames; no Git metadata.", "parameters": schema({"prefix": {"type": "string"}})},
    {"name": "read_file", "description": "Read UTF-8 text and its hash before editing; offsets count characters.", "parameters": schema({"path": {"type": "string"}, "offset": {"type": "integer"}, "limit": {"type": "integer"}}, ["path"])},
    {"name": "search_files", "description": "Find literal text in worktree files with line context.", "parameters": schema({"query": {"type": "string"}}, ["query"])},
    {"name": "write_file", "description": "Write text with a matching read hash; null hash creates, null content removes.", "parameters": schema({"path": {"type": "string"}, "content": {"type": ["string", "null"]}, "expectedSha256": {"type": ["string", "null"]}}, ["path", "content", "expectedSha256"])},
    {"name": "diff", "description": "Review changes since this invocation began.", "parameters": schema({"path": {"type": "string"}})},
    {"name": "run_command", "description": "Run a bounded command only in the reviewed isolated command runtime. No host fallback.", "parameters": schema({"command": {"type": "string"}, "timeoutSeconds": {"type": "integer"}}, ["command"])},
    {"name": "ask_question", "description": "Pause for explicit choices or custom answers. Use this as the only call in a response.", "parameters": schema({"questions": {"type": "array", "minItems": 1, "maxItems": 3, "items": schema({
        "id": {"type": "string", "description": "UUID"}, "kind": {"type": "string", "enum": ["choice", "text"]}, "prompt": {"type": "string"},
        "options": {"type": "array", "items": schema({"id": {"type": "string", "description": "UUID"}, "label": {"type": "string"}, "description": {"type": "string"}}, ["id", "label", "description"])},
        "recommendedOptionId": {"type": ["string", "null"]}}, ["id", "kind", "prompt", "options", "recommendedOptionId"]) }}, ["questions"])},
]


class ToolJournal:
    def __init__(self, data_dir, run_id):
        if str(UUID(run_id)) != run_id:
            raise WorkspaceError("Invalid coding run identity.")
        directory = Path(data_dir).resolve() / "execution" / run_id
        for path in (directory.parent, directory):
            if path.exists() and not _plain(path):
                raise WorkspaceError("Coding records must not contain links.")
        directory.mkdir(parents=True, exist_ok=True)
        if any(not _plain(path) for path in (directory, directory.parent)):
            raise WorkspaceError("Coding records must not contain links.")
        self.path = directory / "agent-tools.json"

    def load(self):
        if not self.path.exists(): return None
        if not _plain(self.path) or self.path.stat().st_size > 3_000_000:
            raise WorkspaceError("The coding journal is not readable safely.")
        return json.loads(self.path.read_text(encoding="utf-8"))

    def save(self, value):
        if len(encoded(value).encode()) > 2_500_000:
            raise WorkspaceError("The coding journal limit was reached; work is retained.")
        _atomic_json(self.path, value)

    def public_question(self):
        journal = self.load()
        if not journal or journal.get("state") not in {"question", "answered"}: return None
        question = deepcopy(journal["question"])
        if journal.get("answerRequest"): question["answerRequest"] = journal["answerRequest"]
        return question

    def answer(self, request):
        journal = self.load()
        if not journal or journal.get("state") not in {"question", "answered"}:
            raise WorkspaceError("This run is not waiting for an answer.")
        if journal["question"]["id"] != request["questionId"]:
            raise WorkspaceError("This question is no longer current.")
        validate_answers(journal["question"]["questions"], request["answers"])
        if journal.get("answerRequest"):
            if journal["answerRequest"] != request:
                raise WorkspaceError("Retry the original saved answer request before submitting another answer.")
            return
        journal.update(state="answered", answerRequest=deepcopy(request))
        self.save(journal)

    def cancel_question(self):
        journal = self.load()
        if journal and journal.get("state") in {"question", "answered"}:
            journal["state"] = "cancelled"
            self.save(journal)


class DeadlineCancel:
    """Cancellation view shared by provider and runner; never cancels the caller."""
    def __init__(self, parent, deadline): self.parent, self.deadline = parent, deadline
    def is_set(self): return self.parent.is_set() or time.monotonic() >= self.deadline
    def wait(self, timeout=None):
        remaining = max(0, self.deadline - time.monotonic())
        self.parent.wait(remaining if timeout is None else min(timeout, remaining))
        return self.is_set()


class ModelExecutor:
    def __init__(self, data_dir, registry=None, runner=None):
        if registry is None:
            from .providers import ProviderRegistry
            registry = ProviderRegistry(data_dir)
        self.data_dir, self.registry = Path(data_dir), registry
        self.runner = runner or DockerCommandRunner(data_dir)

    def status(self, provider="ollama"):
        return self.registry.status(provider)

    def configure(self, selection):
        provider = self.registry.configure(selection, purpose="coding")
        instructions = files("flowdesk").joinpath("prompts", VERSION + ".md").read_text(encoding="utf-8")
        return {"provider": selection["provider"], "selection": deepcopy(selection), "providerGeneration": provider,
                "instructionVersion": VERSION, "instructionHash": hashlib.sha256(instructions.encode()).hexdigest(),
                "instructions": instructions, "toolSchemaVersion": 1, "commandPolicy": self.runner.configure(),
                "harnessPolicy": {"version": 1, "maxTurns": MAX_TURNS, "maxCalls": MAX_CALLS, "maxSeconds": MAX_SECONDS, "maxContextBytes": MAX_CONTEXT}}

    def run(self, context, worktree, cancel, on_event):
        started = time.monotonic()
        journal = ToolJournal(self.data_dir, context["runId"])
        generation = context["generation"]
        result = {"status": "interrupted", "summary": "", "commands": []}
        commands, state = {}, journal.load()
        elapsed_base = None
        def save_state():
            if elapsed_base is not None:
                # Account only while this invocation owns the work. Awaiting an
                # answer, server downtime and explicit retry delays are idle.
                state["elapsedSeconds"] = max(state["elapsedSeconds"],
                    elapsed_base + max(0, time.monotonic() - started))
            journal.save(state)
        def event(value):
            if value.get("type") == "command":
                commands[value["command"]["id"]] = deepcopy(value["command"])
            on_event(value)
        try:
            if generation.get("instructionVersion") != VERSION or generation.get("toolSchemaVersion") != 1:
                raise WorkspaceError("The coding instruction contract is unsupported. Review a new Run step.")
            if hashlib.sha256(generation["instructions"].encode()).hexdigest() != generation.get("instructionHash"):
                raise WorkspaceError("The frozen coding instruction identity is invalid.")
            policy = harness_policy(generation.get("harnessPolicy"))
            identity = fingerprint({key: context[key] for key in ("task", "brief", "linkedNodes", "sourceCommit", "generation")})
            if state is None:
                state = {"version": 1, "identity": identity, "state": "running", "calls": [], "messages": [], "turns": 0, "invocation": 1,
                         "elapsedSeconds": 0}
            elif state.get("identity") != identity:
                raise WorkspaceError("The frozen task or provider changed; this run cannot continue.")
            elif state.get("state") != "answered" or any(call["state"] == "pending" for call in state["calls"]):
                raise WorkspaceError("This run has an interrupted or uncertain operation. Inspect retained work; it was not replayed.")
            elif "elapsedSeconds" not in state:
                # Older journals did not retain active time. Granting a fresh
                # budget could exceed the original authority; retain all work.
                raise WorkspaceError("This older run has no saved elapsed-time record and cannot safely continue. Review its retained work and preview a new Run step.")
            elapsed = state["elapsedSeconds"]
            if type(elapsed) not in (int, float) or not math.isfinite(elapsed) or elapsed < 0:
                raise WorkspaceError("The saved coding elapsed time is invalid. Review retained work and preview a new Run step.")
            if elapsed >= policy["maxSeconds"]:
                raise WorkspaceError("This run's coding time limit was reached. Review retained work and preview a new Run step.")
            elapsed_base = elapsed
            deadline = started + policy["maxSeconds"] - elapsed_base
            bounded_cancel = DeadlineCancel(cancel, deadline)
            if state["state"] == "answered":
                answer = state["answerRequest"]
                call = next(item for item in state["calls"] if item["id"] == state["question"]["toolCallId"])
                call.update(state="done", result={"answers": answer["answers"]})
                state["messages"].append({"role": "tool", "toolCallId": call.get("nativeId", call["id"]), "content": encoded(call["result"])})
                state["state"] = "running"
                state["invocation"] = state.get("invocation", 1) + 1
            for call in state["calls"]:
                if call.get("result", {}).get("command"):
                    record = call["result"]["command"]
                    commands[record["id"]] = record
            save_state()  # consume an answer before any owned workspace/model work
            tools = WorkspaceTools(worktree)
            payload = {key: context[key] for key in ("task", "brief", "linkedNodes", "sourceCommit")}
            payload["commandPolicy"] = generation["commandPolicy"]
            # Native reasoning/signatures stay only in memory during this loop.
            # An explicit answer starts a fresh turn with ordinary prior evidence.
            payload["priorVisibleWork"] = state["messages"]
            messages = [{"role": "system", "content": generation["instructions"]},
                        {"role": "user", "content": encoded(payload)}]
            for _ in range(policy["maxTurns"]):
                if cancel.is_set():
                    result["status"] = "cancelled"
                    break
                if time.monotonic() >= deadline:
                    raise WorkspaceError("The coding time limit was reached before the next provider turn. Review the retained work.")
                if state["turns"] >= policy["maxTurns"] or len(encoded(messages).encode()) > policy["maxContextBytes"]:
                    raise WorkspaceError("The coding turn or context limit was reached. Review the retained work.")
                state["turns"] += 1
                save_state()
                on_event({"type": "progress", "message": "The selected model is working on this step."})
                reply = self.registry.turn(generation["providerGeneration"], messages, deepcopy(TOOLS), cancel=bounded_cancel)
                if time.monotonic() >= deadline:
                    raise WorkspaceError("The coding time limit was reached while awaiting the provider.")
                usage = {str(key)[:100]: value for key, value in list((reply.get("usage") or {}).items())[:30]
                         if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1e15}
                if usage:
                    event({"type": "usage", "provider": generation["provider"], "turn": state["turns"], "usage": usage})
                calls, text = reply.get("toolCalls", []), reply.get("text", "")
                if not isinstance(text, str) or len(text) > 32000 or not isinstance(calls, list) or len(calls) > 8:
                    raise WorkspaceError("The provider returned an oversized or invalid coding response.")
                if text:
                    result["summary"] = text
                    on_event({"type": "message", "text": text})
                if any(call.get("name") == "ask_question" for call in calls) and len(calls) != 1:
                    raise WorkspaceError("A question must be the only tool call in its response.")
                visible = {"role": "assistant", "content": text, "toolCalls": calls}
                messages.append({**visible, "continuation": reply.get("continuation")})
                state["messages"].append(deepcopy(visible))
                save_state()
                if not calls and reply.get("done"):
                    result["status"] = "succeeded"
                    break
                for call in calls:
                    if cancel.is_set(): break
                    if time.monotonic() >= deadline:
                        raise WorkspaceError("The coding time limit was reached before the next tool operation.")
                    key, name, args = call.get("id"), call.get("name"), call.get("arguments")
                    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", key) or not isinstance(args, dict):
                        raise WorkspaceError("The provider returned an invalid tool-call identity or arguments.")
                    native_key = key
                    key = str(state["invocation"]) + ":" + key
                    signature = fingerprint({"name": name, "arguments": args})
                    prior = next((item for item in state["calls"] if item["id"] == key), None)
                    if prior:
                        if prior["signature"] != signature or prior["state"] != "done":
                            raise WorkspaceError("A tool identity changed or has an uncertain result. It will not be replayed.")
                        raise WorkspaceError("The provider repeated a completed tool identity. Its operation was not repeated.")
                    else:
                        if len(state["calls"]) >= policy["maxCalls"]:
                            raise WorkspaceError("The coding tool-call limit was reached.")
                        record = {"id": key, "nativeId": native_key, "name": name, "arguments": deepcopy(args), "signature": signature, "state": "pending"}
                        state["calls"].append(record)
                        save_state()  # intent precedes every tool effect
                        try:
                            definition = next((tool for tool in TOOLS if tool["name"] == name), None)
                            if definition is None or set(args) - set(definition["parameters"]["properties"]) or not set(definition["parameters"]["required"]) <= set(args):
                                raise WorkspaceError("Unsupported tool or unexpected/missing arguments.")
                            if name == "ask_question":
                                questions = validate_questions(args["questions"])
                                state.pop("answerRequest", None)
                                state.update(state="question", question={"id": str(uuid4()), "questions": questions,
                                    "createdAt": now(), "toolCallId": key})
                                record["state"] = "waiting"
                                save_state()
                                result.update(status="interrupted", error="Answer the execution question to continue this step.")
                                return {**result, "commands": list(commands.values())}
                            if name == "run_command":
                                output = self.runner.run(generation["commandPolicy"], worktree, args, key, bounded_cancel, event)
                                if output.get("command"): commands[output["command"]["id"]] = output["command"]
                            else:
                                output = getattr(tools, name)(args)
                        except (WorkspaceError, KeyError, TypeError, ValueError) as exc:
                            if name == "run_command":
                                raise  # an uncertain command intent must never be retried by the model
                            output = {"error": str(exc)[:2000]}
                        record.update(state="done", result=deepcopy(output))
                        failed = output.get("error") or output.get("executed") is False or (output.get("command") and output["command"].get("status") != "completed")
                        state["consecutiveFailures"] = state.get("consecutiveFailures", 0) + 1 if failed else 0
                        save_state()
                        if state["consecutiveFailures"] >= 3:
                            raise WorkspaceError("Three consecutive tool operations failed. Review the retained work before another run.")
                    message = {"role": "tool", "toolCallId": native_key, "content": encoded(output)}
                    messages.append(message)
                    state["messages"].append(message)
                    save_state()
            if cancel.is_set(): result["status"] = "cancelled"
            elif result["status"] == "interrupted": result["error"] = "The coding turn limit was reached. Review the retained work."
            if not commands:
                result["summary"] += "\nNo commands or tests were run by this execution."
            elif any(item["exitCode"] not in (None, 0) for item in commands.values()):
                result["summary"] += "\nObserved command failures remain in the run results."
            state["state"] = result["status"]
            save_state()
        except Exception as exc:
            result.update(status="cancelled" if cancel.is_set() else "interrupted", error=str(exc)[:4000])
            # Leave pending tool intents untouched. Restart must never repeat them.
            if elapsed_base is not None:
                try:
                    save_state()
                except Exception:
                    # Keep the original error; a failed durable checkpoint must
                    # never turn into an implicit replay or a fresh time budget.
                    result["error"] += " Elapsed usage could not be saved; this run was not retried."
        result["commands"] = list(commands.values())
        return result
