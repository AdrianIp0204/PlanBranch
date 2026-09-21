"""Planning is reviewable, restart-safe, and never an execution permission."""
from contextlib import closing
from copy import deepcopy
import json
import threading
import time
from uuid import uuid4

import pytest

from flowdesk import migrations
from flowdesk.planning import PlanningService, provider_context_for
from flowdesk.sample import sample_content
from flowdesk.storage import ConflictError, NotFoundError, Store, now
from flowdesk.validation import ValidationError


class FakePlanner:
    def __init__(self, response=None, gate=None):
        self.response = response
        self.gate = gate
        self.contexts = []

    def status(self):
        return {"available": True, "label": "Fake Codex CLI"}

    def generate(self, context):
        self.contexts.append(deepcopy(context))
        if self.gate:
            assert self.gate.wait(5), "test failed to release fake provider"
        if isinstance(self.response, Exception):
            raise self.response
        if self.response is not None:
            return deepcopy(self.response)
        diagram = deepcopy(next(d for d in context["content"]["diagrams"] if d["id"] == context["activeDiagramId"]))
        diagram["nodes"][0]["title"] = "Review the proposed input validation"
        return {"message": "I propose a clearer first step.", "proposal": {
            "title": "Clarify input validation", "summary": "Only the first title changes.",
            "diagramId": diagram["id"], "nodes": diagram["nodes"], "edges": diagram["edges"]}}


@pytest.fixture
def workspace(tmp_path):
    store = Store(tmp_path / "data" / "flowdesk.sqlite3")
    content = sample_content()
    content["diagrams"].append({"id": str(uuid4()), "name": "Unrelated diagram", "nodes": [], "edges": []})
    project = store.create_project(content=content)
    planner = FakePlanner()
    service = PlanningService(store, planner)
    return store, project, service, planner


def payload(project, text="Clarify the first step", **extra):
    return {"mutationId": str(uuid4()), "text": text, "diagramId": project["content"]["diagrams"][0]["id"], **extra}


def wait_for(service, project_id):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        state = service.state(project_id)
        if state["request"] and state["request"]["status"] != "running":
            return state
        time.sleep(.01)
    pytest.fail("Planning request did not finish")


def propose(service, project):
    service.send_message(project["id"], payload(project))
    state = wait_for(service, project["id"])
    assert state["request"]["status"] == "succeeded", state["request"]
    return state["proposals"][-1]


def save(store, project, content=None, cursor=None, views=None):
    history = project["history"]
    checkpoint = {"id": str(uuid4()), "label": "Manual change", "content": content} if content is not None else None
    store.save_project(project["id"], {"baseRevision": project["revision"], "mutationId": str(uuid4()),
        "anchorId": history[-1]["id"], "append": [checkpoint] if checkpoint else [],
        "cursor": checkpoint["id"] if checkpoint else cursor or project["cursor"],
        "views": project["views"] if views is None else views})
    return store.get_project(project["id"])


def test_generation_creates_inspectable_proposal_without_changing_project(workspace):
    store, project, service, planner = workspace
    proposal = propose(service, project)
    assert store.get_project(project["id"]) == project
    assert proposal["baseRevision"] == project["revision"]
    assert proposal["baseCursor"] == project["cursor"]
    assert proposal["state"] == "pending"
    assert proposal["changes"] == [{"kind": "update_node", "nodeId": project["content"]["diagrams"][0]["nodes"][0]["id"],
        "field": "title", "label": project["content"]["diagrams"][0]["nodes"][0]["title"] + ": title",
        "before": project["content"]["diagrams"][0]["nodes"][0]["title"], "after": "Review the proposed input validation"}]
    assert planner.contexts[0]["messages"][-1]["role"] == "user"
    assert service.state(project["id"])["messages"][-1]["proposalId"] == proposal["id"]


def test_planning_reads_only_current_snapshot_without_decoding_undo_history(workspace, monkeypatch):
    store, project, service, planner = workspace
    content = deepcopy(project["content"])
    content["notes"] = "The current snapshot has an older undo checkpoint."
    current = save(store, project, content)
    def forbid_history(*args):
        raise AssertionError("Planning polling must not decode retained history")
    monkeypatch.setattr(store, "_history", forbid_history)
    assert service.state(project["id"])["messages"] == []
    node = content["diagrams"][0]["nodes"][0]
    comment = service.add_comment(project["id"], payload(project, nodeId=node["id"]))["comments"][0]
    service.resolve_comment(project["id"], comment["id"], {"resolved": True})
    approval = service.approve(project["id"], {"baseRevision": current["revision"], "mutationId": str(uuid4())})["approval"]
    assert approval["snapshot"] == content
    planner.response = {"message": "The updated notes are included.", "proposal": None}
    service.send_message(project["id"], payload(project))
    assert wait_for(service, project["id"])["request"]["status"] == "succeeded"
    assert planner.contexts[0]["content"]["notes"] == content["notes"]


def test_acceptance_is_one_undoable_action_durable_and_retryable(workspace):
    store, project, service, _ = workspace
    proposal = propose(service, project)
    request = {"baseRevision": project["revision"], "mutationId": str(uuid4())}
    result = service.accept(project["id"], proposal["id"], request)
    changed = result["project"]
    assert changed["revision"] == 1 and len(changed["history"]) == 2
    assert result["planning"]["proposals"][0]["state"] == "accepted"
    assert changed["content"]["diagrams"][1] == project["content"]["diagrams"][1]
    assert changed["content"]["nodeLinks"] == project["content"]["nodeLinks"]
    undone = save(store, changed, cursor=project["cursor"])
    assert undone["content"] == project["content"]
    restored = PlanningService(Store(store.db_path), FakePlanner())
    retry = restored.accept(project["id"], proposal["id"], request)
    assert retry["project"] == undone  # Lost acknowledgements must never restore older content.
    redone = save(store, undone, cursor=changed["cursor"])
    assert redone["content"] == changed["content"]
    assert len(restored.state(project["id"])["messages"]) == 2


def test_acceptance_rolls_back_content_history_receipt_and_review_together(workspace, monkeypatch):
    store, project, service, _ = workspace
    proposal = propose(service, project)
    original = store._write_current
    def fail_after_write(db, project_id, content):
        original(db, project_id, content)
        raise RuntimeError("Injected current projection failure")
    monkeypatch.setattr(store, "_write_current", fail_after_write)
    mutation = {"baseRevision": 0, "mutationId": str(uuid4())}
    with pytest.raises(RuntimeError, match="Injected"):
        service.accept(project["id"], proposal["id"], mutation)
    assert store.get_project(project["id"]) == project
    assert service.state(project["id"])["proposals"][0]["state"] == "pending"
    with closing(store.connect()) as db:
        assert db.execute("SELECT COUNT(*) FROM planning_receipts").fetchone()[0] == 0
    monkeypatch.setattr(store, "_write_current", original)
    assert service.accept(project["id"], proposal["id"], mutation)["project"]["revision"] == 1


def test_stale_proposal_and_stale_tab_cannot_overwrite_manual_changes(workspace):
    store, project, service, _ = workspace
    proposal = propose(service, project)
    content = deepcopy(project["content"])
    content["notes"] = "New user decision"
    changed = save(store, project, content)
    assert service.state(project["id"])["proposals"][0]["state"] == "stale"
    with pytest.raises(ConflictError):
        service.accept(project["id"], proposal["id"], {"baseRevision": 0, "mutationId": str(uuid4())})
    with pytest.raises(RuntimeError, match="plan changed"):
        service.accept(project["id"], proposal["id"], {"baseRevision": 1, "mutationId": str(uuid4())})
    assert store.get_project(project["id"]) == changed


def test_viewport_only_save_does_not_invalidate_proposal_or_approval(workspace):
    store, project, service, _ = workspace
    proposal = propose(service, project)
    diagram_id = project["content"]["diagrams"][0]["id"]
    moved = save(store, project, views={diagram_id: {"x": 123, "y": -54, "zoom": .75}})
    assert service.state(project["id"])["proposals"][0]["state"] == "pending"
    accepted = service.accept(project["id"], proposal["id"], {"baseRevision": moved["revision"], "mutationId": str(uuid4())})["project"]
    approved = service.approve(project["id"], {"baseRevision": accepted["revision"], "mutationId": str(uuid4())})["approval"]
    assert approved["current"] and approved["snapshot"] == accepted["content"]
    moved = save(store, accepted, views={diagram_id: {"x": -82, "y": 102, "zoom": 1.5}})
    assert service.state(project["id"])["approval"] == approved
    assert moved["views"][diagram_id]["zoom"] == 1.5


def test_deletions_review_lost_links_and_comments_survive_removed_node(workspace):
    store, project, service, planner = workspace
    diagram = deepcopy(project["content"]["diagrams"][0])
    node = next(n for n in diagram["nodes"] if any(link["nodeId"] == n["id"] for link in project["content"]["nodeLinks"]))
    comment = service.add_comment(project["id"], payload(project, "Keep this concern", nodeId=node["id"]))["comments"][0]
    diagram["nodes"] = [n for n in diagram["nodes"] if n["id"] != node["id"]]
    diagram["edges"] = [e for e in diagram["edges"] if node["id"] not in (e["source"], e["target"])]
    planner.response = {"message": "Review this deletion.", "proposal": {"title": "Remove step", "summary": "Its links will be removed too.",
        "diagramId": diagram["id"], "nodes": diagram["nodes"], "edges": diagram["edges"]}}
    proposed = propose(service, project)
    kinds = {change["kind"] for change in proposed["changes"]}
    assert {"remove_node", "remove_edge", "remove_link"} <= kinds
    accepted = service.accept(project["id"], proposed["id"], {"baseRevision": 0, "mutationId": str(uuid4())})
    assert accepted["planning"]["comments"] == [comment]
    assert not any(link["nodeId"] == node["id"] for link in accepted["project"]["content"]["nodeLinks"])
    assert service.resolve_comment(project["id"], comment["id"], {"resolved": True})["comments"][0]["resolved"]
    restarted = PlanningService(Store(store.db_path), FakePlanner())
    assert restarted.state(project["id"])["comments"][0] == {**comment, "resolved": True}


def test_comment_scope_validation_and_idempotency(workspace):
    store, project, service, _ = workspace
    node = project["content"]["diagrams"][0]["nodes"][0]
    request = payload(project, "Explain this condition", nodeId=node["id"])
    first = service.add_comment(project["id"], request)
    assert service.add_comment(project["id"], request)["comments"] == first["comments"]
    with pytest.raises(ValidationError, match="reused"):
        service.add_comment(project["id"], {**request, "text": "Different message"})
    other = store.create_project(content=sample_content())
    with pytest.raises(ValidationError, match="diagram"):
        service.add_comment(other["id"], payload(project, nodeId=node["id"]))
    with pytest.raises(NotFoundError):
        service.resolve_comment(other["id"], first["comments"][0]["id"], {"resolved": True})
    with pytest.raises(ValidationError, match="true or false"):
        service.resolve_comment(project["id"], first["comments"][0]["id"], {"resolved": 1})
    assert store.get_project(project["id"]) == project


def test_approval_gates_and_exact_snapshot_durable_reopen(workspace):
    store, project, service, planner = workspace
    empty = store.create_project()
    with pytest.raises(ValidationError, match="planning step"):
        service.approve(empty["id"], {"baseRevision": 0, "mutationId": str(uuid4())})
    node = project["content"]["diagrams"][0]["nodes"][0]
    comment = service.add_comment(project["id"], payload(project, nodeId=node["id"]))["comments"][0]
    with pytest.raises(RuntimeError, match="comments"):
        service.approve(project["id"], {"baseRevision": 0, "mutationId": str(uuid4())})
    service.resolve_comment(project["id"], comment["id"], {"resolved": True})
    proposal = propose(service, project)
    with pytest.raises(RuntimeError, match="pending proposals"):
        service.approve(project["id"], {"baseRevision": 0, "mutationId": str(uuid4())})
    service.reject(project["id"], proposal["id"], {"mutationId": str(uuid4())})
    mutation = {"baseRevision": 0, "mutationId": str(uuid4())}
    approval = service.approve(project["id"], mutation)["approval"]
    assert service.approve(project["id"], mutation)["approval"] == approval
    assert approval["current"] and approval["snapshot"] == project["content"]
    restored = PlanningService(Store(store.db_path), FakePlanner())
    assert restored.state(project["id"])["approval"] == approval
    content = deepcopy(project["content"])
    content["notes"] = "This edit requires review"
    changed = save(store, project, content)
    assert not restored.state(project["id"])["approval"]["current"]
    undone = save(store, changed, cursor=project["cursor"])
    assert restored.state(project["id"])["approval"]["current"]
    restored.reopen(project["id"], {"mutationId": str(uuid4())})
    assert not restored.state(project["id"])["approval"]["current"]
    assert store.get_project(project["id"]) == undone


def test_new_comment_and_message_reopen_approval_without_mutating_graph(workspace):
    store, project, service, planner = workspace
    service.approve(project["id"], {"baseRevision": 0, "mutationId": str(uuid4())})
    node = project["content"]["diagrams"][0]["nodes"][0]
    state = service.add_comment(project["id"], payload(project, nodeId=node["id"]))
    assert not state["approval"]["current"]
    service.resolve_comment(project["id"], state["comments"][0]["id"], {"resolved": True})
    assert not service.state(project["id"])["approval"]["current"]
    service.approve(project["id"], {"baseRevision": 0, "mutationId": str(uuid4())})
    planner.response = {"message": "Here is an explanation.", "proposal": None}
    service.send_message(project["id"], payload(project, "Explain the plan"))
    assert not wait_for(service, project["id"])["approval"]["current"]
    assert store.get_project(project["id"]) == project


def test_single_background_request_safe_retry_and_context_keeps_original_base(workspace):
    store, project, service, planner = workspace
    gate = threading.Event()
    planner.gate = gate
    request = payload(project)
    state = service.send_message(project["id"], request)
    assert state["request"]["status"] == "running"
    assert service.send_message(project["id"], request)["request"]["id"] == request["mutationId"]
    with pytest.raises(RuntimeError, match="current planning reply"):
        service.send_message(project["id"], payload(project, "Concurrent message"))
    with pytest.raises(RuntimeError, match="planning reply"):
        service.approve(project["id"], {"baseRevision": 0, "mutationId": str(uuid4())})
    content = deepcopy(project["content"])
    content["notes"] = "Manual edits remain available during generation"
    save(store, project, content)
    gate.set()
    state = wait_for(service, project["id"])
    assert state["proposals"][0]["state"] == "stale"
    assert len(planner.contexts) == 1 and len(state["messages"]) == 2
    assert service.send_message(project["id"], request)["messages"] == state["messages"]


def test_failed_provider_retry_has_one_user_message_and_no_partial_proposal(workspace):
    store, project, service, planner = workspace
    planner.response = RuntimeError("Codex sign-in is required.")
    request = payload(project)
    service.send_message(project["id"], request)
    state = wait_for(service, project["id"])
    assert state["request"]["status"] == "failed" and "sign-in" in state["request"]["error"]
    assert len(state["messages"]) == 1 and state["proposals"] == []
    planner.response = None
    service.send_message(project["id"], request)
    state = wait_for(service, project["id"])
    assert state["request"]["status"] == "succeeded" and len(state["messages"]) == 2
    assert len(state["proposals"]) == 1
    assert store.get_project(project["id"]) == project


def test_replayed_message_does_not_hold_sqlite_write_lock_during_cli_probe(workspace, monkeypatch):
    store, project, service, planner = workspace
    request = payload(project)
    service.send_message(project["id"], request)
    wait_for(service, project["id"])
    def status_while_writing():
        with closing(store.connect()) as concurrent:
            concurrent.execute("PRAGMA busy_timeout=100")
            concurrent.execute("BEGIN IMMEDIATE")
            concurrent.rollback()
        return {"available": True, "label": "Fake Codex CLI"}
    monkeypatch.setattr(planner, "status", status_while_writing)
    assert service.send_message(project["id"], request)["request"]["status"] == "succeeded"


@pytest.mark.parametrize("invalid", ["cross_diagram", "bad_reference", "change_variable", "no_changes"])
def test_invalid_agent_proposals_never_change_content_or_leave_partial_reply(workspace, invalid):
    store, project, service, planner = workspace
    diagram = deepcopy(project["content"]["diagrams"][0])
    response = {"message": "Proposed changes", "proposal": {"title": "Review", "summary": "Review the changes", "diagramId": diagram["id"], "nodes": diagram["nodes"], "edges": diagram["edges"]}}
    if invalid == "cross_diagram":
        response["proposal"]["diagramId"] = project["content"]["diagrams"][1]["id"]
    elif invalid == "bad_reference":
        response["proposal"]["edges"][0]["target"] = "nonexistent"
    elif invalid == "change_variable":
        response["proposal"]["variables"] = []
    planner.response = response
    service.send_message(project["id"], payload(project))
    state = wait_for(service, project["id"])
    assert state["request"]["status"] == "failed"
    assert state["proposals"] == [] and len(state["messages"]) == 1
    assert store.get_project(project["id"]) == project


def test_provider_context_excludes_scanner_evidence_roots_and_detected_links(tmp_path):
    store = Store(tmp_path / "data.sqlite3")
    content = sample_content()
    symbol_id = str(uuid4())
    content["nodeLinks"].append({"id": str(uuid4()), "nodeId": content["diagrams"][0]["nodes"][0]["id"], "origin": "detected", "variableId": symbol_id, "relationship": "reads"})
    content["matches"] = [{"id": str(uuid4()), "plannedId": content["variables"][0]["id"], "symbolId": symbol_id, "decision": "confirmed"}]
    project = store.create_project(content=content, evidence=[{"id": symbol_id, "name": "secret_evidence", "sourceExcerpt": "private_source_contents"}])
    with closing(store.connect()) as db, db:
        db.execute("INSERT INTO source_attachments VALUES(?,?,?,?)", (project["id"], "/private/source-root", "[]", "authorization"))
    planner = FakePlanner()
    service = PlanningService(store, planner)
    proposal = propose(service, project)
    context = planner.contexts[0]
    serialized = json.dumps(context)
    assert all(word not in serialized for word in ("private/source-root", "private_source_contents", "secret_evidence", "authorization", symbol_id))
    assert context["content"]["variables"] == project["content"]["variables"]
    accepted = service.accept(project["id"], proposal["id"], {"baseRevision": 0, "mutationId": str(uuid4())})["project"]
    assert accepted["content"]["nodeLinks"] == project["content"]["nodeLinks"]
    assert accepted["content"]["matches"] == project["content"]["matches"]


def test_interrupted_request_recovers_as_explicit_failure_and_retries_original_context(workspace):
    store, project, service, planner = workspace
    request = payload(project)
    planner.response = RuntimeError("Injected stop")
    service.send_message(project["id"], request)
    wait_for(service, project["id"])
    with closing(store.connect()) as db, db:
        db.execute("UPDATE planning_requests SET status='running',error=NULL WHERE project_id=?", (project["id"],))
    restored = PlanningService(Store(store.db_path), FakePlanner())
    state = restored.state(project["id"])
    assert state["request"]["status"] == "failed" and "interrupted" in state["request"]["error"]
    restored.send_message(project["id"], request)
    assert wait_for(restored, project["id"])["request"]["status"] == "succeeded"


def test_obsolete_worker_cannot_publish_after_a_restart_and_retry(workspace):
    store, project, service, planner = workspace
    gate = threading.Event()
    planner.gate = gate
    request = payload(project)
    service.send_message(project["id"], request)
    deadline = time.monotonic() + 5
    while not planner.contexts and time.monotonic() < deadline:
        time.sleep(.01)
    assert planner.contexts
    replacement = PlanningService(Store(store.db_path), FakePlanner({"message": "Only this replacement reply should appear.", "proposal": None}))
    replacement.send_message(project["id"], request)
    state = wait_for(replacement, project["id"])
    gate.set()
    for thread in list(service._threads.values()):
        thread.join(5)
    final = replacement.state(project["id"])
    assert final["messages"] == state["messages"]
    assert len(final["messages"]) == 2 and final["proposals"] == []


def test_large_context_reports_omitted_history_preserving_open_concerns(workspace):
    _, project, _, _ = workspace
    content = project["content"]
    open_comment = {"id": "open", "text": "Never silently discard this concern.", "resolved": False}
    last_message = {"role": "user", "text": "Please refine this step"}
    context = {"content": content, "activeDiagramId": content["diagrams"][0]["id"], "nodeId": None,
        "messages": [{"role": "assistant", "text": "x" * 12000} for _ in range(80)] + [last_message],
        "comments": [{"id": "old", "text": "y" * 12000, "resolved": True}, open_comment], "omittedMessageCount": 17}
    bounded = provider_context_for(context)
    assert bounded["omittedMessageCount"] > 17
    assert bounded["omittedResolvedCommentCount"] == 1
    assert bounded["messages"][-1] == last_message and bounded["comments"] == [open_comment]
    assert bounded["content"] == content
    assert len(json.dumps(bounded, separators=(",", ":"), ensure_ascii=False).encode()) <= 450000
    assert len(context["messages"]) == 81  # Stored context remains intact.


def test_acceptance_prunes_redo_and_retains_one_hundred_undoable_actions(workspace):
    store, project, service, _ = workspace
    additions = [{"id": str(uuid4()), "label": f"Historical edit {i}", "content": deepcopy(project["content"])} for i in range(100)]
    store.save_project(project["id"], {"baseRevision": 0, "mutationId": str(uuid4()), "anchorId": project["cursor"],
        "append": additions, "cursor": additions[-1]["id"], "views": {}})
    current = store.get_project(project["id"])
    proposal = propose(service, current)
    accepted = service.accept(project["id"], proposal["id"], {"baseRevision": current["revision"], "mutationId": str(uuid4())})["project"]
    assert len(accepted["history"]) == 101 and accepted["history"][0]["id"] == additions[0]["id"]
    undone = save(store, accepted, cursor=accepted["history"][-3]["id"])
    proposal = propose(service, undone)
    branched = service.accept(project["id"], proposal["id"], {"baseRevision": undone["revision"], "mutationId": str(uuid4())})["project"]
    ids = {h["id"] for h in branched["history"]}
    assert accepted["cursor"] not in ids and accepted["history"][-2]["id"] not in ids
    assert len(branched["history"]) == 100


def test_proposal_rejection_and_cross_project_review(workspace):
    store, project, service, _ = workspace
    proposal = propose(service, project)
    other = store.create_project()
    with pytest.raises(NotFoundError):
        service.accept(other["id"], proposal["id"], {"baseRevision": 0, "mutationId": str(uuid4())})
    with pytest.raises(NotFoundError):
        service.reject(other["id"], proposal["id"], {"mutationId": str(uuid4())})
    request = {"mutationId": str(uuid4())}
    assert service.reject(project["id"], proposal["id"], request)["proposals"][0]["state"] == "rejected"
    assert service.reject(project["id"], proposal["id"], request)["proposals"][0]["state"] == "rejected"
    with pytest.raises(RuntimeError, match="already been reviewed"):
        service.accept(project["id"], proposal["id"], {"baseRevision": 0, "mutationId": str(uuid4())})


def test_backup_preserves_planning_but_portable_export_excludes_it(workspace):
    from flowdesk.exports import portable_project
    store, project, service, _ = workspace
    proposal = propose(service, project)
    service.reject(project["id"], proposal["id"], {"mutationId": str(uuid4())})
    service.approve(project["id"], {"baseRevision": 0, "mutationId": str(uuid4())})
    backup = Store(store.backup())
    assert PlanningService(backup, FakePlanner()).state(project["id"]) == service.state(project["id"])
    portable = portable_project(store.get_project(project["id"]), [])
    assert not any(key in portable for key in ("messages", "proposals", "comments", "approval"))
    store.delete_project(project["id"], 0)
    with closing(store.connect()) as db:
        for table in ("planning_messages", "planning_proposals", "planning_requests", "planning_approvals", "planning_receipts"):
            assert db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0


def test_upgrade_from_v2_preserves_history_links_cursor_and_views(tmp_path):
    class VersionTwoStore(Store):
        def initialize(self):
            with closing(self.connect()) as db, db:
                for version, filename in ((1, "001_initial.sql"), (2, "002_scanner.sql")):
                    migrations.apply_sql(db, filename)
                    db.execute("INSERT INTO schema_migrations VALUES(?,?)", (version, now()))
    old = VersionTwoStore(tmp_path / "v2.sqlite3")
    project = old.create_project(content=sample_content())
    content = deepcopy(project["content"])
    content["notes"] = "Retain this redo branch"
    edited = save(old, project, content, views={project["content"]["diagrams"][0]["id"]: {"x": 24, "y": 12, "zoom": .8}})
    expected = save(old, edited, cursor=project["cursor"])
    upgraded = Store(old.db_path)
    assert upgraded.get_project(project["id"]) == expected
    with closing(upgraded.connect()) as db:
        assert migrations.applied_versions(db) == tuple(range(1, migrations.DATABASE_VERSION + 1))
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    assert PlanningService(upgraded, FakePlanner()).state(project["id"])["messages"] == []


def test_api_routes_are_protected_bounded_and_use_injected_provider(tmp_path):
    from flowdesk.app import create_app
    app = create_app(tmp_path, testing=True, planner=FakePlanner())
    client = app.test_client()
    token = client.get("/api/bootstrap").json["token"]
    headers = {"X-FlowDesk-Token": token}
    project = client.post("/api/projects", json={"sample": True}, headers=headers).json
    base = f'/api/projects/{project["id"]}/planning'
    assert client.get(base).status_code == 403
    assert client.get(base, headers={**headers, "Origin": "https://evil.example"}).status_code == 403
    assert client.get(base, headers={**headers, "Host": "evil.example"}).status_code == 400
    assert client.get(base, headers=headers).json["messages"] == []
    assert client.post(base + "/messages", headers=headers, json=payload(project, "x" * 12001)).status_code == 400
    assert client.post(base + "/messages", headers=headers, json={"text": "x" * 70000}).status_code == 400
    assert client.post(base + "/messages", headers=headers, json=payload(project)).status_code == 202
    state = wait_for(app.extensions["flowdesk_planning"], project["id"])
    proposal_id = state["proposals"][0]["id"]
    accepted = client.post(base + f"/proposals/{proposal_id}/accept", headers=headers, json={"baseRevision": 0, "mutationId": str(uuid4())})
    assert accepted.status_code == 200 and accepted.json["project"]["revision"] == 1
    assert client.post(base + "/approve", headers=headers, json={"baseRevision": 1, "mutationId": str(uuid4())}).json["approval"]["current"]
    assert not client.post(base + "/reopen", headers=headers, json={"mutationId": str(uuid4())}).json["approval"]["current"]
