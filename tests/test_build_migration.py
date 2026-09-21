"""The Build schema upgrades retained snapshots without replacing frozen plans."""
from contextlib import closing
from copy import deepcopy
import hashlib
import json

import pytest

from flowdesk import migrations
from flowdesk.codex_planner import instruction_resource
from flowdesk.content_versions import empty_brief
from flowdesk.planning import PlanningService, fingerprint, manual_fingerprint
from flowdesk.storage import Store, encode, now
from test_brief_migration import frozen_rows, released_v5
from test_planning import FakePlanner


def v2(raw):
    content = deepcopy(raw)
    content["schemaVersion"] = 2
    content["brief"] = {**empty_brief(), "goal": "A durable agreed goal", "assumptions": "Storage is not agreed"}
    content.pop("buildTasks", None)
    return content


@pytest.fixture
def released_v6(released_v5):
    old = released_v5
    store = old["store"]
    instruction = instruction_resource("planner-v4")
    with closing(store.connect()) as db, db:
        migrations.apply_sql(db, "006_project_briefs.sql")
        db.execute("INSERT INTO schema_migrations VALUES(6,?)", (now(),))
        for row in db.execute("SELECT project_id,id,content FROM history_checkpoints").fetchall():
            db.execute("UPDATE history_checkpoints SET content=?,schema_version=2 WHERE project_id=? AND id=?",
                       (encode(v2(json.loads(row["content"]))), row["project_id"], row["id"]))
        identities = {row["id"]: manual_fingerprint(json.loads(row["content"])) for row in db.execute(
            "SELECT p.id,h.content FROM projects p JOIN history_checkpoints h ON h.project_id=p.id AND h.id=p.cursor")}
        for row in db.execute("SELECT id,project_id,context FROM planning_requests").fetchall():
            context = json.loads(row["context"]); context["content"] = v2(context["content"])
            context["generation"].update(instructionVersion="planner-v4", protocolVersion=3, instructions=instruction,
                                         instructionHash=hashlib.sha256(instruction.encode()).hexdigest())
            db.execute("UPDATE planning_requests SET context=?,base_hash=? WHERE project_id=? AND id=?",
                       (encode(context), identities[row["project_id"]], row["project_id"], row["id"]))
        proposal = db.execute("SELECT content FROM planning_proposals WHERE id=?", (old["proposal"]["id"],)).fetchone()
        proposal_content = v2(json.loads(proposal["content"]))
        proposal_hash = fingerprint(proposal_content)
        base_hash = identities[old["project"]["id"]]
        db.execute("UPDATE planning_proposals SET content=?,base_hash=? WHERE id=?", (encode(proposal_content), base_hash, old["proposal"]["id"]))
        candidate = db.execute("SELECT candidate FROM proposal_drafts WHERE id=?", (old["summary"]["id"],)).fetchone()
        old["save_request"]["contentHash"] = old["apply_request"]["contentHash"] = proposal_hash
        for summary in (old["summary"], old["prepared"]["draft"]):
            summary.update(baseHash=base_hash, proposalHash=proposal_hash)
        db.execute("UPDATE proposal_drafts SET candidate=?,base_hash=?,proposal_hash=?,apply_request=? WHERE id=?",
                   (encode(v2(json.loads(candidate["candidate"]))), base_hash, proposal_hash, encode(old["apply_request"]), old["summary"]["id"]))
        request_hash = fingerprint({"action": "save", "proposalId": old["proposal"]["id"], "draftId": old["summary"]["id"], "payload": old["save_request"]})
        db.execute("UPDATE proposal_draft_receipts SET payload_hash=?,acknowledgement=? WHERE mutation_id=?",
                   (request_hash, encode({"draft": old["summary"]}), old["save_request"]["mutationId"]))
        db.execute("UPDATE proposal_draft_receipts SET acknowledgement=? WHERE mutation_id=?",
                   (encode(old["prepared"]), old["prepare_request"]["mutationId"]))
        for row in db.execute("SELECT id,content FROM planning_approvals").fetchall():
            content = v2(json.loads(row["content"]))
            db.execute("UPDATE planning_approvals SET content=?,content_hash=? WHERE id=?", (encode(content), manual_fingerprint(content), row["id"]))
    return old


def test_v6_build_migration_keeps_brief_approval_and_apply_identities(released_v6):
    old = released_v6
    before = frozen_rows(old["store"])
    store = Store(old["store"].db_path)
    assert frozen_rows(store) == before
    project = store.get_project(old["project"]["id"])
    assert project["content"]["brief"]["goal"] == "A durable agreed goal"
    assert all(item["content"]["schemaVersion"] == 3 and item["content"]["buildTasks"] == [] for item in project["history"])
    service = PlanningService(store, FakePlanner())
    assert service.state(old["approved_project"]["id"])["approval"]["current"]
    detail = service.proposal_detail(project["id"], old["proposal"]["id"])
    assert detail["proposal"]["state"] == "pending" and detail["contentHash"] == old["apply_request"]["contentHash"]
    assert detail["baseContent"] == project["content"]
    loaded = service.drafts.get(project["id"], old["proposal"]["id"], old["summary"]["id"])["draft"]
    assert not loaded["stale"] and loaded["applyRequest"] == old["apply_request"] and loaded["candidate"]["buildTasks"] == []
    assert service.drafts.save(project["id"], old["proposal"]["id"], old["summary"]["id"], old["save_request"]) == {"draft": old["summary"]}
    assert service.drafts.prepare(project["id"], old["proposal"]["id"], old["summary"]["id"], old["prepare_request"]) == old["prepared"]
    applied = service.accept(project["id"], old["proposal"]["id"], old["apply_request"])["project"]
    assert applied["content"]["diagrams"][0] == old["diagram"]
    assert applied["content"]["brief"] == project["content"]["brief"]
    assert service.accept(project["id"], old["proposal"]["id"], old["apply_request"])["project"] == applied
    backups = list((store.db_path.parent / "backups").glob("*.sqlite3"))
    assert len(backups) == 1
    migrations.verify_backup(backups[0], expected_versions=(1, 2, 3, 4, 5, 6))


def test_v7_failure_restores_version6_manual_and_frozen_records(released_v6, monkeypatch):
    store = released_v6["store"]
    frozen = frozen_rows(store)
    with closing(store.connect()) as db:
        before = [tuple(row) for row in db.execute("SELECT * FROM history_checkpoints ORDER BY project_id,id")]
    original = migrations.MIGRATIONS[-1]
    def interrupted(db, owner):
        original.apply(db, owner)
        raise RuntimeError("Injected Build migration failure")
    monkeypatch.setattr(migrations, "MIGRATIONS", (*migrations.MIGRATIONS[:-1], migrations.Migration(7, original.name, True, interrupted)))
    with pytest.raises(RuntimeError, match="Injected"):
        Store(store.db_path)
    assert frozen_rows(store) == frozen
    with closing(store.connect()) as db:
        assert migrations.applied_versions(db) == (1, 2, 3, 4, 5, 6)
        assert [tuple(row) for row in db.execute("SELECT * FROM history_checkpoints ORDER BY project_id,id")] == before
