"""Approval authority and evidence remain separate from progress and agent claims."""
from contextlib import closing
from copy import deepcopy
import json
import threading
from uuid import uuid4

import pytest

from flowdesk.check_evidence import source_identity, junit_observation, observation_state
from flowdesk.planning import PlanningService, manual_fingerprint
from flowdesk.sample import sample_content
from flowdesk.semantic_intent import semantic_fingerprint, task_fingerprint, task_approved
from flowdesk.storage import Store, encode, now
from flowdesk.traceability import requirement_record, TraceabilityService
from flowdesk.execution import ExecutionService
from flowdesk.validation import ValidationError
from test_build_tasks import task
from test_planning import FakePlanner, save
from test_model_executor import setup, reply, question, ToolJournal


def test_approval_scope_defines_progress_layout_and_semantics():
    original = sample_content()
    diagram = original["diagrams"][0]
    original["buildTasks"] = [task(node=diagram["nodes"][0], diagram=diagram), task("Unrelated")]
    changed = deepcopy(original)
    changed["buildTasks"][0]["status"] = "done"
    changed["diagrams"][0]["nodes"][0].update(status="done", position={"x": 900, "y": -300}, pinned=True)
    for item in changed["diagrams"][0]["nodes"][0]["checklist"]: item["checked"] = not item["checked"]
    assert semantic_fingerprint(changed) == semantic_fingerprint(original)
    changed["buildTasks"][1]["acceptanceChecks"][0]["text"] = "Materially different behavior"
    first, second = [item["id"] for item in original["buildTasks"]]
    assert semantic_fingerprint(changed) != semantic_fingerprint(original)
    assert task_fingerprint(changed, first) == task_fingerprint(original, first)
    assert task_fingerprint(changed, second) != task_fingerprint(original, second)
    changed["diagrams"][0]["edges"][0]["sourceHandle"] = "no"
    assert task_fingerprint(changed, first) != task_fingerprint(original, first)


def test_dependency_scope_includes_semantics_not_completion():
    content = sample_content()
    a = task("Database"); b = task("API", prerequisites=[a["id"]]); unrelated = task("Documentation")
    content["buildTasks"] = [a, b, unrelated]
    initial = task_fingerprint(content, b["id"])
    a["status"] = "done"
    unrelated["deliverable"] = "New unrelated scope"
    assert task_fingerprint(content, b["id"]) == initial
    a["acceptanceChecks"][0]["text"] = "New database behavior"
    assert task_fingerprint(content, b["id"]) != initial


def test_persisted_approval_scopes_survive_progress_but_invalidate_affected_task(tmp_path):
    store = Store(tmp_path / "data.sqlite3")
    content = sample_content(); content["buildTasks"] = [task("First"), task("Second")]
    project = store.create_project(content=content); service = PlanningService(store, FakePlanner())
    approval = service.approve(project["id"], {"baseRevision": 0, "mutationId": str(uuid4())})["approval"]
    first, second = [item["id"] for item in content["buildTasks"]]
    assert approval["scopeVersion"] == 1 and task_approved(approval, first)
    content["buildTasks"][0]["status"] = "done"
    project = save(store, project, content)
    assert service.state(project["id"])["approval"]["current"]
    content["buildTasks"][1]["deliverable"] = "Different scope"
    project = save(store, project, content)
    restored = PlanningService(Store(store.db_path), FakePlanner()).state(project["id"])["approval"]
    assert not restored["current"] and task_approved(restored, first) and not task_approved(restored, second)
    content["brief"]["requirements"] = "New requirement"
    save(store, project, content)
    assert not task_approved(service.state(project["id"])["approval"], first)


def test_legacy_approval_not_silently_upgraded_to_broader_authority(tmp_path):
    store = Store(tmp_path / "data.sqlite3"); content = sample_content(); content["buildTasks"] = [task()]
    project = store.create_project(content=content); service = PlanningService(store, FakePlanner())
    with closing(store.connect()) as db, db:
        db.execute("INSERT INTO planning_approvals(id,project_id,revision,cursor,content_hash,content,created_at,revoked) VALUES(?,?,?,?,?,?,?,0)",
            (str(uuid4()), project["id"], project["revision"], project["cursor"], manual_fingerprint(project["content"]), encode(project["content"]), now()))
    assert service.state(project["id"])["approval"]["scopeVersion"] == 0
    content["buildTasks"][0]["status"] = "done"; save(store, project, content)
    assert not service.state(project["id"])["approval"]["current"]


def test_requirement_identity_stays_stable_while_meaning_changes():
    pid = str(uuid4()); content = sample_content()
    before = requirement_record(pid, content)
    content["brief"]["requirements"] = "Another requirement"
    after = requirement_record(pid, content)
    assert before["id"] == after["id"] and before["meaningHash"] != after["meaningHash"]


def test_candidate_identity_includes_all_candidate_bytes_outputs_are_separate_mounts():
    files = {"main.py": b"value = 1", "uncommitted.py": b"pass"}
    baseline = source_identity(files)
    files["__pycache__/main.pyc"] = b"cache"; files[".planbranch-results/junit.xml"] = b"report"
    assert source_identity(files)["sha256"] != baseline["sha256"]
    assert source_identity(files)['exclusions'] == ['.git']
    files["uncommitted.py"] = b"changed"
    assert source_identity(files)["sha256"] != baseline["sha256"]


@pytest.mark.parametrize("xml,state", [
    (b'<testsuite/>', "no_tests"),
    (b'<testsuite><testcase><skipped/></testcase></testsuite>', "skipped"),
    (b'<testsuite><testcase><failure/></testcase></testsuite>', "failed"),
    (b'<testsuite><testcase/><testcase><skipped/></testcase></testsuite>', "passed"),
    (b'<!DOCTYPE root><testsuite/>', "unreadable"),
])
def test_structured_results_distinguish_tests_from_exit_status(xml, state):
    result = junit_observation({".planbranch-results/junit.xml": xml})
    assert result["state"] == state and len(result["artifact"]["sha256"]) == 64


def test_observed_result_never_proves_a_different_candidate_or_missing_tests():
    command = {"status": "completed", "exitCode": 0, "output": "All tests passed"}
    assert observation_state(command, "candidate") == "external_result_reported"
    command["evidence"] = {"schemaVersion": 1, "provenance": "host_observed", "candidateBefore": "candidate", "candidateAfter": "candidate", "sourceChanged": False}
    assert observation_state(command, 'candidate') == 'legacy_writable_observation'
    command['evidence'].update(schemaVersion=2, hostAuthenticated=True, executionMode='immutable_verification', mountReadOnly=True, runtime='docker-source-bound-v2')
    assert observation_state(command, 'candidate') == 'command_exit_observed'
    command['evidence']['testResult'] = {'state': 'passed'}
    assert observation_state(command, "candidate") == "observed_check_passed"
    assert observation_state(command, "different") == "stale_evidence"
    command["evidence"]["sourceChanged"] = True
    assert observation_state(command, "candidate") == "stale_evidence"
    command["evidence"].update(sourceChanged=False, testResult={"state": "no_tests"})
    assert observation_state(command, "candidate") == "human_review_required"
    command["exitCode"] = 1
    assert observation_state(command, "candidate") == "observed_check_failed"
    command.update(exitCode=None, status="interrupted")
    assert observation_state(command, "candidate") == "not_verified"


@pytest.mark.parametrize("field,value", [("version", 2), ("turns", -2), ("calls", [] )])
def test_unsupported_or_invalid_journal_cannot_resume(tmp_path, field, value):
    root, executor, context, registry = setup(tmp_path, [reply("ask_question", {"questions": [question()]})])
    executor.run(context, root, threading.Event(), lambda _: None)
    journal = ToolJournal(executor.data_dir, context["runId"])
    state = journal.load()
    if field == "calls": value = [{"id": "pending", "state": "unknown"}]
    state[field] = value; state["state"] = "answered"
    journal.save(state)
    outcome = executor.run(context, root, threading.Event(), lambda _: None)
    assert "invalid or unsupported" in outcome["error"] and len(registry.seen) == 1
    assert journal.load() == state


@pytest.fixture
def trace_fixture(tmp_path):
    store = Store(tmp_path / "data.sqlite3"); content = sample_content(); content["buildTasks"] = [task()]
    project = store.create_project(content=content); planning = PlanningService(store, FakePlanner())
    planning.approve(project["id"], {"baseRevision": 0, "mutationId": str(uuid4())})
    task_id = content["buildTasks"][0]["id"]; run_id = str(uuid4()); stamp = now()
    candidate = source_identity({"main.py": b"implementation"})
    command = {"id": "check", "command": "pytest", "status": "completed", "exitCode": 0, "output": "reported pass",
               "verificationState": "external_result_reported"}
    snapshot = {"task": content["buildTasks"][0], "sourceCommit": "base"}
    with closing(store.connect()) as db, db:
        db.execute("INSERT INTO execution_runs(id,project_id,preview_id,state,snapshot,created_at,updated_at) VALUES(?,?,?,'succeeded',?,?,?)",
                   (run_id, project["id"], str(uuid4()), encode(snapshot), stamp, stamp))
    run = {"id": run_id, "taskId": task_id, "state": "succeeded", "sourceCommit": "base", "candidate": candidate,
           "capturedCandidate": deepcopy(candidate), "candidateStale": False, "planStale": False,
           "artifact": {"digest": "diff", "files": [{"path": "main.py", "kind": "modified"}]}, "commands": [command]}
    class FixtureExecution:
        _summary = staticmethod(ExecutionService._summary)
        def detail(self, pid, rid):
            assert pid == project["id"] and rid == run_id
            return {"run": deepcopy(run)}
    return store, project, run, TraceabilityService(store, planning, FixtureExecution())


def test_review_is_bound_to_criterion_candidate_and_never_promotes_reported_check(trace_fixture):
    store, project, run, service = trace_fixture
    state = service.state(project["id"], run["taskId"])
    assert state["criteria"][0]["verificationState"] == "not_verified"
    criterion = state["criteria"][0]
    request = {"mutationId": str(uuid4()), "criterionId": criterion["id"], "criterionHash": criterion["meaningHash"],
        "requirementHash": state["requirement"]["meaningHash"], "runId": run["id"], "candidateHash": run["candidate"]["sha256"],
        "commandId": "check", "filePaths": ["main.py"], "note": "Reviewed validation cases; concurrency remains untested.", "confirmed": True}
    reviewed = service.review(project["id"], run["taskId"], request)
    assert reviewed["criteria"][0]["verificationState"] == "human_review_recorded"
    assert reviewed["run"]["commands"][0]["verificationState"] == "external_result_reported"
    assert len(service.review(project["id"], run["taskId"], request)["criteria"][0]["reviews"]) == 1
    run["candidate"] = source_identity({"main.py": b"new code"}); run["candidateStale"] = True
    assert service.state(project["id"], run["taskId"])["criteria"][0]["verificationState"] == "stale_evidence"
    with pytest.raises(ValidationError, match="candidate changed"):
        service.review(project["id"], run["taskId"], {**request, "mutationId": str(uuid4())})
    run["candidate"] = deepcopy(run["capturedCandidate"]); run["candidateStale"] = False
    changed = deepcopy(project["content"]); changed["buildTasks"][0]["acceptanceChecks"][0]["text"] = "A different criterion"
    save(store, project, changed)
    state = service.state(project["id"], run["taskId"])
    assert state["criteria"][0]["id"] == criterion["id"] and state["criteria"][0]["verificationState"] == "stale_evidence"
    with pytest.raises(ValidationError, match="criterion or requirement changed"):
        service.review(project["id"], run["taskId"], {**request, "mutationId": str(uuid4())})


def test_reviews_refuse_uncaptured_candidate_and_unrelated_file(trace_fixture):
    _, project, run, service = trace_fixture
    state = service.state(project["id"], run["taskId"]); criterion = state["criteria"][0]
    request = {"mutationId": str(uuid4()), "criterionId": criterion["id"], "criterionHash": criterion["meaningHash"],
        "requirementHash": state["requirement"]["meaningHash"], "runId": run["id"], "candidateHash": run["candidate"]["sha256"],
        "filePaths": ["unrelated.py"], "note": "Reviewed", "confirmed": True}
    with pytest.raises(ValidationError, match="not in this result"):
        service.review(project["id"], run["taskId"], request)
    run["candidateStale"] = True
    with pytest.raises(ValidationError, match="diff does not describe"):
        service.review(project["id"], run["taskId"], {**request, "filePaths": ["main.py"]})


def test_budget_reports_cumulative_saved_usage_and_unknown_time_without_reset():
    service = ExecutionService.__new__(ExecutionService)
    state = {"version": 1, "turns": 7, "calls": [None] * 3, "elapsedSeconds": 41.5, "state": "question"}
    class Journal:
        def load(self): return deepcopy(state)
    service._journal = lambda _: Journal()
    budget = service._budget("unused", {"generation": {"providerGeneration": {"provider": "fixture"}}})
    assert budget["used"] == {"turns": 7, "toolCalls": 3, "activeSeconds": 41.5}
    assert budget["remaining"] == {"turns": 17, "toolCalls": 77, "activeSeconds": 1158.5}
    assert not budget["timeIsLowerBound"]
    del state["elapsedSeconds"]
    unavailable = service._budget("unused", {"generation": {"providerGeneration": {"provider": "fixture"}}})
    assert not unavailable["available"] and "zero" in unavailable["reason"]
