"""Named checkpoints are durable plan data, never resurrected execution authority."""
from contextlib import closing
from copy import deepcopy
from uuid import uuid4

import pytest

from flowdesk.plan_branches import PlanBranches, plan_epoch
from flowdesk.planning import PlanningService
from flowdesk.storage import ConflictError, Store, encode, now
from test_build_tasks import task
from test_planning import FakePlanner, save
from flowdesk.sample import sample_content


@pytest.fixture
def plans(tmp_path):
    store = Store(tmp_path / "plans.sqlite3")
    content = sample_content()
    content["buildTasks"] = [task()]
    project = store.create_project(content=content)
    planning = PlanningService(store, FakePlanner())
    return store, project, planning, PlanBranches(store, planning)


def mutate(fixture, action, **extra):
    store, project, _, service = fixture
    return service.mutate(project["id"], action, {"mutationId": str(uuid4()), "baseRevision": store.get_project(project["id"])["revision"], **extra})


def test_checkpoint_survives_restart_and_undo_trimming(plans):
    store, project, planning, service = plans
    saved = mutate(plans, "checkpoint", name="Baseline", explanation="Keep the offline design")
    current = store.get_project(project["id"])
    changed = deepcopy(current["content"])
    changed["brief"]["requirements"] = "Use online services"
    save(store, current, changed)
    reopened = Store(store.db_path)
    other = PlanBranches(reopened, PlanningService(reopened, FakePlanner()))
    assert other.inspect(project["id"], saved["snapshotId"])["content"] == project["content"]
    assert other.state(project["id"])["snapshots"][0]["name"] == "Baseline"


def test_duplicate_compare_select_and_recover_without_copying_authority(plans):
    store, project, planning, service = plans
    planning.approve(project["id"], {"mutationId": str(uuid4()), "baseRevision": project["revision"]})
    alternate = mutate(plans, "duplicate", name="Offline first", explanation="Avoid a hosted dependency")
    baseline_id = service.state(project["id"])["selectedAlternativeId"]
    changed = deepcopy(project["content"])
    changed["brief"]["requirements"] = "Use cloud storage"
    changed["buildTasks"][0]["status"] = "done"
    current = save(store, project, changed)
    comparison = service.compare(project["id"], alternate["snapshotId"])
    assert [item["section"] for item in comparison["changes"]] == ["Requirements, constraints and decisions"]
    chosen = mutate(plans, "select", targetId=alternate["alternativeId"], note="Choose offline privacy")
    assert chosen["project"]["content"]["brief"]["requirements"] == project["content"]["brief"]["requirements"]
    assert chosen["project"]["content"]["buildTasks"][0]["status"] == "not_started"
    assert not planning.state(project["id"])["approval"]["current"]
    recovered = mutate(plans, "select", targetId=baseline_id, note="Recover previous exploration")
    assert recovered["project"]["content"]["brief"]["requirements"] == "Use cloud storage"
    assert len(service.state(project["id"])["snapshots"]) == 4
    with closing(store.connect()) as db:
        assert plan_epoch(db, project["id"]) == 2
        assert db.execute("SELECT count(*) FROM execution_runs").fetchone()[0] == 0
    assert service.state(project["id"])["decisions"][0]["note"] == "Recover previous exploration"


def test_layout_and_progress_are_not_semantic_comparison(plans):
    store, project, _, service = plans
    saved = mutate(plans, "checkpoint", name="Original")
    changed = deepcopy(project["content"])
    for diagram in changed["diagrams"]:
        for node in diagram["nodes"]:
            node["position"]["x"] += 600
            node["status"] = "done"
            node["pinned"] = True
            for check in node["checklist"]:
                check["checked"] = not check["checked"]
    changed["buildTasks"][0]["status"] = "done"
    save(store, project, changed)
    assert service.compare(project["id"], saved["snapshotId"])["changes"] == []


@pytest.mark.parametrize("operation", ["active", "pending_apply"])
def test_restore_blocks_unfinished_side_effects_and_preserves_current(plans, operation):
    store, project, _, service = plans
    snapshot = mutate(plans, "checkpoint", name="Safe baseline")
    with closing(store.connect()) as db, db:
        if operation == "active":
            db.execute("INSERT INTO execution_runs(id,project_id,preview_id,state,snapshot,created_at,updated_at) VALUES(?,?,?,'running','{}',?,?)", (str(uuid4()), project["id"], str(uuid4()), now(), now()))
        else:
            db.execute("INSERT INTO execution_receipts VALUES(?,?,?,'apply:test','pending',NULL)", (project["id"], str(uuid4()), "digest"))
    before = store.get_project(project["id"])
    with pytest.raises(RuntimeError, match="active run|unfinished Apply"):
        mutate(plans, "restore", targetId=snapshot["snapshotId"])
    assert store.get_project(project["id"]) == before


def test_mutation_receipt_conflict_and_snapshot_integrity(plans):
    store, project, _, service = plans
    payload = {"mutationId": str(uuid4()), "baseRevision": project["revision"], "name": "Stable"}
    first = service.mutate(project["id"], "checkpoint", payload)
    again = service.mutate(project["id"], "checkpoint", payload)
    assert first == again
    with pytest.raises(ValueError, match="reused"):
        service.mutate(project["id"], "checkpoint", {**payload, "name": "Different"})
    with pytest.raises(ConflictError):
        service.mutate(project["id"], "checkpoint", {**payload, "mutationId": str(uuid4()), "baseRevision": 99})
    with closing(store.connect()) as db, db:
        db.execute("UPDATE plan_snapshots SET content='{}' WHERE id=?", (first["snapshotId"],))
    with pytest.raises(ValueError, match="saved snapshot changed"):
        service.inspect(project["id"], first["snapshotId"])


def test_restore_retains_other_work_and_delete_cascades(plans):
    store, project, _, service = plans
    original = mutate(plans, "checkpoint", name="Original")
    changed = deepcopy(project["content"])
    changed["brief"]["goal"] = "Do not lose me"
    save(store, project, changed)
    result = mutate(plans, "restore", targetId=original["snapshotId"])
    recovery = next(item for item in service.state(project["id"])["snapshots"] if item["kind"] == "recovery")
    assert service.inspect(project["id"], recovery["id"])["content"]["brief"]["goal"] == "Do not lose me"
    store.delete_project(project["id"], result["project"]["revision"])
    with closing(store.connect()) as db:
        assert db.execute("SELECT count(*) FROM plan_snapshots").fetchone()[0] == 0


def test_interrupted_restore_rolls_back_content_recovery_and_authority(plans, monkeypatch):
    store, project, planning, service = plans
    original = mutate(plans, "checkpoint", name="Original")
    planning.approve(project["id"], {"mutationId": str(uuid4()), "baseRevision": project["revision"]})
    before = store.get_project(project["id"])
    prior_state = service.state(project["id"])
    def interrupted(*args):
        raise OSError("simulated interrupted write")
    monkeypatch.setattr(store, "_write_current", interrupted)
    with pytest.raises(OSError, match="interrupted write"):
        mutate(plans, "restore", targetId=original["snapshotId"])
    assert store.get_project(project["id"]) == before
    assert service.state(project["id"]) == prior_state
    assert planning.state(project["id"])["approval"]["current"]


def test_checkpoint_retains_source_reference_metadata_without_excerpts_or_consent(plans):
    store, project, _, service = plans
    proposal = str(uuid4())
    receipt = {"schemaVersion": 1, "proposalId": proposal, "provider": "fixture", "model": "local", "revision": "a" * 40,
               "packageHash": "package", "consentToken": "must-not-survive", "excerpt": "private source",
               "files": [{"path": "main.py", "fileHash": "bytes", "startLine": 1, "endLine": 4, "symbol": "process", "excerpt": "private source"}]}
    with closing(store.connect()) as db, db:
        db.execute("INSERT INTO planning_proposals(id,project_id,title,summary,diagram_id,base_revision,base_cursor,base_hash,content,changes,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (proposal, project["id"], "Grounded", "Use the inspected code", project["content"]["diagrams"][0]["id"], 0, project["cursor"], "base", "{}", "[]", "accepted", now()))
        db.execute("INSERT INTO planning_requests(id,project_id,payload_hash,payload,context,base_revision,base_cursor,base_hash,attempt_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (str(uuid4()), project["id"], "payload", "{}", encode({"repositoryContextReceipt": receipt}), 0, project["cursor"], "base", str(uuid4()), "succeeded", now(), now()))
    saved = mutate(plans, "checkpoint", name="Grounded checkpoint")
    inspected = service.inspect(project["id"], saved["snapshotId"])
    assert inspected["sourceReferences"][0]["files"][0]["path"] == "main.py"
    assert "private source" not in encode(inspected)
    assert "must-not-survive" not in encode(inspected)
