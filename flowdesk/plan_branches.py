"""Immutable logical plan checkpoints, with no copied execution authority."""
from contextlib import closing
from copy import deepcopy
import json
from uuid import uuid4

from .planning import fingerprint
from .storage import ConflictError, NotFoundError, encode, now
from .validation import MAX_HISTORY, identifier, integer, obj, string, validate_content


def plan_epoch(db, project_id):
    row = db.execute("SELECT epoch FROM plan_selection WHERE project_id=?", (project_id,)).fetchone()
    return row[0] if row else 0


def semantic_sections(content):
    """Explicit comparison scope: progress, layout and viewport are not design."""
    diagrams = []
    for diagram in content["diagrams"]:
        nodes = []
        for original in diagram["nodes"]:
            node = {key: value for key, value in original.items() if key not in {"position", "pinned", "status", "blocker"}}
            node["checklist"] = [{"id": item["id"], "text": item["text"]} for item in original["checklist"]]
            nodes.append(node)
        diagrams.append({"id": diagram["id"], "name": diagram["name"],
                         "nodes": sorted(nodes, key=lambda item: item["id"]),
                         "edges": sorted(diagram["edges"], key=lambda item: item["id"])})
    return {"Requirements, constraints and decisions": content.get("brief", {}),
            "Diagram elements and relationships": sorted(diagrams, key=lambda item: item["id"]),
            "Tasks, dependencies and acceptance criteria": sorted(
                [{key: value for key, value in task.items() if key != "status"} for task in content.get("buildTasks", [])], key=lambda item: item["id"]),
            "Variables and source references": {"variables": [{key: value for key, value in variable.items() if key != "status"} for variable in content["variables"]],
                                                "nodeLinks": content["nodeLinks"], "matches": content["matches"]},
            "Project notes": content["notes"]}


class PlanBranches:
    def __init__(self, store, planning):
        self.store, self.planning = store, planning

    def _source_references(self, db, project):
        """Metadata-only inspection history; never excerpts, tokens or consent."""
        accepted = {row[0] for row in db.execute("SELECT id FROM planning_proposals WHERE project_id=? AND state='accepted'", (project["id"],))}
        references = []
        for row in db.execute("SELECT context FROM planning_requests WHERE project_id=? AND status='succeeded' ORDER BY created_at DESC LIMIT 100", (project["id"],)):
            receipt = json.loads(row["context"]).get("repositoryContextReceipt")
            if not isinstance(receipt, dict) or receipt.get("proposalId") not in accepted:
                continue
            record = {key: deepcopy(receipt[key]) for key in ("schemaVersion", "provider", "model", "revision", "exclusionPolicyHash", "proposalId", "packageHash") if key in receipt}
            record["files"] = [{key: deepcopy(file[key]) for key in ("path", "fileHash", "startLine", "endLine", "symbol", "excerptHash", "redactedLines") if key in file}
                               for file in receipt.get("files", []) if isinstance(file, dict)]
            references.append(record)
        return sorted(references, key=lambda item: item["proposalId"])

    def _snapshot(self, db, project, name, explanation, kind, alternative_id=None):
        key = str(uuid4())
        approval = db.execute("SELECT id FROM planning_approvals WHERE project_id=? ORDER BY created_at DESC LIMIT 1", (project["id"],)).fetchone()
        db.execute("INSERT INTO plan_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (
            key, project["id"], alternative_id, kind, name, explanation, encode(project["content"]), fingerprint(project["content"]),
            encode(self._source_references(db, project)), project["revision"], approval[0] if approval else None, now()))
        return key

    def _ensure(self, db, project):
        selected = db.execute("SELECT alternative_id FROM plan_selection WHERE project_id=?", (project["id"],)).fetchone()
        if selected:
            return selected[0]
        key = str(uuid4())
        snapshot = self._snapshot(db, project, "Original plan", "Initial baseline", "alternative", key)
        db.execute("INSERT INTO plan_alternatives VALUES(?,?,?,?,?,?)", (key, project["id"], None, "Original plan", snapshot, now()))
        db.execute("INSERT INTO plan_selection VALUES(?,?,0)", (project["id"], key))
        return key

    def _get_snapshot(self, db, project_id, snapshot_id):
        identifier(snapshot_id, "Snapshot ID")
        row = db.execute("SELECT * FROM plan_snapshots WHERE project_id=? AND id=?", (project_id, snapshot_id)).fetchone()
        if row is None:
            raise NotFoundError("Plan snapshot not found in this project.")
        if fingerprint(json.loads(row["content"])) != row["content_hash"]:
            raise ValueError("The saved snapshot changed. Restore a database backup.")
        return row

    def state(self, project_id):
        with closing(self.store.connect()) as db:
            self.store._row(db, project_id)
            selected = db.execute("SELECT * FROM plan_selection WHERE project_id=?", (project_id,)).fetchone()
            return {"selectedAlternativeId": selected["alternative_id"] if selected else None,
                    "epoch": selected["epoch"] if selected else 0,
                    "alternatives": [dict(row) for row in db.execute("SELECT id,parent_id AS parentId,name,snapshot_id AS snapshotId,created_at AS createdAt FROM plan_alternatives WHERE project_id=? ORDER BY created_at", (project_id,))],
                    "snapshots": [dict(row) for row in db.execute("SELECT id,alternative_id AS alternativeId,kind,name,explanation,content_hash AS contentHash,source_revision AS sourceRevision,historical_approval_id AS historicalApprovalId,created_at AS createdAt FROM plan_snapshots WHERE project_id=? ORDER BY created_at DESC", (project_id,))],
                    "decisions": [dict(row) for row in db.execute("SELECT id,alternative_id AS alternativeId,snapshot_id AS snapshotId,action,note,created_at AS createdAt FROM plan_decisions WHERE project_id=? ORDER BY created_at DESC", (project_id,))]}

    def inspect(self, project_id, snapshot_id):
        with closing(self.store.connect()) as db:
            row = self._get_snapshot(db, project_id, snapshot_id)
            return {"id": row["id"], "name": row["name"], "content": json.loads(row["content"]),
                    "contentHash": row["content_hash"], "historicalApprovalId": row["historical_approval_id"],
                    "sourceReferences": json.loads(row["source_references"]),
                    "authority": "Historical record only; restoration requires fresh approval."}

    def compare(self, project_id, snapshot_id):
        with closing(self.store.connect()) as db:
            db.execute("BEGIN")
            saved = self._get_snapshot(db, project_id, snapshot_id)
            project = self.planning._current(db, project_id)
            before = semantic_sections(json.loads(saved["content"]))
            after = semantic_sections(project["content"])
            before["Repository inspection reference history"] = json.loads(saved["source_references"])
            after["Repository inspection reference history"] = self._source_references(db, project)
            return {"snapshotId": snapshot_id, "changes": [{"section": key, "before": before[key], "after": after[key]}
                                                           for key in before if before[key] != after[key]]}

    def mutate(self, project_id, action, payload):
        obj(payload, {"mutationId", "baseRevision", "name", "explanation", "targetId", "note"}, "plan action")
        identifier(payload.get("mutationId"), "Mutation ID")
        integer(payload.get("baseRevision"), "Base revision")
        if action not in {"checkpoint", "duplicate", "select", "restore"}:
            raise ValueError("Unsupported plan action.")
        digest = fingerprint({"action": action, "payload": payload})
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            project = self.planning._current(db, project_id)
            receipt = db.execute("SELECT * FROM plan_receipts WHERE project_id=? AND mutation_id=?", (project_id, payload["mutationId"])).fetchone()
            if receipt:
                if receipt["payload_hash"] != digest:
                    raise ValueError("A plan mutation ID cannot be reused for different content.")
                return {**json.loads(receipt["result"]), "project": self.store._envelope(db, project_id)}
            if project["revision"] != payload["baseRevision"]:
                raise ConflictError(project["revision"])
            selected = self._ensure(db, project)
            note = string(payload.get("note", ""), "Decision note", 8000)
            if action in {"checkpoint", "duplicate"}:
                name = string(payload.get("name"), "Name", 120, True).strip()
                explanation = string(payload.get("explanation", ""), "Explanation", 8000)
                target = str(uuid4()) if action == "duplicate" else selected
                snapshot = self._snapshot(db, project, name, explanation, "alternative" if action == "duplicate" else "checkpoint", target)
                if action == "duplicate":
                    db.execute("INSERT INTO plan_alternatives VALUES(?,?,?,?,?,?)", (target, project_id, selected, name, snapshot, now()))
            else:
                # Outstanding side effects remain recoverable in their original plan.
                if db.execute("SELECT 1 FROM execution_runs WHERE project_id=? AND state IN ('queued','running','cancelling')", (project_id,)).fetchone():
                    raise RuntimeError("Finish or cancel the active run before selecting or restoring a plan.")
                if db.execute("SELECT 1 FROM execution_receipts WHERE project_id=? AND action LIKE 'apply:%' AND state='pending'", (project_id,)).fetchone():
                    raise RuntimeError("Recover the unfinished Apply before changing plans.")
                identifier(payload.get("targetId"), "Target ID")
                target = selected
                snapshot = payload["targetId"]
                if action == "select":
                    alternative = db.execute("SELECT * FROM plan_alternatives WHERE project_id=? AND id=?", (project_id, payload["targetId"])).fetchone()
                    if alternative is None:
                        raise NotFoundError("Alternative not found in this project.")
                    target, snapshot = alternative["id"], alternative["snapshot_id"]
                    if target == selected:
                        raise ValueError("This alternative is already selected.")
                saved = self._get_snapshot(db, project_id, snapshot)
                recovery = self._snapshot(db, project, "Before " + action + ": " + saved["name"], note, "recovery", selected)
                db.execute("UPDATE plan_alternatives SET snapshot_id=? WHERE project_id=? AND id=?", (recovery, project_id, selected))
                content = deepcopy(json.loads(saved["content"]))
                for task in content.get("buildTasks", []):
                    task["status"] = "not_started"
                for variable in content["variables"]:
                    variable["status"] = "not_started"
                for diagram in content["diagrams"]:
                    for node in diagram["nodes"]:
                        node["status"] = "not_started"
                        for check in node["checklist"]:
                            check["checked"] = False
                content = validate_content(content, self.store._detected_ids(db, project_id))
                history = self.store._history(db, project_id)
                cursor = str(uuid4())
                history.append({"id": cursor, "label": action.title() + ": " + saved["name"], "content": content})
                self.store._write_history(db, project_id, history[-MAX_HISTORY:])
                self.store._write_current(db, project_id, content)
                db.execute("UPDATE projects SET revision=revision+1,cursor=?,saved_at=? WHERE id=?", (cursor, now(), project_id))
                db.execute("UPDATE plan_selection SET alternative_id=?,epoch=epoch+1 WHERE project_id=?", (target, project_id))
                db.execute("UPDATE planning_approvals SET revoked=1 WHERE project_id=?", (project_id,))
                db.execute("UPDATE execution_previews SET ready=0,issues=? WHERE project_id=?", (encode(["The selected plan changed. Review and approve it again."]), project_id))
            db.execute("INSERT INTO plan_decisions VALUES(?,?,?,?,?,?,?)", (str(uuid4()), project_id, target, snapshot, action, note or payload.get("explanation", ""), now()))
            result = {"snapshotId": snapshot, "alternativeId": target}
            db.execute("INSERT INTO plan_receipts VALUES(?,?,?,?)", (project_id, payload["mutationId"], digest, encode(result)))
            return {**result, "project": self.store._envelope(db, project_id)}


def register_plan_routes(app, service):
    from flask import jsonify, request

    @app.get("/api/projects/<project_id>/plans")
    def plans_state(project_id):
        return jsonify(service.state(project_id))

    @app.get("/api/projects/<project_id>/plans/snapshots/<snapshot_id>")
    def plans_snapshot(project_id, snapshot_id):
        return jsonify(service.inspect(project_id, snapshot_id))

    @app.get("/api/projects/<project_id>/plans/snapshots/<snapshot_id>/compare")
    def plans_compare(project_id, snapshot_id):
        return jsonify(service.compare(project_id, snapshot_id))

    @app.post("/api/projects/<project_id>/plans/<action>")
    def plans_mutate(project_id, action):
        return jsonify(service.mutate(project_id, action, request.get_json()))
