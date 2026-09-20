"""Clarifications are durable discussion state, never automatic graph edits."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
import hashlib
import json
import threading
from uuid import uuid4

import pytest

from flowdesk import migrations
from flowdesk.exports import portable_project
from flowdesk.planning import PlanningService, provider_context_for
from flowdesk.planning_questions import validate_answers, validate_envelope, validate_questions
from flowdesk.sample import sample_content
from flowdesk.storage import ConflictError, NotFoundError, Store, now
from flowdesk.validation import ValidationError
from test_planning import FakePlanner, payload, save, wait_for


def questions():
    return [{"id": "storage", "kind": "choice", "prompt": "How should tasks be stored?",
             "options": [{"id": "sqlite", "label": "SQLite", "description": "One local database"},
                         {"id": "json", "label": "JSON", "description": "A readable file"}], "recommendedOptionId": "sqlite"},
            {"id": "constraints", "kind": "text", "prompt": "Any important storage constraints?", "options": [], "recommendedOptionId": None}]


def response(items=None):
    return {"protocolVersion": 2, "kind": "questions", "message": "", "questions": questions() if items is None else items, "proposal": None}


def reply():
    return {"protocolVersion": 2, "kind": "reply", "message": "The choices are recorded for the next proposal.", "questions": [], "proposal": None}


class QuestionPlanner(FakePlanner):
    def __init__(self, result=None):
        super().__init__(response() if result is None else result)
        self.configured = []

    def configure(self, selection):
        self.configured.append(deepcopy(selection))
        instructions = "Synthetic planning-only instructions"
        return {"selection": deepcopy(selection), "cliVersion": "test-cli", "protocolVersion": 2,
                "instructionVersion": "planner-v2", "instructionHash": hashlib.sha256(instructions.encode()).hexdigest(),
                "instructions": instructions}


@pytest.fixture
def workspace(tmp_path):
    store = Store(tmp_path / "data.sqlite3")
    project = store.create_project(content=sample_content())
    provider = QuestionPlanner()
    return store, project, PlanningService(store, provider), provider


def ask(service, project, **extra):
    request = payload(project, "Help choose the storage", **extra)
    service.send_message(project["id"], request)
    state = wait_for(service, project["id"])
    assert state["request"]["status"] == "succeeded", state["request"]
    return state["questionSets"][-1]


def answer_payload(project, **extra):
    return {"mutationId": str(uuid4()), "baseRevision": project["revision"],
            "answers": [{"questionId": "storage", "optionId": "sqlite", "text": None},
                        {"questionId": "constraints", "optionId": None, "text": "Must work offline"}], **extra}


def test_questions_and_submitted_answers_survive_restart_without_graph_edits(workspace):
    store, project, service, provider = workspace
    node = project["content"]["diagrams"][0]["nodes"][0]
    question_set = ask(service, project, nodeId=node["id"])
    assert question_set["state"] == "open" and question_set["nodeId"] == node["id"]
    assert store.get_project(project["id"]) == project
    restarted_provider = QuestionPlanner(reply())
    restarted = PlanningService(Store(store.db_path), restarted_provider)
    assert restarted.state(project["id"])["questionSets"] == [question_set]
    answered = restarted.answer_questions(project["id"], question_set["id"], answer_payload(project))
    state = wait_for(restarted, project["id"])
    item = state["questionSets"][0]
    assert item["state"] == "answered" and item["answeredAt"] and item["continuationRequestId"]
    assert len(state["messages"]) == 4 and state["proposals"] == []
    assert "SQLite" in state["messages"][2]["text"] and "Must work offline" in state["messages"][2]["text"]
    assert answered["answerReceipt"]["requestId"] == item["continuationRequestId"]
    context = restarted_provider.contexts[0]
    assert context["questionSets"][0]["answers"] == item["answers"]
    assert "baseSnapshot" not in context["questionSets"][0]
    assert store.get_project(project["id"]) == project
    assert PlanningService(Store(store.db_path), QuestionPlanner()).state(project["id"])["questionSets"] == state["questionSets"]


def test_lost_answer_ack_replays_original_receipt_after_manual_edit(workspace, monkeypatch):
    store, project, service, provider = workspace
    question_set = ask(service, project)
    provider.response = reply()
    request = answer_payload(project)
    first = service.answer_questions(project["id"], question_set["id"], request)
    state = wait_for(service, project["id"])
    content = deepcopy(project["content"])
    content["notes"] = "A later edit must stay visible"
    edited = save(store, project, content)
    monkeypatch.setattr(provider, "configure", lambda _: pytest.fail("receipt replay rediscovered settings"))
    replayed = service.answer_questions(project["id"], question_set["id"], request)
    assert replayed["answerReceipt"] == first["answerReceipt"]
    assert replayed["messages"] == state["messages"]
    assert store.get_project(project["id"]) == edited
    changed = deepcopy(request)
    changed["answers"][0]["optionId"] = "json"
    with pytest.raises(ValidationError, match="reused"):
        service.answer_questions(project["id"], question_set["id"], changed)


def test_failed_continuation_retry_uses_original_answers_context_and_settings(workspace, monkeypatch):
    store, project, service, provider = workspace
    question_set = ask(service, project)
    provider.response = RuntimeError("Injected connection failure")
    selection = {"mode": "explicit", "model": "synthetic-model", "reasoningEffort": "high"}
    service.answer_questions(project["id"], question_set["id"], answer_payload(project, selection=selection))
    failed = wait_for(service, project["id"])
    assert failed["request"]["status"] == "failed" and len(failed["messages"]) == 3
    original_context = deepcopy(provider.contexts[-1])
    content = deepcopy(project["content"]); content["notes"] = "Later plan"
    current = save(store, project, content)
    provider.response = reply()
    monkeypatch.setattr(provider, "configure", lambda _: pytest.fail("retry replaced the frozen configuration"))
    service.send_message(project["id"], failed["request"]["payload"])
    final = wait_for(service, project["id"])
    assert final["request"]["status"] == "succeeded" and len(final["messages"]) == 4
    assert provider.contexts[-1] == original_context
    assert final["request"]["selection"] == selection
    assert len(final["questionSets"]) == 1 and final["questionSets"][0]["state"] == "answered"
    assert store.get_project(project["id"]) == current


def test_viewport_changes_do_not_stale_questions_but_revision_still_guards_answers(workspace):
    store, project, service, provider = workspace
    question_set = ask(service, project)
    diagram_id = project["content"]["diagrams"][0]["id"]
    viewed = save(store, project, views={diagram_id: {"x": 20, "y": 30, "zoom": .7}})
    assert service.state(project["id"])["questionSets"][0]["state"] == "open"
    with pytest.raises(ConflictError):
        service.answer_questions(project["id"], question_set["id"], answer_payload(project))
    provider.response = reply()
    service.answer_questions(project["id"], question_set["id"], answer_payload(viewed))
    assert wait_for(service, project["id"])["questionSets"][0]["state"] == "answered"
    assert store.get_project(project["id"]) == viewed


def test_outdated_questions_can_be_superseded_and_undo_does_not_resurrect(workspace):
    store, project, service, provider = workspace
    first = ask(service, project)
    content = deepcopy(project["content"]); content["notes"] = "A changed requirement"
    changed = save(store, project, content)
    assert service.state(project["id"])["questionSets"][0]["state"] == "stale"
    with pytest.raises(ValidationError, match="outdated"):
        service.answer_questions(project["id"], first["id"], answer_payload(changed))
    second = ask(service, changed)
    state = service.state(project["id"])
    assert state["questionSets"][0]["state"] == "superseded" and second["state"] == "open"
    undone = save(store, changed, cursor=project["cursor"])
    state = service.state(project["id"])
    assert state["questionSets"][0]["state"] == "superseded" and state["questionSets"][1]["state"] == "stale"
    provider.response = reply()
    service.send_message(project["id"], payload(undone, "Change direction: use a simple file"))
    final = wait_for(service, project["id"])
    assert all(item["state"] == "superseded" for item in final["questionSets"])
    assert service.approve(project["id"], {"baseRevision": undone["revision"], "mutationId": str(uuid4())})["approval"]["current"]


def test_open_questions_block_approval_and_answers_do_not_resolve_comments(workspace):
    store, project, service, provider = workspace
    first = service.approve(project["id"], {"baseRevision": 0, "mutationId": str(uuid4())})
    assert first["approval"]["current"]
    question_set = ask(service, project)
    assert not service.state(project["id"])["approval"]["current"]
    with pytest.raises(RuntimeError, match="questions"):
        service.approve(project["id"], {"baseRevision": 0, "mutationId": str(uuid4())})
    node_id = project["content"]["diagrams"][0]["nodes"][0]["id"]
    service.add_comment(project["id"], payload(project, "Check the storage failure path", nodeId=node_id))
    provider.response = reply()
    service.answer_questions(project["id"], question_set["id"], answer_payload(project))
    final = wait_for(service, project["id"])
    assert final["comments"][0]["resolved"] is False and final["approval"]["current"] is False
    assert store.get_project(project["id"]) == project


@pytest.mark.parametrize("invalid", ["missing", "duplicate", "unknown", "unknown_option", "both", "empty", "long", "text_option"])
def test_invalid_answers_fail_atomically(workspace, invalid):
    store, project, service, provider = workspace
    question_set = ask(service, project)
    before = service.state(project["id"])
    request = answer_payload(project)
    answers = request["answers"]
    if invalid == "missing": answers.pop()
    elif invalid == "duplicate": answers[1] = deepcopy(answers[0])
    elif invalid == "unknown": answers[0]["questionId"] = "unknown"
    elif invalid == "unknown_option": answers[0]["optionId"] = "unknown"
    elif invalid == "both": answers[0]["text"] = "Also a custom answer"
    elif invalid == "empty": answers[1]["text"] = " "
    elif invalid == "long": answers[1]["text"] = "x" * 2001
    elif invalid == "text_option": answers[1].update(optionId="sqlite", text=None)
    with pytest.raises(ValidationError):
        service.answer_questions(project["id"], question_set["id"], request)
    assert service.state(project["id"]) == before
    assert store.get_project(project["id"]) == project
    with closing(store.connect()) as db:
        assert db.execute("SELECT COUNT(*) FROM planning_receipts WHERE mutation_id=?", (request["mutationId"],)).fetchone()[0] == 0


def test_custom_choice_answer_and_cross_project_ownership(workspace):
    store, project, service, provider = workspace
    question_set = ask(service, project)
    other = store.create_project(content=sample_content())
    with pytest.raises(NotFoundError):
        service.answer_questions(other["id"], question_set["id"], answer_payload(other))
    request = answer_payload(project)
    request["answers"][0].update(optionId=None, text="A memory-only prototype")
    provider.response = reply()
    service.answer_questions(project["id"], question_set["id"], request)
    final = wait_for(service, project["id"])
    assert final["questionSets"][0]["answers"][0]["text"] == "A memory-only prototype"


def test_answer_transaction_rolls_back_after_answer_and_summary_writes(workspace, monkeypatch):
    store, project, service, provider = workspace
    question_set = ask(service, project)
    before = service.state(project["id"])
    original = service._context
    def fail(*args):
        raise RuntimeError("Injected continuation context failure")
    monkeypatch.setattr(service, "_context", fail)
    request = answer_payload(project)
    with pytest.raises(RuntimeError, match="Injected"):
        service.answer_questions(project["id"], question_set["id"], request)
    assert service.state(project["id"]) == before
    with closing(store.connect()) as db:
        assert db.execute("SELECT COUNT(*) FROM planning_requests WHERE id=?", (request["mutationId"],)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM planning_receipts WHERE mutation_id=?", (request["mutationId"],)).fetchone()[0] == 0
    monkeypatch.setattr(service, "_context", original)
    provider.response = reply()
    service.answer_questions(project["id"], question_set["id"], request)
    assert wait_for(service, project["id"])["questionSets"][0]["state"] == "answered"


@pytest.mark.parametrize("same_mutation", [True, False])
def test_competing_answer_submissions_continue_once(workspace, same_mutation):
    _, project, service, provider = workspace
    question_set = ask(service, project)
    provider.response = reply()
    first = answer_payload(project)
    second = deepcopy(first) if same_mutation else answer_payload(project)
    start = threading.Barrier(2)
    def submit(request):
        start.wait(5)
        try:
            return service.answer_questions(project["id"], question_set["id"], request)
        except ValidationError as error:
            return error
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(submit, [first, second]))
    final = wait_for(service, project["id"])
    assert len(final["messages"]) == 4 and len(provider.contexts) == 2
    assert sum(isinstance(item, ValidationError) for item in results) == (0 if same_mutation else 1)
    assert len({item["answerReceipt"]["requestId"] for item in results if isinstance(item, dict)}) == 1


def test_question_publication_rolls_back_message_with_failed_set_insert(workspace):
    store, project, service, provider = workspace
    with closing(store.connect()) as db, db:
        db.execute("CREATE TRIGGER fail_question BEFORE INSERT ON planning_question_sets BEGIN SELECT RAISE(ABORT, 'Injected question insert failure'); END")
    request = payload(project)
    service.send_message(project["id"], request)
    failed = wait_for(service, project["id"])
    assert failed["request"]["status"] == "failed" and failed["questionSets"] == [] and len(failed["messages"]) == 1
    with closing(store.connect()) as db, db:
        db.execute("DROP TRIGGER fail_question")
    service.send_message(project["id"], request)
    done = wait_for(service, project["id"])
    assert len(done["questionSets"]) == 1 and len(done["messages"]) == 2
    assert store.get_project(project["id"]) == project


def test_interrupted_continuation_can_retry_after_restart(workspace):
    store, project, service, provider = workspace
    question_set = ask(service, project)
    provider.response = RuntimeError("Injected stop")
    service.answer_questions(project["id"], question_set["id"], answer_payload(project))
    failed = wait_for(service, project["id"])
    with closing(store.connect()) as db, db:
        db.execute("UPDATE planning_requests SET status='running',error=NULL WHERE id=?", (failed["request"]["id"],))
    restarted = PlanningService(Store(store.db_path), QuestionPlanner(reply()))
    recovered = restarted.state(project["id"])
    assert recovered["request"]["status"] == "failed" and "interrupted" in recovered["request"]["error"]
    restarted.send_message(project["id"], recovered["request"]["payload"])
    final = wait_for(restarted, project["id"])
    assert len(final["messages"]) == 4 and len(final["questionSets"]) == 1


def test_backup_contains_questions_portable_export_excludes_them_and_delete_cascades(workspace):
    store, project, service, provider = workspace
    question_set = ask(service, project)
    provider.response = reply()
    service.answer_questions(project["id"], question_set["id"], answer_payload(project))
    original = wait_for(service, project["id"])
    restored = PlanningService(Store(store.backup()), QuestionPlanner())
    assert restored.state(project["id"])["questionSets"] == original["questionSets"]
    exported = portable_project(store.get_project(project["id"]), [])
    assert "questionSets" not in exported and "generation" not in exported
    store.delete_project(project["id"], project["revision"])
    with closing(store.connect()) as db:
        assert db.execute("SELECT COUNT(*) FROM planning_question_sets").fetchone()[0] == 0
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_upgrade_v3_retains_manual_redo_and_discussion_records(tmp_path):
    class VersionThreeStore(Store):
        def initialize(self):
            with closing(self.connect()) as db, db:
                for version, filename in ((1, "001_initial.sql"), (2, "002_scanner.sql"), (3, "003_planning.sql")):
                    migrations.apply_sql(db, filename)
                    db.execute("INSERT INTO schema_migrations VALUES(?,?)", (version, now()))
    old = VersionThreeStore(tmp_path / "v3.sqlite3")
    project = old.create_project(content=sample_content())
    content = deepcopy(project["content"]); content["notes"] = "Keep redo"
    edited = save(old, project, content)
    expected = save(old, edited, cursor=project["cursor"])
    message_id = str(uuid4())
    with closing(old.connect()) as db, db:
        db.execute("INSERT INTO planning_messages VALUES(?,?,?,?,?,?,?,?,NULL)",
                   (message_id, project["id"], "user", "Preserve this discussion", now(), None, None, None))
    upgraded = Store(old.db_path)
    assert upgraded.get_project(project["id"]) == expected
    state = PlanningService(upgraded, QuestionPlanner()).state(project["id"])
    assert state["messages"][0]["id"] == message_id and state["questionSets"] == []
    with closing(upgraded.connect()) as db:
        assert migrations.applied_versions(db) == (1, 2, 3, 4)
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.parametrize("invalid", ["empty", "too_many", "duplicate", "id_long", "prompt_long", "option_long", "bad_recommendation", "text_options"])
def test_question_contract_rejects_malformed_sets(invalid):
    items = questions()
    if invalid == "empty": items = []
    elif invalid == "too_many": items *= 2
    elif invalid == "duplicate": items[1]["id"] = items[0]["id"]
    elif invalid == "id_long": items[0]["id"] = "x" * 129
    elif invalid == "prompt_long": items[0]["prompt"] = "x" * 501
    elif invalid == "option_long": items[0]["options"][0]["label"] = "x" * 201
    elif invalid == "bad_recommendation": items[0]["recommendedOptionId"] = "not-an-option"
    elif invalid == "text_options": items[1]["options"] = deepcopy(items[0]["options"])
    with pytest.raises(ValidationError):
        validate_envelope(response(items), 2)


def test_provider_context_keeps_answers_even_when_old_messages_are_trimmed(workspace):
    _, project, _, _ = workspace
    items = [{"id": "answered", "state": "answered", "questions": questions(), "answers": answer_payload(project)["answers"]}]
    context = {"content": project["content"], "activeDiagramId": project["content"]["diagrams"][0]["id"], "nodeId": None,
               "messages": [{"role": "user", "text": "x" * 12000} for _ in range(80)], "comments": [], "questionSets": items}
    bounded = provider_context_for(context)
    assert bounded["questionSets"] == items and bounded["omittedMessageCount"] > 0

def test_answer_continuation_proposal_still_requires_explicit_undoable_acceptance(workspace):
    store, project, service, provider = workspace
    question_set = ask(service, project)
    diagram = deepcopy(project["content"]["diagrams"][0])
    diagram["nodes"][0]["title"] = "Store tasks in SQLite"
    provider.response = {"protocolVersion": 2, "kind": "proposal", "message": "Proposed storage step.", "questions": [],
        "proposal": {"title": "Use the selected storage", "summary": "Use the confirmed choice.", "diagramId": diagram["id"],
                     "nodes": diagram["nodes"], "edges": diagram["edges"]}}
    service.answer_questions(project["id"], question_set["id"], answer_payload(project))
    state = wait_for(service, project["id"])
    assert state["request"]["status"] == "succeeded"
    assert store.get_project(project["id"]) == project and state["proposals"][0]["state"] == "pending"
    with pytest.raises(RuntimeError, match="pending proposals"):
        service.approve(project["id"], {"baseRevision": 0, "mutationId": str(uuid4())})
    accepted = service.accept(project["id"], state["proposals"][0]["id"], {"baseRevision": 0, "mutationId": str(uuid4())})["project"]
    assert len(accepted["history"]) == len(project["history"]) + 1
    assert accepted["content"]["diagrams"][0]["nodes"][0]["id"] == diagram["nodes"][0]["id"]
    undone = save(store, accepted, cursor=project["cursor"])
    assert undone["content"] == project["content"]
    assert service.state(project["id"])["questionSets"][0]["state"] == "answered"


def test_capability_routes_require_local_auth_and_refresh_explicitly(tmp_path):
    from flowdesk.app import create_app
    provider = QuestionPlanner()
    calls = []
    catalogue = {"status": "ready", "source": "cli_catalogue", "cliVersion": "test-cli",
                 "fetchedAt": "2026-09-20T00:00:00Z", "models": []}
    def capabilities(refresh=False):
        calls.append(refresh)
        return deepcopy(catalogue)
    provider.capabilities = capabilities
    client = create_app(tmp_path, testing=True, planner=provider).test_client()
    headers = {"X-FlowDesk-Token": client.get("/api/bootstrap").json["token"]}
    for method, route in (("get", "/api/planning/capabilities"),
                          ("post", "/api/planning/capabilities/refresh")):
        request = getattr(client, method)
        assert request(route).status_code == 403
        assert request(route, headers={**headers, "Origin": "https://evil.example"}).status_code == 403
        assert request(route, headers={**headers, "Host": "evil.example"}).status_code == 400
        assert calls == []
    assert client.get("/api/planning/capabilities", headers=headers).json == catalogue
    assert client.post("/api/planning/capabilities/refresh", headers=headers).json == catalogue
    assert calls == [False, True]


def test_answer_route_is_protected_bounded_and_returns_durable_receipt(tmp_path):
    from flowdesk.app import create_app
    provider = QuestionPlanner()
    app = create_app(tmp_path, testing=True, planner=provider)
    client = app.test_client()
    headers = {"X-FlowDesk-Token": client.get("/api/bootstrap").json["token"]}
    project = client.post("/api/projects", json={"sample": True}, headers=headers).json
    service = app.extensions["flowdesk_planning"]
    question_set = ask(service, project)
    route = f'/api/projects/{project["id"]}/planning/questions/{question_set["id"]}/answers'
    request = answer_payload(project)
    assert client.post(route, json=request).status_code == 403
    assert client.post(route, json=request, headers={**headers, "Origin": "https://evil.example"}).status_code == 403
    assert client.post(route, json=request, headers={**headers, "Host": "evil.example"}).status_code == 400
    assert client.post(route, json={"text": "x" * 70000}, headers=headers).status_code == 400
    assert service.state(project["id"])["questionSets"][0]["state"] == "open"
    assert len(provider.contexts) == 1
    provider.response = reply()
    submitted = client.post(route, json=request, headers=headers)
    assert submitted.status_code == 202
    assert submitted.json["answerReceipt"] == {"questionSetId": question_set["id"], "requestId": request["mutationId"]}
    state = wait_for(service, project["id"])
    assert state["questionSets"][0]["state"] == "answered"
    assert state["request"]["status"] == "succeeded"
    replay = client.post(route, json=request, headers=headers)
    assert replay.status_code == 202 and replay.json["answerReceipt"] == submitted.json["answerReceipt"]
    assert len(provider.contexts) == 2


def test_ask_again_keeps_superseded_question_context_without_inventing_answers(workspace):
    store, project, service, provider = workspace
    original = ask(service, project)
    content = deepcopy(project["content"])
    content["notes"] = "The requirements have changed"
    changed = save(store, project, content)
    assert service.state(project["id"])["questionSets"][0]["state"] == "stale"
    provider.response = reply()
    service.send_message(project["id"], payload(changed, "Ask again using this plan"))
    assert wait_for(service, project["id"])["request"]["status"] == "succeeded"
    historical = provider.contexts[-1]["questionSets"]
    assert len(historical) == 1
    assert historical[0]["id"] == original["id"]
    assert historical[0]["state"] == "superseded"
    assert historical[0]["questions"] == original["questions"]
    assert historical[0]["answers"] is None
    assert "baseSnapshot" not in historical[0]
    assert store.get_project(project["id"]) == changed
