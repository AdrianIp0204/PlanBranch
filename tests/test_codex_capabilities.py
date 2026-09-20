"""Model discovery tests use a synthetic stdio server, never Codex or credentials."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

from flowdesk import codex_capabilities as capabilities
from flowdesk import codex_planner as planner


def model(name="quick", efforts=("low", "high"), **extra):
    return {"id": "picker-" + name, "model": name, "displayName": name.title(), "description": "A test model",
            "defaultReasoningEffort": efforts[0] if efforts else None,
            "supportedReasoningEfforts": [{"reasoningEffort": effort, "description": effort.title()} for effort in efforts],
            "isDefault": name == "quick", "hidden": False, **extra}


def test_normalize_uses_invocation_model_and_dynamic_efforts():
    value = capabilities.normalize_models([model(), model("future", ("custom-effort",)), model("plain", ())])
    assert [entry["id"] for entry in value] == ["quick", "future", "plain"]
    assert value[1]["reasoningEfforts"] == [{"id": "custom-effort", "description": "Custom-Effort"}]
    assert value[2]["reasoningEfforts"] == [] and value[2]["defaultReasoningEffort"] is None


@pytest.mark.parametrize("rows", [[], None, [None], [model(), model()],
    [model(model='bad"\nnotify=[]')], [model(defaultReasoningEffort="absent")], [model(defaultReasoningEffort={})],
    [model(supportedReasoningEfforts=[{"reasoningEffort": "low"}, {"reasoningEffort": "low"}])],
    [model(inputModalities=None)], [model(hidden="false")]])
def test_normalize_rejects_malformed_catalogues(rows):
    with pytest.raises(capabilities.CatalogueError):
        capabilities.normalize_models(rows)


def test_normalize_excludes_hidden_and_non_text_models():
    assert [entry["id"] for entry in capabilities.normalize_models([
        model(), model("hidden", hidden=True), model("image", inputModalities=["image"])])] == ["quick"]


def test_cache_is_bounded_refreshable_and_defensive(monkeypatch):
    monkeypatch.setattr(planner, "_executable", lambda: "fake-codex")
    calls = []
    def probe(executable):
        calls.append(executable)
        return {"cliVersion": "0.144.1", "models": capabilities.normalize_models([model()])}
    monkeypatch.setattr(capabilities, "_probe", probe)
    catalogue = capabilities.CodexCapabilities()
    first = catalogue.get()
    assert first["status"] == "ready" and first["source"] == "cli_catalogue" and first["fetchedAt"]
    first["models"].clear()
    assert len(catalogue.get()["models"]) == 1 and len(calls) == 1
    catalogue.get(refresh=True)
    assert len(calls) == 2
    catalogue._at -= capabilities.CACHE_SECONDS + 1
    catalogue.get()
    assert len(calls) == 3


def test_discovery_failure_discards_stale_catalogue_and_sanitizes_error(monkeypatch):
    monkeypatch.setattr(planner, "_executable", lambda: "fake-codex")
    monkeypatch.setattr(capabilities, "_probe", lambda _: {"cliVersion": "0.144.1", "models": capabilities.normalize_models([model()])})
    catalogue = capabilities.CodexCapabilities()
    assert catalogue.get()["status"] == "ready"
    calls = []
    def failure(_):
        calls.append(True)
        raise OSError("private token and path")
    monkeypatch.setattr(capabilities, "_probe", failure)
    unavailable = catalogue.get(refresh=True)
    assert unavailable["status"] == "unavailable" and unavailable["models"] == []
    assert "private" not in unavailable["reason"]
    catalogue.get()
    assert len(calls) == 1
    catalogue._at -= capabilities.FAILURE_CACHE_SECONDS + 1
    catalogue.get()
    assert len(calls) == 2


def test_missing_cli_is_actionable_without_starting_process(monkeypatch):
    monkeypatch.setattr(planner, "_executable", lambda: None)
    monkeypatch.setattr(capabilities, "_probe", lambda _: pytest.fail("missing CLI was invoked"))
    result = capabilities.CodexCapabilities().get()
    assert result["status"] == "unavailable" and "Install" in result["reason"]


def test_metadata_command_keeps_current_home_credentials_out():
    args = capabilities._command("fake-codex")
    assert args[:3] == ["fake-codex", "app-server", "--stdio"]
    assert args[-4:] == ["-c", 'cli_auth_credentials_store="file"', "-c", 'sandbox_mode="read-only"']
    assert "--ignore-user-config" not in args  # Not supported by app-server 0.144.1.
    assert "thread/start" not in args and "turn/start" not in args


@pytest.fixture
def server(tmp_path, monkeypatch):
    script = tmp_path / "metadata_server.py"
    script.write_text('''import json, os, pathlib, sys, time
mode, record = sys.argv[1:]
home = pathlib.Path(os.environ["CODEX_HOME"])
assert list(home.iterdir()) == []
assert "CODEX_THREAD_ID" not in os.environ and "OPENAI_API_KEY" not in os.environ
methods = []
def send(value): print(json.dumps(value), flush=True)
def row(name):
    return {"id": "picker-" + name, "model": name, "displayName": name.title(), "description": "", "hidden": False,
      "isDefault": name == "quick", "defaultReasoningEffort": "low",
      "supportedReasoningEfforts": [{"reasoningEffort":"low","description":"Quick"}]}
for line in sys.stdin:
    req = json.loads(line); methods.append(req["method"])
    pathlib.Path(record).write_text(json.dumps({"methods":methods,"home":str(home),"cwd":os.getcwd()}))
    if mode == "timeout": time.sleep(30)
    if mode == "blocked_input":
        send({"id":req["id"],"result":{"userAgent":"flowdesk_catalogue/0.144.1 (test)"}})
        for number in range(2, 9):
            send({"id":number,"result":{"data":[row("model-" + str(number))],"nextCursor":str(number)+"x"*1800}})
        time.sleep(30)
    if mode == "overflow": print("x"*20000,flush=True); time.sleep(30)
    if mode == "stderr": sys.stderr.write("x"*20000);sys.stderr.flush();time.sleep(30)
    if mode == "malformed": print("not json",flush=True);time.sleep(30)
    if mode == "interaction": send({"id":999,"method":"tool/execute","params":{}});time.sleep(30)
    if mode == "error": send({"id":req["id"],"error":{"message":"private secret"}});continue
    if req["method"] == "initialize":
        send({"id":req["id"],"result":{"userAgent":"flowdesk_catalogue/0.144.1 (test)"}})
    elif req["method"] == "initialized": continue
    elif req["method"] == "model/list":
        assert req["params"]["includeHidden"] is False
        second = bool(req["params"].get("cursor"))
        send({"method":"remoteControl/status/changed","params":{}})
        send({"id":req["id"],"result":{"data":[row("plain" if second else "quick")],
          "nextCursor":"again" if mode == "pagination" or not second else None}})
    else: raise AssertionError("Unexpected method: " + req["method"])
if mode == "hang_exit": time.sleep(30)
''', encoding="utf-8")
    monkeypatch.setenv("CODEX_HOME", "do-not-use-real-auth-home")
    monkeypatch.setenv("CODEX_THREAD_ID", "do-not-use-session")
    monkeypatch.setenv("OPENAI_API_KEY", "do-not-use-secret")
    original = subprocess.Popen
    processes = []
    def capture(*args, **kwargs):
        if args[0][0] != sys.executable:
            return original(*args, **kwargs)  # Windows taskkill used by normal cleanup.
        assert kwargs["shell"] is False
        process = original(*args, **kwargs)
        processes.append(process)
        return process
    monkeypatch.setattr(capabilities.subprocess, "Popen", capture)
    def run(mode="good", **kwargs):
        record = tmp_path / (mode + ".json")
        monkeypatch.setattr(capabilities, "_command", lambda _: [sys.executable, "-u", str(script), mode, str(record)])
        return capabilities._probe(sys.executable, **kwargs), record, processes
    yield run
    for process in processes:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


def test_probe_paginates_without_credentials_turns_or_retained_home(server):
    result, record, processes = server()
    assert result["cliVersion"] == "0.144.1"
    assert [row["id"] for row in result["models"]] == ["quick", "plain"]
    observed = json.loads(record.read_text())
    assert observed["methods"] == ["initialize", "initialized", "model/list", "model/list"]
    assert not Path(observed["home"]).exists() and not Path(observed["cwd"]).exists()
    assert processes[0].poll() == 0


@pytest.mark.parametrize("mode,match", [("timeout", "timed out"), ("blocked_input", "timed out"), ("overflow", "too much"), ("stderr", "too much"),
    ("malformed", "invalid"), ("interaction", "unsupported interaction"), ("pagination", "pagination"), ("error", "protocol")])
def test_probe_bounds_and_sanitizes_failures(server, monkeypatch, mode, match):
    monkeypatch.setattr(capabilities, "MAX_OUTPUT_BYTES", 50000 if mode == "blocked_input" else 5000)
    started = time.monotonic()
    with pytest.raises(capabilities.CatalogueError, match=match) as caught:
        server(mode, timeout=.3 if mode in {"timeout", "blocked_input"} else 5)
    assert time.monotonic() - started < 8
    assert "private" not in str(caught.value) and "secret" not in str(caught.value)


def test_probe_stops_process_that_ignores_eof(server):
    started = time.monotonic()
    _, _, processes = server("hang_exit", timeout=5)
    assert time.monotonic() - started < 5
    assert processes[0].poll() is not None
