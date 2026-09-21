"""Brief intent is manual content; generated edits remain reviewable and durable."""
from contextlib import closing
from copy import deepcopy
import json
from uuid import uuid4

import pytest

from flowdesk.app import create_app
from flowdesk.content_versions import BRIEF_FIELDS, empty_brief
from flowdesk.exports import import_project, markdown_brief, portable_project
from flowdesk.planning import PlanningService, fingerprint, manual_fingerprint, provider_context_for
from flowdesk.sample import sample_content
from flowdesk.storage import Store
from flowdesk.validation import ValidationError, validate_content
from test_planning import FakePlanner, payload, propose, save, wait_for
from test_planning_questions import QuestionPlanner, answer_payload, questions


class BriefPlanner(QuestionPlanner):
    def configure(self, selection):
        return {**super().configure(selection), "protocolVersion": 3, "instructionVersion": "planner-v4"}


def response(project, *, graph=False, brief=True):
    diagram = deepcopy(project["content"]["diagrams"][0])
    if graph:
        diagram["nodes"][0]["title"] = "Proposed first step"
    candidate = {**empty_brief(), "goal": "An offline task CLI", "audience": "One local developer",
                 "decisions": "Use Python", "assumptions": "SQLite is a candidate, not an agreed requirement"}
    return {"protocolVersion": 3, "kind": "proposal", "message": "Review the proposed brief.", "questions": [],
            "proposal": {"title": "Clarify intent", "summary": "Keep assumptions explicit", "diagramId": diagram["id"],
                         "nodes": diagram["nodes"] if graph else None, "edges": diagram["edges"] if graph else None,
                         "brief": candidate if brief else None}}


@pytest.fixture
def workspace(tmp_path):
    store = Store(tmp_path / "data.sqlite3")
    project = store.create_project(content=sample_content())
    planner = BriefPlanner(response(project))
    return store, project, PlanningService(store, planner), planner


def draft(service, project, proposal, *, brief=None, diagram=None):
    detail = service.proposal_detail(project["id"], proposal["id"])
    request = {"mutationId": str(uuid4()), "baseDraftRevision": 0, "contentHash": detail["contentHash"]}
    if brief is not None:
        request["brief"] = brief
    if diagram is not None:
        request["diagram"] = diagram
    key = str(uuid4())
    saved = service.drafts.save(project["id"], proposal["id"], key, request)["draft"]
    return detail, saved


def test_manual_brief_restart_undo_redo_and_approval_freshness(workspace):
    store, project, service, _ = workspace
    approved = service.approve(project["id"], {"mutationId": str(uuid4()), "baseRevision": project["revision"]})["approval"]
    assert approved["current"]
    content = deepcopy(project["content"])
    content["brief"].update(goal="Manage tasks", requirements="Works offline", decisions="Use Python", assumptions="Storage remains undecided")
    edited = save(store, project, content)
    assert not service.state(project["id"])["approval"]["current"]
    restarted = Store(store.db_path)
    assert restarted.get_project(project["id"])["content"]["brief"] == content["brief"]
    undone = save(restarted, edited, cursor=project["cursor"])
    assert undone["content"]["brief"] == empty_brief()
    assert PlanningService(restarted, FakePlanner()).state(project["id"])["approval"]["current"]
    redone = save(restarted, undone, cursor=edited["cursor"])
    assert redone["content"] == content


def test_brief_export_import_and_legacy_format_are_portable(workspace):
    store, project, _, _ = workspace
    content = deepcopy(project["content"])
    content["brief"] = {field: f"{field}: <script>alert(1)</script> *plain*" for field in BRIEF_FIELDS}
    project = save(store, project, content)
    document = portable_project(project, [])
    assert document["version"] == 2 and document["content"]["schemaVersion"] == 2
    restored = import_project(store, document)
    assert restored["content"]["brief"] == content["brief"]
    markdown = markdown_brief(content)
    assert "### Agreed decisions" in markdown and "### Assumptions" in markdown
    assert "<script>" not in markdown and "&lt;script&gt;" in markdown
    legacy = deepcopy(document)
    legacy["version"] = legacy["content"]["schemaVersion"] = 1
    legacy["content"].pop("brief")
    old = import_project(store, legacy)
    assert old["content"]["schemaVersion"] == 2 and old["content"]["brief"] == empty_brief()


@pytest.mark.parametrize("invalid", [None, [], {"goal": 42}, {"unexpected": "text"}, {"goal": "x" * 32769}])
def test_brief_validation_rejects_invalid_fields(workspace, invalid):
    _, project, _, _ = workspace
    content = deepcopy(project["content"]); content["brief"] = invalid
    with pytest.raises(ValidationError):
        validate_content(content)


@pytest.mark.parametrize("graph", [False, True])
def test_agent_brief_draft_is_reviewed_and_applied_as_one_action(workspace, graph):
    store, project, service, planner = workspace
    planner.response = response(project, graph=graph)
    proposal = propose(service, project)
    assert proposal["editableSections"] == (["diagram", "brief"] if graph else ["brief"])
    assert any(change["kind"] == "update_brief" for change in proposal["changes"])
    authored = {**planner.response["proposal"]["brief"], "requirements": "Manual draft requirement"}
    detail, saved = draft(service, project, proposal, brief=authored)
    assert store.get_project(project["id"]) == project
    restarted = PlanningService(Store(store.db_path), planner)
    recovered = restarted.drafts.get(project["id"], proposal["id"], saved["id"])["draft"]
    assert recovered["candidate"]["brief"] == authored
    if graph:
        assert recovered["candidate"]["diagrams"][0]["nodes"][0]["title"] == "Proposed first step"
    prepared = restarted.drafts.prepare(project["id"], proposal["id"], saved["id"], {
        "mutationId": str(uuid4()), "baseRevision": project["revision"], "baseDraftRevision": saved["draftRevision"]})
    applied = restarted.accept(project["id"], proposal["id"], prepared["applyRequest"])["project"]
    assert applied["content"]["brief"] == authored and len(applied["history"]) == len(project["history"]) + 1
    if not graph:
        assert applied["content"]["diagrams"] == project["content"]["diagrams"]
        assert applied["content"]["nodeLinks"] == project["content"]["nodeLinks"]
    assert restarted.accept(project["id"], proposal["id"], prepared["applyRequest"])["project"] == applied
    assert save(store, applied, cursor=project["cursor"])["content"] == project["content"]


@pytest.mark.parametrize("legacy", [False, True])
def test_draft_and_revision_cannot_edit_unproposed_sections(workspace, legacy):
    store, project, service, _ = workspace
    if legacy:
        service = PlanningService(store, FakePlanner())
    proposal = propose(service, project)
    detail = service.proposal_detail(project["id"], proposal["id"])
    field, candidate = ("brief", empty_brief()) if legacy else ("diagram", project["content"]["diagrams"][0])
    with pytest.raises(ValidationError, match="does not include"):
        service.drafts.save(project["id"], proposal["id"], str(uuid4()), {
            "mutationId": str(uuid4()), "baseDraftRevision": 0, "contentHash": detail["contentHash"], field: candidate})
    with pytest.raises(ValidationError, match="does not include"):
        service.send_message(project["id"], payload(project, proposalId=proposal["id"], **{"proposal" + field.capitalize(): candidate}))
    assert store.get_project(project["id"]) == project


def test_review_brief_questions_and_retry_keep_exact_candidate(workspace):
    store, project, service, planner = workspace
    proposal = propose(service, project)
    authored = {**planner.response["proposal"]["brief"], "constraints": "User-authored candidate restriction"}
    planner.response = {"protocolVersion": 3, "kind": "questions", "message": "", "questions": questions(), "proposal": None}
    request = payload(project, "Revise this brief", proposalId=proposal["id"], proposalBrief=authored)
    service.send_message(project["id"], request)
    state = wait_for(service, project["id"])
    assert state["request"]["status"] == "succeeded", state["request"]
    review = planner.contexts[-1]["reviewProposal"]
    assert review["brief"] == authored and review["editableSections"] == ["brief"]
    planner.response = RuntimeError("Synthetic interruption")
    service.answer_questions(project["id"], state["questionSets"][-1]["id"], answer_payload(project))
    state = wait_for(service, project["id"])
    assert state["request"]["status"] == "failed"
    continuation = state["request"]["payload"]
    assert continuation["proposalBrief"] == authored and "proposalDiagram" not in continuation
    frozen = deepcopy(planner.contexts[-1])
    planner.response = {"protocolVersion": 3, "kind": "reply", "message": "Keep the requirement", "questions": [], "proposal": None}
    changed = deepcopy(project["content"]); changed["brief"]["goal"] = "A later saved goal"
    save(store, project, changed)
    service.send_message(project["id"], continuation)
    assert wait_for(service, project["id"])["request"]["status"] == "succeeded"
    assert planner.contexts[-1] == frozen
    assert service.proposal_detail(project["id"], proposal["id"])["proposal"]["state"] == "stale"


def test_large_conversation_keeps_current_brief_while_omitting_old_messages(workspace):
    store, project, service, planner = workspace
    content = deepcopy(project["content"]); content["brief"]["decisions"] = "The permanent agreed decision"
    project = save(store, project, content)
    with closing(store.connect()) as db, db:
        for index in range(225):
            db.execute("INSERT INTO planning_messages VALUES(?,?,?,?,?,?,?,?,?)", (
                str(uuid4()), project["id"], "user", "Old discussion " + "x" * 4000, f"2026-09-21T00:{index:03d}", None, None, None, None))
    planner.response = {"protocolVersion": 3, "kind": "reply", "message": "The brief is available.", "questions": [], "proposal": None}
    service.send_message(project["id"], payload(project, "What did we agree?"))
    assert wait_for(service, project["id"])["request"]["status"] == "succeeded"
    context = planner.contexts[-1]
    assert context["content"]["brief"] == content["brief"]
    assert context["omittedMessageCount"] > 25 and len(context["messages"]) < 200


@pytest.mark.parametrize("case", ["both_null", "missing_brief", "nodes_only", "edges_only", "no_change"])
def test_malformed_or_empty_proposal_does_not_change_plan(workspace, case):
    store, project, service, planner = workspace
    candidate = response(project)
    if case == "both_null": candidate["proposal"]["brief"] = None
    elif case == "missing_brief": candidate["proposal"].pop("brief")
    elif case == "nodes_only": candidate["proposal"]["nodes"] = []
    elif case == "edges_only": candidate["proposal"]["edges"] = []
    else: candidate["proposal"]["brief"] = empty_brief()
    planner.response = candidate
    service.send_message(project["id"], payload(project))
    state = wait_for(service, project["id"])
    assert state["request"]["status"] == "failed" and not state["proposals"]
    assert store.get_project(project["id"]) == project


def test_large_brief_only_draft_and_revision_are_allowed_by_api(tmp_path):
    planner = BriefPlanner()
    app = create_app(tmp_path, testing=True, planner=planner)
    store, service = app.extensions["flowdesk_store"], app.extensions["flowdesk_planning"]
    project = store.create_project(content=sample_content())
    planner.response = response(project)
    proposal = propose(service, project)
    detail = service.proposal_detail(project["id"], proposal["id"])
    client = app.test_client(); token = client.get("/api/bootstrap").json["token"]
    client.environ_base["HTTP_X_FLOWDESK_TOKEN"] = token
    brief = {field: field + "x" * 11000 for field in BRIEF_FIELDS}
    base = f"/api/projects/{project['id']}/planning"
    saved = client.put(base + f"/proposals/{proposal['id']}/drafts/{uuid4()}", json={
        "mutationId": str(uuid4()), "baseDraftRevision": 0, "contentHash": detail["contentHash"], "brief": brief})
    assert saved.status_code == 200, saved.json
    planner.response = {"protocolVersion": 3, "kind": "reply", "message": "Ready", "questions": [], "proposal": None}
    sent = client.post(base + "/messages", json=payload(project, proposalId=proposal["id"], proposalBrief=brief))
    assert sent.status_code == 202, sent.json
    assert wait_for(service, project["id"])["request"]["status"] == "succeeded"


def test_semantic_hash_preserves_empty_legacy_identity_and_detects_real_brief(workspace):
    _, project, _, _ = workspace
    legacy = deepcopy(project["content"]); legacy["schemaVersion"] = 1; legacy.pop("brief")
    assert manual_fingerprint(project["content"]) == fingerprint(legacy)
    changed = deepcopy(project["content"]); changed["brief"]["assumptions"] = "Not agreed"
    assert manual_fingerprint(changed) != fingerprint(legacy)
