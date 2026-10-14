"""A requirement → task → candidate → criterion review slice over existing runs.

No claim or review in this module authorizes execution, acceptance or application.
The existing brief's requirements paragraph is one stable requirement record;
existing acceptance-check UUIDs retain their identity when their text changes.
"""
from contextlib import closing
import json
from uuid import UUID, uuid4, uuid5

from .semantic_intent import digest, task_approved
from .prerequisites import evaluate_prerequisites
from .storage import encode, now
from .validation import identifier, obj, string, ValidationError


def requirement_record(project_id, content):
    text = content.get("brief", {}).get("requirements", "")
    return {"id": str(uuid5(UUID(project_id), "brief:requirements")), "text": text,
            "meaningHash": digest(text), "source": "brief.requirements", "schemaVersion": 1}


class TraceabilityService:
    def __init__(self, store, planning, execution):
        self.store, self.planning, self.execution = store, planning, execution

    def workflow(self, project_id, task_id):
        with closing(self.store.connect()) as db:
            db.execute("BEGIN")
            project = self.planning._current(db, project_id)
            tasks = {task["id"]: task for task in project["content"]["buildTasks"]}
            task = tasks.get(task_id)
            if task is None: raise ValidationError("Choose a task in the current plan.")
            approval = self.planning._state(db, project_id)["approval"]
            rows = db.execute("SELECT * FROM execution_runs WHERE project_id=? ORDER BY created_at DESC,id DESC", (project_id,)).fetchall()
            row = next((item for item in rows if json.loads(item["snapshot"])["task"]["id"] == task_id), None)
            from .plan_branches import plan_epoch
            epoch = plan_epoch(db, project_id)
            snapshot = json.loads(row["snapshot"]) if row else None
            run_current = self.execution._plan_current(db, project_id, snapshot) if snapshot else False
            repository = self.execution._repository(db, project_id)
            source = None
            if repository is not None and task["prerequisiteIds"]:
                try: source = self.execution.git.inspect_repository(repository["path"])
                except (OSError, RuntimeError, ValueError): pass
            prerequisite_issues = evaluate_prerequisites(db, project_id, project["content"], task_id, source, self.execution.git) if task["prerequisiteIds"] else []
        blockers = list(prerequisite_issues)
        if task["status"] == "blocked": blockers.append({"code": "task_blocked", "taskId": task_id,
            "message": "This task is marked blocked. Resolve its blocker and update progress before authorizing a run.",
            "action": "open_task", "actionLabel": "Edit task progress", "reference": {"taskId": task_id}})
        current = task_approved(approval, task_id)
        if not current: blockers.append({"code": "approval_required", "taskId": task_id,
            "message": "Review the changed task scope, requirements or acceptance criteria before running.",
            "action": "review_plan", "actionLabel": "Review task intent", "reference": {"taskId": task_id}})
        if row:
            run = self.execution._summary(row)
            run["artifact"] = {"digest": row["artifact_digest"]} if row["artifact_digest"] else None
            historical = snapshot.get("planEpoch", 0) != epoch
            run["planStale"] = not run_current
            if snapshot.get("generation", {}).get("providerGeneration"):
                try: run["question"] = self.execution._journal(row["id"]).public_question()
                except (OSError, ValueError): pass
            result = self.execution._workflow(run)
            result.update(action="review_result", runId=row["id"])
            if historical:
                result.update(stage="Plan", nextAction="The prior result belongs to an earlier plan selection. Its review remains in history; review this selected plan and authorize a new run.",
                              action="preview_run" if current else "review_plan")
            elif not run_current and run["state"] not in {"queued", "running", "cancelling"}:
                result.update(stage="Plan", nextAction="The prior result does not match the current approved task scope. Review its history, then review this task's intent and authorize a new run.",
                              action="preview_run" if current else "review_plan")
        elif task["status"] == "done":
            result = {"stage": "Completion needs review", "nextAction": "Task progress is marked done without a reviewed execution result. Reopen progress and review an authorized local run to establish prerequisite evidence.", "action": "open_task"}
        elif blockers:
            result = {"stage": "Plan", "nextAction": blockers[0]["message"], "action": "review_plan" if not current else "prerequisite"}
        else:
            result = {"stage": "Ready to preview", "nextAction": "Review the source revision, execution permissions and runtime in Preview run before authorizing execution.", "action": "preview_run"}
        if prerequisite_issues and (row is None or row["state"] not in {"queued", "running", "cancelling"}):
            result.update(stage="Prerequisites need attention", nextAction=prerequisite_issues[0]["message"], action="prerequisite")
        return {**result, "taskId": task_id, "approvalCurrent": current, "blockers": blockers,
            "prerequisiteIssues": prerequisite_issues,
            "progress": task["status"], "boundaryNote": "Intent approval → execution authorization → result acceptance → checkout apply → your Git commit are separate decisions."}

    def state(self, project_id, task_id, run_id=None):
        identifier(task_id, "Build task ID")
        with closing(self.store.connect()) as db:
            project = self.planning._current(db, project_id)
            task = next((item for item in project["content"]["buildTasks"] if item["id"] == task_id), None)
            if task is None: raise ValidationError("Choose a task in the current plan.")
            approval = self.planning._state(db, project_id)["approval"]
            rows = db.execute("SELECT * FROM execution_runs WHERE project_id=? ORDER BY created_at DESC,id DESC", (project_id,)).fetchall()
            runs = [self.execution._summary(row) for row in rows if json.loads(row["snapshot"])["task"]["id"] == task_id]
            reviews = [dict(row) for row in db.execute("SELECT * FROM trace_reviews WHERE project_id=? AND task_id=? ORDER BY created_at,id", (project_id, task_id))]
        if run_id and not any(run["id"] == run_id for run in runs):
            raise ValidationError("The result does not belong to this task.")
        selected = run_id or (runs[0]["id"] if runs else None)
        run = self.execution.detail(project_id, selected)["run"] if selected else None
        requirement = requirement_record(project_id, project["content"])
        candidate = run.get("candidate") if run else None
        criteria = []
        for criterion in task["acceptanceChecks"]:
            history = []
            for review in reviews:
                if review["criterion_id"] != criterion["id"]: continue
                stale = (not candidate or review["candidate_hash"] != candidate["sha256"] or
                         review["run_id"] != selected or review["criterion_hash"] != digest(criterion["text"]) or
                         review["requirement_hash"] != requirement["meaningHash"] or (run and (run["planStale"] or run.get("candidateStale"))))
                history.append({"id": review["id"], "runId": review["run_id"], "commandId": review["command_id"],
                    "filePaths": json.loads(review["file_paths"]), "candidateHash": review["candidate_hash"],
                    "criterionHash": review["criterion_hash"], "note": review["note"], "createdAt": review["created_at"],
                    "provenance": "human_review", "mappingProvenance": "user_confirmed", "stale": bool(stale)})
            current = [review for review in history if not review["stale"]]
            criteria.append({**criterion, "meaningHash": digest(criterion["text"]), "requirementId": requirement["id"],
                "requirementAssociation": "task_context", "verificationState": "human_review_recorded" if current else "stale_evidence" if history else "not_verified",
                "reviews": history})
        files = []
        if run and run.get("artifact"):
            captured = run.get("capturedCandidate") or {}
            identities = {entry["path"]: entry for entry in captured.get("files", [])}
            for item in run["artifact"]["files"]:
                files.append({"path": item["path"], "kind": item["kind"], "baseRevision": run["sourceCommit"],
                    "candidateHash": captured.get("sha256"), "fileHash": identities.get(item["path"], {}).get("sha256"),
                    "referenceKind": "revision_bound_file", "association": "observed_task_change"})
        return {"schemaVersion": 1, "projectId": project_id, "taskId": task_id, "taskTitle": task["title"],
            "requirement": requirement, "diagramLinks": task["nodeLinks"], "criteria": criteria,
            "approvalCurrent": task_approved(approval, task_id), "runs": runs, "run": run, "files": files,
            "uncertainty": "A passing command supports only the behavior it checks. Associations and human reviews do not prove a natural-language requirement. Hashes identify bytes, not correctness or authenticity."}

    def review(self, project_id, task_id, payload):
        obj(payload, {"mutationId", "criterionId", "criterionHash", "requirementHash", "runId", "candidateHash", "commandId", "filePaths", "note", "confirmed"}, "criterion review")
        for key in ("mutationId", "criterionId", "runId"): identifier(payload.get(key), key)
        for key in ("criterionHash", "requirementHash", "candidateHash"): string(payload.get(key), key, 64, True)
        string(payload.get("note"), "Review note", 4000, True)
        if payload.get("confirmed") is not True: raise ValidationError("Confirm this criterion mapping and human review.")
        paths = payload.get("filePaths", [])
        if not isinstance(paths, list) or len(paths) > 512 or any(not isinstance(path, str) for path in paths):
            raise ValidationError("Choose changed files from this task result.")
        state = self.state(project_id, task_id, payload["runId"])
        run = state["run"]
        criterion = next((item for item in state["criteria"] if item["id"] == payload["criterionId"]), None)
        if (not criterion or criterion["meaningHash"] != payload["criterionHash"] or
                state["requirement"]["meaningHash"] != payload["requirementHash"]):
            raise ValidationError("The criterion or requirement changed. Refresh before recording review.")
        if not run.get("candidate") or run["candidate"]["sha256"] != payload["candidateHash"]:
            raise ValidationError("The candidate changed or is still running. Refresh before recording review.")
        if run.get("candidateStale"):
            raise ValidationError("The diff does not describe the current candidate. Refresh results before recording review.")
        if run["planStale"]: raise ValidationError("The task scope is stale. Review the plan before recording current evidence.")
        if set(paths) - {item["path"] for item in state["files"]}: raise ValidationError("The selected file is not in this result's diff.")
        command_id = payload.get("commandId")
        if command_id is not None and not any(command["id"] == command_id for command in run["commands"]):
            raise ValidationError("Choose a command from this result.")
        request_hash = digest(payload)
        with closing(self.store.connect()) as db, db:
            previous = db.execute("SELECT payload_hash FROM trace_reviews WHERE project_id=? AND mutation_id=?", (project_id, payload["mutationId"])).fetchone()
            if previous:
                if previous[0] != request_hash: raise ValidationError("A review mutation cannot be reused for different content.")
            else:
                db.execute("INSERT INTO trace_reviews(id,project_id,task_id,criterion_id,criterion_hash,requirement_hash,run_id,candidate_hash,command_id,file_paths,note,created_at,mutation_id,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (str(uuid4()), project_id, task_id, criterion["id"], criterion["meaningHash"], state["requirement"]["meaningHash"],
                     run["id"], payload["candidateHash"], command_id, encode(paths), payload["note"], now(), payload["mutationId"], request_hash))
        return self.state(project_id, task_id, run["id"])


def register_traceability(app, store, planning, execution):
    from flask import jsonify, request, Response
    service = TraceabilityService(store, planning, execution)

    @app.get("/api/projects/<project_id>/tasks/<task_id>/workflow")
    def task_workflow(project_id, task_id):
        return jsonify(service.workflow(project_id, task_id))

    @app.get("/api/projects/<project_id>/tasks/<task_id>/traceability")
    def task_traceability(project_id, task_id):
        return jsonify(service.state(project_id, task_id, request.args.get("runId")))

    @app.post("/api/projects/<project_id>/tasks/<task_id>/traceability/reviews")
    def task_criterion_review(project_id, task_id):
        return jsonify(service.review(project_id, task_id, request.get_json()))

    @app.get("/api/projects/<project_id>/tasks/<task_id>/traceability/export")
    def export_task_traceability(project_id, task_id):
        state = service.state(project_id, task_id, request.args.get("runId"))
        # Portable review export omits machine paths, provider events, instructions
        # and unrelated content. Host provenance is data, never imported authority.
        run = state["run"]
        if run:
            state["run"] = {key: run[key] for key in ("id", "state", "sourceCommit", "candidate", "capturedCandidate", "candidateStale", "commands", "workflow", "budget")}
        return Response(encode(state), mimetype="application/json",
            headers={"Content-Disposition": 'attachment; filename="planbranch-task-evidence.json"'})
    return service
