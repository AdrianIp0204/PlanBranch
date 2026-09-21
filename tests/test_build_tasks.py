"""Implementation tasks stay distinct from program flow and remain reviewable."""
from contextlib import closing
from copy import deepcopy
from uuid import uuid4

import pytest

from flowdesk.app import create_app
from flowdesk.content_versions import CONTENT_VERSION, empty_brief
from flowdesk.exports import EXPORT_VERSION, import_project, markdown_brief, portable_project
from flowdesk.planning import PlanningService, manual_fingerprint
from flowdesk.sample import sample_content
from flowdesk.storage import Store
from flowdesk.validation import ValidationError, validate_content
from test_planning import FakePlanner, payload, propose, save, wait_for
from test_project_brief import BriefPlanner
from test_planning_questions import answer_payload, questions


def task(title="Implement command parsing", *, key=None, node=None, diagram=None, prerequisites=None):
    return {"id": key or str(uuid4()), "title": title, "deliverable": "A parser with predictable commands",
            "nodeLinks": [{"nodeId": node["id"], "diagramId": diagram["id"], "title": node["title"], "missing": False}] if node else [],
            "prerequisiteIds": prerequisites or [], "expectedFiles": ["cli.py", "Parsing layer"],
            "acceptanceChecks": [{"id": str(uuid4()), "text": "Unknown commands report a useful error"}], "status": "not_started"}


class BuildPlanner(BriefPlanner):
    def configure(self, selection):
        return {**super().configure(selection), "protocolVersion": 4, "instructionVersion": "planner-v5"}


def response(project, *, tasks=None, graph=False, brief=False):
    diagram = deepcopy(project["content"]["diagrams"][0])
    if graph:
        diagram["nodes"][0]["title"] = "Proposed runtime step"
    if tasks is None:
        tasks = [task(node=diagram["nodes"][0], diagram=diagram)]
    return {"protocolVersion": 4, "kind": "proposal", "message": "Review the implementation tasks.", "questions": [],
            "proposal": {"title": "Build the command parser", "summary": "Keep runtime flow separate", "diagramId": diagram["id"],
                         "nodes": diagram["nodes"] if graph else None, "edges": diagram["edges"] if graph else None,
                         "brief": {**empty_brief(), "goal": "Ship the CLI"} if brief else None, "buildTasks": tasks}}


@pytest.fixture
def workspace(tmp_path):
    store = Store(tmp_path / "data.sqlite3")
    project = store.create_project(content=sample_content())
    provider = BuildPlanner(response(project))
    return store, project, PlanningService(store, provider), provider


def with_tasks(project):
    content = deepcopy(project["content"])
    diagram = content["diagrams"][0]
    first = task(node=diagram["nodes"][0], diagram=diagram)
    second = task("Implement task storage", prerequisites=[first["id"]])
    content["buildTasks"] = [first, second]
    return content


def save_draft(service, project, proposal, tasks):
    detail = service.proposal_detail(project["id"], proposal["id"])
    draft_id = str(uuid4())
    request = {"mutationId": str(uuid4()), "baseDraftRevision": 0, "contentHash": detail["contentHash"], "buildTasks": tasks}
    saved = service.drafts.save(project["id"], proposal["id"], draft_id, request)["draft"]
    return saved


def apply_draft(service, project, proposal, saved):
    prepared = service.drafts.prepare(project["id"], proposal["id"], saved["id"], {
        "mutationId": str(uuid4()), "baseRevision": project["revision"], "baseDraftRevision": saved["draftRevision"]})
    return service.accept(project["id"], proposal["id"], prepared["applyRequest"])["project"], prepared["applyRequest"]


def test_task_order_links_status_and_prerequisites_survive_history_restart(workspace):
    store, project, service, _ = workspace
    content = with_tasks(project)
    content["buildTasks"][0]["status"] = "done"
    # Program cycles are valid; they do not become Build prerequisites.
    diagram = content["diagrams"][0]
    diagram["edges"].append({"id": str(uuid4()), "source": diagram["nodes"][0]["id"], "target": diagram["nodes"][0]["id"], "label": "Retry"})
    initial = save(store, project, content)
    reordered = deepcopy(initial["content"]); reordered["buildTasks"].reverse()
    latest = save(store, initial, reordered)
    restored = Store(store.db_path).get_project(project["id"])
    assert restored == latest
    assert restored["content"]["diagrams"][0]["nodes"][0]["status"] == project["content"]["diagrams"][0]["nodes"][0]["status"]
    undone = save(store, restored, cursor=initial["cursor"])
    assert undone["content"] == initial["content"]
    assert save(store, undone, cursor=latest["cursor"])["content"] == latest["content"]


def test_deleted_node_keeps_task_and_last_known_link_and_undo_restores_it(workspace):
    store, project, _, _ = workspace
    initial = save(store, project, with_tasks(project))
    content = deepcopy(initial["content"])
    removed = content["diagrams"][0]["nodes"].pop(0)
    diagram = content["diagrams"][0]
    diagram["edges"] = [edge for edge in diagram["edges"] if removed["id"] not in (edge["source"], edge["target"])]
    content["nodeLinks"] = [link for link in content["nodeLinks"] if link["nodeId"] != removed["id"]]
    deleted = save(store, initial, content)
    assert len(deleted["content"]["buildTasks"]) == 2
    link = deleted["content"]["buildTasks"][0]["nodeLinks"][0]
    assert link == {"nodeId": removed["id"], "diagramId": diagram["id"], "title": removed["title"], "missing": True}
    restored = save(store, deleted, cursor=initial["cursor"])
    assert restored["content"]["buildTasks"][0]["nodeLinks"][0]["missing"] is False


def test_live_links_follow_node_rename_and_diagram_move(workspace):
    _, project, _, _ = workspace
    content = with_tasks(project)
    node = content["diagrams"][0]["nodes"].pop(0)
    content["diagrams"][0]["edges"] = [e for e in content["diagrams"][0]["edges"] if node["id"] not in (e["source"], e["target"])]
    node["title"] = "Renamed runtime behaviour"
    other = {"id": str(uuid4()), "name": "Moved flow", "nodes": [node], "edges": []}
    content["diagrams"].append(other)
    normalized = validate_content(content)
    assert normalized["buildTasks"][0]["nodeLinks"][0] == {
        "nodeId": node["id"], "diagramId": other["id"], "title": node["title"], "missing": False}


@pytest.mark.parametrize("case", ["cycle", "self", "unknown", "duplicate", "global_id", "duplicate_check", "duplicate_link", "bad_missing", "incomplete_shape"])
def test_invalid_build_relationships_are_rejected_atomically(workspace, case):
    store, project, _, _ = workspace
    content = with_tasks(project); first, second = content["buildTasks"]
    if case == "cycle": first["prerequisiteIds"] = [second["id"]]
    elif case == "self": first["prerequisiteIds"] = [first["id"]]
    elif case == "unknown": first["prerequisiteIds"] = ["missing-task"]
    elif case == "duplicate": second["prerequisiteIds"] *= 2
    elif case == "global_id": first["id"] = content["diagrams"][0]["nodes"][0]["id"]
    elif case == "duplicate_check": second["acceptanceChecks"][0]["id"] = first["acceptanceChecks"][0]["id"]
    elif case == "duplicate_link": first["nodeLinks"] *= 2
    elif case == "bad_missing": first["nodeLinks"][0]["missing"] = "false"
    else: first.pop("deliverable")
    with pytest.raises(ValidationError): save(store, project, content)
    assert store.get_project(project["id"]) == project


def test_incomplete_tasks_save_and_long_dag_avoids_recursive_validation(workspace):
    _, project, _, _ = workspace
    content = deepcopy(project["content"])
    content["buildTasks"] = [task("", key=f"build-{i}", prerequisites=[f"build-{i-1}"] if i else []) for i in range(1000)]
    first = content["buildTasks"][0]
    first.update(deliverable="", expectedFiles=[""], acceptanceChecks=[{"id": "blank-check", "text": ""}])
    assert len(validate_content(content)["buildTasks"]) == 1000
    content["buildTasks"][0]["prerequisiteIds"] = ["build-999"]
    with pytest.raises(ValidationError, match="cycle"):
        validate_content(content)
    content["buildTasks"][0]["prerequisiteIds"] = []
    content["buildTasks"].append(task())
    with pytest.raises(ValidationError, match="1000"):
        validate_content(content)


def test_json_remaps_tasks_checks_prerequisites_and_shared_missing_links(workspace):
    store, project, _, _ = workspace
    content = with_tasks(project)
    tombstone = {"nodeId": str(uuid4()), "diagramId": str(uuid4()), "title": "Removed flow step", "missing": True}
    for item in content["buildTasks"]: item["nodeLinks"].append(deepcopy(tombstone))
    project = save(store, project, content)
    document = portable_project(project, [])
    assert document["version"] == EXPORT_VERSION == 3
    imported = import_project(store, document)["content"]
    first, second = imported["buildTasks"]
    assert first["id"] != content["buildTasks"][0]["id"] and second["prerequisiteIds"] == [first["id"]]
    assert first["acceptanceChecks"][0]["id"] != content["buildTasks"][0]["acceptanceChecks"][0]["id"]
    assert first["nodeLinks"][0]["nodeId"] == imported["diagrams"][0]["nodes"][0]["id"]
    assert first["nodeLinks"][-1] == second["nodeLinks"][-1]
    assert first["nodeLinks"][-1]["missing"] and first["nodeLinks"][-1]["nodeId"] != tombstone["nodeId"]
    assert first["nodeLinks"][-1]["diagramId"] != tombstone["diagramId"]
    markdown = markdown_brief(imported)
    assert "## Build tasks" in markdown and "Prerequisites:" in markdown and "(removed from diagram)" in markdown
    assert "Unknown commands report a useful error" in markdown


@pytest.mark.parametrize("graph,brief", [(False, False), (True, False), (True, True)])
def test_reviewed_build_draft_apply_is_one_history_action(workspace, graph, brief):
    store, project, service, provider = workspace
    provider.response = response(project, graph=graph, brief=brief)
    proposal = propose(service, project)
    assert proposal["editableSections"] == (["diagram"] if graph else []) + (["brief"] if brief else []) + ["buildTasks"]
    assert any(item["kind"] == "add_build_task" for item in proposal["changes"])
    authored = deepcopy(provider.response["proposal"]["buildTasks"]); authored[0]["deliverable"] = "My precise parser deliverable"
    saved = save_draft(service, project, proposal, authored)
    assert store.get_project(project["id"]) == project
    restarted = PlanningService(Store(store.db_path), provider)
    restored = restarted.drafts.get(project["id"], proposal["id"], saved["id"])["draft"]
    assert restored["candidate"]["buildTasks"][0]["deliverable"] == authored[0]["deliverable"]
    applied, request = apply_draft(restarted, project, proposal, saved)
    assert len(applied["history"]) == 2 and applied["content"]["buildTasks"][0]["deliverable"] == authored[0]["deliverable"]
    if not graph: assert applied["content"]["diagrams"] == project["content"]["diagrams"]
    if brief: assert applied["content"]["brief"]["goal"] == "Ship the CLI"
    assert restarted.accept(project["id"], proposal["id"], request)["project"] == applied
    assert save(store, applied, cursor=project["cursor"])["content"] == project["content"]


def test_graph_proposal_deletion_preserves_build_task_as_missing_link(workspace):
    store, project, service, provider = workspace
    project = save(store, project, with_tasks(project))
    candidate = response(project)
    diagram = deepcopy(project["content"]["diagrams"][0]); deleted = diagram["nodes"].pop(0)
    diagram["edges"] = [edge for edge in diagram["edges"] if deleted["id"] not in (edge["source"], edge["target"])]
    candidate["proposal"].update(nodes=diagram["nodes"], edges=diagram["edges"], buildTasks=None)
    provider.response = candidate
    proposal = propose(service, project)
    assert proposal["editableSections"] == ["diagram"]
    assert any(change["kind"] == "update_build_task" and change["field"] == "nodeLinks" for change in proposal["changes"])
    detail = service.proposal_detail(project["id"], proposal["id"])
    applied = service.accept(project["id"], proposal["id"], {"mutationId": str(uuid4()), "baseRevision": project["revision"], "contentHash": detail["contentHash"]})["project"]
    assert len(applied["content"]["buildTasks"]) == 2
    assert applied["content"]["buildTasks"][0]["nodeLinks"][0]["missing"]


def test_legacy_diagram_proposal_cannot_author_build_tasks(workspace):
    store, project, _, _ = workspace
    service = PlanningService(store, FakePlanner())
    proposal = propose(service, project)
    with pytest.raises(ValidationError, match="does not include"):
        save_draft(service, project, proposal, [task()])
    with pytest.raises(ValidationError, match="does not include"):
        service.send_message(project["id"], payload(project, proposalId=proposal["id"], proposalBuildTasks=[task()]))


def test_build_revision_question_continuation_and_retry_keep_manual_candidate(workspace):
    store, project, service, provider = workspace
    proposal = propose(service, project)
    authored = deepcopy(provider.response["proposal"]["buildTasks"]); authored[0]["title"] = "User-edited build candidate"
    provider.response = {"protocolVersion": 4, "kind": "questions", "message": "", "questions": questions(), "proposal": None}
    service.send_message(project["id"], payload(project, "Refine implementation", proposalId=proposal["id"], proposalBuildTasks=authored))
    state = wait_for(service, project["id"])
    assert state["request"]["status"] == "succeeded", state["request"]
    assert provider.contexts[-1]["reviewProposal"]["buildTasks"] == authored
    provider.response = RuntimeError("Interrupted once")
    service.answer_questions(project["id"], state["questionSets"][-1]["id"], answer_payload(project))
    state = wait_for(service, project["id"])
    request = state["request"]["payload"]
    assert request["proposalBuildTasks"] == authored and "proposalDiagram" not in request
    frozen = deepcopy(provider.contexts[-1])
    provider.response = {"protocolVersion": 4, "kind": "reply", "message": "Keep the candidate", "questions": [], "proposal": None}
    service.send_message(project["id"], request)
    assert wait_for(service, project["id"])["request"]["status"] == "succeeded"
    assert provider.contexts[-1] == frozen


def test_build_only_approval_and_independent_task_edit_freshness(workspace):
    store, _, _, provider = workspace
    project = store.create_project()
    content = deepcopy(project["content"]); content["buildTasks"] = [task("")]
    project = save(store, project, content)
    service = PlanningService(store, provider)
    approval = service.approve(project["id"], {"mutationId": str(uuid4()), "baseRevision": project["revision"]})["approval"]
    assert approval["current"]
    content = deepcopy(project["content"]); content["buildTasks"][0]["status"] = "done"
    save(store, project, content)
    assert not service.state(project["id"])["approval"]["current"]


def test_old_content_hash_and_formats_upgrade_without_task_evidence(workspace):
    store, project, _, _ = workspace
    old = deepcopy(project["content"]); old["schemaVersion"] = 2; old.pop("buildTasks")
    assert manual_fingerprint(old) == manual_fingerprint(project["content"])
    document = {"format": "flowdesk", "version": 2, "content": old, "symbols": [], "views": {}}
    imported = import_project(store, document)
    assert imported["content"]["schemaVersion"] == CONTENT_VERSION and imported["content"]["buildTasks"] == []


def test_large_build_only_draft_and_revision_requests_are_supported(tmp_path):
    provider = BuildPlanner()
    app = create_app(tmp_path, testing=True, planner=provider)
    store, service = app.extensions["flowdesk_store"], app.extensions["flowdesk_planning"]
    project = store.create_project(content=sample_content()); provider.response = response(project)
    proposal = propose(service, project); detail = service.proposal_detail(project["id"], proposal["id"])
    client = app.test_client(); client.environ_base["HTTP_X_FLOWDESK_TOKEN"] = client.get("/api/bootstrap").json["token"]
    tasks = [task() for _ in range(80)]
    for item in tasks: item["deliverable"] = "x" * 1500
    base = f"/api/projects/{project['id']}/planning"
    saved = client.put(base + f"/proposals/{proposal['id']}/drafts/{uuid4()}", json={
        "mutationId": str(uuid4()), "baseDraftRevision": 0, "contentHash": detail["contentHash"], "buildTasks": tasks})
    assert saved.status_code == 200, saved.json
    provider.response = {"protocolVersion": 4, "kind": "reply", "message": "Ready", "questions": [], "proposal": None}
    sent = client.post(base + "/messages", json=payload(project, proposalId=proposal["id"], proposalBuildTasks=tasks))
    assert sent.status_code == 202, sent.json
    assert wait_for(service, project["id"])["request"]["status"] == "succeeded"
