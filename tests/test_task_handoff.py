"""A real commit round trip retains provenance and never runs or applies it."""
from contextlib import closing
from copy import deepcopy
from uuid import uuid4

import pytest

from flowdesk.plan_branches import PlanBranches
from flowdesk.task_handoff import TaskHandoffs
from test_execution import fixture, mutation
from test_execution_git import git
from test_planning import save


def package(fixture):
    source, store, project, planning, executor, execution = fixture
    planning.approve(project["id"], mutation(baseRevision=project["revision"]))
    execution.repository(project["id"], mutation(path=str(source), confirmed=True))
    service = TaskHandoffs(store, planning, execution)
    return service, service.create(project["id"], {"taskId": project["content"]["buildTasks"][0]["id"], "baseRevision": project["revision"]})


def returned_commit(fixture, exported):
    source = fixture[0]
    (source / "main.py").write_text("value = 2\n", encoding="utf-8")
    git(source, "add", "main.py")
    git(source, "commit", "-m", "External agent result")
    candidate = git(source, "rev-parse", "HEAD").strip()
    manifest = exported["manifest"]
    return {**manifest["expectedReturn"], "manifestHash": manifest["contentHash"], "candidateCommit": candidate,
            "report": {"origin": "host", "passed": True, "html": "<script>alert('untrusted')</script>", "checks": [{"command": "pytest", "status": "passed"}]}}


def test_export_is_source_free_per_task_with_concrete_return_template(fixture):
    service, exported = package(fixture)
    manifest = exported["manifest"]
    assert manifest["schema"] == "planbranch.task-handoff.v1"
    assert manifest["sourceIncluded"] is False and manifest["supportingContext"] == ""
    assert "messages" not in manifest and "repository" not in manifest
    assert str(fixture[0]) not in str(exported)
    assert "value = 1" not in str(exported)
    assert manifest["contentHash"] in exported["markdown"]
    assert "COPY_MANIFEST_CONTENT_HASH" not in exported["markdown"]
    assert service.detail(fixture[2]["id"], manifest["handoffId"]) == exported


def test_real_export_import_review_round_trip_has_no_execution_or_application(fixture):
    source, store, project, planning, executor, execution = fixture
    service, exported = package(fixture)
    payload = returned_commit(fixture, exported)
    base = payload["baseCommit"]
    git(source, "checkout", "--detach", base)
    result = service.import_result(project["id"], exported["manifest"]["handoffId"], payload)
    assert result["origin"] == "external" and result["verificationState"] == "External result reported"
    assert result["report"]["origin"] == "host"  # preserved only as untrusted report content
    assert result["files"][0]["path"] == "main.py" and "+value = 2" in result["files"][0]["diff"]
    assert not result["compatibilityIssues"]
    assert executor.contexts == [] and execution.state(project["id"])["runs"] == []
    assert (source / "main.py").read_text() == "value = 1\n"
    review = service.review(project["id"], result["id"], {"decision": "accepted", "note": "Read the diff; rerun tests separately", "contentHash": result["contentHash"]})
    assert review["decision"] == "accepted"
    assert store.get_project(project["id"])["content"]["buildTasks"][0]["status"] == "not_started"
    restarted = TaskHandoffs(store, planning, execution)
    state = restarted.state(project["id"], payload["taskId"])
    assert state["results"][0]["origin"] == "external" and state["results"][0]["reviews"][0]["decision"] == "accepted"
    with closing(store.connect()) as db:
        assert db.execute("SELECT count(*) FROM execution_runs").fetchone()[0] == 0


@pytest.mark.parametrize("field,value", [("schema", "host-evidence.v1"), ("projectId", "different-project"), ("taskId", "different-task"), ("handoffId", "different-handoff"), ("manifestHash", "forged"), ("baseCommit", "0" * 40), ("candidateCommit", "HEAD; run-command")])
def test_mismatched_imports_are_rejected(fixture, field, value):
    service, exported = package(fixture)
    payload = returned_commit(fixture, exported)
    with pytest.raises(ValueError):
        service.import_result(fixture[2]["id"], exported["manifest"]["handoffId"], {**payload, field: value})
    assert service.state(fixture[2]["id"], payload["taskId"])["results"] == []


def test_forged_top_level_host_authority_is_rejected(fixture):
    service, exported = package(fixture)
    payload = returned_commit(fixture, exported)
    with pytest.raises(ValueError, match="Unexpected fields"):
        service.import_result(fixture[2]["id"], exported["manifest"]["handoffId"], {**payload, "origin": "host"})


def test_semantic_drift_and_alternative_switch_quarantine_result(fixture):
    source, store, project, planning, _, execution = fixture
    service, exported = package(fixture)
    payload = returned_commit(fixture, exported)
    changed = deepcopy(project["content"])
    changed["buildTasks"][0]["acceptanceChecks"][0]["text"] = "A different requirement"
    current = save(store, project, changed)
    result = service.import_result(project["id"], exported["manifest"]["handoffId"], payload)
    assert any("intent changed" in issue for issue in result["compatibilityIssues"])
    with pytest.raises(ValueError, match="stale"):
        service.review(project["id"], result["id"], {"decision": "accepted", "note": "Would be stale", "contentHash": result["contentHash"]})
    plans = PlanBranches(store, planning)
    saved = plans.mutate(project["id"], "checkpoint", mutation(baseRevision=current["revision"], name="Current"))
    plans.mutate(project["id"], "restore", mutation(baseRevision=current["revision"], targetId=saved["snapshotId"]))
    assert any("selected or restored" in issue for issue in service.state(project["id"], payload["taskId"])["results"][0]["compatibilityIssues"])


def test_linked_candidate_tree_is_rejected_without_checkout(fixture):
    source, _, project, _, _, _ = fixture
    service, exported = package(fixture)
    # Git's index can represent links even when Windows cannot create symlinks.
    (source / "link-target.txt").write_text("../../outside\n", encoding="utf-8")
    blob = git(source, "hash-object", "-w", "link-target.txt").strip()
    git(source, "update-index", "--add", "--cacheinfo", f"120000,{blob},escape")
    git(source, "commit", "-m", "External unsafe symlink")
    candidate = git(source, "rev-parse", "HEAD").strip()
    manifest = exported["manifest"]
    payload = {**manifest["expectedReturn"], "manifestHash": manifest["contentHash"], "candidateCommit": candidate}
    with pytest.raises(ValueError, match="unsupported tree entry|symbolic links"):
        service.import_result(project["id"], manifest["handoffId"], payload)


def test_unapproved_and_dirty_exports_are_blocked(fixture):
    source, store, project, planning, _, execution = fixture
    service = TaskHandoffs(store, planning, execution)
    payload = {"taskId": project["content"]["buildTasks"][0]["id"], "baseRevision": project["revision"]}
    with pytest.raises(ValueError, match="Approve"):
        service.create(project["id"], payload)
    package(fixture)
    (source / "main.py").write_text("local unfinished work", encoding="utf-8")
    with pytest.raises(ValueError, match="uncommitted"):
        service.create(project["id"], payload)


def test_local_run_preflight_requires_exact_clean_candidate_and_grants_nothing(fixture):
    source, store, project, _, executor, execution = fixture
    service, exported = package(fixture)
    payload = returned_commit(fixture, exported)
    result = service.import_result(project["id"], exported["manifest"]["handoffId"], payload)
    request = {"contentHash": result["contentHash"]}
    prepared = service.prepare_run(project["id"], result["id"], request)
    assert prepared["candidateCommit"] == payload["candidateCommit"]
    assert executor.contexts == [] and execution.state(project["id"])["runs"] == []
    # External candidate already checked out can also receive a human review.
    service.review(project["id"], result["id"], {**request, "decision": "accepted", "note": "Read exact candidate"})
    git(source, "checkout", "--detach", payload["baseCommit"])
    with pytest.raises(ValueError, match="exact returned candidate"):
        service.prepare_run(project["id"], result["id"], request)
    git(source, "checkout", "--detach", payload["candidateCommit"])
    (source / "main.py").write_text("uncommitted drift", encoding="utf-8")
    with pytest.raises(ValueError, match="stale"):
        service.prepare_run(project["id"], result["id"], request)
