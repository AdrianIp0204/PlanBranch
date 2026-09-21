"""Drafts and uncertain Apply requests survive restart without changing a plan."""
from contextlib import closing
from copy import deepcopy
from uuid import uuid4

import pytest

from flowdesk import migrations
from flowdesk.planning import PlanningService, fingerprint
from flowdesk.proposal_drafts import DraftConflictError
from flowdesk.storage import ConflictError, NotFoundError, Store, now
from flowdesk.validation import ValidationError
from test_planning import FakePlanner, save, workspace
from test_proposal_review import reviewed


def draft_request(detail, diagram, revision=0, **changes):
    return {"mutationId": str(uuid4()), "baseDraftRevision": revision,
            "contentHash": detail["contentHash"], "diagram": deepcopy(diagram), **changes}


def create_draft(service, project):
    proposal, detail, diagram = reviewed(service, project)
    diagram["nodes"][0]["notes"] = "My manually edited candidate"
    draft_id = str(uuid4())
    request = draft_request(detail, diagram)
    summary = service.drafts.save(project["id"], proposal["id"], draft_id, request)["draft"]
    return proposal, detail, diagram, summary, request


def prepare(service, project, proposal, summary):
    payload = {"mutationId": str(uuid4()), "baseRevision": project["revision"],
               "baseDraftRevision": summary["draftRevision"]}
    return service.drafts.prepare(project["id"], proposal["id"], summary["id"], payload), payload


def test_save_restart_and_list_keep_candidate_separate_from_plan(workspace):
    store, project, service, _ = workspace
    proposal, detail, diagram, summary, _ = create_draft(service, project)
    assert summary["draftRevision"] == 1 and summary["state"] == "active"
    assert summary["baseRevision"] == proposal["baseRevision"]
    assert summary["baseHash"] == proposal["baseHash"]
    assert summary["proposalHash"] == detail["contentHash"]
    assert summary["conflictOf"] is None and not summary["stale"]
    restarted = PlanningService(Store(store.db_path), FakePlanner())
    restored = restarted.drafts.get(project["id"], proposal["id"], summary["id"])["draft"]
    assert restored["candidate"]["diagrams"][0] == diagram
    assert restored["applyRequest"] is None
    assert restarted.drafts.list(project["id"], proposal["id"]) == {
        "drafts": [summary], "defaultDraftId": summary["id"]}
    full = restarted.proposal_detail(project["id"], proposal["id"])
    assert full["content"] == detail["content"] and full["drafts"] == [summary]
    assert full["defaultDraftId"] == summary["id"]
    assert store.get_project(project["id"]) == project


def test_save_receipt_is_immutable_and_late_retry_never_replaces_newer_draft(workspace):
    store, project, service, _ = workspace
    proposal, detail, diagram, first, initial_request = create_draft(service, project)
    newer = deepcopy(diagram); newer["nodes"][0]["title"] = "The latest manual wording"
    current = service.drafts.save(project["id"], proposal["id"], first["id"], draft_request(detail, newer, 1))["draft"]
    assert current["draftRevision"] == 2
    replay = service.drafts.save(project["id"], proposal["id"], first["id"], initial_request)
    assert replay == {"draft": first}
    loaded = service.drafts.get(project["id"], proposal["id"], first["id"])["draft"]
    assert loaded["draftRevision"] == 2 and loaded["candidate"]["diagrams"][0] == newer
    with pytest.raises(ValidationError, match="reused"):
        service.drafts.save(project["id"], proposal["id"], first["id"], {**initial_request, "diagram": newer})
    assert store.get_project(project["id"]) == project


def test_conflicting_save_keeps_both_drafts_and_retry_creates_one_recovery_copy(workspace):
    store, project, service, _ = workspace
    proposal, detail, diagram, first, _ = create_draft(service, project)
    first_tab = deepcopy(diagram); first_tab["nodes"][0]["notes"] = "Saved in the first tab"
    current = service.drafts.save(project["id"], proposal["id"], first["id"], draft_request(detail, first_tab, 1))["draft"]
    second_tab = deepcopy(diagram); second_tab["nodes"][0]["notes"] = "Do not lose the other tab"
    request = draft_request(detail, second_tab, 1)
    with pytest.raises(DraftConflictError) as conflict:
        service.drafts.save(project["id"], proposal["id"], first["id"], request)
    response = conflict.value.response
    assert response["draftRevision"] == 2 and response["latestDraft"] == current
    recovered_id = response["recoveryDraft"]["id"]
    assert response["recoveryDraft"]["conflictOf"] == first["id"]
    restarted = PlanningService(Store(store.db_path), FakePlanner())
    with pytest.raises(DraftConflictError) as replay:
        restarted.drafts.save(project["id"], proposal["id"], first["id"], request)
    assert replay.value.response == response
    assert restarted.drafts.get(project["id"], proposal["id"], recovered_id)["draft"]["candidate"]["diagrams"][0] == second_tab
    assert restarted.drafts.get(project["id"], proposal["id"], first["id"])["draft"]["candidate"]["diagrams"][0] == first_tab
    listing = restarted.drafts.list(project["id"], proposal["id"])
    assert len(listing["drafts"]) == 2 and listing["defaultDraftId"] == recovered_id
    assert store.get_project(project["id"]) == project


def test_invalid_conflicting_candidate_does_not_create_recovery_copy(workspace):
    store, project, service, _ = workspace
    proposal, detail, diagram, first, _ = create_draft(service, project)
    diagram["edges"][0]["target"] = "Missing node"
    with pytest.raises(ValidationError):
        service.drafts.save(project["id"], proposal["id"], first["id"], draft_request(detail, diagram, 0))
    assert len(service.drafts.list(project["id"], proposal["id"])["drafts"]) == 1
    assert store.get_project(project["id"]) == project


def test_stale_draft_stays_editable_and_recoverable_but_cannot_apply(workspace):
    store, project, service, _ = workspace
    proposal, detail, diagram, first, _ = create_draft(service, project)
    changed = deepcopy(project["content"]); changed["notes"] = "A newer saved requirement"
    current = save(store, project, changed)
    diagram["nodes"][0]["notes"] = "Keep this outdated candidate for reconciliation"
    updated = service.drafts.save(project["id"], proposal["id"], first["id"], draft_request(detail, diagram, 1))["draft"]
    assert updated["stale"]
    with pytest.raises(RuntimeError, match="plan changed"):
        prepare(service, current, proposal, updated)
    assert service.drafts.get(project["id"], proposal["id"], first["id"])["draft"]["candidate"]["diagrams"][0] == diagram
    assert store.get_project(project["id"]) == current


def test_interrupted_prepare_recovers_exact_request_without_executing_and_apply_is_once(workspace):
    store, project, service, _ = workspace
    proposal, _, diagram, first, _ = create_draft(service, project)
    prepared, request = prepare(service, project, proposal, first)
    assert prepared["draft"]["state"] == "applying" and prepared["draft"]["draftRevision"] == 2
    assert store.get_project(project["id"]) == project
    restarted = PlanningService(Store(store.db_path), FakePlanner())
    assert restarted.drafts.prepare(project["id"], proposal["id"], first["id"], request) == prepared
    recovered = restarted.drafts.get(project["id"], proposal["id"], first["id"])["draft"]
    assert recovered["applyRequest"] == prepared["applyRequest"]
    assert store.get_project(project["id"]) == project
    accepted = restarted.accept(project["id"], proposal["id"], recovered["applyRequest"])["project"]
    assert accepted["content"]["diagrams"][0] == diagram and len(accepted["history"]) == 2
    applied = restarted.drafts.get(project["id"], proposal["id"], first["id"])["draft"]
    assert applied["state"] == "applied" and applied["appliedCursor"] == accepted["cursor"]
    assert restarted.drafts.list(project["id"], proposal["id"])["defaultDraftId"] is None
    again = PlanningService(Store(store.db_path), FakePlanner())
    assert again.accept(project["id"], proposal["id"], recovered["applyRequest"])["project"] == accepted
    undone = save(store, accepted, cursor=project["cursor"])
    assert again.accept(project["id"], proposal["id"], recovered["applyRequest"])["project"] == undone


def test_apply_rolls_back_history_projection_review_receipt_and_draft_together(workspace, monkeypatch):
    store, project, service, _ = workspace
    proposal, _, _, first, _ = create_draft(service, project)
    prepared, _ = prepare(service, project, proposal, first)
    original = store._write_current
    def fail(db, project_id, content):
        original(db, project_id, content)
        raise RuntimeError("Injected projection failure")
    monkeypatch.setattr(store, "_write_current", fail)
    with pytest.raises(RuntimeError, match="Injected"):
        service.accept(project["id"], proposal["id"], prepared["applyRequest"])
    assert store.get_project(project["id"]) == project
    assert service.proposal_detail(project["id"], proposal["id"])["proposal"]["state"] == "pending"
    assert service.drafts.get(project["id"], proposal["id"], first["id"])["draft"]["state"] == "applying"
    with closing(store.connect()) as db:
        assert db.execute("SELECT COUNT(*) FROM planning_receipts WHERE mutation_id=?", (prepared["applyRequest"]["mutationId"],)).fetchone()[0] == 0
    monkeypatch.setattr(store, "_write_current", original)
    assert service.accept(project["id"], proposal["id"], prepared["applyRequest"])["project"]["revision"] == 1


def test_draft_and_receipt_insert_roll_back_together(workspace):
    store, project, service, _ = workspace
    proposal, detail, diagram = reviewed(service, project)
    draft_id = str(uuid4()); request = draft_request(detail, diagram)
    with closing(store.connect()) as db, db:
        db.execute("CREATE TRIGGER reject_draft_receipt BEFORE INSERT ON proposal_draft_receipts BEGIN SELECT RAISE(ABORT, 'Injected draft receipt failure'); END")
    with pytest.raises(Exception, match="Injected draft receipt"):
        service.drafts.save(project["id"], proposal["id"], draft_id, request)
    assert service.drafts.list(project["id"], proposal["id"])["drafts"] == []
    with closing(store.connect()) as db, db:
        db.execute("DROP TRIGGER reject_draft_receipt")
    assert service.drafts.save(project["id"], proposal["id"], draft_id, request)["draft"]["draftRevision"] == 1


@pytest.mark.parametrize("discard", [False, True])
def test_cancel_or_discard_invalidates_late_apply(workspace, discard):
    store, project, service, _ = workspace
    proposal, _, _, first, _ = create_draft(service, project)
    prepared, _ = prepare(service, project, proposal, first)
    request = {"mutationId": str(uuid4()), "baseDraftRevision": prepared["draft"]["draftRevision"]}
    stopped = service.drafts.finish(project["id"], proposal["id"], first["id"], request, discard=discard)
    assert stopped["draft"]["state"] == ("discarded" if discard else "active")
    assert service.drafts.finish(project["id"], proposal["id"], first["id"], request, discard=discard) == stopped
    with pytest.raises(RuntimeError, match="no longer current"):
        service.accept(project["id"], proposal["id"], prepared["applyRequest"])
    assert service.drafts.get(project["id"], proposal["id"], first["id"])["draft"]["applyRequest"] is None
    assert store.get_project(project["id"]) == project


def test_discard_tombstone_cannot_be_resurrected_by_late_save_or_old_receipt(workspace):
    store, project, service, _ = workspace
    proposal, detail, diagram, first, old_request = create_draft(service, project)
    service.drafts.finish(project["id"], proposal["id"], first["id"], {
        "mutationId": str(uuid4()), "baseDraftRevision": 1}, discard=True)
    restarted = PlanningService(Store(store.db_path), FakePlanner())
    with pytest.raises(RuntimeError, match="applied or discarded"):
        restarted.drafts.save(project["id"], proposal["id"], first["id"], draft_request(detail, diagram, 1))
    assert restarted.drafts.save(project["id"], proposal["id"], first["id"], old_request) == {"draft": first}
    listing = restarted.drafts.list(project["id"], proposal["id"])
    assert listing["defaultDraftId"] is None and len(listing["drafts"]) == 1
    assert listing["drafts"][0]["state"] == "discarded"


def test_legacy_accept_cannot_bypass_saved_or_prepared_candidate(workspace):
    store, project, service, _ = workspace
    proposal, detail, diagram, first, _ = create_draft(service, project)
    legacy = {"mutationId": str(uuid4()), "baseRevision": 0, "contentHash": detail["contentHash"], "diagram": diagram}
    with pytest.raises(RuntimeError, match="saved drafts"):
        service.accept(project["id"], proposal["id"], legacy)
    prepared, _ = prepare(service, project, proposal, first)
    with pytest.raises(RuntimeError, match="saved drafts"):
        service.accept(project["id"], proposal["id"], legacy)
    with pytest.raises(ValidationError, match="exact prepared"):
        service.accept(project["id"], proposal["id"], {**prepared["applyRequest"], "diagram": diagram})
    assert store.get_project(project["id"]) == project


def test_prepared_candidate_stays_frozen_if_another_tab_saves_and_is_default(workspace):
    _, project, service, _ = workspace
    proposal, detail, diagram, first, _ = create_draft(service, project)
    prepare(service, project, proposal, first)
    diagram["nodes"][0]["notes"] = "Other tab edit after prepare"
    with pytest.raises(DraftConflictError):
        service.drafts.save(project["id"], proposal["id"], first["id"], draft_request(detail, diagram, 1))
    listing = service.drafts.list(project["id"], proposal["id"])
    assert len(listing["drafts"]) == 2 and listing["defaultDraftId"] == first["id"]
    other = next(d for d in listing["drafts"] if d["id"] != first["id"])
    with pytest.raises(RuntimeError, match="unfinished Apply"):
        prepare(service, project, proposal, other)


def test_cas_conflicts_on_prepare_cancel_discard_never_change_draft(workspace):
    _, project, service, _ = workspace
    proposal, _, _, first, _ = create_draft(service, project)
    with pytest.raises(DraftConflictError) as failure:
        prepare(service, project, proposal, {**first, "draftRevision": 0})
    assert "recoveryDraft" not in failure.value.response
    for discard in (False, True):
        with pytest.raises(DraftConflictError):
            service.drafts.finish(project["id"], proposal["id"], first["id"],
                                  {"baseDraftRevision": 0, "mutationId": str(uuid4())}, discard=discard)
    assert service.drafts.list(project["id"], proposal["id"])["drafts"] == [first]


def test_project_conflict_and_staleness_after_prepare_cannot_apply(workspace):
    store, project, service, _ = workspace
    proposal, _, _, first, _ = create_draft(service, project)
    prepared, _ = prepare(service, project, proposal, first)
    changed = deepcopy(project["content"]); changed["notes"] = "New requirements while reviewing"
    current = save(store, project, changed)
    with pytest.raises(ConflictError):
        service.accept(project["id"], proposal["id"], prepared["applyRequest"])
    assert service.drafts.get(project["id"], proposal["id"], first["id"])["draft"]["state"] == "applying"
    assert store.get_project(project["id"]) == current


def test_reject_tombstones_all_copies_and_project_delete_cascades(workspace):
    store, project, service, _ = workspace
    proposal, detail, diagram, first, _ = create_draft(service, project)
    second = service.drafts.save(project["id"], proposal["id"], str(uuid4()), draft_request(detail, diagram))["draft"]
    prepare(service, project, proposal, first)
    service.reject(project["id"], proposal["id"], {"mutationId": str(uuid4())})
    listing = service.drafts.list(project["id"], proposal["id"])
    assert {d["id"] for d in listing["drafts"]} == {first["id"], second["id"]}
    assert all(d["state"] == "discarded" for d in listing["drafts"]) and listing["defaultDraftId"] is None
    store.delete_project(project["id"], project["revision"])
    with closing(store.connect()) as db:
        assert db.execute("SELECT COUNT(*) FROM proposal_drafts").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM proposal_draft_receipts").fetchone()[0] == 0
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_draft_ownership_is_enforced(workspace):
    store, project, service, _ = workspace
    proposal, detail, diagram, first, _ = create_draft(service, project)
    other = store.create_project()
    with pytest.raises(NotFoundError):
        service.drafts.get(other["id"], proposal["id"], first["id"])
    proposal2, detail2, diagram2 = reviewed(service, project)
    with pytest.raises(NotFoundError):
        service.drafts.save(project["id"], proposal2["id"], first["id"], draft_request(detail2, diagram2))


def test_upgrade_from_four_preserves_existing_project_and_planning_snapshots(tmp_path):
    class VersionFourStore(Store):
        def initialize(self):
            with closing(self.connect()) as db, db:
                for migration in migrations.MIGRATIONS[:4]:
                    migration.apply(db, self)
                    db.execute("INSERT INTO schema_migrations VALUES(?,?)", (migration.version, now()))
    old = VersionFourStore(tmp_path / "upgrade.sqlite3")
    from flowdesk.sample import sample_content
    project = old.create_project(content=sample_content())
    # PlanningService requires the new draft tables, so use an unmodified old
    # request/context row to prove migration does not rewrite frozen content.
    with closing(old.connect()) as db, db:
        db.execute("INSERT INTO planning_receipts VALUES(?,?,?)", (project["id"], "old-retry", "frozen-hash"))
    upgraded = Store(old.db_path)
    assert upgraded.get_project(project["id"]) == project
    with closing(upgraded.connect()) as db:
        assert migrations.applied_versions(db) == tuple(range(1, migrations.DATABASE_VERSION + 1))
        assert db.execute("SELECT payload_hash FROM planning_receipts WHERE mutation_id='old-retry'").fetchone()[0] == "frozen-hash"
        assert db.execute("SELECT COUNT(*) FROM proposal_drafts").fetchone()[0] == 0
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_api_conflict_response_and_protected_routes(tmp_path):
    from flowdesk.app import create_app
    app = create_app(tmp_path, testing=True, planner=FakePlanner())
    client = app.test_client()
    headers = {"X-FlowDesk-Token": client.get("/api/bootstrap").json["token"]}
    project = client.post("/api/projects", json={"sample": True}, headers=headers).json
    service = app.extensions["flowdesk_planning"]
    proposal, detail, diagram = reviewed(service, project)
    base = f'/api/projects/{project["id"]}/planning/proposals/{proposal["id"]}/drafts'
    url = base + "/" + str(uuid4())
    assert client.get(base).status_code == 403
    assert client.get(base, headers={**headers, "Origin": "https://evil.example"}).status_code == 403
    first = client.put(url, json=draft_request(detail, diagram), headers=headers)
    assert first.status_code == 200 and first.json["draft"]["draftRevision"] == 1
    assert client.get(url, headers=headers).json["draft"]["candidate"]["diagrams"][0] == diagram
    diagram["nodes"][0]["notes"] = "Conflicting tab"
    conflict = client.put(url, json=draft_request(detail, diagram), headers=headers)
    assert conflict.status_code == 409 and conflict.json["draftConflict"]
    assert "revision" not in conflict.json and conflict.json["draftRevision"] == 1
    assert conflict.json["recoveryDraft"]["id"] != first.json["draft"]["id"]
    assert client.put(url, json={"diagram": "x" * 2_100_000}, headers=headers).status_code == 400
