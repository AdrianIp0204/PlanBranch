"""Progress can change without changing intent; launch must recheck both."""
from copy import deepcopy

import pytest

from test_build_tasks import task
from test_execution import fixture, accept, execute, finish, mutation
from test_execution_git import git
from test_planning import save


@pytest.mark.parametrize("status", ["blocked", "done"])
def test_progress_change_during_preparation_prevents_agent_launch(fixture, monkeypatch, status):
    source, store, project, planning, executor, service = fixture
    create = service.git.create

    def prepare_then_change_progress(*args):
        workspace = create(*args)
        current = store.get_project(project["id"])
        content = deepcopy(current["content"])
        content["buildTasks"][0]["status"] = status
        save(store, current, content)
        # Progress intentionally remains outside the semantic approval scope.
        assert planning.state(project["id"])["approval"]["current"]
        return workspace

    monkeypatch.setattr(service.git, "create", prepare_then_change_progress)
    run, _ = execute(fixture)
    assert run["state"] == "failed" and "agent was not started" in run["error"]
    assert executor.contexts == [] and run["artifact"]["files"] == []
    assert (source / "main.py").read_text() == "value = 1\n"
    assert not run["acceptedDigest"] and not run["applied"]


def test_reopened_prerequisite_during_preparation_prevents_dependent_launch(fixture, monkeypatch):
    source, store, project, planning, executor, service = fixture
    content = deepcopy(project["content"])
    first = content["buildTasks"][0]
    dependent = task("Use the accepted prerequisite", prerequisites=[first["id"]])
    content["buildTasks"].append(dependent)
    current = save(store, project, content)
    run, _ = execute(fixture)
    accept(fixture, run)
    service.complete(project["id"], run["id"], mutation(
        digest=run["artifact"]["digest"], baseRevision=current["revision"], confirmed=True))
    service.apply(project["id"], run["id"], mutation(digest=run["artifact"]["digest"], confirmed=True))
    git(source, "add", "main.py")
    git(source, "commit", "-m", "Fixture records human prerequisite commit")
    preview = service.preview(project["id"], {"taskId": dependent["id"]})
    assert preview["ready"], preview["issues"]
    create = service.git.create

    def prepare_then_reopen_prerequisite(*args):
        workspace = create(*args)
        current = store.get_project(project["id"])
        changed = deepcopy(current["content"])
        changed["buildTasks"][0]["status"] = "in_progress"
        save(store, current, changed)
        assert planning.state(project["id"])["approval"]["current"]
        return workspace

    monkeypatch.setattr(service.git, "create", prepare_then_reopen_prerequisite)
    started = service.start(project["id"], mutation(previewId=preview["preview"]["id"], confirmed=True))
    blocked = finish(service, project["id"], started["run"]["id"])
    assert blocked["state"] == "failed" and "agent was not started" in blocked["error"]
    assert "Complete" in blocked["error"]
    assert len(executor.contexts) == 1  # Only the earlier prerequisite ran.
    assert blocked["artifact"]["files"] == [] and not blocked["acceptedDigest"]
    assert (source / "main.py").read_text() == "value = 2\n"


def test_nonblocking_progress_and_layout_change_during_preparation_preserve_approval(fixture, monkeypatch):
    _, store, project, planning, executor, service = fixture
    create = service.git.create

    def prepare_then_move_node(*args):
        workspace = create(*args)
        current = store.get_project(project["id"])
        content = deepcopy(current["content"])
        content["buildTasks"][0]["status"] = "in_progress"
        content["diagrams"][0]["nodes"][0]["position"]["x"] += 100
        save(store, current, content)
        return workspace

    monkeypatch.setattr(service.git, "create", prepare_then_move_node)
    run, _ = execute(fixture)
    assert run["state"] == "succeeded", run["error"]
    assert planning.state(project["id"])["approval"]["current"]
    assert len(executor.contexts) == 1
    assert not run["acceptedDigest"] and not run["applied"]
