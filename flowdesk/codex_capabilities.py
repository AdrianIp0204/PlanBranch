"""Bounded, credential-free discovery of the installed Codex CLI catalogue.

The short-lived app-server uses a new CODEX_HOME, because app-server lacks
exec's --ignore-user-config flag and empty table overrides do not remove user
MCP entries. This catalogue describes CLI capabilities, not account access.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
import time


PROBE_TIMEOUT = 15
MAX_OUTPUT_BYTES = 2_000_000
MAX_MODELS = 100
MAX_PAGES = 10
CACHE_SECONDS = 300
FAILURE_CACHE_SECONDS = 30
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}\Z")


class CatalogueError(RuntimeError):
    """A bounded discovery failure with no raw diagnostics."""


def _string(value, limit, *, empty=False):
    return isinstance(value, str) and len(value) <= limit and (empty or bool(value.strip()))


def normalize_models(rows):
    if not isinstance(rows, list) or not rows or len(rows) > MAX_MODELS:
        raise CatalogueError("Codex returned an invalid model catalogue. Update Codex CLI or use CLI default.")
    result = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise CatalogueError("Codex returned an invalid model catalogue.")
        model = row.get("model")
        efforts = row.get("supportedReasoningEfforts")
        default = row.get("defaultReasoningEffort")
        if (not isinstance(model, str) or not IDENTIFIER.fullmatch(model) or model in seen
                or not _string(row.get("displayName"), 200) or not _string(row.get("description", ""), 2000, empty=True)
                or type(row.get("isDefault")) is not bool or not isinstance(efforts, list) or len(efforts) > 20):
            raise CatalogueError("Codex returned an invalid model catalogue.")
        normalized_efforts = []
        effort_ids = set()
        for effort in efforts:
            if (not isinstance(effort, dict) or not isinstance(effort.get("reasoningEffort"), str)
                    or not IDENTIFIER.fullmatch(effort["reasoningEffort"]) or effort["reasoningEffort"] in effort_ids
                    or not _string(effort.get("description", ""), 2000, empty=True)):
                raise CatalogueError("Codex returned invalid reasoning choices.")
            effort_ids.add(effort["reasoningEffort"])
            normalized_efforts.append({"id": effort["reasoningEffort"], "description": effort.get("description", "")})
        if efforts and (not isinstance(default, str) or default not in effort_ids):
            raise CatalogueError("Codex returned an unsupported default reasoning choice.")
        modalities = row.get("inputModalities", ["text", "image"])
        if (not isinstance(modalities, list) or not all(isinstance(value, str) for value in modalities)
                or ("hidden" in row and type(row["hidden"]) is not bool)):
            raise CatalogueError("Codex returned invalid model capabilities.")
        seen.add(model)
        # Requests ask for visible models. Defensively omit hidden/non-text entries.
        if row.get("hidden") is True or "text" not in modalities:
            continue
        result.append({"id": model, "label": row["displayName"], "description": row.get("description", ""),
                       "defaultReasoningEffort": default if efforts else None,
                       "reasoningEfforts": normalized_efforts, "isDefault": row["isDefault"]})
    if not result:
        raise CatalogueError("Codex did not advertise any text models. Use CLI default or update Codex CLI.")
    return result


def _command(executable):
    from .codex_planner import CONFIG_OVERRIDES, DISABLED_FEATURES
    args = [executable, "app-server", "--stdio"]
    for feature in DISABLED_FEATURES:
        args.extend(("--disable", feature))
    for config in CONFIG_OVERRIDES:
        args.extend(("-c", config))
    # Never consult the normal credential store for this metadata-only process.
    args.extend(("-c", 'cli_auth_credentials_store="file"', "-c", 'sandbox_mode="read-only"'))
    return args


def _probe(executable, *, timeout=PROBE_TIMEOUT):
    from .codex_planner import _environment, _stop
    with tempfile.TemporaryDirectory(prefix="flowdesk-codex-catalogue-") as directory:
        root = Path(directory)
        isolated_home = root / "home"
        isolated_home.mkdir()
        env = _environment()
        env["CODEX_HOME"] = str(isolated_home)
        try:
            process = subprocess.Popen(_command(executable), cwd=root, env=env, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                start_new_session=os.name != "nt")
        except OSError:
            raise CatalogueError("Codex model discovery could not start. Check the CLI installation or use CLI default.") from None
        inbox = queue.Queue()
        overflow = threading.Event()
        malformed = threading.Event()
        write_failed = threading.Event()
        outgoing = queue.Queue()
        deadline = time.monotonic() + timeout

        def read_output():
            total = 0
            try:
                while line := process.stdout.readline(MAX_OUTPUT_BYTES + 1):
                    total += len(line)
                    if total > MAX_OUTPUT_BYTES or not line.endswith(b"\n"):
                        overflow.set()
                        return
                    try:
                        value = json.loads(line)
                    except (ValueError, UnicodeError, RecursionError):
                        malformed.set()
                        return
                    if not isinstance(value, dict):
                        malformed.set()
                        return
                    inbox.put(value)
            finally:
                process.stdout.close()

        def drain_errors():
            total = 0
            try:
                while chunk := process.stderr.read(4096):
                    total += len(chunk)
                    if total > MAX_OUTPUT_BYTES:
                        overflow.set()
                        return
            finally:
                process.stderr.close()

        def write_input():
            try:
                while (packet := outgoing.get()) is not None:
                    process.stdin.write(packet)
                    process.stdin.flush()
            except (BrokenPipeError, OSError, ValueError):
                write_failed.set()
            finally:
                try:
                    process.stdin.close()
                except OSError:
                    pass

        readers = [threading.Thread(target=read_output, daemon=True), threading.Thread(target=drain_errors, daemon=True),
                   threading.Thread(target=write_input, daemon=True)]
        for reader in readers:
            reader.start()
        request_id = 0

        def send(value):
            # A peer that stops reading cannot block the deadline on pipe writes.
            outgoing.put(json.dumps(value).encode("utf-8") + b"\n")

        def request(method, params):
            nonlocal request_id
            request_id += 1
            send({"id": request_id, "method": method, "params": params})
            while True:
                if write_failed.is_set():
                    raise CatalogueError("Codex model discovery stopped unexpectedly. Update Codex CLI or use CLI default.")
                if overflow.is_set():
                    raise CatalogueError("Codex model discovery returned too much data. Use CLI default or update Codex CLI.")
                if malformed.is_set():
                    raise CatalogueError("Codex returned an invalid discovery response. Use CLI default or update Codex CLI.")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CatalogueError("Codex model discovery timed out. Retry or use CLI default.")
                try:
                    message = inbox.get(timeout=min(.1, remaining))
                except queue.Empty:
                    if process.poll() is not None:
                        raise CatalogueError("Codex model discovery stopped unexpectedly. Update Codex CLI or use CLI default.")
                    continue
                # No server request is authorized in a metadata-only session.
                if "method" in message:
                    if "id" in message:
                        raise CatalogueError("Codex discovery requested an unsupported interaction. Use CLI default.")
                    continue
                if message.get("id") != request_id or "error" in message or "result" not in message:
                    raise CatalogueError("Codex does not support this discovery protocol. Update Codex CLI or use CLI default.")
                return message["result"]

        try:
            initialized = request("initialize", {"clientInfo": {"name": "flowdesk_catalogue", "version": "0.1.0"}})
            if not isinstance(initialized, dict):
                raise CatalogueError("Codex returned an invalid discovery response.")
            agent = initialized.get("userAgent", "")
            version = re.search(r"/([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)", agent) if isinstance(agent, str) else None
            send({"method": "initialized", "params": {}})
            models = []
            cursors = set()
            cursor = None
            for _ in range(MAX_PAGES):
                page = request("model/list", {"limit": 20, "includeHidden": False, **({"cursor": cursor} if cursor else {})})
                if not isinstance(page, dict) or not isinstance(page.get("data"), list):
                    raise CatalogueError("Codex returned an invalid model catalogue.")
                models.extend(page["data"])
                if len(models) > MAX_MODELS:
                    raise CatalogueError("Codex model catalogue exceeded the supported size.")
                cursor = page.get("nextCursor")
                if cursor is None:
                    return {"cliVersion": version[1] if version else None, "models": normalize_models(models)}
                if not _string(cursor, 2000) or cursor in cursors:
                    raise CatalogueError("Codex returned invalid catalogue pagination.")
                cursors.add(cursor)
            raise CatalogueError("Codex model catalogue exceeded the supported page count.")
        finally:
            outgoing.put(None)
            try:
                process.wait(timeout=min(1, max(.01, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                _stop(process)
            for reader in readers:
                reader.join(timeout=1)


class CodexCapabilities:
    def __init__(self):
        self._lock = threading.Lock()
        self._value = None
        self._at = float("-inf")

    def get(self, refresh=False):
        from .codex_planner import _executable
        with self._lock:
            ttl = CACHE_SECONDS if self._value and self._value["status"] == "ready" else FAILURE_CACHE_SECONDS
            if not refresh and self._value is not None and time.monotonic() - self._at < ttl:
                return deepcopy(self._value)
            result = {"status": "unavailable", "source": "cli_catalogue", "cliVersion": None,
                      "fetchedAt": None, "models": []}
            executable = _executable()
            if not executable:
                result["reason"] = "Install Codex CLI to discover models. Planning still requires your CLI sign-in."
            else:
                try:
                    discovered = _probe(executable)
                    result.update(discovered, status="ready", fetchedAt=datetime.now(timezone.utc).isoformat())
                except (CatalogueError, OSError, ValueError) as exc:
                    result["reason"] = str(exc) if isinstance(exc, CatalogueError) else "Codex model discovery failed. Retry or use CLI default."
            self._value, self._at = result, time.monotonic()
            return deepcopy(result)
