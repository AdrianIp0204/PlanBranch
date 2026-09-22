"""Small read-only activity snapshot; excludes source, prompts, diffs and CLI checks."""
from contextlib import closing


def operation_snapshot(store, project_id):
    operations = []
    with closing(store.connect()) as db:
        db.execute("BEGIN")
        store._row(db, project_id)
        # One planner runs per project. Successful completion and its assistant
        # message commit together; failed/retried windows must not borrow an
        # intervening request's response. Questions also have an exact stored link.
        for row in db.execute("""
            WITH recent AS (
                SELECT * FROM planning_requests WHERE project_id=?
                ORDER BY updated_at DESC,id DESC LIMIT 100
            ), responses AS (
                SELECT r.*, CASE WHEN r.status='succeeded' THEN coalesce(
                    (SELECT q.message_id FROM planning_question_sets q
                     WHERE q.project_id=r.project_id AND q.request_id=r.id LIMIT 1),
                    (SELECT m.id FROM planning_messages m
                     WHERE m.project_id=r.project_id AND m.role='assistant'
                     AND m.created_at>=r.created_at AND m.created_at<=r.updated_at
                     AND NOT EXISTS(SELECT 1 FROM planning_requests other
                         WHERE other.project_id=r.project_id AND other.id!=r.id
                         AND other.status='succeeded' AND other.updated_at>=m.created_at
                         AND other.updated_at<=r.updated_at)
                     ORDER BY m.created_at DESC,m.id DESC LIMIT 1)
                ) END AS message_id FROM recent r
            )
            SELECT r.id,r.status,r.created_at,r.message_id,
                EXISTS(SELECT 1 FROM planning_question_sets q WHERE q.project_id=r.project_id
                    AND q.request_id=r.id AND q.state='open') AS needs_input,
                EXISTS(SELECT 1 FROM planning_proposals p WHERE p.project_id=r.project_id
                    AND p.state='pending' AND p.id=m.proposal_id) AS needs_review
            FROM responses r LEFT JOIN planning_messages m
                ON m.project_id=r.project_id AND m.id=r.message_id
            ORDER BY r.updated_at DESC,r.id DESC
        """, (project_id,)):
            operations.append({"kind": "planning", "id": row["id"], "state": row["status"],
                               "createdAt": row["created_at"], "needsInput": bool(row["needs_input"]),
                               "needsReview": bool(row["needs_review"]),
                               **({"messageId": row["message_id"]} if row["message_id"] else {})})
        for row in db.execute("""
            SELECT id,json_extract(data,'$.status') AS state,json_extract(data,'$.startedAt') AS created_at,
                coalesce(json_extract(data,'$.summary.errors'),0)+coalesce(json_extract(data,'$.summary.skipped'),0) AS issues
            FROM scan_runs WHERE project_id=? ORDER BY rowid DESC LIMIT 100
        """, (project_id,)):
            operations.append({"kind": "scan", "id": row["id"], "state": row["state"],
                               "createdAt": row["created_at"], "hasIssues": bool(row["issues"])})
        for row in db.execute("""
            SELECT id,state,created_at,json_extract(snapshot,'$.task.id') AS task_id,
                json_extract(snapshot,'$.task.title') AS task_title
            FROM execution_runs WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 100
        """, (project_id,)):
            operations.append({"kind": "execution", "id": row["id"], "state": row["state"],
                               "createdAt": row["created_at"], "taskId": row["task_id"], "taskTitle": row["task_title"]})
    return {"operations": operations}
