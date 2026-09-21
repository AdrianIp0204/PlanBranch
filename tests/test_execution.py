"""Execution requires a separate grant, frozen preview and deliberate actions."""
from contextlib import closing
from copy import deepcopy
from pathlib import Path
import subprocess
import sys
import threading
import time
from uuid import uuid4

import pytest

from flowdesk.app import create_app
from flowdesk.execution import ExecutionService
from flowdesk.execution_git import GitWorkspace
from flowdesk.planning import PlanningService
from flowdesk.sample import sample_content
from flowdesk.storage import ConflictError, Store
from flowdesk.validation import ValidationError
from test_build_tasks import task
from test_execution_git import git
from test_planning import FakePlanner, save


def mutation(**extra):
    return {"mutationId": str(uuid4()), **extra}


class Executor:
    def __init__(self):
        self.contexts = []
        self.started = threading.Event()
        self.gate = None
        self.fail_command = False
        self.available = True
        self.version = "fixture-1"

    def status(self):
        return {"available": self.available, "label": "Deterministic executor", "reason": "Fixture unavailable"}

    def configure(self, selection):
        return {"provider": "fixture", "selection": deepcopy(selection), "instructionVersion": self.version,
                "instructions": "Edit the isolated fixture only.", "resolvedModel": "fixture-model"}

    def run(self, context, worktree, cancel, on_event):
        self.contexts.append(deepcopy(context))
        root = Path(worktree)
        (root / "main.py").write_text("value = 2\n", encoding="utf-8")
        self.started.set()
        on_event({"type": "progress", "message": "Fixture changed main.py"})
        while self.gate is not None and not self.gate.is_set() and not cancel.wait(.01):
            pass
        if cancel.is_set():
            return {"status": "cancelled", "summary": "Partial work retained", "commands": []}
        command = [sys.executable, "-c", "assert False, 'fixture failure'" if self.fail_command else "assert 2 + 2 == 4; print('observed success')"]
        result = subprocess.run(command, cwd=root, text=True, capture_output=True)
        record = {"id": "observed-command", "command": "python fixture acceptance check", "status": "completed",
                  "exitCode": result.returncode, "output": result.stdout + result.stderr}
        on_event({"type": "command", "command": record})
        return {"status": "succeeded", "summary": "Agent reports its work is ready for review.", "commands": [record]}


@pytest.fixture
def fixture(tmp_path):
    source = tmp_path / "repo"
    source.mkdir()
    git(source, "init")
    git(source, "config", "user.name", "PlanBranch fixture")
    git(source, "config", "user.email", "fixture@example.invalid")
    (source / "main.py").write_text("value = 1\n", encoding="utf-8")
    (source / "keep.txt").write_text("baseline\n", encoding="utf-8")
    git(source, "add", ".")
    git(source, "commit", "-m", "Fixture")
    store = Store(tmp_path / "data" / "flowdesk.sqlite3")
    content = sample_content()
    content["buildTasks"] = [task()]
    project = store.create_project(content=content)
    planning = PlanningService(store, FakePlanner())
    executor = Executor()
    service = ExecutionService(store, planning, executor, GitWorkspace(store.db_path.parent))
    yield source, store, project, planning, executor, service
    service.close()


def prepare(fixture):
    source, store, project, planning, executor, service = fixture
    current = store.get_project(project["id"])
    planning.approve(project["id"], mutation(baseRevision=current["revision"]))
    service.repository(project["id"], mutation(path=str(source), confirmed=True))
    preview = service.preview(project["id"], {"taskId": current["content"]["buildTasks"][0]["id"]})
    assert preview["ready"], preview["issues"]
    return preview["preview"]


def finish(service, project_id, run_id):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        run = service.detail(project_id, run_id)["run"]
        if run["state"] not in {"queued", "running", "cancelling"}:
            assert run["artifact"], run
            return run
        time.sleep(.02)
    pytest.fail("Fixture run did not finish")


def execute(fixture):
    preview = prepare(fixture)
    service, project = fixture[-1], fixture[2]
    request = mutation(previewId=preview["id"], confirmed=True)
    reply = service.start(project["id"], request)
    return finish(service, project["id"], reply["run"]["id"]), request


def accept(fixture, run):
    return fixture[-1].accept(fixture[2]["id"], run["id"], mutation(digest=run["artifact"]["digest"], confirmed=True))["run"]


def test_preview_requires_execution_grant_and_approval_without_running(fixture):
    source, store, project, planning, executor, service = fixture
    request = {"taskId": project["content"]["buildTasks"][0]["id"]}
    unready = service.preview(project["id"], request)
    assert not unready["ready"] and len(unready["issues"]) == 2
    planning.approve(project["id"], mutation(baseRevision=project["revision"]))
    assert not service.preview(project["id"], request)["ready"]
    with pytest.raises(ValidationError, match="Confirm"):
        service.repository(project["id"], mutation(path=str(source)))
    preview = prepare(fixture)
    assert preview["generation"]["instructionVersion"] == "fixture-1"
    assert executor.contexts == [] and service.state(project["id"])["runs"] == []
    with pytest.raises(ValidationError, match="not ready"):
        service.start(project["id"], mutation(previewId=unready["preview"]["id"], confirmed=True))
    assert store.get_project(project["id"]) == project


def test_frozen_preview_start_receipt_and_duplicate_preview_do_not_rerun(fixture):
    source, store, project, planning, executor, service = fixture
    preview = prepare(fixture)
    executor.version = "fixture-2"
    request = mutation(previewId=preview["id"], confirmed=True)
    run = service.start(project["id"], request)["run"]
    done = finish(service, project["id"], run["id"])
    assert done["state"] == "succeeded", done["error"]
    assert executor.contexts[0]["generation"]["instructionVersion"] == "fixture-1"
    assert done["commands"][0]["exitCode"] == 0 and "observed success" in done["commands"][0]["output"]
    assert service.start(project["id"], request)["run"]["id"] == run["id"]
    with pytest.raises(RuntimeError, match="already started"):
        service.start(project["id"], mutation(previewId=preview["id"], confirmed=True))
    with pytest.raises(ValidationError, match="cannot be reused"):
        service.start(project["id"], {**request, "previewId": str(uuid4())})
    assert len(executor.contexts) == 1
    assert (source / "main.py").read_text() == "value = 1\n"
    assert store.get_project(project["id"]) == project


def test_accept_complete_and_checkout_apply_are_separate_retryable_actions(fixture):
    source, store, project, planning, executor, service = fixture
    (source / "keep.txt").write_text("unrelated staged edit\n", encoding="utf-8")
    git(source, "add", "keep.txt")
    index = (source / ".git" / "index").read_bytes()
    run, _ = execute(fixture)
    digest = run["artifact"]["digest"]
    with pytest.raises(RuntimeError, match="accept"):
        service.complete(project["id"], run["id"], mutation(digest=digest, baseRevision=project["revision"], confirmed=True))
    accepted = accept(fixture, run)
    assert accepted["acceptedDigest"] == digest and not accepted["completedCursor"] and not accepted["applied"]
    request = mutation(digest=digest, baseRevision=project["revision"], confirmed=True)
    completed = service.complete(project["id"], run["id"], request)
    assert completed["project"]["content"]["buildTasks"][0]["status"] == "done"
    assert len(completed["project"]["history"]) == len(project["history"]) + 1
    assert completed["run"]["planStale"] and not completed["run"]["applyPlanStale"]
    assert service.complete(project["id"], run["id"], request)["project"] == completed["project"]
    assert (source / "main.py").read_text() == "value = 1\n"
    apply_request = mutation(digest=digest, confirmed=True)
    assert service.apply(project["id"], run["id"], apply_request)["run"]["applied"]
    assert (source / "main.py").read_text() == "value = 2\n"
    assert (source / "keep.txt").read_text() == "unrelated staged edit\n"
    assert (source / ".git" / "index").read_bytes() == index
    (source / "main.py").write_text("newer user edit\n", encoding="utf-8")
    service.apply(project["id"], run["id"], apply_request)
    assert (source / "main.py").read_text() == "newer user edit\n"
    restored = save(store, completed["project"], cursor=project["cursor"])
    assert restored["content"] == project["content"]


def test_failed_observed_command_remains_visible_without_trusting_agent_summary(fixture):
    fixture[4].fail_command = True
    run, _ = execute(fixture)
    assert run["state"] == "succeeded"
    assert run["commands"][0]["exitCode"] == 1
    assert "fixture failure" in run["commands"][0]["output"]
    assert not run["acceptedDigest"] and not run["completedCursor"]


def test_cancellation_preserves_partial_work_and_blocks_concurrent_execution(fixture):
    source, store, project, planning, executor, service = fixture
    executor.gate = threading.Event()
    preview = prepare(fixture)
    run = service.start(project["id"], mutation(previewId=preview["id"], confirmed=True))["run"]
    assert executor.started.wait(15)
    other = ExecutionService(store, planning, Executor(), service.git)
    try:
        assert not other.state(project["id"])["ownership"]["available"]
        assert other.detail(project["id"], run["id"])["run"]["state"] == "running"
        with pytest.raises(RuntimeError, match="owns execution"):
            other.cancel(project["id"], run["id"], mutation())
        other_project = store.create_project("Manual planning remains usable")
        changed = deepcopy(other_project["content"])
        changed["notes"] = "Work alongside an active run"
        assert save(store, other_project, changed)["content"]["notes"]
        with pytest.raises(RuntimeError, match="Cancel"):
            store.delete_project(project["id"], project["revision"])
        assert not service.preview(project["id"], {"taskId": project["content"]["buildTasks"][0]["id"]})["ready"]
        service.cancel(project["id"], run["id"], mutation())
        done = finish(service, project["id"], run["id"])
        assert done["state"] == "cancelled" and done["artifact"]["files"][0]["path"] == "main.py"
        assert (source / "main.py").read_text() == "value = 1\n"
    finally:
        executor.gate.set()
        other.close()


def test_restart_recovers_interrupted_work_without_rerun(fixture):
    source, store, project, planning, executor, service = fixture
    run, start_request = execute(fixture)
    # Simulate a server death after files were written but before final capture.
    with closing(store.connect()) as db, db:
        db.execute("UPDATE execution_runs SET state='running',artifact_digest=NULL WHERE id=?", (run["id"],))
    service.close()
    restarted = ExecutionService(Store(store.db_path), planning, executor, service.git)
    try:
        restored = restarted.detail(project["id"], run["id"])["run"]
        assert restored["state"] == "interrupted" and restored["worktreePath"] == run["worktreePath"]
        assert restored["commands"] == run["commands"] and restored["artifact"] is None
        assert restarted.start(project["id"], start_request)["run"]["id"] == run["id"]
        assert len(executor.contexts) == 1
        refreshed = restarted.refresh(project["id"], run["id"], mutation())["run"]
        assert refreshed["artifact"]["digest"] == run["artifact"]["digest"]
        assert (source / "main.py").read_text() == "value = 1\n"
    finally:
        restarted.close()


def test_stale_preview_and_changed_worktree_require_new_review(fixture):
    source, store, project, planning, executor, service = fixture
    preview = prepare(fixture)
    changed = deepcopy(project["content"])
    changed["brief"]["constraints"] = "A changed constraint"
    current = save(store, project, changed)
    with pytest.raises(ConflictError):
        service.start(project["id"], mutation(previewId=preview["id"], confirmed=True))
    assert executor.contexts == []
    run, _ = execute(fixture)
    old_digest = run["artifact"]["digest"]
    (Path(run["worktreePath"]) / "main.py").write_text("value = 3\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="worktree changed"):
        service.accept(project["id"], run["id"], mutation(digest=old_digest, confirmed=True))
    refreshed = service.refresh(project["id"], run["id"], mutation())["run"]
    assert refreshed["artifact"]["digest"] != old_digest
    accept(fixture, refreshed)
    newer = deepcopy(current["content"])
    newer["notes"] = "Changed after accepting code"
    save(store, current, newer)
    assert service.detail(project["id"], run["id"])["run"]["applyPlanStale"]
    with pytest.raises(RuntimeError, match="reviewed plan changed"):
        service.apply(project["id"], run["id"], mutation(digest=refreshed["artifact"]["digest"], confirmed=True))


def test_plan_change_during_worktree_creation_stops_agent_launch(fixture, monkeypatch):
    source, store, project, planning, executor, service = fixture
    original_create = service.git.create
    def create_then_change(*args):
        workspace = original_create(*args)
        content = deepcopy(project["content"])
        content["notes"] = "Plan changed while worktree was prepared"
        save(store, project, content)
        return workspace
    monkeypatch.setattr(service.git, "create", create_then_change)
    run, _ = execute(fixture)
    assert run["state"] == "failed" and "agent was not started" in run["error"]
    assert executor.contexts == [] and run["artifact"]["files"] == []


def test_completion_rolls_back_history_receipt_and_task_together(fixture, monkeypatch):
    source, store, project, planning, executor, service = fixture
    run, _ = execute(fixture)
    accept(fixture, run)
    request = mutation(digest=run["artifact"]["digest"], baseRevision=project["revision"], confirmed=True)
    original_write = store._write_current
    def fail(*args):
        raise RuntimeError("Injected content write failure")
    monkeypatch.setattr(store, "_write_current", fail)
    with pytest.raises(RuntimeError, match="Injected"):
        service.complete(project["id"], run["id"], request)
    assert store.get_project(project["id"]) == project
    assert not service.detail(project["id"], run["id"])["run"]["completedCursor"]
    with closing(store.connect()) as db:
        assert db.execute("SELECT 1 FROM execution_receipts WHERE mutation_id=?", (request["mutationId"],)).fetchone() is None
    monkeypatch.setattr(store, "_write_current", original_write)
    assert service.complete(project["id"], run["id"], request)["project"]["revision"] == project["revision"] + 1


def test_apply_lost_acknowledgement_keeps_original_request_across_restart(fixture, monkeypatch):
    source, store, project, planning, executor, service = fixture
    run, _ = execute(fixture)
    accept(fixture, run)
    request = mutation(digest=run["artifact"]["digest"], confirmed=True)
    original_done = service._done
    def fail_final_commit(db, project_id, payload, result):
        if payload["mutationId"] == request["mutationId"]:
            raise OSError("Injected lost acknowledgement")
        return original_done(db, project_id, payload, result)
    monkeypatch.setattr(service, "_done", fail_final_commit)
    with pytest.raises(OSError, match="lost acknowledgement"):
        service.apply(project["id"], run["id"], request)
    assert (source / "main.py").read_text() == "value = 2\n"
    with pytest.raises(RuntimeError, match="unfinished code Apply"):
        store.delete_project(project["id"], project["revision"])
    service.close()
    restarted = ExecutionService(store, planning, executor, service.git)
    try:
        restored = restarted.detail(project["id"], run["id"])["run"]
        assert restored["applyRequest"] == request and restored["applyState"]["state"] == "applied"
        assert not restored["applied"]
        with pytest.raises(RuntimeError, match="unfinished Apply"):
            restarted.apply(project["id"], run["id"], mutation(digest=request["digest"], confirmed=True))
        (source / "main.py").write_text("newer user edit\n", encoding="utf-8")
        recovered = restarted.apply(project["id"], run["id"], request)["run"]
        assert recovered["applied"] and recovered["applyRequest"] is None
        assert (source / "main.py").read_text() == "newer user edit\n"
    finally:
        restarted.close()


def test_known_apply_conflict_exposes_definitive_receipt_then_allows_new_action(fixture):
    from flowdesk.execution import ExecutionReceiptError
    source, store, project, planning, executor, service = fixture
    run, _ = execute(fixture)
    accept(fixture, run)
    request = mutation(digest=run["artifact"]["digest"], confirmed=True)
    (source / "main.py").write_text("conflicting user edit\n", encoding="utf-8")
    for _ in range(2):
        with pytest.raises(ExecutionReceiptError) as caught:
            service.apply(project["id"], run["id"], request)
        assert caught.value.receipt == {"mutationId": request["mutationId"], "state": "failed"}
    assert service.detail(project["id"], run["id"])["run"]["applyRequest"] is None
    (source / "main.py").write_text("value = 1\n", encoding="utf-8")
    assert service.apply(project["id"], run["id"], mutation(digest=request["digest"], confirmed=True))["run"]["applied"]


def test_readiness_checks_and_changed_source_never_launch_agent(fixture):
    source, store, project, planning, executor, service = fixture
    preview = prepare(fixture)
    (source / "new.txt").write_text("New source revision", encoding="utf-8")
    git(source, "add", "new.txt")
    git(source, "commit", "-m", "Source changed")
    with pytest.raises(RuntimeError, match="source revision changed"):
        service.start(project["id"], mutation(previewId=preview["id"], confirmed=True))
    content = deepcopy(project["content"])
    dependent = task(prerequisites=[content["buildTasks"][0]["id"]])
    dependent["acceptanceChecks"] = []
    content["buildTasks"].append(dependent)
    current = save(store, project, content)
    planning.approve(project["id"], mutation(baseRevision=current["revision"]))
    unready = service.preview(project["id"], {"taskId": dependent["id"]})
    assert any("acceptance check" in issue for issue in unready["issues"])
    assert any("prerequisites" in issue for issue in unready["issues"])
    executor.available = False
    assert not service.preview(project["id"], {"taskId": content["buildTasks"][0]["id"]})["ready"]
    assert executor.contexts == []


def test_execution_api_preserves_token_origin_and_explicit_confirmation(fixture, monkeypatch):
    source, store, project, planning, executor, service = fixture
    preview = prepare(fixture)
    service.close()
    app = create_app(store.db_path.parent, testing=True, planner=FakePlanner(), executor=executor, execution_git=service.git)
    client = app.test_client()
    token = client.get("/api/bootstrap").json["token"]
    headers = {"X-FlowDesk-Token": token}
    route = f"/api/projects/{project['id']}/execution"
    try:
        assert client.get(route).status_code == 403
        assert client.get(route, headers={**headers, "Origin": "https://example.invalid"}).status_code == 403
        assert client.get(route, headers=headers).json["ownership"]["available"]
        response = client.post(route + "/runs", headers=headers, json=mutation(previewId=preview["id"]))
        assert response.status_code == 400 and "Confirm" in response.json["error"]
        assert client.post(route + "/preview", headers=headers, json={"taskId": str(uuid4())}).status_code == 400
        assert executor.contexts == []
        from flowdesk.execution import ExecutionReceiptError
        request = mutation(digest="unwritten", confirmed=True)
        def refused(*args):
            raise ExecutionReceiptError("The diff changed before Apply", request["mutationId"])
        monkeypatch.setattr(app.extensions["flowdesk_execution"], "apply", refused)
        response = client.post(route + f"/runs/{uuid4()}/apply", headers=headers, json=request)
        assert response.status_code == 409
        assert response.json["executionReceipt"] == {"mutationId": request["mutationId"], "state": "failed"}
    finally:
        app.extensions["flowdesk_execution"].close()


def test_new_apply_preflight_refusal_allows_refresh_review_and_new_digest(fixture):
    from flowdesk.execution import ExecutionReceiptError
    source, store, project, planning, executor, service = fixture
    run, _ = execute(fixture)
    accept(fixture, run)
    original_request = mutation(digest=run["artifact"]["digest"], confirmed=True)
    (Path(run["worktreePath"]) / "main.py").write_text("value = 3\n", encoding="utf-8")
    with pytest.raises(ExecutionReceiptError) as caught:
        service.apply(project["id"], run["id"], original_request)
    assert caught.value.receipt == {"mutationId": original_request["mutationId"], "state": "failed"}
    assert service.detail(project["id"], run["id"])["run"]["applyRequest"] is None
    refreshed = service.refresh(project["id"], run["id"], mutation())["run"]
    assert refreshed["artifact"]["digest"] != original_request["digest"]
    accept(fixture, refreshed)
    assert service.apply(project["id"], run["id"], mutation(digest=refreshed["artifact"]["digest"], confirmed=True))["run"]["applied"]
    assert (source / "main.py").read_text() == "value = 3\n"
    with pytest.raises(ExecutionReceiptError):
        service.apply(project["id"], run["id"], original_request)
