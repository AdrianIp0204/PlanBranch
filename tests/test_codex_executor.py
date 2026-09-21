"""Deterministic executables only: no live Codex, sign-in or user repository."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

import pytest

from flowdesk import codex_executor as adapter
from flowdesk import executor_process as process_adapter


def generation():
    instructions = adapter.instruction_resource()
    return {"selection": {"mode": "default"}, "cliVersion": "test-1",
            "instructionVersion": "executor-v1", "instructions": instructions,
            "instructionHash": hashlib.sha256(instructions.encode()).hexdigest()}


@pytest.fixture
def context():
    return {"generation": generation(), "task": {"id": "one", "title": "Implement one result", "acceptanceChecks": []},
            "brief": {"goal": "Keep the tool local"}, "linkedNodes": [], "sourceCommit": "a" * 40,
            "credentials": "must-not-cross-boundary", "sourceRoot": "must-not-cross-boundary"}


@pytest.fixture
def worktree(tmp_path):
    root = tmp_path / "owned-worktree"
    root.mkdir()
    (root / ".git").write_text("gitdir: test-only-pointer\n", encoding="utf-8")
    return root


def fake_executor(tmp_path, monkeypatch, script, timeout=10):
    executable = tmp_path / "fake-executor.py"
    executable.write_text(script, encoding="utf-8")
    executor = adapter.CodexExecutor(timeout=timeout)
    monkeypatch.setattr(executor, "status", lambda: {"available": True, "label": "Deterministic fixture"})
    monkeypatch.setattr(adapter, "_executable", lambda: sys.executable)
    monkeypatch.setattr(adapter, "command_args", lambda *_: [sys.executable, "-I", str(executable)])
    return executor


def event(kind, **values):
    return json.dumps({"type": kind, **values})


def test_configuration_freezes_separate_policy_and_validates_selection(monkeypatch):
    executor = adapter.CodexExecutor()
    received = []
    def configure(selection):
        received.append(selection)
        return {"selection": selection, "cliVersion": "0.test", "instructions": "planning only", "protocolVersion": 4}
    monkeypatch.setattr(executor._planner, "configure", configure)
    selection = {"mode": "explicit", "model": "fixture-model", "reasoningEffort": "high"}
    value = executor.configure(selection)
    assert received == [selection]
    assert set(value) == {"selection", "cliVersion", "instructionVersion", "instructionHash", "instructions"}
    assert value["instructionVersion"] == "executor-v1"
    assert "one explicitly selected" in value["instructions"]
    assert "Do not commit" in value["instructions"]
    assert adapter.validate_generation(value) == value
    with pytest.raises(adapter.CodexExecutorError, match="invalid"):
        adapter.validate_generation({**value, "instructions": "replace policy"})
    with pytest.raises(adapter.CodexExecutorError, match="unsupported"):
        adapter.validate_generation({**value, "instructionVersion": "planner-v5"})


def test_command_has_fixed_sandbox_no_integrations_or_permission_bypass(worktree):
    saved = generation()
    saved["selection"] = {"mode": "explicit", "model": "fixture-model", "reasoningEffort": "high"}
    args = adapter.command_args("native-codex", worktree, saved)
    assert args[:2] == ["native-codex", "exec"]
    assert args[args.index("--sandbox") + 1] == "workspace-write"
    assert args[args.index("--cd") + 1] == str(worktree)
    assert args[args.index("--model") + 1] == "fixture-model"
    assert all(flag in args for flag in ("--ignore-user-config", "--ignore-rules", "--strict-config", "--json", "--ephemeral"))
    assert not any(flag in args for flag in ("--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--add-dir", "--skip-git-repo-check"))
    assert 'approval_policy="never"' in args
    assert 'sandbox_workspace_write.network_access=false' in args
    assert 'sandbox_workspace_write.writable_roots=[]' in args
    assert 'projects.' + json.dumps(str(worktree)) + '.trust_level="untrusted"' in args
    assert 'sandbox_workspace_write.exclude_tmpdir_env_var=true' in args
    assert 'sandbox_workspace_write.exclude_slash_tmp=true' in args
    assert 'allow_login_shell=false' in args
    disabled = [args[i + 1] for i, arg in enumerate(args[:-1]) if arg == "--disable"]
    assert all(feature in disabled for feature in ("hooks", "plugins", "apps", "multi_agent", "browser_use", "shell_snapshot"))
    assert "shell_tool" not in disabled and "unified_exec" not in disabled
    if os.name == "nt":
        assert 'windows.sandbox="elevated"' in args
        assert not any('sandbox="unelevated"' in arg for arg in args)


def test_execution_environment_retains_auth_location_without_keys_or_injected_startup(monkeypatch):
    values = {"CODEX_HOME": "existing-auth-location", "CODEX_API_KEY": "secret", "OPENAI_API_KEY": "secret",
              "OTHER_API_KEY": "secret", "SERVICE_ACCESS_TOKEN": "secret", "CODEX_THREAD_ID": "host-thread",
              "GIT_DIR": "original-checkout", "GIT_CONFIG_COUNT": "1", "PYTHONPATH": "repo-injection",
              "BASH_ENV": "startup-hook", "NODE_OPTIONS": "--require=hook.js", "GH_TOKEN": "secret", "SSH_AUTH_SOCK": "agent"}
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    actual = adapter.execution_environment()
    assert actual["CODEX_HOME"] == values["CODEX_HOME"]
    assert not (set(values) - {"CODEX_HOME"}).intersection(actual)


def test_jsonl_command_evidence_is_independent_of_agent_claims(tmp_path, worktree, context, monkeypatch):
    script = '''import json, pathlib, sys
data=json.loads(sys.stdin.read().split("\\n",1)[1])
assert set(data)=={"task","brief","linkedNodes","sourceCommit"}
pathlib.Path("task.txt").write_text("one selected task",encoding="utf8")
def emit(value): print(json.dumps(value),flush=True)
emit({"type":"turn.started"})
emit({"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"python -m unittest","status":"in_progress"}})
emit({"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","command":"python -m unittest","status":"completed","exit_code":1,"aggregated_output":"FAILED: expected a stored result"}})
emit({"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"All tests passed (an intentionally wrong fixture claim)."}})
emit({"type":"turn.completed"})
'''
    executor = fake_executor(tmp_path, monkeypatch, script)
    events = []
    outside = worktree.parent / "original.txt"
    outside.write_text("unchanged")
    result = executor.run(context, str(worktree), threading.Event(), events.append)
    assert result["status"] == "succeeded", result
    assert result["commands"] == [{"id": "cmd-1", "command": "python -m unittest", "status": "failed", "exitCode": 1, "output": "FAILED: expected a stored result"}]
    assert "All tests passed" in result["summary"]
    assert [entry["command"]["status"] for entry in events if entry["type"] == "command"] == ["in_progress", "failed"]
    assert (worktree / "task.txt").read_text() == "one selected task"
    assert outside.read_text() == "unchanged"


def test_no_command_evidence_is_invented_from_summary():
    events = []
    collector = adapter.EventCollector(events.append)
    collector.consume(event("item.completed", item={"type": "agent_message", "id": "one", "text": "pytest passed: 15 tests"}))
    collector.consume(event("item.completed", item={"type": "reasoning", "id": "private", "text": "do not expose this"}))
    collector.consume(event("turn.completed"))
    assert collector.commands == {}
    assert len(events) == 1 and events[0]["type"] == "message"


@pytest.mark.parametrize("tail,expected", [
    ('print("not json",flush=True)', "failed"),
    ('print("x"*520000,flush=True)', "failed"),
    ('pass', "interrupted"),
    ('import time; time.sleep(10)', "interrupted"),
])
def test_malformed_overflow_uncertain_exit_and_timeout_are_not_success(tmp_path, worktree, context, monkeypatch, tail, expected):
    executor = fake_executor(tmp_path, monkeypatch, "import sys\nsys.stdin.read()\n" + tail, timeout=.3 if "sleep" in tail else 10)
    result = executor.run(context, str(worktree), threading.Event(), lambda _: None)
    assert result["status"] == expected
    assert result.get("error")


def test_cancellation_stops_owned_child_and_keeps_observed_command(tmp_path, worktree, context, monkeypatch):
    script = '''import json, pathlib, sys, time
sys.stdin.read()
print(json.dumps({"type":"item.started","item":{"type":"command_execution","id":"running","command":"long check","status":"in_progress"}}),flush=True)
time.sleep(5)
pathlib.Path("must-not-exist").write_text("too late")
'''
    executor = fake_executor(tmp_path, monkeypatch, script)
    cancel = threading.Event()
    def observe(event):
        if event["type"] == "command":
            cancel.set()
    result = executor.run(context, str(worktree), cancel, observe)
    assert result["status"] == "cancelled"
    assert result["commands"][0]["status"] == "interrupted"
    assert result["commands"][0]["exitCode"] is None
    assert not (worktree / "must-not-exist").exists()


def test_explicit_sandbox_failure_stops_without_retry_or_fallback(tmp_path, worktree, context, monkeypatch):
    script = '''import pathlib, sys, time
sys.stdin.read()
sys.stderr.write("Sandbox setup failed: CreateRestrictedToken failed: 87\\n");sys.stderr.flush()
time.sleep(5)
pathlib.Path("unsafe-fallback").write_text("never")
'''
    executor = fake_executor(tmp_path, monkeypatch, script)
    result = executor.run(context, str(worktree), threading.Event(), lambda _: None)
    assert result["status"] == "failed"
    assert "sandbox" in result["error"] and "outside PlanBranch" in result["error"]
    assert not (worktree / "unsafe-fallback").exists()


def test_structured_sandbox_downgrade_warning_is_fatal():
    collector = adapter.EventCollector(lambda _: None)
    with pytest.raises(adapter.CodexExecutorError, match="No weaker mode was used"):
        collector.consume(event("warning", message="Falling back to unelevated sandbox"))


def test_invalid_context_or_ordinary_checkout_never_reaches_cli(worktree, context, monkeypatch):
    executor = adapter.CodexExecutor()
    monkeypatch.setattr(executor, "status", lambda: pytest.fail("No CLI check is needed for invalid execution context"))
    result = executor.run(None, str(worktree), threading.Event(), lambda _: None)
    assert result["status"] == "failed" and "context" in result["error"]
    (worktree / ".git").unlink()
    (worktree / ".git").mkdir()
    result = executor.run(context, str(worktree), threading.Event(), lambda _: None)
    assert result["status"] == "failed" and "isolated Git worktree" in result["error"]


def test_missing_required_cli_capability_disables_run_without_claiming_sandbox_verification(monkeypatch):
    from types import SimpleNamespace
    executor = adapter.CodexExecutor()
    monkeypatch.setattr(executor._planner, "status", lambda: {"available": True, "label": "Codex CLI"})
    monkeypatch.setattr(adapter, "_executable", lambda: "fixture-cli")
    monkeypatch.setattr(adapter, "_run", lambda *a, **k: SimpleNamespace(returncode=0, stdout=b"--sandbox --json --cd --ignore-user-config --ignore-rules --ephemeral"))
    status = executor.status()
    assert not status["available"] and "Update" in status["reason"]


def test_forged_command_completion_does_not_overwrite_observed_failure():
    collector = adapter.EventCollector(lambda _: None)
    item = {"type": "command_execution", "id": "c", "command": "test", "status": "completed", "exit_code": 1}
    collector.consume(event("item.completed", item=item))
    with pytest.raises(adapter.CodexExecutorError, match="conflicting"):
        collector.consume(event("item.completed", item={**item, "exit_code": 0}))
    assert collector.commands["c"]["exitCode"] == 1


def test_output_truncation_and_event_limit_are_bounded(monkeypatch):
    collector = adapter.EventCollector(lambda _: None)
    item = {"type": "command_execution", "id": "c", "command": "test", "status": "completed", "exit_code": 0, "aggregated_output": "x" * 100_000}
    collector.consume(event("item.completed", item=item))
    assert collector.commands["c"]["output"].endswith("[Output truncated]")
    assert len(collector.commands["c"]["output"]) < 65_000
    monkeypatch.setattr(adapter, "MAX_EVENTS", 1)
    with pytest.raises(adapter.CodexExecutorError, match="event limit"):
        collector.consume(event("turn.completed"))


@pytest.mark.skipif(os.name != "nt", reason="Windows job assignment guard")
def test_windows_assignment_failure_never_starts_the_task(tmp_path, monkeypatch):
    marker = tmp_path / "not-started"
    def refuse(self, process):
        raise process_adapter.ExecutionProcessError("Assignment intentionally denied")
    monkeypatch.setattr(process_adapter.WindowsJob, "assign", refuse)
    with pytest.raises(process_adapter.ExecutionProcessError, match="denied"):
        process_adapter.run_supervised([sys.executable, "-I", "-c", "from pathlib import Path;Path(" + repr(str(marker)) + ").write_text('bad')"],
            cwd=tmp_path, env=adapter.execution_environment(), prompt=b"", cancel=threading.Event(), on_packet=lambda _: None, timeout=5)
    assert not marker.exists()


def wait_until(check, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(.05)
    raise AssertionError("Fixture did not reach the expected state")


def test_hard_owner_death_stops_worker_and_descendant_without_pid_recovery(tmp_path):
    heartbeat = tmp_path / "heartbeat"
    child = tmp_path / "child.py"
    child.write_text("import pathlib,time\np=pathlib.Path(" + repr(str(heartbeat)) + ")\ndeadline=time.monotonic()+15\nwhile time.monotonic()<deadline:\n p.write_text(str(time.monotonic()))\n time.sleep(.05)\n", encoding="utf8")
    fixture = tmp_path / "spawn-descendant.py"
    fixture.write_text("import subprocess,sys,time\nsubprocess.Popen([sys.executable,'-I'," + repr(str(child)) + "])\nsys.stdin.read()\ntime.sleep(60)\n", encoding="utf8")
    owner = tmp_path / "owner.py"
    package_root = str(Path(__file__).resolve().parents[1])
    owner.write_text("import sys,threading\nsys.path.insert(0," + repr(package_root) + ")\nfrom flowdesk.executor_process import run_supervised\nfrom flowdesk.codex_executor import execution_environment\nrun_supervised(" + repr([sys.executable, "-I", str(fixture)]) + ",cwd=" + repr(str(tmp_path)) + ",env=execution_environment(),prompt=b'',cancel=threading.Event(),on_packet=lambda _:None,timeout=60)\n", encoding="utf8")
    process = subprocess.Popen([sys.executable, "-I", str(owner)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    try:
        wait_until(heartbeat.exists)
        first = heartbeat.read_text()
        wait_until(lambda: heartbeat.read_text() != first)
        process.kill()
        process.wait(timeout=5)
        time.sleep(.3)
        stopped = heartbeat.read_text()
        time.sleep(.4)
        assert heartbeat.read_text() == stopped, "Server death stops even the fixture grandchild"
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()
        process.stderr.close()


def test_normal_completion_also_cleans_background_descendants(tmp_path):
    heartbeat = tmp_path / "completed-heartbeat"
    child = tmp_path / "background.py"
    child.write_text("import pathlib,time\np=pathlib.Path(" + repr(str(heartbeat)) + ")\ndeadline=time.monotonic()+15\nwhile time.monotonic()<deadline:\n p.write_text(str(time.monotonic()))\n time.sleep(.05)\n", encoding="utf8")
    # The short-lived parent must wait until its descendant is running. A fixed
    # sleep can let correct job cleanup kill a slow-starting child before this
    # test observes any heartbeat, especially during concurrent browser suites.
    script = ("import pathlib,subprocess,sys,time\n"
        "subprocess.Popen([sys.executable,'-I'," + repr(str(child)) + "],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n"
        "heartbeat=pathlib.Path(" + repr(str(heartbeat)) + ")\n"
        "deadline=time.monotonic()+10\n"
        "while not heartbeat.exists() and time.monotonic()<deadline:\n time.sleep(.01)\n"
        "assert heartbeat.exists(), 'Background fixture did not become ready'\n")
    outcome = process_adapter.run_supervised([sys.executable, "-I", "-c", script], cwd=tmp_path,
        env=adapter.execution_environment(), prompt=b"", cancel=threading.Event(), on_packet=lambda _: None, timeout=15)
    assert outcome == {"reason": "exited", "returncode": 0}
    assert heartbeat.exists()
    time.sleep(.2)
    stopped = heartbeat.read_text()
    time.sleep(.3)
    assert heartbeat.read_text() == stopped


def test_undrained_output_is_interrupted_instead_of_a_false_completed_turn(tmp_path):
    script = "import subprocess,sys\nsubprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(10)'])\n"
    outcome = process_adapter.run_supervised([sys.executable, "-I", "-c", script], cwd=tmp_path,
        env=adapter.execution_environment(), prompt=b"", cancel=threading.Event(), on_packet=lambda _: None, timeout=5)
    assert outcome == {"reason": "interrupted", "returncode": None}
