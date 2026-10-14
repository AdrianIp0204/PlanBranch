"""External-return verification routes with a deterministic runner double.

These tests cover authorization/routing/provenance. They do not exercise Docker
or claim that the injected runner establishes container isolation.
"""
from contextlib import closing
from pathlib import Path
import time

import pytest

from flowdesk.app import create_app
from flowdesk.check_evidence import seal_command, snapshot_identity
from test_execution import Executor, fixture, mutation
from test_execution_git import git
from test_planning import FakePlanner
from test_task_handoff import package, returned_commit


class VerificationRunnerDouble:
    def __init__(self, data_dir):
        self.data_dir, self.calls = data_dir, []

    def configure(self):
        return {"version": "deterministic-test-double", "available": True, "imageLabel": "No Docker runtime exercised"}

    def verify(self, policy, root, arguments, call_id, cancel, on_event):
        assert (Path(root) / "main.py").read_text() == "value = 2\n"
        self.calls.append({"root": str(root), **arguments})
        identity = snapshot_identity(root)
        command = {"id": call_id, "command": arguments["command"], "status": "completed", "exitCode": 0,
                   "output": "Deterministic verification fixture; no Docker isolation exercised.",
                   "evidence": {"schemaVersion": 2, "provenance": "host_observed", "runId": policy["evidenceRunId"],
                                "executionMode": "immutable_verification", "runtime": "test-double",
                                "candidateBefore": identity["sha256"], "candidateAfter": identity["sha256"],
                                "candidateIdentity": identity, "sourceChanged": False, "testResult": None}}
        command = seal_command(self.data_dir, command)
        on_event({"type": "command", "command": command})
        return {"executed": True, "command": command}


@pytest.fixture
def returned_app(fixture):
    source, store, project, _, old_executor, old_execution = fixture
    handoffs, exported = package(fixture)
    payload = returned_commit(fixture, exported)
    external = handoffs.import_result(project["id"], exported["manifest"]["handoffId"], payload)
    old_execution.close()
    executor = Executor()
    app = create_app(store.db_path.parent, testing=True, planner=FakePlanner(), executor=executor)
    service = app.extensions["flowdesk_execution"]
    runner = VerificationRunnerDouble(store.db_path.parent)
    service._command_runner = runner
    client = app.test_client()
    route = f"/api/projects/{project['id']}/external-results/{external['id']}/verification"
    request = {"contentHash": external["contentHash"], "command": "fixture_selected_check", "timeoutSeconds": 30}
    assert client.post(route + "/preview", json=request).status_code == 403
    client.environ_base["HTTP_X_FLOWDESK_TOKEN"] = client.get("/api/bootstrap").json["token"]
    yield source, store, project, external, payload, client, route, request, service, runner, executor
    assert old_executor.contexts == executor.contexts == []
    service.close()
    app.extensions["flowdesk_scans"].close()


def test_external_verification_runs_one_selected_check_and_preserves_external_authority(returned_app):
    source, store, project, external, _, client, route, request, service, runner, _ = returned_app
    baseline = (source / "main.py").read_bytes()
    preview = client.post(route + "/preview", json=request)
    assert preview.status_code == 200 and preview.json["ready"], preview.json
    assert runner.calls == []
    assert preview.json["preview"]["candidateCommit"] == external["candidateCommit"]
    unauthorized = client.post(route + "/start", json=mutation(previewId=preview.json["preview"]["id"], confirmed=False))
    assert unauthorized.status_code == 400 and runner.calls == []
    authorization = mutation(previewId=preview.json["preview"]["id"], confirmed=True)
    started = client.post(route + "/start", json=authorization)
    assert started.status_code == 200, started.json
    run_id = started.json["run"]["id"]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        with closing(store.connect()) as db:
            state = db.execute("SELECT state FROM execution_runs WHERE id=?", (run_id,)).fetchone()[0]
        if state not in {"queued", "running", "cancelling"}:
            break
        time.sleep(.05)
    run = service.detail(project["id"], run_id)["run"]
    assert run["state"] == "succeeded", run
    assert run["executionMode"] == "immutable_verification"
    assert len(runner.calls) == 1 and runner.calls[0]["command"] == request["command"]
    assert run["commands"][0]["verificationState"] == "not_verified"
    assert run["commands"][0]["evidence"]["hostAuthenticated"] is True
    assert run["commands"][0]["evidence"]["candidateBefore"] == run["capturedCandidate"]["sha256"]
    assert run["artifact"]["files"] == []
    assert (source / "main.py").read_bytes() == baseline
    repeated = client.post(route + "/start", json=authorization)
    assert repeated.status_code == 200 and repeated.json["run"]["id"] == run_id
    assert len(runner.calls) == 1
    rejected = client.post(f"/api/projects/{project['id']}/execution/runs/{run_id}/accept",
                           json=mutation(digest=run["artifact"]["digest"], confirmed=True))
    assert rejected.status_code == 409 and "verification-only" in str(rejected.json)
    state = client.get(f"/api/projects/{project['id']}/handoffs", query_string={"taskId": external.get("taskId", project["content"]["buildTasks"][0]["id"])}).json
    assert state["results"][0]["origin"] == "external"
    assert state["results"][0]["verificationState"] == "External result reported"
    assert state["results"][0]["report"] == external["report"]
    assert state["results"][0]["localVerifications"][0]["id"] == run_id
    assert store.get_project(project["id"])["content"]["buildTasks"][0]["status"] == "not_started"


@pytest.mark.parametrize("drift", ["candidate", "selection"])
def test_external_verification_rejects_drift_between_preview_and_start(returned_app, tmp_path, drift):
    source, store, project, _, payload, client, route, request, service, runner, _ = returned_app
    preview = client.post(route + "/preview", json=request)
    assert preview.status_code == 200 and preview.json["ready"], preview.json
    if drift == "candidate":
        git(source, "checkout", "--detach", payload["baseCommit"])
    else:
        replacement = tmp_path / "replacement"
        git(tmp_path, "clone", str(source), str(replacement))
        service.repository(project["id"], mutation(path=str(replacement), confirmed=True))
    started = client.post(route + "/start", json=mutation(previewId=preview.json["preview"]["id"], confirmed=True))
    assert started.status_code in {400, 409}, started.json
    assert runner.calls == []
    with closing(store.connect()) as db:
        assert db.execute("SELECT COUNT(*) FROM execution_runs").fetchone()[0] == 0


def test_external_verification_rejects_mutated_isolated_copy_before_container_launch(returned_app, monkeypatch):
    from flowdesk.command_runner import DockerCommandRunner, POLICY_VERSION
    from test_execution import finish
    source, store, project, _, _, client, route, request, service, _, _ = returned_app
    baseline = (source / "main.py").read_bytes()
    runtime_calls = []
    runner = DockerCommandRunner(store.db_path.parent)
    monkeypatch.setattr(runner, "configure", lambda: {"version": POLICY_VERSION, "available": True,
        "executable": "unused", "endpoint": "test", "daemonId": "fixture", "imageId": "fixture"})
    def runtime_probe(executable, endpoint, arguments):
        runtime_calls.append(arguments)
        assert arguments == ["info", "--format", "{{json .}}"], "No container may be launched for changed candidate bytes"
        return '{"ID":"fixture","OSType":"linux","SecurityOptions":["seccomp"]}'
    monkeypatch.setattr(runner, "_call", runtime_probe)
    service._command_runner = runner
    original_create = service.git.create
    def altered_copy(*arguments):
        workspace = original_create(*arguments)
        (Path(workspace["path"]) / "main.py").write_text("value = 999\n")
        return workspace
    monkeypatch.setattr(service.git, "create", altered_copy)
    preview = client.post(route + "/preview", json=request)
    assert preview.status_code == 200 and preview.json["ready"], preview.json
    started = client.post(route + "/start", json=mutation(previewId=preview.json["preview"]["id"], confirmed=True))
    assert started.status_code == 200, started.json
    run = finish(service, project["id"], started.json["run"]["id"])
    assert run["state"] == "failed" and "candidate changed" in run["error"], run
    assert len(runtime_calls) == 1 and run["commands"] == []
    assert (source / "main.py").read_bytes() == baseline
