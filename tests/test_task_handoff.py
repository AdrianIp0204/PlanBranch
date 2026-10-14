"""A real commit round trip retains provenance and never runs or applies it."""
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
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


def attach_source(fixture, path):
    from flowdesk.scans import ScanService
    scans = ScanService(fixture[1])
    try:
        scans.attach(fixture[2]["id"], str(path), confirmed=True)
    finally:
        scans.close()


def test_execution_repository_takes_precedence_over_unrelated_scanner_attachment(fixture, tmp_path):
    scanner = tmp_path / "scanner-only"
    scanner.mkdir()
    attach_source(fixture, scanner)
    service, exported = package(fixture)
    assert exported["manifest"]["baseCommit"] == git(fixture[0], "rev-parse", "HEAD").strip()
    assert exported["manifest"]["repositorySelection"] == "execution"


@pytest.mark.parametrize("subdirectory", [False, True])
def test_scanner_only_non_repository_exports_a_planning_package_without_expanding_root(fixture, tmp_path, subdirectory):
    source, store, project, planning, _, execution = fixture
    scanner = (source / "selected-subdirectory") if subdirectory else (tmp_path / "non-git-source")
    scanner.mkdir()
    attach_source(fixture, scanner)
    planning.approve(project["id"], mutation(baseRevision=project["revision"]))
    service = TaskHandoffs(store, planning, execution)
    exported = service.create(project["id"], {"taskId": project["content"]["buildTasks"][0]["id"], "baseRevision": project["revision"]})
    assert exported["manifest"]["baseCommit"] is None
    assert exported["manifest"]["baseUnavailableReason"]
    assert str(scanner) not in str(exported)


def test_changed_execution_selection_rejects_import_even_when_old_repository_remains_available(fixture, tmp_path):
    source, _, project, _, _, execution = fixture
    service, exported = package(fixture)
    payload = returned_commit(fixture, exported)
    replacement = tmp_path / "other-repository"
    git(tmp_path, "clone", str(source), str(replacement))
    execution.repository(project["id"], mutation(path=str(replacement), confirmed=True))
    with pytest.raises(ValueError, match="repository selection"):
        service.import_result(project["id"], exported["manifest"]["handoffId"], payload)
    assert service.state(project["id"], payload["taskId"])["results"] == []


def scanner_package(fixture, path):
    _, store, project, planning, _, execution = fixture
    attach_source(fixture, path)
    planning.approve(project["id"], mutation(baseRevision=project["revision"]))
    return TaskHandoffs(store, planning, execution), {"taskId": project["content"]["buildTasks"][0]["id"], "baseRevision": project["revision"]}


def test_missing_scanner_root_exports_planning_only_without_inspecting_parent(fixture, tmp_path, monkeypatch):
    scanner = tmp_path / "scanner"
    scanner.mkdir()
    service, request = scanner_package(fixture, scanner)
    scanner.rename(tmp_path / "moved-scanner")
    monkeypatch.setattr(fixture[5].git, "inspect_repository", lambda *_: pytest.fail("A missing scanner root must not expand to its parent"))
    exported = service.create(fixture[2]["id"], request)
    assert exported["manifest"]["baseCommit"] is None
    assert "missing" in exported["manifest"]["baseUnavailableReason"]


def test_corrupt_scanner_git_marker_is_an_actionable_error_not_planning_fallback(fixture, tmp_path):
    scanner = tmp_path / "corrupt-scanner"
    scanner.mkdir()
    (scanner / ".git").write_text("not a valid Git pointer\n")
    service, request = scanner_package(fixture, scanner)
    with pytest.raises(ValueError, match="Git marker.*Repair the repository"):
        service.create(fixture[2]["id"], request)
    with closing(fixture[1].connect()) as db:
        assert db.execute("SELECT COUNT(*) FROM task_handoffs").fetchone()[0] == 0


@pytest.mark.parametrize("denied", ["root", "marker", "inspect"])
def test_scanner_permission_failures_never_fall_back_to_planning_only(fixture, monkeypatch, denied):
    source = fixture[0]
    service, request = scanner_package(fixture, source)
    if denied == "inspect":
        def inspect_denied(*_):
            raise PermissionError("fixture access denied")
        monkeypatch.setattr(fixture[5].git, "inspect_repository", inspect_denied)
    else:
        target = source if denied == "root" else source / ".git"
        original_lstat = Path.lstat
        def denied_lstat(path, *args, **kwargs):
            if path == target:
                raise PermissionError("fixture access denied")
            return original_lstat(path, *args, **kwargs)
        monkeypatch.setattr(Path, "lstat", denied_lstat)
    with pytest.raises(ValueError, match="access permissions.*fixture access denied"):
        service.create(fixture[2]["id"], request)
    with closing(fixture[1].connect()) as db:
        assert db.execute("SELECT COUNT(*) FROM task_handoffs").fetchone()[0] == 0


def test_broken_execution_selection_does_not_fall_back_to_scanner(fixture, tmp_path):
    source, store, project, _, _, _ = fixture
    service, _ = package(fixture)
    attach_source(fixture, source)
    with closing(store.connect()) as db, db:
        selected = json.loads(db.execute("SELECT repository FROM execution_repositories WHERE project_id=?", (project["id"],)).fetchone()[0])
        selected["path"] = str(tmp_path / "repository-no-longer-present")
        db.execute("UPDATE execution_repositories SET repository=? WHERE project_id=?", (json.dumps(selected), project["id"]))
    with pytest.raises(ValueError, match="selected execution repository is unavailable"):
        service.create(project["id"], {"taskId": project["content"]["buildTasks"][0]["id"], "baseRevision": project["revision"]})


def test_scanner_repository_selection_is_frozen_for_return_import(fixture, tmp_path):
    source, store, project, planning, _, execution = fixture
    attach_source(fixture, source)
    planning.approve(project["id"], mutation(baseRevision=project["revision"]))
    service = TaskHandoffs(store, planning, execution)
    exported = service.create(project["id"], {"taskId": project["content"]["buildTasks"][0]["id"], "baseRevision": project["revision"]})
    assert exported["manifest"]["repositorySelection"] == "source"
    payload = returned_commit(fixture, exported)
    other = tmp_path / "new-read-only-source"
    other.mkdir()
    attach_source(fixture, other)
    with pytest.raises(ValueError, match="repository selection"):
        service.import_result(project["id"], exported["manifest"]["handoffId"], payload)


def test_verification_binding_rechecks_selection_after_import(fixture, tmp_path):
    source, _, project, _, executor, execution = fixture
    service, exported = package(fixture)
    payload = returned_commit(fixture, exported)
    result = service.import_result(project["id"], exported["manifest"]["handoffId"], payload)
    bound = execution.verification_binding(project["id"], result["id"])
    assert bound["candidateCommit"] == payload["candidateCommit"]
    assert bound["externalContentHash"] == result["contentHash"]
    replacement = tmp_path / "replacement-with-same-commit"
    git(tmp_path, "clone", str(source), str(replacement))
    execution.repository(project["id"], mutation(path=str(replacement), confirmed=True))
    with pytest.raises(ValueError, match="repository selection"):
        execution.verification_binding(project["id"], result["id"])
    assert executor.contexts == []


def test_verification_preview_routes_only_explicit_command_and_exact_return_binding(fixture, monkeypatch):
    _, _, project, _, executor, execution = fixture
    service, exported = package(fixture)
    payload = returned_commit(fixture, exported)
    result = service.import_result(project["id"], exported["manifest"]["handoffId"], payload)
    calls = []
    monkeypatch.setattr(execution, "preview_verification", lambda project_id, request: calls.append((project_id, request)) or {"ready": True}, raising=False)
    assert service.preview_verification(project["id"], result["id"], {"contentHash": result["contentHash"], "command": "python -m pytest", "timeoutSeconds": 40}) == {"ready": True}
    assert calls == [(project["id"], {"taskId": payload["taskId"], "externalResultId": result["id"], "externalContentHash": result["contentHash"],
                                  "candidateCommit": payload["candidateCommit"], "command": "python -m pytest", "timeoutSeconds": 40})]
    with pytest.raises(ValueError, match="Refresh this external result"):
        service.preview_verification(project["id"], result["id"], {"contentHash": "wrong", "command": "other", "timeoutSeconds": 40})
    assert len(calls) == 1 and executor.contexts == []


def test_verification_start_rejects_another_results_preview(fixture, monkeypatch):
    _, store, project, _, _, execution = fixture
    service, _ = package(fixture)
    key = str(uuid4())
    with closing(store.connect()) as db, db:
        db.execute("INSERT INTO execution_previews VALUES(?,?,?,?,?,?)", (key, project["id"], json.dumps({"externalResultId": str(uuid4())}), 1, "[]", "2026-01-01"))
    monkeypatch.setattr(execution, "start_verification", lambda *_: pytest.fail("A foreign preview cannot start"), raising=False)
    with pytest.raises(ValueError, match="does not belong"):
        service.start_verification(project["id"], str(uuid4()), mutation(previewId=key, confirmed=True))


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
