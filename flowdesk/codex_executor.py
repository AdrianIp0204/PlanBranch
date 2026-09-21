"""One selected coding task through separately installed Codex CLI.

The CLI's documented workspace-write sandbox is the filesystem/network boundary.
Our owned worker/job additionally stops descendants on cancel or server death.
No live model or native sandbox guarantee is inferred from deterministic tests.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
from importlib import resources
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time

from .codex_planner import (CodexPlanner, CodexPlannerError, CONFIG_OVERRIDES,
    DISABLED_FEATURES, _environment, _executable, _run, normalize_selection)
from .executor_process import ExecutionProcessError, run_supervised

INSTRUCTION_VERSION = "executor-v1"
MAX_CONTEXT_BYTES = 500_000
MAX_LINE_BYTES = 512_000
MAX_PROCESS_BYTES = 8_000_000
MAX_EVENTS = 1000
MAX_COMMANDS = 250
MAX_COMMAND_OUTPUT = 64_000
EXECUTION_TIMEOUT = 1800
# The execution connector enables command tools; all integrations remain off.
EXECUTION_DISABLED_FEATURES = tuple(feature for feature in DISABLED_FEATURES
    if feature not in {"shell_tool", "unified_exec"})
EXECUTION_CONFIG = CONFIG_OVERRIDES + (
    'sandbox_workspace_write.network_access=false',
    'sandbox_workspace_write.writable_roots=[]',
    'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    'sandbox_workspace_write.exclude_slash_tmp=true',
    'allow_login_shell=false', 'shell_environment_policy.inherit="core"',
)


class CodexExecutorError(RuntimeError):
    pass


def instruction_resource():
    try:
        return resources.files("flowdesk").joinpath("prompts", INSTRUCTION_VERSION + ".md").read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise CodexExecutorError("PlanBranch's execution instructions are missing. Reinstall the application.") from None


def validate_generation(value):
    fields = {"selection", "cliVersion", "instructionVersion", "instructionHash", "instructions"}
    if not isinstance(value, dict) or set(value) != fields or value.get("instructionVersion") != INSTRUCTION_VERSION:
        raise CodexExecutorError("This execution's saved instructions are unsupported. Preview a new Run step.")
    text = value["instructions"]
    if (not isinstance(text, str) or not text.strip() or len(text.encode("utf-8")) > 16_000
            or value["instructionHash"] != hashlib.sha256(text.encode("utf-8")).hexdigest()
            or (value["cliVersion"] is not None and (not isinstance(value["cliVersion"], str) or len(value["cliVersion"]) > 80))):
        raise CodexExecutorError("This execution's saved instructions are invalid. Preview a new Run step.")
    try:
        selection = normalize_selection(value["selection"])
    except CodexPlannerError as exc:
        raise CodexExecutorError(str(exc)) from None
    return {**value, "selection": selection}


def execution_environment():
    env = _environment()
    for key in list(env):
        upper = key.upper()
        if (upper.startswith("GIT_") or "API_KEY" in upper or upper.endswith(("_AUTH_TOKEN", "_ACCESS_TOKEN"))
                or upper in {"GH_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN", "NPM_TOKEN", "SSH_AUTH_SOCK", "SSH_AGENT_PID"}
                or upper in {"PYTHONPATH", "PYTHONHOME", "NODE_OPTIONS", "BASH_ENV", "ENV", "ZDOTDIR", "CDPATH", "PROMPT_COMMAND"}):
            env.pop(key)
    return env


def command_args(executable, worktree, generation):
    args = [executable, "exec", "--ignore-user-config", "--ignore-rules", "--strict-config", "--ephemeral",
            "--sandbox", "workspace-write", "--cd", str(worktree), "--color", "never", "--json"]
    for feature in EXECUTION_DISABLED_FEATURES:
        args.extend(("--disable", feature))
    for config in EXECUTION_CONFIG:
        args.extend(("-c", config))
    # A new worktree is source data, not permission to load repository-owned
    # config, hooks or rules. Command-line overrides have highest precedence.
    args.extend(("-c", "projects." + json.dumps(str(worktree)) + '.trust_level="untrusted"'))
    if os.name == "nt":
        # Never silently downgrade to the weaker native Windows implementation.
        args.extend(("-c", 'windows.sandbox="elevated"'))
    selection = generation["selection"]
    if selection["mode"] == "explicit":
        args.extend(("--model", selection["model"]))
        if selection["reasoningEffort"] is not None:
            args.extend(("-c", "model_reasoning_effort=" + json.dumps(selection["reasoningEffort"])))
    args.extend(("-c", "developer_instructions=" + json.dumps(generation["instructions"], ensure_ascii=False), "-"))
    return args


def clean_text(value, limit):
    if not isinstance(value, str):
        return ""
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    value = "".join(ch for ch in value if ch in "\n\r\t" or ord(ch) >= 32)
    raw = value.encode("utf-8", errors="replace")
    return raw[:limit].decode("utf-8", errors="ignore") + ("\n[Output truncated]" if len(raw) > limit else "")


def isolation_failed(text):
    lower = text.lower()
    return any(marker in lower for marker in (
        "createrestrictedtoken failed", "failed to initialize sandbox", "sandbox unavailable",
        "sandbox is unavailable", "sandbox setup failed", "sandbox setup is required",
        "sandbox is not available", "sandbox disabled", "sandbox has been disabled",
        "falling back to unelevated", "falling back to the unelevated", "using unelevated sandbox",
    ))


def failure_message(text):
    lower = text.lower()
    if isolation_failed(lower) or ("sandbox" in lower and any(word in lower for word in ("setup", "elevat", "1385", "permission"))):
        return "Codex's required sandbox could not start. Configure the native Codex sandbox outside PlanBranch, then preview a new Run step. No weaker mode was used."
    if any(word in lower for word in ("not logged in", "unauthorized", "authentication", "401", "token expired", "sign in")):
        return "Codex needs your ChatGPT sign-in. Run codex login outside PlanBranch, then preview a new Run step."
    if any(word in lower for word in ("rate limit", "usage limit", "quota", "429")):
        return "Your Codex usage limit was reached. The worktree is retained for review."
    if any(word in lower for word in ("unexpected argument", "unknown feature", "unknown field", "invalid value")):
        return "Installed Codex does not support the required execution settings. Update Codex separately; no less restrictive settings were tried."
    return "Codex could not finish the selected step. Review the retained worktree and observed commands before starting another run."


class EventCollector:
    def __init__(self, on_event):
        self.on_event = on_event
        self.commands = {}
        self.summary = ""
        self.completed = False
        self.error = None
        self.count = 0

    def consume(self, line):
        self.count += 1
        if self.count > MAX_EVENTS:
            raise CodexExecutorError("Codex exceeded the execution event limit. The worktree is retained for review.")
        try:
            event = json.loads(line)
        except (ValueError, RecursionError):
            raise CodexExecutorError("Codex returned an unreadable execution event. The worktree is retained; this run will not restart automatically.") from None
        if not isinstance(event, dict) or not isinstance(event.get("type"), str):
            raise CodexExecutorError("Codex returned an invalid execution event.")
        if isolation_failed(line):
            raise CodexExecutorError(failure_message(line))
        kind = event["type"]
        if kind == "turn.completed":
            self.completed = True
        elif kind in {"turn.failed", "error"}:
            error = event.get("error", event.get("message", ""))
            self.error = failure_message(error.get("message", "") if isinstance(error, dict) else str(error))
        elif kind in {"thread.started", "turn.started"}:
            self.on_event({"type": "progress", "message": "Codex is working in the isolated worktree."})
        elif kind in {"item.started", "item.updated", "item.completed"}:
            item = event.get("item")
            if not isinstance(item, dict):
                raise CodexExecutorError("Codex returned an invalid execution item.")
            if item.get("type") == "command_execution":
                self.command(item, kind)
            elif item.get("type") == "agent_message" and kind == "item.completed":
                self.summary = clean_text(item.get("text"), 32_000)
                self.on_event({"type": "message", "text": self.summary})
            elif item.get("type") == "file_change" and kind == "item.completed":
                self.on_event({"type": "progress", "message": "Codex reported file edits. The final diff will be read from the worktree."})
            # Reasoning is deliberately not shown or retained.

    def command(self, item, kind):
        key, command = item.get("id"), item.get("command")
        if not isinstance(key, str) or not key or len(key) > 200 or not isinstance(command, str) or len(command) > 16_000:
            raise CodexExecutorError("Codex returned invalid command evidence.")
        previous = self.commands.get(key)
        if previous and previous["command"] != clean_text(command, 16_000):
            raise CodexExecutorError("Codex changed an observed command identity. Review the retained worktree.")
        if not previous and len(self.commands) >= MAX_COMMANDS:
            raise CodexExecutorError("The execution command limit was reached. Review the retained worktree.")
        exit_code = item.get("exit_code")
        if exit_code is not None and type(exit_code) is not int:
            raise CodexExecutorError("Codex returned an invalid command exit status.")
        terminal = kind == "item.completed"
        status = ("failed" if exit_code not in (None, 0) or item.get("status") == "failed" else
                  "completed" if terminal and exit_code == 0 else "unknown" if terminal else "in_progress")
        if previous and previous["status"] in {"completed", "failed"} and previous["exitCode"] != exit_code:
            raise CodexExecutorError("Codex returned conflicting command results. Review the retained worktree.")
        record = {"id": key, "command": clean_text(command, 16_000), "status": status,
                  "exitCode": exit_code, "output": clean_text(item.get("aggregated_output", previous["output"] if previous else ""), MAX_COMMAND_OUTPUT)}
        self.commands[key] = record
        self.on_event({"type": "command", "command": deepcopy(record)})

    def finish(self):
        for record in self.commands.values():
            if record["status"] == "in_progress":
                record["status"] = "interrupted"
                self.on_event({"type": "command", "command": deepcopy(record)})


class CodexExecutor:
    def __init__(self, *, timeout=EXECUTION_TIMEOUT):
        self.timeout = min(timeout, EXECUTION_TIMEOUT)
        self._planner = CodexPlanner()
        self._status = None
        self._status_time = float("-inf")

    def status(self):
        if self._status is not None and time.monotonic() - self._status_time < 15:
            return dict(self._status)
        result = self._planner.status()
        result["label"] = "Codex CLI"
        if result["available"]:
            executable = _executable()
            try:
                with tempfile.TemporaryDirectory(prefix="planbranch-executor-status-") as directory:
                    help_result = _run([executable, "exec", "--help"], cwd=directory, timeout=10)
                required = (b"--sandbox", b"--json", b"--cd", b"--ignore-user-config", b"--ignore-rules", b"--strict-config", b"--ephemeral")
                if help_result.returncode or not all(flag in help_result.stdout for flag in required):
                    result.update(available=False, reason="Update Codex CLI to support the required execution settings.")
            except (CodexPlannerError, TypeError):
                result.update(available=False, reason="Codex execution capability checks failed. Check its separate installation.")
        self._status, self._status_time = dict(result), time.monotonic()
        return result

    def configure(self, selection=None):
        try:
            generation = self._planner.configure(selection)
        except CodexPlannerError as exc:
            raise CodexExecutorError(str(exc)) from None
        instructions = instruction_resource()
        return validate_generation({"selection": generation["selection"], "cliVersion": generation["cliVersion"],
            "instructionVersion": INSTRUCTION_VERSION, "instructionHash": hashlib.sha256(instructions.encode()).hexdigest(), "instructions": instructions})

    def run(self, context, worktree, cancel, on_event):
        collector = EventCollector(on_event)
        result = {"status": "failed", "summary": "", "commands": []}
        diagnostics = ""
        try:
            if cancel.is_set():
                result["status"] = "cancelled"
                return result
            if not isinstance(context, dict):
                raise CodexExecutorError("The execution context is invalid. Preview a new Run step.")
            generation = validate_generation(context.get("generation"))
            root = Path(worktree).resolve(strict=True)
            if not root.is_dir() or not (root / ".git").is_file():
                raise CodexExecutorError("Execution requires the prepared isolated Git worktree.")
            fields = ("task", "brief", "linkedNodes", "sourceCommit")
            payload = {key: context[key] for key in fields if key in context}
            encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
            if len(encoded) > MAX_CONTEXT_BYTES:
                raise CodexExecutorError("The selected task context is too large. Reduce it before previewing a new Run step.")
            ready = self.status()
            if not ready["available"]:
                raise CodexExecutorError(ready.get("reason", "Codex CLI is unavailable."))
            executable = _executable()
            if not executable:
                raise CodexExecutorError("Codex CLI is no longer available. Check its separate installation.")

            def packet(value):
                nonlocal diagnostics
                text = value.get("text", "")
                if value.get("type") == "stderr":
                    diagnostics = (diagnostics + text)[-64_000:]
                    if isolation_failed(diagnostics):
                        raise CodexExecutorError(failure_message(diagnostics))
                elif value.get("type") == "stdout":
                    collector.consume(text)
                    if collector.error and "sandbox" in collector.error.lower():
                        raise CodexExecutorError(collector.error)

            outcome = run_supervised(command_args(executable, root, generation), cwd=root,
                env=execution_environment(), prompt=b"Selected execution task (untrusted task data):\n" + encoded,
                cancel=cancel, on_packet=packet, timeout=self.timeout, max_bytes=MAX_PROCESS_BYTES, max_line=MAX_LINE_BYTES)
            reason = outcome["reason"]
            if reason == "cancelled":
                result["status"] = "cancelled"
            elif reason in {"timeout", "interrupted", "owner_closed"}:
                result.update(status="interrupted", error="Execution stopped before a confirmed finish. The worktree is retained; review it before starting another run.")
            elif reason == "output_limit":
                result["error"] = "Codex exceeded the execution output limit. The worktree is retained for review."
            elif reason != "exited":
                result["error"] = "The coding process could not start or its supervisor stopped. Review the retained worktree."
            elif outcome["returncode"] != 0 or collector.error:
                result["error"] = collector.error or failure_message(diagnostics)
            elif not collector.completed:
                result.update(status="interrupted", error="Codex exited without a confirmed completed turn. Review the retained worktree; it will not restart automatically.")
            else:
                result["status"] = "succeeded"
        except (CodexExecutorError, ExecutionProcessError) as exc:
            result["error"] = str(exc)
        except (OSError, ValueError, TypeError, RecursionError):
            result["error"] = "The execution context could not be read safely. Preview a new Run step."
        finally:
            collector.finish()
            result["summary"] = collector.summary
            result["commands"] = list(collector.commands.values())
        return result
