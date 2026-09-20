"""Workspace candidates stay isolated until explicitly applied as one action."""
from contextlib import closing
from copy import deepcopy
from uuid import uuid4

import pytest

from flowdesk.planning import PlanningService, fingerprint
from flowdesk.storage import ConflictError, NotFoundError, Store
from flowdesk.validation import ValidationError
from test_planning import FakePlanner, payload, propose, save, wait_for, workspace
from test_planning_questions import QuestionPlanner, answer_payload, reply


def reviewed(service, project):
    proposal = propose(service, project)
    detail = service.proposal_detail(project["id"], proposal["id"])
    return proposal, detail, deepcopy(detail["content"]["diagrams"][0])


def acceptance(project, detail, diagram):
    return {"mutationId": str(uuid4()), "baseRevision": project["revision"],
            "contentHash": detail["contentHash"], "diagram": diagram}


def test_detail_returns_saved_candidate_and_original_without_mutation(workspace):
    store, project, service, _ = workspace
    proposal, detail, diagram = reviewed(service, project)
    assert detail["proposal"] == proposal
    assert detail["baseContent"] == project["content"]
    assert detail["contentHash"] == fingerprint(detail["content"])
    assert diagram["nodes"][0]["title"] == "Review the proposed input validation"
    assert store.get_project(project["id"]) == project
    other = store.create_project()
    with pytest.raises(NotFoundError):
        service.proposal_detail(other["id"], proposal["id"])


def test_original_snapshot_survives_history_retention_and_falls_back_safely(workspace):
    store, project, service, _ = workspace
    proposal, detail, _ = reviewed(service, project)
    with closing(store.connect()) as db, db:
        db.execute("DELETE FROM planning_requests WHERE project_id=?", (project["id"],))
    assert service.proposal_detail(project["id"], proposal["id"])["baseContent"] == project["content"]
    # Once both provenance sources are unavailable, do not invent a baseline.
    with closing(store.connect()) as db, db:
        db.execute("UPDATE planning_proposals SET base_cursor=? WHERE id=?", ("missing", proposal["id"]))
    assert service.proposal_detail(project["id"], proposal["id"])["baseContent"] is None
    assert service.proposal_detail(project["id"], proposal["id"])["content"] == detail["content"]


def test_request_snapshot_is_available_after_history_cursor_removed(workspace):
    store, project, service, _ = workspace
    proposal, _, _ = reviewed(service, project)
    changed = deepcopy(project["content"])
    changed["notes"] = "New content"
    save(store, project, changed)
    with closing(store.connect()) as db, db:
        db.execute("DELETE FROM history_checkpoints WHERE project_id=? AND id=?", (project["id"], project["cursor"]))
    detail = service.proposal_detail(project["id"], proposal["id"])
    assert detail["baseContent"] == project["content"]
    assert detail["proposal"]["state"] == "stale"


def test_manual_acceptance_is_atomic_durable_single_undo_and_retryable(workspace):
    store, project, service, _ = workspace
    proposal, detail, diagram = reviewed(service, project)
    diagram["nodes"][0]["title"] = "My revised proposal"
    diagram["nodes"][0]["notes"] = "Keep these manual refinements"
    diagram["nodes"][0]["position"]["x"] += 180
    mutation = acceptance(project, detail, diagram)
    applied = service.accept(project["id"], proposal["id"], mutation)["project"]
    assert applied["content"]["diagrams"][0] == diagram
    assert len(applied["history"]) == 2 and applied["revision"] == 1
    for field in ("variables", "nodeLinks", "matches", "name", "notes"):
        assert applied["content"][field] == project["content"][field]
    assert applied["content"]["diagrams"][1] == project["content"]["diagrams"][1]
    # The immutable agent candidate remains inspectable after accepting edits.
    assert service.proposal_detail(project["id"], proposal["id"])["content"] == detail["content"]
    undone = save(store, applied, cursor=project["cursor"])
    restored = PlanningService(Store(store.db_path), FakePlanner())
    assert restored.accept(project["id"], proposal["id"], mutation)["project"] == undone
    assert save(store, undone, cursor=applied["cursor"])["content"] == applied["content"]
    with pytest.raises(ValidationError, match="reused"):
        restored.accept(project["id"], proposal["id"], {**mutation, "contentHash": "different"})


def test_manual_deletion_prunes_only_deleted_links_and_undo_restores(workspace):
    store, project, service, _ = workspace
    proposal, detail, diagram = reviewed(service, project)
    target = project["content"]["nodeLinks"][0]["nodeId"]
    diagram["nodes"] = [node for node in diagram["nodes"] if node["id"] != target]
    diagram["edges"] = [edge for edge in diagram["edges"] if target not in (edge["source"], edge["target"])]
    applied = service.accept(project["id"], proposal["id"], acceptance(project, detail, diagram))["project"]
    assert applied["content"]["nodeLinks"] == [link for link in project["content"]["nodeLinks"] if link["nodeId"] != target]
    assert save(store, applied, cursor=project["cursor"])["content"] == project["content"]


def test_restoring_an_agent_deleted_node_preserves_its_original_links(workspace):
    store, project, service, planner = workspace
    original = project["content"]["diagrams"][0]
    removed = project["content"]["nodeLinks"][0]["nodeId"]
    candidate = deepcopy(original)
    candidate["nodes"] = [n for n in candidate["nodes"] if n["id"] != removed]
    candidate["edges"] = [e for e in candidate["edges"] if removed not in (e["source"], e["target"])]
    planner.response = {"message": "Review deletion", "proposal": {"title": "Remove node", "summary": "Review this deletion",
                        "diagramId": original["id"], "nodes": candidate["nodes"], "edges": candidate["edges"]}}
    proposal = propose(service, project)
    detail = service.proposal_detail(project["id"], proposal["id"])
    restored = deepcopy(original)
    restored["nodes"][0]["notes"] = "Instead, keep this step with clearer intent"
    applied = service.accept(project["id"], proposal["id"], acceptance(project, detail, restored))["project"]
    assert applied["content"]["nodeLinks"] == project["content"]["nodeLinks"]


@pytest.mark.parametrize("invalid", ["id", "name", "extra", "foreign_edge", "duplicate_id", "null", "no_changes", "hash"])
def test_invalid_edited_acceptance_leaves_receipt_history_and_review_intact(workspace, invalid):
    store, project, service, _ = workspace
    proposal, detail, diagram = reviewed(service, project)
    mutation = acceptance(project, detail, diagram)
    if invalid == "id": diagram["id"] = project["content"]["diagrams"][1]["id"]
    elif invalid == "name": diagram["name"] = "Sneaky rename"
    elif invalid == "extra": diagram["variables"] = []
    elif invalid == "foreign_edge": diagram["edges"][0]["target"] = "unknown"
    elif invalid == "duplicate_id": diagram["nodes"][1]["id"] = diagram["nodes"][0]["id"]
    elif invalid == "null": mutation["diagram"] = None
    elif invalid == "no_changes": mutation["diagram"] = project["content"]["diagrams"][0]
    else: mutation["contentHash"] = "wrong"
    with pytest.raises((ValidationError, RuntimeError)):
        service.accept(project["id"], proposal["id"], mutation)
    assert store.get_project(project["id"]) == project
    assert service.state(project["id"])["proposals"][0]["state"] == "pending"
    with closing(store.connect()) as db:
        assert db.execute("SELECT COUNT(*) FROM planning_receipts").fetchone()[0] == 0


def test_edited_acceptance_rolls_back_and_rejects_stale_base(workspace, monkeypatch):
    store, project, service, _ = workspace
    proposal, detail, diagram = reviewed(service, project)
    diagram["nodes"][0]["notes"] = "Edited draft"
    mutation = acceptance(project, detail, diagram)
    original = store._write_current
    def fail(db, project_id, content):
        original(db, project_id, content)
        raise RuntimeError("Injected write error")
    monkeypatch.setattr(store, "_write_current", fail)
    with pytest.raises(RuntimeError, match="Injected"):
        service.accept(project["id"], proposal["id"], mutation)
    assert store.get_project(project["id"]) == project
    monkeypatch.setattr(store, "_write_current", original)
    changed = deepcopy(project["content"]); changed["notes"] = "Keep later edits"
    current = save(store, project, changed)
    with pytest.raises(ConflictError):
        service.accept(project["id"], proposal["id"], mutation)
    with pytest.raises(RuntimeError, match="plan changed"):
        service.accept(project["id"], proposal["id"], {**mutation, "baseRevision": current["revision"]})
    assert store.get_project(project["id"]) == current


@pytest.mark.parametrize("manual", [False, True])
def test_revision_uses_unapplied_candidate_and_retains_original(workspace, manual):
    store, project, service, planner = workspace
    proposal, detail, diagram = reviewed(service, project)
    if manual: diagram["nodes"][0]["notes"] = "My draft refinement"
    planner.response = {"message": "Tell me more", "proposal": None}
    request = payload(project, "Refine the proposal", proposalId=proposal["id"])
    if manual: request["proposalDiagram"] = diagram
    service.send_message(project["id"], request)
    state = wait_for(service, project["id"])
    review = planner.contexts[-1]["reviewProposal"]
    assert review == {"id": proposal["id"], "title": proposal["title"], "summary": proposal["summary"], "diagram": diagram, "stale": False}
    assert state["proposals"][0]["state"] == "pending"
    assert store.get_project(project["id"]) == project
    assert service.proposal_detail(project["id"], proposal["id"])["content"] == detail["content"]


def test_failed_revision_retry_keeps_frozen_candidate_and_current_base(workspace):
    store, project, service, planner = workspace
    proposal, _, diagram = reviewed(service, project)
    changed = deepcopy(project["content"]); changed["notes"] = "Later manual work"
    current = save(store, project, changed)
    planner.response = RuntimeError("Try again")
    request = payload(project, "Reconcile this candidate", proposalId=proposal["id"], proposalDiagram=diagram)
    service.send_message(project["id"], request)
    assert wait_for(service, project["id"])["request"]["status"] == "failed"
    frozen = deepcopy(planner.contexts[-1])
    assert frozen["reviewProposal"]["stale"] and frozen["content"] == changed
    changed_again = deepcopy(changed); changed_again["notes"] = "Even newer manual work"
    latest = save(store, current, changed_again)
    planner.response = {"message": "Still reviewing", "proposal": None}
    service.send_message(project["id"], request)
    assert wait_for(service, project["id"])["request"]["status"] == "succeeded"
    assert planner.contexts[-1] == frozen
    assert store.get_project(project["id"]) == latest


def test_revised_proposal_can_be_applied_once_without_applying_original(workspace):
    store, project, service, planner = workspace
    original, _, diagram = reviewed(service, project)
    diagram["nodes"][0]["notes"] = "Manually refined before asking"
    diagram["nodes"][1]["title"] = "Agent's requested refinement"
    planner.response = {"message": "A revised candidate", "proposal": {"title": "Revised candidate", "summary": "Retain manual work",
                        "diagramId": diagram["id"], "nodes": diagram["nodes"], "edges": diagram["edges"]}}
    service.send_message(project["id"], payload(project, "Refine the next step", proposalId=original["id"], proposalDiagram=diagram))
    state = wait_for(service, project["id"])
    revised = next(p for p in state["proposals"] if p["id"] != original["id"])
    assert all(p["state"] == "pending" for p in state["proposals"])
    assert store.get_project(project["id"]) == project
    result = service.accept(project["id"], revised["id"], {"mutationId": str(uuid4()), "baseRevision": 0})
    assert len(result["project"]["history"]) == 2
    assert result["project"]["content"]["diagrams"][0] == diagram
    assert next(p for p in result["planning"]["proposals"] if p["id"] == original["id"])["state"] == "stale"


@pytest.mark.parametrize("invalid", ["other_project", "other_diagram", "rejected", "no_proposal", "bad_candidate"])
def test_invalid_revision_is_rejected_before_recording_messages(workspace, invalid):
    store, project, service, _ = workspace
    proposal, _, diagram = reviewed(service, project)
    request = payload(project, "Revise", proposalId=proposal["id"], proposalDiagram=diagram)
    target = project
    if invalid == "other_project":
        target = store.create_project(); request["diagramId"] = target["content"]["diagrams"][0]["id"]
    elif invalid == "other_diagram": request["diagramId"] = project["content"]["diagrams"][1]["id"]
    elif invalid == "rejected": service.reject(project["id"], proposal["id"], {"mutationId": str(uuid4())})
    elif invalid == "no_proposal": del request["proposalId"]
    else: diagram["edges"][0]["target"] = "missing"
    before = service.state(target["id"])
    with pytest.raises((ValidationError, NotFoundError)):
        service.send_message(target["id"], request)
    assert service.state(target["id"]) == before


def test_revision_clarification_continuation_and_retry_keep_candidate(workspace):
    store, project, service, _ = workspace
    proposal, _, diagram = reviewed(service, project)
    diagram["nodes"][0]["notes"] = "User manual refinement"
    provider = QuestionPlanner()
    service = PlanningService(store, provider)
    service.send_message(project["id"], payload(project, "Revise", proposalId=proposal["id"], proposalDiagram=diagram))
    question = wait_for(service, project["id"])["questionSets"][0]
    review = deepcopy(provider.contexts[-1]["reviewProposal"])
    provider.response = RuntimeError("Temporary failure")
    service.answer_questions(project["id"], question["id"], answer_payload(project))
    failed = wait_for(service, project["id"])
    assert failed["request"]["status"] == "failed"
    assert failed["request"]["payload"]["proposalDiagram"] == diagram
    assert provider.contexts[-1]["reviewProposal"] == review
    provider.response = reply()
    service.send_message(project["id"], failed["request"]["payload"])
    assert wait_for(service, project["id"])["request"]["status"] == "succeeded"
    assert provider.contexts[-1]["reviewProposal"] == review
    assert store.get_project(project["id"]) == project


def test_api_detail_protection_and_large_manual_candidate(tmp_path):
    from flowdesk.app import create_app
    app = create_app(tmp_path, testing=True, planner=FakePlanner())
    client = app.test_client()
    headers = {"X-FlowDesk-Token": client.get("/api/bootstrap").json["token"]}
    project = client.post("/api/projects", json={"sample": True}, headers=headers).json
    service = app.extensions["flowdesk_planning"]
    proposal, detail, diagram = reviewed(service, project)
    url = f'/api/projects/{project["id"]}/planning/proposals/{proposal["id"]}'
    assert client.get(url).status_code == 403
    assert client.get(url, headers={**headers, "Origin": "https://evil.example"}).status_code == 403
    assert client.get(url, headers=headers).json == detail
    for node in diagram["nodes"][:3]: node["notes"] = "n" * 30000
    accepted = client.post(url + "/accept", headers=headers, json=acceptance(project, detail, diagram))
    assert accepted.status_code == 200
    assert accepted.json["project"]["content"]["diagrams"][0] == diagram
    assert client.post(url + "/accept", headers=headers, json={"diagram": "n" * 2_100_000}).status_code == 400
