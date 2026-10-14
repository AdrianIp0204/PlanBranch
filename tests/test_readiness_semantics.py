"""Comparison and task guidance must agree with the authority checks they explain."""
from contextlib import closing
from copy import deepcopy
from uuid import uuid4

import pytest

from flowdesk.semantic_intent import semantic_fingerprint, semantic_sections, field_changes
from flowdesk.storage import encode, now
from flowdesk.traceability import TraceabilityService
from test_build_tasks import task
from test_execution import fixture, mutation, prepare
from test_plan_branches import plans, mutate
from test_planning import save


@pytest.mark.parametrize("field", ["name", "blocker"])
def test_semantic_comparison_reports_every_approval_relevant_change(plans, field):
    store, project, planning, service = plans
    saved = mutate(plans, "checkpoint", name="Approved design")
    planning.approve(project["id"], mutation(baseRevision=project["revision"]))
    changed = deepcopy(project["content"])
    if field == "name":
        changed["name"] = "A different project intent"
    else:
        changed["diagrams"][0]["nodes"][0]["blocker"] = "Cannot preserve the required privacy boundary"
    save(store, project, changed)
    assert semantic_fingerprint(changed) != semantic_fingerprint(project["content"])
    assert not planning.state(project["id"])["approval"]["current"]
    comparison = service.compare(project["id"], saved["snapshotId"])
    assert comparison["changes"], field
    assert comparison["beforeHash"] != comparison["afterHash"]
    assert any(item["label"].endswith("Name" if field == "name" else "Blocker")
               for section in comparison["changes"] for item in section["fields"])


def test_semantic_comparison_ignores_identity_collection_order(plans):
    store, project, _, service = plans
    saved = mutate(plans, "checkpoint", name="Original order")
    changed = deepcopy(project["content"])
    changed["variables"].reverse()
    changed["nodeLinks"].reverse()
    for diagram in changed["diagrams"]:
        for node in diagram["nodes"]:
            node["checklist"].reverse()
    save(store, project, changed)
    assert semantic_fingerprint(changed) == semantic_fingerprint(project["content"])
    assert service.compare(project["id"], saved["snapshotId"])["changes"] == []


def test_meaning_changes_always_have_readable_comparison_fields(plans):
    content = plans[1]["content"]
    paths = [("name",), ("notes",), ("brief", "requirements"), ("brief", "constraints"),
             ("diagrams", 0, "name"), ("diagrams", 0, "nodes", 0, "title"),
             ("diagrams", 0, "nodes", 0, "blocker"), ("diagrams", 0, "nodes", 0, "targetFile"),
             ("diagrams", 0, "nodes", 0, "pseudocode"), ("diagrams", 0, "edges", 0, "label"),
             ("diagrams", 0, "nodes", 2, "checklist", 0, "text"),
             ("buildTasks", 0, "title"), ("buildTasks", 0, "deliverable"),
             ("buildTasks", 0, "acceptanceChecks", 0, "text"),
             ("variables", 0, "name"), ("variables", 0, "scope"),
             ("variables", 0, "initialExpression"), ("nodeLinks", 0, "relationship")]
    original = semantic_sections(content)
    for path in paths:
        changed = deepcopy(content)
        parent = changed
        for part in path[:-1]: parent = parent[part]
        parent[path[-1]] = str(parent[path[-1]]) + " revised intent"
        assert semantic_fingerprint(content) != semantic_fingerprint(changed), path
        sections = semantic_sections(changed)
        differences = [field for key in original for field in field_changes(original[key], sections[key])]
        assert differences and all(field["label"] and field["path"] for field in differences), path
        assert any(field["after"] == parent[path[-1]] for field in differences), path


def test_verification_guidance_never_suggests_implementation_acceptance(fixture):
    _, store, project, planning, _, execution = fixture
    preview = prepare(fixture)
    run_id = str(uuid4())
    with closing(store.connect()) as db, db:
        import json
        snapshot = json.loads(db.execute("SELECT snapshot FROM execution_previews WHERE id=?", (preview["id"],)).fetchone()[0])
        snapshot["executionMode"] = "immutable_verification"
        db.execute("INSERT INTO execution_runs(id,project_id,preview_id,state,snapshot,created_at,updated_at) VALUES(?,?,?,'succeeded',?,?,?)",
                   (run_id, project["id"], preview["id"], encode(snapshot), now(), now()))
    workflow = TraceabilityService(store, planning, execution).workflow(project["id"], snapshot["task"]["id"])
    assert workflow["stage"] == "Review verification"
    assert "no implementation acceptance or application" in workflow["nextAction"]
    assert workflow["action"] == "review_result" and workflow["runId"] == run_id


def test_workflow_does_not_call_manually_done_prerequisite_ready(fixture):
    source, store, project, planning, _, execution = fixture
    content = deepcopy(project["content"])
    prerequisite = content["buildTasks"][0]
    prerequisite["status"] = "done"
    dependent = task("Dependent task", prerequisites=[prerequisite["id"]])
    content["buildTasks"].append(dependent)
    current = save(store, project, content)
    planning.approve(project["id"], mutation(baseRevision=current["revision"]))
    execution.repository(project["id"], mutation(path=str(source), confirmed=True))
    preview = execution.preview(project["id"], {"taskId": dependent["id"]})
    workflow = TraceabilityService(store, planning, execution).workflow(project["id"], dependent["id"])
    assert not preview["ready"]
    assert workflow["stage"] != "Ready to preview"
    assert any(item.get("taskId") == prerequisite["id"] for item in workflow["blockers"])
    assert workflow["prerequisiteIssues"] == preview["prerequisiteIssues"]
    assert workflow["prerequisiteIssues"][0]["code"] == "prerequisite_no_result"


@pytest.mark.parametrize("state,code,action", [
    ("incomplete", "prerequisite_incomplete", "open_task"),
    ("unaccepted", "prerequisite_review_required", "review_result"),
    ("uncompleted", "prerequisite_completion_required", "finish_task"),
    ("unapplied", "prerequisite_apply_required", "apply_changes"),
    ("uncommitted", "prerequisite_commit_required", "commit_changes"),
    ("changed_scope", "prerequisite_scope_changed", "open_task"),
    ("changed_epoch", "prerequisite_plan_changed", "open_task"),
    ("missing_artifact", "prerequisite_unverifiable", "refresh_evidence"),
    ("missing_repository", "prerequisite_repository_required", "preview_run"),
    ("ready", None, None),
    ("verification_after_ready", None, None),
])
def test_workflow_and_preview_share_prerequisite_codes_references_and_actions(fixture, monkeypatch, state, code, action):
    source, store, project, planning, _, execution = fixture
    content = deepcopy(project["content"])
    prerequisite = content["buildTasks"][0]
    prerequisite["status"] = "not_started" if state == "incomplete" else "done"
    dependent = task("Dependent task", prerequisites=[prerequisite["id"]])
    content["buildTasks"].append(dependent)
    current = save(store, project, content)
    planning.approve(project["id"], mutation(baseRevision=current["revision"]))
    execution.repository(project["id"], mutation(path=str(source), confirmed=True))
    snapshot = {"task": deepcopy(prerequisite), "content": deepcopy(content), "sourceCommit": "recorded-base",
                "planEpoch": -1 if state == "changed_epoch" else 0}
    if state == "changed_scope": snapshot["content"]["buildTasks"][0]["deliverable"] = "Earlier deliverable"
    run_id = str(uuid4())
    with closing(store.connect()) as db, db:
        db.execute("INSERT INTO execution_runs(id,project_id,preview_id,state,snapshot,accepted_digest,completed_cursor,applied,created_at,updated_at) VALUES(?,?,?,'succeeded',?,?,?,?,?,?)",
            (run_id, project["id"], str(uuid4()), encode(snapshot), None if state == "unaccepted" else "reviewed-artifact",
             None if state == "uncompleted" else "completed-history", 0 if state == "unapplied" else 1, now(), now()))
        if state == "missing_repository": db.execute("DELETE FROM execution_repositories WHERE project_id=?", (project["id"],))
        if state == "verification_after_ready":
            db.execute("INSERT INTO execution_runs(id,project_id,preview_id,state,snapshot,created_at,updated_at) VALUES(?,?,?,'succeeded',?,'9999','9999')",
                (str(uuid4()), project["id"], str(uuid4()), encode({**snapshot, "executionMode": "immutable_verification"})))
        before_runs = [tuple(row) for row in db.execute("SELECT * FROM execution_runs")]
    def contains(*args):
        if state == "missing_artifact": raise OSError("Captured artifact unavailable")
        return state != "uncommitted"
    monkeypatch.setattr(execution.git, "contains_artifact", contains)
    source_before = (source / "main.py").read_bytes()
    preview = execution.preview(project["id"], {"taskId": dependent["id"]})
    workflow = TraceabilityService(store, planning, execution).workflow(project["id"], dependent["id"])
    assert workflow["prerequisiteIssues"] == preview["prerequisiteIssues"]
    issues = preview["prerequisiteIssues"]
    if code is None:
        assert issues == [] and preview["ready"]
        assert workflow["stage"] == "Ready to preview"
    else:
        assert not preview["ready"] and workflow["stage"] == "Prerequisites need attention"
        assert issues[0]["code"] == code and issues[0]["action"] == action
        assert issues[0]["taskId"] == issues[0]["reference"]["taskId"] == prerequisite["id"]
        if state != "incomplete": assert issues[0]["runId"] == issues[0]["reference"]["runId"] == run_id
        assert issues[0]["message"] in preview["issues"]
    with closing(store.connect()) as db:
        assert [tuple(row) for row in db.execute("SELECT * FROM execution_runs")] == before_runs
    assert (source / "main.py").read_bytes() == source_before
