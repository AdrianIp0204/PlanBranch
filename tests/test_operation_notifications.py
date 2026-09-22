"""The activity feed reads only scoped metadata and does not inspect a repository."""
from contextlib import closing
import json

import pytest

from flowdesk.operation_notifications import operation_snapshot
from flowdesk.storage import Store, NotFoundError


def request(db, project_id, request_id, status="succeeded", created="2026-01-01T00:00:00", updated="2026-01-01T00:00:02"):
    db.execute("""INSERT INTO planning_requests
        (id,project_id,payload_hash,payload,context,base_revision,base_cursor,base_hash,attempt_id,status,created_at,updated_at)
        VALUES(?,?,'hash','secret prompt','secret context',1,'cursor','base','attempt',?,?,?)""",
               (request_id, project_id, status, created, updated))


def test_activity_metadata_excludes_prompts_source_paths_and_execution_output(tmp_path):
    store = Store(tmp_path / "db.sqlite3")
    project = store.create_project(name="Activity")
    pid = project["id"]
    with closing(store.connect()) as db, db:
        request(db, pid, "request")
        db.execute("INSERT INTO scan_runs VALUES(?,?,?)", ("scan", pid, json.dumps({"status": "completed", "startedAt": "2026-01-01", "files": [{"path": "private/source.py", "message": "source details"}], "summary": {"errors": 1, "skipped": 2}})))
        db.execute("""INSERT INTO execution_runs(id,project_id,preview_id,state,snapshot,created_at,updated_at,commands,events)
            VALUES(?,?,?,'succeeded',?,'2026-01-01','2026-01-02','secret output','secret events')""",
                   ("run", pid, "preview", json.dumps({"task": {"id": "task", "title": "Implement parsing"}, "repository": {"path": "private/repo"}, "instructions": "secret instructions"})))
    before = store.get_project(pid)
    result = operation_snapshot(store, pid)
    assert result["operations"] == [
        {"kind": "planning", "id": "request", "state": "succeeded", "createdAt": "2026-01-01T00:00:00", "needsInput": False, "needsReview": False},
        {"kind": "scan", "id": "scan", "state": "completed", "createdAt": "2026-01-01", "hasIssues": True},
        {"kind": "execution", "id": "run", "state": "succeeded", "createdAt": "2026-01-01", "taskId": "task", "taskTitle": "Implement parsing"},
    ]
    assert "secret" not in json.dumps(result)
    assert "private/" not in json.dumps(result)
    assert store.get_project(pid) == before


def test_feed_keeps_projects_separate_checks_existence_and_bounds_history(tmp_path):
    store = Store(tmp_path / "db.sqlite3")
    project = store.create_project(name="First")
    other = store.create_project(name="Other")
    with closing(store.connect()) as db, db:
        request(db, other["id"], "other")
        for n in range(110):
            request(db, project["id"], f"r{n:03d}")
            db.execute("INSERT INTO scan_runs VALUES(?,?,?)", (f"s{n:03d}", project["id"], '{"status":"completed"}'))
    result = operation_snapshot(store, project["id"])["operations"]
    assert len(result) == 200
    assert {item["id"] for item in result if item["kind"] == "planning"} == {f"r{n:03d}" for n in range(10, 110)}
    assert all(item["id"] != "other" for item in result)
    with pytest.raises(NotFoundError):
        operation_snapshot(store, "missing")


def test_pending_questions_and_proposals_are_reported_without_reading_content(tmp_path):
    store = Store(tmp_path / "db.sqlite3")
    pid = store.create_project(name="Questions")["id"]
    with closing(store.connect()) as db, db:
        request(db, pid, "request")
        db.execute("""INSERT INTO planning_proposals(id,project_id,title,summary,diagram_id,base_revision,base_cursor,base_hash,content,changes,state,created_at)
            VALUES('proposal',?,'Proposal','Summary','diagram',1,'cursor','base','unread content','unread changes','pending','2026-01-01T00:00:01')""", (pid,))
        db.execute("INSERT INTO planning_messages(id,project_id,role,text,created_at,proposal_id) VALUES('message',?,'assistant','unread message','2026-01-01T00:00:01','proposal')", (pid,))
        db.execute("""INSERT INTO planning_question_sets(id,project_id,request_id,message_id,diagram_id,base_hash,protocol_version,questions,state,created_at)
            VALUES('questions',?,'request','message','diagram','base',2,'unread questions','open','2026-01-01T00:00:01')""", (pid,))
    result = operation_snapshot(store, pid)["operations"][0]
    assert result["needsInput"] and result["needsReview"]
    assert result["messageId"] == "message"
    with closing(store.connect()) as db, db:
        db.execute("UPDATE planning_question_sets SET state='answered' WHERE id='questions'")
        db.execute("UPDATE planning_proposals SET state='accepted' WHERE id='proposal'")
    result = operation_snapshot(store, pid)["operations"][0]
    assert not result["needsInput"] and not result["needsReview"]


def test_reply_target_does_not_borrow_another_request_response_on_failed_retry(tmp_path):
    store = Store(tmp_path / "db.sqlite3")
    pid = store.create_project(name="Retries")["id"]
    with closing(store.connect()) as db, db:
        request(db, pid, "failed-retry", status="failed", created="2026-01-01T00:00:00", updated="2026-01-01T00:00:09")
        request(db, pid, "completed", created="2026-01-01T00:00:03", updated="2026-01-01T00:00:05")
        db.execute("INSERT INTO planning_messages(id,project_id,role,text,created_at) VALUES('reply',?,'assistant','Unread reply','2026-01-01T00:00:04')", (pid,))
    rows = {item["id"]: item for item in operation_snapshot(store, pid)["operations"]}
    assert "messageId" not in rows["failed-retry"]
    assert not rows["failed-retry"]["needsReview"]
    assert rows["completed"]["messageId"] == "reply"
    with closing(store.connect()) as db, db:
        # The old request eventually succeeds: only its new response is its target.
        db.execute("UPDATE planning_requests SET status='succeeded' WHERE id='failed-retry'")
        db.execute("INSERT INTO planning_messages(id,project_id,role,text,created_at) VALUES('retry-reply',?,'assistant','Unread retry reply','2026-01-01T00:00:08')", (pid,))
    rows = {item["id"]: item for item in operation_snapshot(store, pid)["operations"]}
    assert rows["failed-retry"]["messageId"] == "retry-reply"
    assert rows["completed"]["messageId"] == "reply"


def test_ambiguous_completion_times_do_not_guess_a_message_target(tmp_path):
    store = Store(tmp_path / "db.sqlite3")
    pid = store.create_project(name="Ambiguous timestamps")["id"]
    with closing(store.connect()) as db, db:
        request(db, pid, "first")
        request(db, pid, "second")
        db.execute("INSERT INTO planning_messages(id,project_id,role,text,created_at) VALUES('reply',?,'assistant','Unread reply','2026-01-01T00:00:01')", (pid,))
    assert all("messageId" not in item for item in operation_snapshot(store, pid)["operations"])


def test_activity_endpoint_requires_local_authorization_and_never_mutates_data(tmp_path):
    from flowdesk.app import create_app

    app = create_app(tmp_path, testing=True)
    client = app.test_client()
    store = app.extensions["flowdesk_store"]
    try:
        project = store.create_project(name="Endpoint")
        url = f"/api/projects/{project['id']}/operations"
        assert client.get(url).status_code == 403
        token = client.get("/api/bootstrap").json["token"]
        client.environ_base["HTTP_X_FLOWDESK_TOKEN"] = token
        assert client.get(url, headers={"Origin": "https://unrelated.example"}).status_code == 403
        assert client.get(url, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
        assert client.get("/api/projects/missing/operations").status_code == 404
        with closing(store.connect()) as db, db:
            request(db, project["id"], "request", status="failed")
        with closing(store.connect()) as db:
            before = tuple(db.iterdump())
        response = client.get(url, headers={"Origin": "http://localhost"})
        assert response.status_code == 200
        assert response.headers["Cache-Control"] == "no-store"
        assert response.json["operations"][0]["id"] == "request"
        assert client.get(url).json == response.json
        with closing(store.connect()) as db:
            assert tuple(db.iterdump()) == before
    finally:
        app.extensions["flowdesk_execution"].close()
