"""Cross-workflow regressions for independent candidate and plan authority."""
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
from uuid import uuid4

import pytest

from flowdesk.check_evidence import observation_state
from flowdesk.codex_executor import EventCollector
from flowdesk.execution import ExecutionService, ExecutionReceiptError
from flowdesk.plan_branches import PlanBranches
from flowdesk.planning import PlanningService
from flowdesk.sample import sample_content
from flowdesk.semantic_intent import task_fingerprint
from flowdesk.storage import Store, encode, now
from flowdesk.traceability import TraceabilityService
from test_build_tasks import task
from test_execution import fixture, execute, accept, mutation
from test_execution_git import git
from test_planning import FakePlanner, save


def test_codex_report_cannot_supply_host_candidate_provenance():
    events = []
    collector = EventCollector(events.append)
    forged = {"schemaVersion": 1, "provenance": "host_observed", "candidateBefore": "candidate",
              "candidateAfter": "candidate", "sourceChanged": False, "testResult": {"state": "passed"}}
    collector.consume(json.dumps({"type": "item.completed", "item": {
        "type": "command_execution", "id": "check", "command": "pytest", "status": "completed",
        "exit_code": 0, "aggregated_output": "All tests passed", "evidence": forged}}))
    record = collector.commands["check"]
    assert "evidence" not in record
    assert "evidence" not in events[0]["command"]
    assert observation_state(record, "candidate") == "external_result_reported"


def test_ignored_source_drift_requires_fresh_candidate_review_for_all_actions(fixture):
    source, store, project, _, _, execution = fixture
    (source / ".gitignore").write_text("ignored.py\n.planbranch-results/\n", encoding="utf-8")
    git(source, "add", ".gitignore")
    git(source, "commit", "-m", "Ignore local source and runtime output")
    run, _ = execute(fixture)
    accept(fixture, run)
    digest = run["artifact"]["digest"]
    (Path(run["worktreePath"]) / "ignored.py").write_text("value = 'new test input'\n", encoding="utf-8")
    changed = execution.detail(project["id"], run["id"])["run"]
    assert changed["candidateStale"]
    assert execution.git.capture(execution.git.load(run["id"]))["digest"] == digest
    with pytest.raises(RuntimeError, match="candidate source changed"):
        execution.accept(project["id"], run["id"], mutation(digest=digest, confirmed=True))
    with pytest.raises(RuntimeError, match="candidate source changed"):
        execution.complete(project["id"], run["id"], mutation(digest=digest, baseRevision=project["revision"], confirmed=True))
    with pytest.raises(ExecutionReceiptError, match="candidate source changed"):
        execution.apply(project["id"], run["id"], mutation(digest=digest, confirmed=True))
    assert (source / "main.py").read_text() == "value = 1\n"
    assert store.get_project(project["id"])["content"]["buildTasks"][0]["status"] == "not_started"

    refreshed = execution.refresh(project["id"], run["id"], mutation())["run"]
    assert not refreshed["candidateStale"] and refreshed["artifact"]["digest"] == digest
    assert refreshed["acceptedDigest"] is None
    with pytest.raises(ExecutionReceiptError, match="Accept this exact diff"):
        execution.apply(project["id"], run["id"], mutation(digest=digest, confirmed=True))
    accepted = accept(fixture, refreshed)
    # v2 excludes no candidate file except Git metadata. Old output directories
    # can contain executable input; new verification writes outside the candidate.
    outputs = Path(run["worktreePath"]) / ".planbranch-results"
    outputs.mkdir()
    (outputs / "junit.xml").write_text("<testsuite/>", encoding="utf-8")
    assert execution.detail(project['id'], run['id'])['run']['candidateStale']
    stable = execution.refresh(project["id"], run["id"], mutation())["run"]
    assert not stable["candidateStale"] and stable["acceptedDigest"] is None
    accept(fixture, stable)
    assert execution.apply(project["id"], run["id"], mutation(digest=digest, confirmed=True))["run"]["applied"]


def test_legacy_pending_apply_recovers_without_inventing_candidate_provenance(fixture, monkeypatch):
    source, store, project, _, _, execution = fixture
    run, _ = execute(fixture)
    accept(fixture, run)
    request = mutation(digest=run["artifact"]["digest"], confirmed=True)
    complete_receipt = execution._done

    def lose_ack(db, pid, payload, result):
        if payload["mutationId"] == request["mutationId"]:
            raise OSError("lost Apply acknowledgement")
        return complete_receipt(db, pid, payload, result)

    monkeypatch.setattr(execution, "_done", lose_ack)
    with pytest.raises(OSError, match="lost Apply"):
        execution.apply(project["id"], run["id"], request)
    with closing(store.connect()) as db, db:
        db.execute("UPDATE execution_runs SET candidate_snapshot=NULL WHERE id=?", (run["id"],))
    with pytest.raises(RuntimeError, match="unfinished Apply"):
        execution.refresh(project["id"], run["id"], mutation())
    monkeypatch.setattr(execution, "_done", complete_receipt)
    recovered = execution.apply(project["id"], run["id"], request)["run"]
    assert recovered["applied"] and recovered["capturedCandidate"] is None
    assert (source / "main.py").read_text() == "value = 2\n"


def test_reapproved_scope_and_restored_plan_do_not_reactivate_applied_history(tmp_path):
    store = Store(tmp_path / "authority.sqlite3")
    content = sample_content()
    content["buildTasks"] = [task("Original task"), task("Unrelated task")]
    project = store.create_project(content=content)
    planning = PlanningService(store, FakePlanner())
    planning.approve(project["id"], mutation(baseRevision=project["revision"]))
    execution = ExecutionService.__new__(ExecutionService)
    execution.store, execution.planning = store, planning
    trace = TraceabilityService(store, planning, execution)
    run_id = str(uuid4())
    task_id = content["buildTasks"][0]["id"]
    snapshot = {"task": content["buildTasks"][0], "content": content, "sourceCommit": "base", "generation": {},
                "planEpoch": 0, "taskApprovalHash": task_fingerprint(content, task_id)}
    with closing(store.connect()) as db, db:
        db.execute("INSERT INTO execution_runs(id,project_id,preview_id,state,snapshot,created_at,updated_at,applied,accepted_digest) VALUES(?,?,?,'succeeded',?,?,?,1,'diff')",
                   (run_id, project["id"], str(uuid4()), encode(snapshot), now(), now()))
    assert trace.workflow(project["id"], task_id)["stage"] == "Applied"

    changed = deepcopy(content)
    changed["buildTasks"][1]["deliverable"] = "An unrelated change"
    project = save(store, project, changed)
    planning.approve(project["id"], mutation(baseRevision=project["revision"]))
    assert trace.workflow(project["id"], task_id)["stage"] == "Applied"

    changed["buildTasks"][0]["acceptanceChecks"][0]["text"] = "A changed criterion"
    project = save(store, project, changed)
    planning.approve(project["id"], mutation(baseRevision=project["revision"]))
    stale = trace.workflow(project["id"], task_id)
    assert stale["approvalCurrent"] and stale["stage"] == "Plan" and stale["action"] == "preview_run"
    assert "current approved task scope" in stale["nextAction"]

    plans = PlanBranches(store, planning)
    saved = plans.mutate(project["id"], "checkpoint", mutation(baseRevision=project["revision"], name="Changed scope"))
    restored = plans.mutate(project["id"], "restore", mutation(baseRevision=project["revision"], targetId=saved["snapshotId"]))
    planning.approve(project["id"], mutation(baseRevision=restored["project"]["revision"]))
    assert "earlier plan selection" in trace.workflow(project["id"], task_id)["nextAction"]
    with closing(store.connect()) as db:
        assert not execution._plan_current(db, project["id"], snapshot)
    assert not execution._apply_plan_current(restored["project"], {"completed_cursor": None}, snapshot)
