"""Released v5 data upgrades without invalidating frozen requests or Apply."""
from contextlib import closing
from copy import deepcopy
import hashlib
import json
from uuid import uuid4

import pytest

from flowdesk import migrations
from flowdesk.codex_planner import instruction_resource
from flowdesk.content_versions import CONTENT_VERSION, empty_brief
from flowdesk.planning import PlanningService, fingerprint
from flowdesk.sample import sample_content
from flowdesk.storage import Store, encode
from test_planning import FakePlanner, payload, save
from test_proposal_drafts import create_draft, prepare


def legacy(content):
    result = deepcopy(content)
    result["schemaVersion"] = 1
    result.pop("brief", None)
    result.pop("buildTasks", None)
    return result


def frozen_rows(store):
    fields = {
        "planning_requests": "id,payload_hash,payload,context,base_hash,status",
        "planning_proposals": "id,content,changes,base_hash",
        "proposal_drafts": "id,candidate,apply_request,proposal_hash",
        "proposal_draft_receipts": "*", "planning_receipts": "*", "planning_approvals": "*",
    }
    with closing(store.connect()) as db:
        return {table: [tuple(row) for row in db.execute(f"SELECT {columns} FROM {table} ORDER BY 1")]
                for table, columns in fields.items()}


@pytest.fixture
def released_v5(tmp_path):
    """Build old on-disk representations, including exact historical receipts."""
    store = Store(tmp_path / "legacy.sqlite3")
    project = store.create_project(content=sample_content())
    content = deepcopy(project["content"]); content["notes"] = "Retained first edit"
    first = save(store, project, content)
    content = deepcopy(first["content"]); content["notes"] = "Retained redo edit"
    tail = save(store, first, content)
    project = save(store, tail, cursor=first["cursor"])
    service = PlanningService(store, FakePlanner())
    proposal, detail, diagram, summary, save_request = create_draft(service, project)
    prepared, prepare_request = prepare(service, project, proposal, summary)
    apply_request = prepared["applyRequest"]
    approved_project = store.create_project(content=sample_content())
    approve_request = {"mutationId": str(uuid4()), "baseRevision": approved_project["revision"]}
    service.approve(approved_project["id"], approve_request)
    # Current functions construct the fixture conveniently, then remove only the
    # schema additions and encode every persisted record as the released v5 app.
    old_hash = fingerprint(legacy(detail["content"]))
    save_request["contentHash"] = apply_request["contentHash"] = old_hash
    prepared["draft"]["proposalHash"] = old_hash
    summary["proposalHash"] = old_hash
    instructions = instruction_resource("planner-v3")
    with closing(store.connect()) as db, db:
        for row in db.execute("SELECT project_id,id,content FROM history_checkpoints").fetchall():
            db.execute("UPDATE history_checkpoints SET content=?,schema_version=1 WHERE project_id=? AND id=?",
                       (encode(legacy(json.loads(row["content"]))), row["project_id"], row["id"]))
        for row in db.execute("SELECT id,project_id,context FROM planning_requests").fetchall():
            context = json.loads(row["context"])
            context["content"] = legacy(context["content"])
            context["generation"] = {"selection": {"mode": "default"}, "cliVersion": "0.144.1",
                                     "instructionVersion": "planner-v3", "protocolVersion": 2,
                                     "instructions": instructions,
                                     "instructionHash": hashlib.sha256(instructions.encode()).hexdigest()}
            db.execute("UPDATE planning_requests SET context=? WHERE project_id=? AND id=?",
                       (encode(context), row["project_id"], row["id"]))
        db.execute("UPDATE planning_proposals SET content=? WHERE id=?", (encode(legacy(detail["content"])), proposal["id"]))
        candidate = deepcopy(project["content"]); candidate["diagrams"][0] = diagram
        db.execute("UPDATE proposal_drafts SET candidate=?,proposal_hash=?,apply_request=? WHERE id=?",
                   (encode(legacy(candidate)), old_hash, encode(apply_request), summary["id"]))
        request_hash = fingerprint({"action": "save", "proposalId": proposal["id"], "draftId": summary["id"], "payload": save_request})
        db.execute("UPDATE proposal_draft_receipts SET payload_hash=?,acknowledgement=? WHERE mutation_id=?",
                   (request_hash, encode({"draft": summary}), save_request["mutationId"]))
        db.execute("UPDATE proposal_draft_receipts SET acknowledgement=? WHERE mutation_id=?",
                   (encode(prepared), prepare_request["mutationId"]))
        for row in db.execute("SELECT id,content FROM planning_approvals").fetchall():
            db.execute("UPDATE planning_approvals SET content=? WHERE id=?", (encode(legacy(json.loads(row["content"]))), row["id"]))
        db.execute("ALTER TABLE planning_proposals DROP COLUMN editable_sections")
        db.execute("DELETE FROM schema_migrations WHERE version>=6")
    return dict(store=store, project=project, proposal=proposal, diagram=diagram, summary=summary,
                save_request=save_request, prepare_request=prepare_request, apply_request=apply_request,
                prepared=prepared, approved_project=approved_project, approve_request=approve_request)


def test_v5_migration_keeps_frozen_records_and_prepared_apply_exact(released_v5):
    old = released_v5
    before = frozen_rows(old["store"])
    store = Store(old["store"].db_path)
    assert frozen_rows(store) == before
    restored = store.get_project(old["project"]["id"])
    assert restored == old["project"]
    assert all(item["content"]["schemaVersion"] == CONTENT_VERSION and item["content"]["brief"] == empty_brief() for item in restored["history"])
    assert restored["cursor"] != restored["history"][-1]["id"]  # redo branch retained
    service = PlanningService(store, FakePlanner())
    assert service.state(old["approved_project"]["id"])["approval"]["current"]
    assert service.approve(old["approved_project"]["id"], old["approve_request"])["approval"]["current"]
    detail = service.proposal_detail(restored["id"], old["proposal"]["id"])
    assert detail["proposal"]["editableSections"] == ["diagram"] and detail["proposal"]["state"] == "pending"
    assert detail["contentHash"] == old["apply_request"]["contentHash"]
    assert detail["content"]["schemaVersion"] == CONTENT_VERSION and detail["baseContent"] == restored["content"]
    loaded = service.drafts.get(restored["id"], old["proposal"]["id"], old["summary"]["id"])["draft"]
    assert not loaded["stale"] and loaded["candidate"]["schemaVersion"] == CONTENT_VERSION
    assert loaded["applyRequest"] == old["apply_request"]
    assert service.drafts.save(restored["id"], old["proposal"]["id"], old["summary"]["id"], old["save_request"]) == {"draft": old["summary"]}
    assert service.drafts.prepare(restored["id"], old["proposal"]["id"], old["summary"]["id"], old["prepare_request"]) == old["prepared"]
    applied = service.accept(restored["id"], old["proposal"]["id"], old["apply_request"])["project"]
    assert applied["content"]["diagrams"][0] == old["diagram"] and applied["content"]["brief"] == empty_brief()
    assert service.accept(restored["id"], old["proposal"]["id"], old["apply_request"])["project"] == applied
    backups = list((store.db_path.parent / "backups").glob("*.sqlite3"))
    assert len(backups) == 1
    migrations.verify_backup(backups[0], expected_versions=(1, 2, 3, 4, 5))


def test_v5_brief_migration_failure_rolls_back_history_and_frozen_records(released_v5, monkeypatch):
    old = released_v5["store"]
    before = frozen_rows(old)
    with closing(old.connect()) as db:
        history = [tuple(row) for row in db.execute("SELECT * FROM history_checkpoints ORDER BY project_id,id")]
    original = next(migration for migration in migrations.MIGRATIONS if migration.version == 6)
    def interrupted(db, store):
        original.apply(db, store)
        raise RuntimeError("Injected after all manual snapshots upgraded")
    monkeypatch.setattr(migrations, "MIGRATIONS", tuple(migrations.Migration(6, original.name, True, interrupted) if migration.version == 6 else migration for migration in migrations.MIGRATIONS))
    with pytest.raises(RuntimeError, match="Injected"):
        Store(old.db_path)
    assert frozen_rows(old) == before
    with closing(old.connect()) as db:
        assert migrations.applied_versions(db) == (1, 2, 3, 4, 5)
        assert [tuple(row) for row in db.execute("SELECT * FROM history_checkpoints ORDER BY project_id,id")] == history
        assert "editable_sections" not in {row[1] for row in db.execute("PRAGMA table_info(planning_proposals)")}
    backups = list((old.db_path.parent / "backups").glob("*.sqlite3"))
    assert len(backups) == 1
    migrations.verify_backup(backups[0], expected_versions=(1, 2, 3, 4, 5))
