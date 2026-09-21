"""Planning-only adapter for the user's separately installed, signed-in Codex CLI.

The CLI receives manual planning context through stdin in a disposable directory.
Shell, integrations, hooks and agent delegation are disabled; filesystem writes
are denied by its read-only sandbox. Codex 0.144.1 still exposes built-in plan,
question, patch and image helpers. In particular this is NOT an OS-level ban on
all file reads: its image helper remains available. No source roots are supplied.
PlanBranch never reads or copies credentials and never applies the returned edits.
"""
from __future__ import annotations

import json
import hashlib
from importlib import resources
import math
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass


MAX_CONTEXT_BYTES = 500_000
MAX_RESULT_BYTES = 2_000_000
MAX_PROCESS_BYTES = 4_000_000
GENERATION_TIMEOUT = 180
STATUS_TTL = 15


class CodexPlannerError(RuntimeError):
    """An actionable message safe to display without raw CLI diagnostics."""


def _object(properties):
    return {"type": "object", "properties": properties,
            "required": list(properties), "additionalProperties": False}


_text = {"type": "string"}
NODE_SCHEMA = _object({
    "id": _text, "type": {"type": "string", "enum": ["start", "end", "process", "decision", "io", "note"]},
    "title": _text, "position": _object({"x": {"type": "number"}, "y": {"type": "number"}}),
    **{key: _text for key in ("description", "notes", "pseudocode", "targetFile", "targetScope", "why", "alternatives", "blocker")},
    "status": {"type": "string", "enum": ["not_started", "in_progress", "blocked", "done"]},
    "checklist": {"type": "array", "items": _object({"id": _text, "text": _text, "checked": {"type": "boolean"}})},
})
EDGE_SCHEMA = _object({
    "id": _text, "source": _text, "target": _text, "label": _text,
    "sourceHandle": {"type": ["string", "null"]}, "targetHandle": {"type": ["string", "null"]},
})
OUTPUT_SCHEMA_V1 = _object({
    "message": _text,
    "proposal": {"anyOf": [{"type": "null"}, _object({
        "title": _text, "summary": _text, "diagramId": _text,
        "nodes": {"type": "array", "items": NODE_SCHEMA},
        "edges": {"type": "array", "items": EDGE_SCHEMA},
    })]},
})

QUESTION_SCHEMA = _object({
    "id": _text,
    "kind": {"type": "string", "enum": ["choice", "text"]},
    "prompt": _text,
    "options": {"type": "array", "items": _object({"id": _text, "label": _text, "description": _text})},
    "recommendedOptionId": {"type": ["string", "null"]},
})
OUTPUT_SCHEMA_V2 = _object({
    "protocolVersion": {"type": "integer", "enum": [2]},
    "kind": {"type": "string", "enum": ["reply", "questions", "proposal"]},
    "message": _text,
    "questions": {"type": "array", "items": QUESTION_SCHEMA},
    "proposal": OUTPUT_SCHEMA_V1["properties"]["proposal"],
})
BRIEF_SCHEMA = _object({key: _text for key in (
    "goal", "audience", "requirements", "constraints", "outOfScope", "decisions", "assumptions")})
OUTPUT_SCHEMA_V3 = _object({
    "protocolVersion": {"type": "integer", "enum": [3]},
    "kind": {"type": "string", "enum": ["reply", "questions", "proposal"]},
    "message": _text,
    "questions": {"type": "array", "items": QUESTION_SCHEMA},
    "proposal": {"anyOf": [{"type": "null"}, _object({
        "title": _text, "summary": _text, "diagramId": _text,
        "nodes": {"anyOf": [{"type": "null"}, {"type": "array", "items": NODE_SCHEMA}]},
        "edges": {"anyOf": [{"type": "null"}, {"type": "array", "items": EDGE_SCHEMA}]},
        "brief": {"anyOf": [{"type": "null"}, BRIEF_SCHEMA]},
    })]},
})
OUTPUT_SCHEMAS = {1: OUTPUT_SCHEMA_V1, 2: OUTPUT_SCHEMA_V2, 3: OUTPUT_SCHEMA_V3}
OUTPUT_SCHEMA = OUTPUT_SCHEMA_V3

DISABLED_FEATURES = (
    "shell_tool", "unified_exec", "shell_snapshot", "apps", "plugins", "remote_plugin",
    "hooks", "browser_use", "browser_use_external", "computer_use", "image_generation",
    "multi_agent", "multi_agent_v2", "goals", "memories", "code_mode", "code_mode_host",
    "workspace_dependencies", "tool_suggest", "skill_mcp_dependency_install",
)
CONFIG_OVERRIDES = (
    'approval_policy="never"', 'web_search="disabled"', 'model_provider="openai"',
    'forced_login_method="chatgpt"', 'cli_auth_credentials_store="auto"',
    'project_doc_max_bytes=0', 'skills.max_context_tokens=1', 'mcp_servers={}',
    'notify=[]', 'history.persistence="none"', 'analytics.enabled=false',
    'feedback.enabled=false', 'check_for_update_on_startup=false',
)
INSTRUCTION_VERSION = "planner-v4"
PROTOCOL_VERSION = 3
INSTRUCTION_PROTOCOLS = {"planner-v1": 1, "planner-v2": 2, "planner-v3": 2, "planner-v4": 3}


def instruction_resource(version=None):
    try:
        return resources.files("flowdesk").joinpath("prompts", (version or INSTRUCTION_VERSION) + ".md").read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise CodexPlannerError("PlanBranch's planning instructions are unavailable. Reinstall PlanBranch before sending a new message.") from None


def normalize_selection(selection):
    """Only a typed selection crosses the browser boundary; never CLI config."""
    from .codex_capabilities import IDENTIFIER
    if selection is None:
        return {"mode": "default"}
    if not isinstance(selection, dict):
        raise CodexPlannerError("Choose CLI default or a supported model and reasoning level.")
    if selection == {"mode": "default"}:
        return {"mode": "default"}
    if set(selection) != {"mode", "model", "reasoningEffort"} or selection.get("mode") != "explicit":
        raise CodexPlannerError("Choose CLI default or a supported model and reasoning level.")
    model, effort = selection["model"], selection["reasoningEffort"]
    if (not isinstance(model, str) or not IDENTIFIER.fullmatch(model)
            or (effort is not None and (not isinstance(effort, str) or not IDENTIFIER.fullmatch(effort)))):
        raise CodexPlannerError("The selected model or reasoning level is invalid. Choose from the model menu.")
    return {"mode": "explicit", "model": model, "reasoningEffort": effort}


def validate_generation(generation):
    if not isinstance(generation, dict):
        raise CodexPlannerError("This message uses an earlier planning setup. Send it as a new message to use the current instructions and model controls.")
    fields = {"selection", "cliVersion", "instructionVersion", "instructionHash", "instructions", "protocolVersion"}
    if (set(generation) != fields or type(generation.get("protocolVersion")) is not int
            or generation["protocolVersion"] not in OUTPUT_SCHEMAS
            or not isinstance(generation.get("instructionVersion"), str)
            or INSTRUCTION_PROTOCOLS.get(generation["instructionVersion"]) != generation["protocolVersion"]):
        raise CodexPlannerError("This message's planning contract is no longer supported. Send it as a new message.")
    if not isinstance(generation.get("selection"), dict):
        raise CodexPlannerError("This message has an invalid saved model selection. Send it as a new message.")
    instructions = generation.get("instructions")
    if (not isinstance(instructions, str) or not instructions.strip() or len(instructions.encode("utf-8")) > 16000
            or generation.get("instructionHash") != hashlib.sha256(instructions.encode("utf-8")).hexdigest()
            or (generation.get("cliVersion") is not None and (not isinstance(generation["cliVersion"], str) or len(generation["cliVersion"]) > 80))):
        raise CodexPlannerError("This message's saved planning instructions are invalid. Send it as a new message.")
    return {**generation, "selection": normalize_selection(generation.get("selection"))}



def _executable() -> str | None:
    """Resolve npm Windows shims to the native binary without invoking a shell."""
    found = shutil.which("codex")
    if not found:
        return None
    path = Path(found)
    if os.name != "nt" or path.suffix.lower() == ".exe":
        return str(path)
    if path.suffix.lower() not in {".cmd", ".bat", ".ps1"}:
        return None
    arch = "arm64" if platform.machine().lower() in {"arm64", "aarch64"} else "x64"
    triple = "aarch64-pc-windows-msvc" if arch == "arm64" else "x86_64-pc-windows-msvc"
    package = path.parent / "node_modules" / "@openai" / "codex"
    for vendor in (package / "node_modules" / "@openai" / f"codex-win32-{arch}" / "vendor", package / "vendor"):
        candidate = vendor / triple / "bin" / "codex.exe"
        if candidate.is_file():
            return str(candidate)
    return None


def _environment():
    # Preserve the auth-store location; discard API-key/provider/parent-session
    # overrides so an existing ChatGPT CLI sign-in is the only credential path.
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith("CODEX_") or key.upper() == "CODEX_HOME"}
    for key in list(env):
        if key.upper() in {"OPENAI_API_KEY", "OPENAI_BASE_URL", "CHATGPT_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"}:
            env.pop(key)
    env["RUST_LOG"] = "off"
    env["NO_COLOR"] = "1"
    return env


@dataclass
class _Result:
    returncode: int
    stdout: bytes
    stderr: bytes


def _stop(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        taskkill = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "taskkill.exe"
        try:
            subprocess.run([str(taskkill), "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=5, creationflags=subprocess.CREATE_NO_WINDOW)
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.kill()
    process.wait(timeout=5)


def _run(args, *, cwd, prompt=b"", timeout=GENERATION_TIMEOUT, cancel=None, output_path=None):
    """Bound input, both output streams, wall time and cancellation together."""
    try:
        process = subprocess.Popen(
            args, cwd=cwd, env=_environment(), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            start_new_session=os.name != "nt",
        )
    except OSError:
        raise CodexPlannerError("Codex CLI could not start. Check its installation and try again.") from None
    streams = [bytearray(), bytearray()]
    overflow = threading.Event()

    def read(pipe, target):
        try:
            while chunk := pipe.read(8192):
                remaining = MAX_PROCESS_BYTES - len(target)
                target.extend(chunk[:max(0, remaining)])
                if len(chunk) > remaining:
                    overflow.set()
                    break
        finally:
            pipe.close()

    def write():
        try:
            process.stdin.write(prompt)
        except (BrokenPipeError, OSError, ValueError):
            pass
        finally:
            try:
                process.stdin.close()
            except (BrokenPipeError, OSError, ValueError):
                pass

    threads = [threading.Thread(target=read, args=(process.stdout, streams[0]), daemon=True),
               threading.Thread(target=read, args=(process.stderr, streams[1]), daemon=True),
               threading.Thread(target=write, daemon=True)]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + timeout
    try:
        while process.poll() is None:
            if cancel is not None and cancel.is_set():
                raise CodexPlannerError("Planning request cancelled.")
            if time.monotonic() >= deadline:
                raise CodexPlannerError("Codex took too long to respond. Try a smaller planning request.")
            if overflow.is_set() or (output_path and output_path.exists() and output_path.stat().st_size > MAX_RESULT_BYTES):
                raise CodexPlannerError("Codex returned too much output. Try a smaller planning request.")
            time.sleep(0.05)
        for thread in threads:
            thread.join(timeout=2)
        if overflow.is_set():
            raise CodexPlannerError("Codex returned too much output. Try a smaller planning request.")
        if cancel is not None and cancel.is_set():
            raise CodexPlannerError("Planning request cancelled.")
        return _Result(process.returncode, bytes(streams[0]), bytes(streams[1]))
    finally:
        _stop(process)
        for thread in threads:
            thread.join(timeout=2)


def _failure(result):
    # Diagnostics are classified in memory, never copied into API errors/logs.
    text = (result.stderr + result.stdout).decode("utf-8", errors="replace").lower()
    if any(word in text for word in ("not logged in", "unauthorized", "authentication", "401", "token expired", "sign in")):
        return "Codex needs your sign-in. Run codex login in a terminal, then retry."
    if any(word in text for word in ("rate limit", "usage limit", "quota", "429")):
        return "Your Codex usage limit was reached. Retry after your allowance resets."
    if (("model" in text and any(word in text for word in ("model_not_found", "not supported", "unsupported", "not found", "does not exist", "not available", "not have access")))
            or ("reasoning" in text and any(word in text for word in ("unsupported", "not supported", "invalid value", "does not support")))):
        return "Codex could not use the selected model or reasoning level. Choose another supported pair or CLI default and send a new message."
    if any(word in text for word in ("unexpected argument", "unknown feature", "unknown field", "invalid value")):
        return "This Codex CLI version does not support PlanBranch's planning settings. Update Codex CLI, then retry."
    return "Codex could not complete this request. Check your connection and Codex CLI sign-in, then retry."


def _validate_shape(value, schema):
    if "anyOf" in schema:
        for option in schema["anyOf"]:
            try:
                _validate_shape(value, option)
                return
            except ValueError:
                pass
        raise ValueError
    kind = schema["type"]
    kinds = kind if isinstance(kind, list) else [kind]
    matches = {"null": value is None, "string": isinstance(value, str),
               "object": isinstance(value, dict), "array": isinstance(value, list),
               "boolean": type(value) is bool, "number": type(value) in (int, float), "integer": type(value) is int}
    if not any(matches[x] for x in kinds):
        raise ValueError
    if "number" in kinds and not math.isfinite(value):
        raise ValueError
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError
    if kind == "object":
        if set(value) != set(schema["properties"]):
            raise ValueError
        for key, nested in schema["properties"].items():
            _validate_shape(value[key], nested)
    if kind == "array":
        for item in value:
            _validate_shape(item, schema["items"])


class CodexPlanner:
    def __init__(self, *, timeout=GENERATION_TIMEOUT):
        self.timeout = timeout
        self._status_lock = threading.Lock()
        self._status_time = float("-inf")
        self._status = None
        from .codex_capabilities import CodexCapabilities
        self._capabilities = CodexCapabilities()

    def capabilities(self, refresh=False):
        return self._capabilities.get(refresh=refresh)

    def configure(self, selection=None):
        selection = normalize_selection(selection)
        catalogue = self.capabilities()
        if selection["mode"] == "explicit":
            if catalogue["status"] != "ready":
                raise CodexPlannerError("Model discovery is unavailable. Refresh the model list or choose CLI default before sending.")
            model = next((entry for entry in catalogue["models"] if entry["id"] == selection["model"]), None)
            if model is None:
                raise CodexPlannerError("The selected model is no longer in the CLI catalogue. Choose another model or CLI default.")
            efforts = [entry["id"] for entry in model["reasoningEfforts"]]
            if (efforts and selection["reasoningEffort"] not in efforts) or (not efforts and selection["reasoningEffort"] is not None):
                raise CodexPlannerError("The selected reasoning level is not supported by this model. Choose a supported level.")
        instructions = instruction_resource()
        return validate_generation({"selection": selection, "cliVersion": catalogue.get("cliVersion"),
            "instructionVersion": INSTRUCTION_VERSION, "instructionHash": hashlib.sha256(instructions.encode("utf-8")).hexdigest(),
            "instructions": instructions, "protocolVersion": PROTOCOL_VERSION})

    def status(self) -> dict:
        with self._status_lock:
            if self._status is not None and time.monotonic() - self._status_time < STATUS_TTL:
                return dict(self._status)
            result = {"available": False, "label": "Codex CLI"}
            executable = _executable()
            if not executable:
                result["reason"] = "Install Codex CLI and sign in with codex login, then restart PlanBranch."
            else:
                try:
                    with tempfile.TemporaryDirectory(prefix="flowdesk-codex-status-") as directory:
                        help_result = _run([executable, "exec", "--help"], cwd=directory, timeout=10)
                        required = (b"--ignore-user-config", b"--ignore-rules", b"--ephemeral", b"--output-schema")
                        if help_result.returncode or not all(flag in help_result.stdout for flag in required):
                            result["reason"] = "Update Codex CLI to a version supporting isolated planning requests."
                        else:
                            login = _run([executable, "login", "status", "-c", 'cli_auth_credentials_store="auto"'], cwd=directory, timeout=10)
                            output = (login.stderr + login.stdout).decode("utf-8", errors="replace").lower()
                            if login.returncode == 0 and "logged in" in output and "chatgpt" in output:
                                result["available"] = True
                            else:
                                result["reason"] = "Sign in to Codex CLI with codex login, then retry. PlanBranch uses your ChatGPT sign-in."
                except CodexPlannerError as exc:
                    result["reason"] = str(exc)
            self._status, self._status_time = result, time.monotonic()
            return dict(result)

    def generate(self, context: dict, cancel: threading.Event | None = None) -> dict:
        if cancel is not None and cancel.is_set():
            raise CodexPlannerError("Planning request cancelled.")
        generation = validate_generation(context.get("generation"))
        try:
            # Only these explicit manual-context fields cross the provider boundary.
            fields = ("content", "activeDiagramId", "nodeId", "messages", "comments",
                      "omittedMessageCount", "omittedResolvedCommentCount", "questionSets", "reviewProposal")
            payload = {key: context[key] for key in fields if key in context}
            encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        except (TypeError, ValueError, RecursionError):
            raise CodexPlannerError("The planning context is not valid JSON.") from None
        if len(encoded) > MAX_CONTEXT_BYTES:
            raise CodexPlannerError("This project and conversation are too large for one planning request. Shorten the planning context first.")
        status = self.status()
        if not status["available"]:
            raise CodexPlannerError(status["reason"])
        executable = _executable()
        if not executable:
            raise CodexPlannerError("Codex CLI is no longer available. Check its installation.")
        with tempfile.TemporaryDirectory(prefix="flowdesk-codex-plan-") as directory:
            schema_path = Path(directory, "response-schema.json")
            output_path = Path(directory, "response.json")
            schema = OUTPUT_SCHEMAS[generation["protocolVersion"]]
            schema_path.write_text(json.dumps(schema), encoding="utf-8")
            args = [executable, "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
                    "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "--json",
                    "--output-schema", str(schema_path), "--output-last-message", str(output_path)]
            for feature in DISABLED_FEATURES:
                args.extend(("--disable", feature))
            for config in CONFIG_OVERRIDES:
                args.extend(("-c", config))
            selection = generation["selection"]
            if selection["mode"] == "explicit":
                args.extend(("--model", selection["model"]))
                if selection["reasoningEffort"] is not None:
                    args.extend(("-c", "model_reasoning_effort=" + json.dumps(selection["reasoningEffort"])))
            # JSON string escaping is valid TOML basic-string syntax. This is an
            # argv element, never shell text, and contains only trusted policy.
            args.extend(("-c", "developer_instructions=" + json.dumps(generation["instructions"], ensure_ascii=False)))
            args.append("-")
            result = _run(args, cwd=directory, prompt=b"Planning context (task data):\n" + encoded,
                          timeout=self.timeout, cancel=cancel, output_path=output_path)
            if result.returncode:
                raise CodexPlannerError(_failure(result))
            try:
                with output_path.open("rb") as output:
                    raw = output.read(MAX_RESULT_BYTES + 1)
                if len(raw) > MAX_RESULT_BYTES:
                    raise ValueError
                value = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                _validate_shape(value, schema)
                if generation["protocolVersion"] >= 2:
                    from .planning_questions import validate_envelope
                    validate_envelope(value, generation["protocolVersion"])
                elif not value["message"].strip() or len(value["message"]) > 32768:
                    raise ValueError
                if value["proposal"] and value["proposal"]["diagramId"] != context.get("activeDiagramId"):
                    raise ValueError
            except (OSError, UnicodeError, ValueError, TypeError, RecursionError):
                raise CodexPlannerError("Codex returned an invalid planning response. Your diagram has not changed; try again.") from None
            return value
