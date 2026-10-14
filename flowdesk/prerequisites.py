"""Read-only prerequisite evidence evaluation shared by guidance and execution.

Progress is not completion evidence. These explanations confer no authority and
must be re-evaluated at execution time, including committed artifact identity.
"""
import json

from .semantic_intent import task_fingerprint


def evaluate_prerequisites(db, project_id, content, task_id, source, git):
    from .plan_branches import plan_epoch

    tasks = {task["id"]: task for task in content.get("buildTasks", [])}
    task = tasks.get(task_id)
    if task is None:
        return []
    rows = db.execute("SELECT * FROM execution_runs WHERE project_id=? ORDER BY created_at DESC,id DESC", (project_id,)).fetchall()
    latest = {}
    for row in rows:
        try:
            snapshot = json.loads(row["snapshot"])
            if snapshot.get("executionMode") == "immutable_verification":
                continue
            latest.setdefault(snapshot["task"]["id"], (row, snapshot))
        except (ValueError, KeyError, TypeError):
            continue
    epoch = plan_epoch(db, project_id)
    issues = []

    def issue(code, key, message, action="open_task", prior=None):
        reference = {"taskId": key}
        if prior:
            reference.update(runId=prior[0]["id"], sourceCommit=prior[1].get("sourceCommit"))
        labels = {"open_task": "Open prerequisite task", "review_result": "Review prerequisite result",
                  "finish_task": "Review prerequisite completion", "apply_changes": "Open prerequisite apply review",
                  "commit_changes": "Inspect prerequisite before committing", "refresh_evidence": "Review unavailable prerequisite evidence",
                  "preview_run": "Choose execution repository"}
        issues.append({"code": code, "message": message, "taskId": key,
                       **({"runId": reference["runId"]} if "runId" in reference else {}),
                       "action": action, "actionLabel": labels[action], "reference": reference})

    for key in task.get("prerequisiteIds", []):
        prerequisite = tasks.get(key)
        if prerequisite is None:
            issue("prerequisite_missing", key, "A prerequisite task was removed. Review this task's dependencies.")
            continue
        title = prerequisite["title"]
        if prerequisite["status"] != "done":
            issue("prerequisite_incomplete", key, f'Complete “{title}” before running this task.')
            continue
        prior = latest.get(key)
        if prior is None:
            issue("prerequisite_no_result", key, f'“{title}” is marked done without a reviewed execution result. Reopen it, review an authorized local run, then accept, apply and complete it before running this dependent task.')
            continue
        row, snapshot = prior
        action = "review_result"
        try:
            if snapshot.get("planEpoch", 0) != epoch:
                issue("prerequisite_plan_changed", key, f'Prerequisite “{title}” belongs to an earlier selected plan. Review a new authorized result before using its completion.', prior=prior)
            elif task_fingerprint(snapshot["content"], key) != task_fingerprint(content, key):
                issue("prerequisite_scope_changed", key, f'The scope or acceptance criteria for prerequisite “{title}” changed; its earlier completion needs new review.', prior=prior)
            elif not row["accepted_digest"]:
                issue("prerequisite_review_required", key, f'Review and accept “{title}” before using its completion as a prerequisite.', action, prior)
            elif not row["completed_cursor"]:
                issue("prerequisite_completion_required", key, f'Complete the accepted result for “{title}” before using it as a prerequisite.', "finish_task", prior)
            elif not row["applied"]:
                issue("prerequisite_apply_required", key, f'Apply the accepted changes for “{title}” to your checkout first.', "apply_changes", prior)
            elif source is None:
                issue("prerequisite_repository_required", key, f'Choose an available execution repository to verify the committed changes for “{title}”.', "preview_run", prior)
            elif not git.contains_artifact(source, row["id"], row["accepted_digest"]):
                issue("prerequisite_commit_required", key, f'Commit the applied changes for “{title}” before this dependent task can run; its accepted files must be present in HEAD.', "commit_changes", prior)
        except (OSError, ValueError, RuntimeError, KeyError, TypeError) as exc:
            issue("prerequisite_unverifiable", key, f'Cannot verify prerequisite “{title}”: {exc}', "refresh_evidence", prior)
    return issues
