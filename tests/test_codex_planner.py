"""Connector tests never contact OpenAI or use real CLI credentials."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

import pytest

from flowdesk import codex_planner as adapter


@pytest.fixture
def context():
    return {"content": {"schemaVersion": 1, "name": "Synthetic plan", "diagrams": [
        {"id": "diagram-1", "name": "Plan", "nodes": [], "edges": []}]},
        "activeDiagramId": "diagram-1", "nodeId": None,
        "messages": [{"role": "user", "body": "Help me plan a short example."}], "comments": []}


@pytest.fixture
def ready(monkeypatch):
    monkeypatch.setattr(adapter, "_executable", lambda: "fake-codex")
    planner = adapter.CodexPlanner(timeout=7)
    monkeypatch.setattr(planner, "status", lambda: {"available": True, "label": "Codex CLI"})
    return planner


def fake_response(monkeypatch, response):
    def run(args, **kwargs):
        kwargs["output_path"].write_text(json.dumps(response), encoding="utf-8")
        return adapter._Result(0, b"", b"")
    monkeypatch.setattr(adapter, "_run", run)


def test_missing_cli_is_actionable_and_cached(monkeypatch):
    calls = []
    monkeypatch.setattr(adapter, "_executable", lambda: calls.append(True))
    planner = adapter.CodexPlanner()
    first = planner.status()
    assert not first["available"] and first["label"] == "Codex CLI"
    assert "Install Codex CLI" in first["reason"]
    first["available"] = True
    assert planner.status()["available"] is False
    assert len(calls) == 1


@pytest.mark.parametrize("login,expected", [
    (adapter._Result(0, b"", b"Logged in using ChatGPT"), True),
    (adapter._Result(1, b"", b"Not logged in"), False),
    (adapter._Result(0, b"", b"Logged in using an API key: sk-secret"), False),
])
def test_status_auth_uses_cli_only_and_hides_diagnostics(monkeypatch, login, expected):
    monkeypatch.setattr(adapter, "_executable", lambda: "fake-codex")
    calls = []
    help_text = b"--ignore-user-config --ignore-rules --ephemeral --output-schema"

    def run(args, **kwargs):
        calls.append((args, kwargs["cwd"]))
        return adapter._Result(0, help_text, b"") if "--help" in args else login

    monkeypatch.setattr(adapter, "_run", run)
    planner = adapter.CodexPlanner()
    result = planner.status()
    assert result["available"] is expected
    assert "secret" not in str(result)
    assert len(calls) == 2 and calls[1][0][1:3] == ["login", "status"]
    assert not Path(calls[0][1]).exists()
    planner.status()
    assert len(calls) == 2
    planner._status_time -= adapter.STATUS_TTL + 1
    planner.status()
    assert len(calls) == 4


def test_status_rejects_unsupported_cli_without_login(monkeypatch):
    monkeypatch.setattr(adapter, "_executable", lambda: "fake-codex")
    monkeypatch.setattr(adapter, "_run", lambda *args, **kwargs: adapter._Result(0, b"old help", b"private details"))
    result = adapter.CodexPlanner().status()
    assert result["available"] is False and "Update" in result["reason"]
    assert "private details" not in str(result)


def test_generate_isolated_read_only_arguments_and_stdin(ready, context, monkeypatch):
    observed = {}
    original = copy.deepcopy(context)
    context["sourceRoot"] = "private-source-folder"
    context["omittedMessageCount"] = 5
    context["omittedResolvedCommentCount"] = 2

    def run(args, **kwargs):
        observed.update(kwargs, args=args)
        assert kwargs["timeout"] == 7
        assert args[-1] == "-"
        assert "--ignore-user-config" in args and "--ignore-rules" in args and "--ephemeral" in args
        assert args[args.index("--sandbox") + 1] == "read-only"
        assert 'approval_policy="never"' in args
        assert 'forced_login_method="chatgpt"' in args
        for feature in adapter.DISABLED_FEATURES:
            assert any(args[i:i + 2] == ["--disable", feature] for i in range(len(args) - 1))
        assert b"private-source-folder" not in kwargs["prompt"]
        assert b"Help me plan" in kwargs["prompt"]
        assert b'"omittedMessageCount": 5' in kwargs["prompt"]
        assert b'"omittedResolvedCommentCount": 2' in kwargs["prompt"]
        assert "Help me plan" not in str(args)
        schema = json.loads(Path(args[args.index("--output-schema") + 1]).read_text())
        assert schema == adapter.OUTPUT_SCHEMA
        kwargs["output_path"].write_text('{"message":"What should this step produce?","proposal":null}', encoding="utf-8")
        return adapter._Result(0, b"", b"")

    monkeypatch.setattr(adapter, "_run", run)
    assert ready.generate(context) == {"message": "What should this step produce?", "proposal": None}
    assert context["content"] == original["content"]
    assert not Path(observed["cwd"]).exists()


def test_complete_single_diagram_proposal_is_returned_without_applying(ready, context, monkeypatch):
    proposal = {"title": "Add a first step", "summary": "Describe an expected result.",
                "diagramId": "diagram-1", "nodes": [{
                    "id": "new-node", "type": "process", "title": "Describe the outcome", "position": {"x": 0, "y": 0},
                    **{key: "" for key in ("description", "notes", "pseudocode", "targetFile", "targetScope", "why", "alternatives", "blocker")},
                    "status": "not_started", "checklist": []}], "edges": []}
    fake_response(monkeypatch, {"message": "Here is a proposed first step.", "proposal": proposal})
    result = ready.generate(context)
    assert result["proposal"] == proposal
    assert context["content"]["diagrams"][0]["nodes"] == []


@pytest.mark.parametrize("response", [
    {"message": "", "proposal": None},
    {"message": "ok", "proposal": None, "execute": True},
    {"message": "ok", "proposal": {"title": "Change", "summary": "", "diagramId": "other", "nodes": [], "edges": []}},
    {"message": "ok", "proposal": {"title": "Change", "summary": "", "diagramId": "diagram-1", "nodes": [{"id": "incomplete"}], "edges": []}},
    {"message": "ok", "proposal": {"title": "Change", "summary": "", "diagramId": "diagram-1", "nodes": [], "edges": [{"id": "e", "source": "a", "target": "b", "label": "", "sourceHandle": False, "targetHandle": None}]}},
])
def test_malformed_or_cross_diagram_response_is_not_accepted(ready, context, monkeypatch, response):
    fake_response(monkeypatch, response)
    with pytest.raises(adapter.CodexPlannerError, match="invalid planning response"):
        ready.generate(context)


@pytest.mark.parametrize("raw", [b"not JSON", b'{"message":"ok","proposal":NaN}', b'\xff', b""])
def test_raw_invalid_output_is_hidden(ready, context, monkeypatch, raw):
    def run(args, **kwargs):
        kwargs["output_path"].write_bytes(raw)
        return adapter._Result(0, b"", b"")
    monkeypatch.setattr(adapter, "_run", run)
    with pytest.raises(adapter.CodexPlannerError, match="invalid planning response"):
        ready.generate(context)


def test_missing_output_is_an_error_not_stdout_fallback(ready, context, monkeypatch):
    monkeypatch.setattr(adapter, "_run", lambda *a, **k: adapter._Result(0, b'{"message":"looks valid","proposal":null}', b""))
    with pytest.raises(adapter.CodexPlannerError, match="invalid planning response"):
        ready.generate(context)


@pytest.mark.parametrize("diagnostic,expected", [
    (b"401 unauthorized sk-secret", "sign-in"),
    (b"429 rate limit for user-private", "usage limit"),
    (b"unknown feature private-setting", "Update Codex"),
    (b"private filesystem path and token", "connection"),
])
def test_cli_failure_is_sanitized(ready, context, monkeypatch, diagnostic, expected):
    monkeypatch.setattr(adapter, "_run", lambda *a, **k: adapter._Result(1, b"", diagnostic))
    with pytest.raises(adapter.CodexPlannerError) as caught:
        ready.generate(context)
    assert expected in str(caught.value)
    assert "private" not in str(caught.value) and "secret" not in str(caught.value)


def test_context_and_result_size_limits(ready, context, monkeypatch):
    context["content"]["notes"] = "x" * adapter.MAX_CONTEXT_BYTES
    with pytest.raises(adapter.CodexPlannerError, match="too large"):
        ready.generate(context)
    context["content"]["notes"] = "small"
    monkeypatch.setattr(adapter, "MAX_RESULT_BYTES", 20)
    fake_response(monkeypatch, {"message": "A response larger than twenty bytes", "proposal": None})
    with pytest.raises(adapter.CodexPlannerError, match="invalid planning response"):
        ready.generate(context)


def test_precancelled_request_does_not_probe_cli(ready, context, monkeypatch):
    monkeypatch.setattr(ready, "status", lambda: pytest.fail("cancelled request probed CLI"))
    event = threading.Event()
    event.set()
    with pytest.raises(adapter.CodexPlannerError, match="cancelled"):
        ready.generate(context, event)


def test_environment_does_not_inherit_api_or_parent_session_overrides(monkeypatch):
    monkeypatch.setenv("CODEX_HOME", "/existing-auth-store")
    monkeypatch.setenv("CODEX_API_KEY", "secret")
    monkeypatch.setenv("CODEX_THREAD_ID", "private-session")
    monkeypatch.setenv("OPENAI_API_KEY", "secret")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://unrelated.example")
    env = adapter._environment()
    assert env["CODEX_HOME"] == "/existing-auth-store"
    assert not any(key in env for key in ("CODEX_API_KEY", "CODEX_THREAD_ID", "OPENAI_API_KEY", "OPENAI_BASE_URL"))
    assert os.environ["CODEX_API_KEY"] == "secret"


def test_process_runner_passes_stdin_without_shell(tmp_path):
    result = adapter._run([sys.executable, "-c", "import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())"],
                          cwd=tmp_path, prompt=b'$(ignored) "literal"', timeout=5)
    assert result.returncode == 0 and result.stdout == b'$(ignored) "literal"'


@pytest.mark.parametrize("mode", ["timeout", "cancel", "overflow"])
def test_process_runner_stops_bounded_requests(tmp_path, monkeypatch, mode):
    cancel = threading.Event()
    code = "import time;time.sleep(30)"
    if mode == "overflow":
        monkeypatch.setattr(adapter, "MAX_PROCESS_BYTES", 100)
        code = "import sys,time;sys.stdout.write('x'*10000);sys.stdout.flush();time.sleep(30)"
    if mode == "cancel":
        timer = threading.Timer(0.2, cancel.set)
        timer.start()
    started = time.monotonic()
    with pytest.raises(adapter.CodexPlannerError, match={"timeout": "too long", "cancel": "cancelled", "overflow": "too much"}[mode]):
        adapter._run([sys.executable, "-c", code], cwd=tmp_path, timeout=0.3 if mode == "timeout" else 5, cancel=cancel)
    assert time.monotonic() - started < 8


@pytest.mark.skipif(os.name != "nt", reason="Windows npm shim layout")
def test_windows_npm_shim_resolves_to_native_binary_without_shell(tmp_path, monkeypatch):
    shim = tmp_path / "codex.cmd"
    shim.write_text("must not execute")
    binary = tmp_path / "node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"fake")
    monkeypatch.setattr(adapter.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(adapter.shutil, "which", lambda _: str(shim))
    assert adapter._executable() == str(binary)
