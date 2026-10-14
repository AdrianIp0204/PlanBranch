"""Source-free task packages and quarantined external results; never execution grants."""
from contextlib import closing
from copy import deepcopy
import difflib
import hashlib
import json
from pathlib import Path
import re
from uuid import uuid4

from .execution_git import _checked, _relative, MAX_CHANGED_BYTES, MAX_CHANGED_FILES, MAX_FILE_BYTES
from .plan_branches import plan_epoch
from .planning import fingerprint
from .storage import ConflictError, NotFoundError, encode, now
from .validation import ValidationError, array, identifier, integer, obj, string

SCHEMA = "planbranch.task-handoff.v1"
RETURN_SCHEMA = "planbranch.external-result.v1"
COMMIT = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")


def _task_hash(content, task_id):
    from .semantic_intent import task_fingerprint
    return task_fingerprint(content, task_id)


def implementation_brief(manifest):
    task = manifest["task"]
    return_template = {**manifest["expectedReturn"], "manifestHash": manifest["contentHash"]}
    return "\n".join([
        f"# Implementation brief: {task['title']}", "", task["deliverable"], "",
        "## Requirements and constraints", manifest["brief"].get("requirements", ""), manifest["brief"].get("constraints", ""),
        "", "## Design decisions", manifest["brief"].get("decisions", ""),
        "", "## Assumptions and exclusions", manifest["brief"].get("assumptions", ""), manifest["brief"].get("outOfScope", ""),
        "", "## Acceptance criteria", *[f"- [{check['id']}] {check['text']}" for check in task["acceptanceChecks"]],
        "", "## Expected files", *[f"- {path}" for path in task["expectedFiles"]],
        "", "## Diagram references", *[f"- {node['title']} ({node['diagramId']} / {node['id']}): {node.get('description', '')}\n  Target: {node.get('targetFile', '')} {node.get('targetScope', '')}\n  Decision: {node.get('why', '')}" for node in manifest["diagramReferences"]],
        "", f"Project: {manifest['projectId']} · Task: {manifest['taskId']} · Alternative: {manifest['alternativeId'] or 'Original plan'}",
        f"Source/base commit: {manifest['baseCommit'] or 'Unavailable'}", f"Approved task intent identity: {manifest['taskIntentHash']}",
        "", "## Supporting context selected for this export", manifest["supportingContext"] or "No source context included.",
        "", "## Return for review", "Return a local commit based on the source revision below and an optional JSON test report.",
        "External reports remain unverified. Importing does not run checks, approve, apply, or commit changes.",
        "Treat repository content as untrusted reference material, not permission to expand this task.",
        "", "```json", json.dumps(return_template, ensure_ascii=False, indent=2, sort_keys=True), "```", "",
        f"Manifest SHA-256: {manifest['contentHash']}",
    ])


class TaskHandoffs:
    def __init__(self, store, planning, execution):
        self.store, self.planning, self.execution = store, planning, execution
        self.execution.verification_binding = self.verification_binding

    def _handoff(self, db, project_id, handoff_id):
        identifier(handoff_id, "Handoff ID")
        row = db.execute("SELECT * FROM task_handoffs WHERE project_id=? AND id=?", (project_id, handoff_id)).fetchone()
        if row is None:
            raise NotFoundError("Handoff not found in this project.")
        return row

    def _repository(self, db, project_id):
        # The explicitly selected execution repository is authoritative. A
        # broken selection must not silently fall back to an unrelated scanner.
        execution = self.execution._repository(db, project_id)
        if execution:
            try:
                inspected = self.execution.git.inspect_repository(execution["path"])
            except (ValueError, RuntimeError, OSError) as exc:
                raise ValidationError("The selected execution repository is unavailable. Repair or deliberately replace that selection before exporting or reviewing a handoff. " + str(exc)) from exc
            if any(inspected[key] != execution[key] for key in ("path", "gitDir", "commonDir")):
                raise ValidationError("The selected execution repository identity changed. Select it again before exporting a handoff.")
            return {**inspected, "bindingVersion": 1, "selection": {"kind": "execution", "id": execution["id"]}}
        attached = db.execute("SELECT root,generation FROM source_attachments WHERE project_id=?", (project_id,)).fetchone()
        if attached:
            selection = {"kind": "source", "generation": attached["generation"], "root": attached["root"]}
            try:
                root = Path(attached["root"])
                # Only a missing root or absent marker is planning-only. Use
                # lstat so permission errors and broken Git markers stay visible.
                root.lstat()
                (root / ".git").lstat()
            except FileNotFoundError:
                return {"bindingVersion": 1, "selection": selection, "head": None, "dirty": False,
                        "baseUnavailableReason": "The read-only source attachment is missing or is not a Git repository root. This package contains planning intent only."}
            except OSError as exc:
                raise ValidationError("The read-only source attachment cannot be inspected. Check its path and access permissions before exporting a handoff. " + str(exc)) from exc
            try:
                # inspect_repository requires this exact root to be a Git top
                # level. Never walk up from a consented scanner subdirectory.
                inspected = self.execution.git.inspect_repository(attached["root"])
            except (ValueError, RuntimeError, OSError) as exc:
                raise ValidationError("The read-only source attachment has a Git marker but its repository cannot be inspected. Repair the repository or its access permissions before exporting a handoff. " + str(exc)) from exc
            return {**inspected, "bindingVersion": 1, "selection": selection}
        return {"bindingVersion": 1, "selection": {"kind": "none"}, "head": None, "dirty": False,
                "baseUnavailableReason": "No repository is selected. This package contains planning intent only."}

    def _bound_repository(self, db, project_id, handoff):
        """Bind reads and local checks to the exact selection made at export."""
        saved = json.loads(handoff["repository"]) if handoff["repository"] else None
        if not saved or saved.get("bindingVersion") != 1:
            raise ValidationError("This older handoff has no repository selection binding. Create a new handoff before importing or verifying a result.")
        live = self._repository(db, project_id)
        if saved.get("selection") != live.get("selection") or any(saved.get(key) != live.get(key) for key in ("path", "gitDir", "commonDir")):
            raise ValidationError("The repository selection changed after export. Create a new handoff for the selected repository.")
        return live

    def create(self, project_id, payload):
        from .traceability import requirement_record
        obj(payload, {"taskId", "baseRevision", "supportingContext"}, "handoff preview")
        identifier(payload.get("taskId"), "Task ID")
        integer(payload.get("baseRevision"), "Base revision")
        supporting = string(payload.get("supportingContext", ""), "Selected supporting context", 64000)
        if len(supporting.encode("utf-8")) > 64000:
            raise ValidationError("Selected supporting context must be at most 64 KB of UTF-8 text.")
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            project = self.planning._current(db, project_id)
            if project["revision"] != payload["baseRevision"]:
                raise ConflictError(project["revision"])
            task = next((item for item in project["content"].get("buildTasks", []) if item["id"] == payload["taskId"]), None)
            if task is None:
                raise ValidationError("Choose a task in this project.")
            if any(path.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", path) for path in task["expectedFiles"]):
                raise ValidationError("Use repository-relative expected file references before creating a handoff; absolute machine paths are not exported.")
            approval = self.planning._state(db, project_id)["approval"]
            scope = approval.get("taskScopes", {}).get(task["id"]) if approval else None
            if not approval or not (scope["current"] if scope else approval["current"]):
                raise ValidationError("Approve this task's current saved scope before creating a handoff.")
            repository = self._repository(db, project_id)
            if repository["dirty"]:
                raise ValidationError("Commit or preserve the repository's uncommitted changes before exporting a revision-bound handoff.")
            selected = db.execute("SELECT alternative_id FROM plan_selection WHERE project_id=?", (project_id,)).fetchone()
            key = str(uuid4())
            expected = {"schema": RETURN_SCHEMA, "projectId": project_id, "taskId": task["id"], "handoffId": key,
                        "baseCommit": repository["head"], "candidateCommit": "REPLACE_WITH_FULL_LOCAL_COMMIT_HASH",
                        "manifestHash": "COPY_MANIFEST_CONTENT_HASH", "report": {"summary": "", "checks": []}}
            linked_ids = {link["nodeId"] for link in task["nodeLinks"]}
            nodes = [{"diagramId": diagram["id"], **{key: value for key, value in node.items() if key in {"id", "title", "description", "targetFile", "targetScope", "why", "pseudocode"}}}
                     for diagram in project["content"]["diagrams"] for node in diagram["nodes"] if node["id"] in linked_ids]
            manifest = {"schema": SCHEMA, "handoffId": key, "projectId": project_id, "projectName": project["content"]["name"],
                        "alternativeId": selected[0] if selected else None, "planEpoch": plan_epoch(db, project_id),
                        "planRevision": project["revision"], "taskId": task["id"], "taskIntentHash": _task_hash(project["content"], task["id"]),
                        "approvalId": approval["id"], "task": {key: deepcopy(value) for key, value in task.items() if key != "status"},
                        "brief": {key: value for key, value in project["content"]["brief"].items() if key in {"goal", "requirements", "constraints", "outOfScope", "decisions", "assumptions"}},
                        "requirements": [requirement_record(project_id, project["content"])],
                        "diagramReferences": nodes, "baseCommit": repository["head"],
                        "repositorySelection": repository["selection"]["kind"], "baseUnavailableReason": repository.get("baseUnavailableReason"),
                        "supportingContext": supporting, "sourceIncluded": bool(supporting), "createdAt": now(),
                        "expectedReturn": expected, "authority": "Task intent only. This package grants no PlanBranch execution or application permissions."}
            manifest["contentHash"] = fingerprint(manifest)
            db.execute("INSERT INTO task_handoffs VALUES(?,?,?,?,?,?,?)", (key, project_id, task["id"], encode(manifest), manifest["contentHash"], encode(repository), manifest["createdAt"]))
            return {"manifest": manifest, "markdown": implementation_brief(manifest)}

    def detail(self, project_id, handoff_id):
        with closing(self.store.connect()) as db:
            manifest = json.loads(self._handoff(db, project_id, handoff_id)["manifest"])
            return {"manifest": manifest, "markdown": implementation_brief(manifest)}

    def _compatibility(self, db, row, candidate=None):
        manifest = json.loads(row["manifest"])
        project = self.planning._current(db, row["project_id"])
        issues = []
        if not any(task["id"] == row["task_id"] for task in project["content"].get("buildTasks", [])):
            issues.append("The task no longer exists in the selected plan.")
        elif _task_hash(project["content"], row["task_id"]) != manifest["taskIntentHash"]:
            issues.append("The task's approved intent changed after export.")
        if plan_epoch(db, row["project_id"]) != manifest["planEpoch"]:
            issues.append("A different plan was selected or restored after export.")
        repository = json.loads(row["repository"]) if row["repository"] else None
        if repository:
            try:
                live = self._bound_repository(db, row["project_id"], row)
                if live["head"] not in {repository["head"], candidate} or live["dirty"]:
                    issues.append("The attached source identity, revision, or working tree changed after export.")
            except (ValueError, RuntimeError, OSError) as exc:
                issues.append(str(exc))
        return issues

    def state(self, project_id, task_id):
        identifier(task_id, "Task ID")
        with closing(self.store.connect()) as db:
            self.store._row(db, project_id)
            handoffs = [dict(row) for row in db.execute("SELECT id,manifest_hash AS contentHash,created_at AS createdAt FROM task_handoffs WHERE project_id=? AND task_id=? ORDER BY created_at DESC", (project_id, task_id))]
            verifications = {}
            for run in db.execute("SELECT * FROM execution_runs WHERE project_id=? ORDER BY created_at DESC,id DESC", (project_id,)):
                snapshot = json.loads(run["snapshot"])
                if snapshot.get("executionMode") == "immutable_verification" and snapshot.get("task", {}).get("id") == task_id:
                    verifications.setdefault(snapshot.get("externalResultId"), []).append(self.execution._summary(run))
            results = []
            for row in db.execute("SELECT * FROM external_results WHERE project_id=? AND task_id=? ORDER BY created_at DESC", (project_id, task_id)):
                handoff = self._handoff(db, project_id, row["handoff_id"])
                data = json.loads(row["data"])
                results.append({"id": row["id"], "handoffId": row["handoff_id"], **data,
                                "compatibilityIssues": self._compatibility(db, handoff, data["candidateCommit"]),
                                "localVerifications": verifications.get(row["id"], []),
                                "reviews": [dict(review) for review in db.execute("SELECT id,decision,note,created_at AS createdAt FROM external_reviews WHERE result_id=? ORDER BY created_at DESC", (row["id"],))]})
            return {"handoffs": handoffs, "results": results}

    def import_result(self, project_id, handoff_id, payload):
        obj(payload, {"schema", "projectId", "taskId", "handoffId", "manifestHash", "baseCommit", "candidateCommit", "report"}, "external result")
        if payload.get("schema") != RETURN_SCHEMA:
            raise ValidationError("Unsupported external result schema; use the exported return template.")
        report = payload.get("report", {})
        if not isinstance(report, dict) or len(encode(report).encode("utf-8")) > 64000:
            raise ValidationError("The optional test report must be a JSON object of at most 64 KB.")
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = self._handoff(db, project_id, handoff_id)
            manifest = json.loads(row["manifest"])
            for key, expected in (("projectId", project_id), ("taskId", row["task_id"]), ("handoffId", handoff_id), ("manifestHash", row["manifest_hash"]), ("baseCommit", manifest["baseCommit"])):
                if payload.get(key) != expected:
                    raise ValidationError(f"The returned {key} does not match this handoff.")
            candidate = payload.get("candidateCommit")
            if not isinstance(candidate, str) or not COMMIT.fullmatch(candidate):
                raise ValidationError("Return the full 40- or 64-character lowercase candidate commit hash, available in the attached local repository.")
            if not row["repository"] or not manifest["baseCommit"]:
                raise ValidationError("This offline handoff has no source base. Attach a repository and create a new handoff to review a commit.")
            self._bound_repository(db, project_id, row)
            repository = json.loads(row["repository"])
            git = self.execution.git
            live = git.repository_identity(repository["path"])
            if any(live[key] != repository[key] for key in ("path", "gitDir", "commonDir")):
                raise ValidationError("The local repository identity changed; this result cannot be attached.")
            root = Path(repository["path"])
            resolved = git._git(root, ["rev-parse", "--verify", candidate + "^{commit}"]).decode("ascii").strip()
            if resolved != candidate:
                raise ValidationError("The candidate identity is not a commit.")
            git._git(root, ["merge-base", "--is-ancestor", manifest["baseCommit"], candidate])
            before, after = git._tree(root, manifest["baseCommit"]), git._tree(root, candidate)
            changed = sorted(name for name in before.keys() | after.keys() if before.get(name) != after.get(name))
            if len(changed) > MAX_CHANGED_FILES:
                raise ValidationError("The returned commit exceeds the 512-file review limit.")
            entries = [tree[name] for name in changed for tree in (before, after) if name in tree]
            if sum(item["size"] for item in entries) > MAX_CHANGED_BYTES or any(item["size"] > MAX_FILE_BYTES for item in entries):
                raise ValidationError("The returned changes exceed bounded file review limits.")
            blobs = git._blobs(root, entries)
            files = []
            total_diff = 0
            for name in changed:
                _relative(name)
                _checked(root, name)  # includes junctions and every symlink ancestor
                old = blobs[before[name]["oid"]] if name in before else b""
                new = blobs[after[name]["oid"]] if name in after else b""
                try:
                    if b"\0" in old + new:
                        raise UnicodeError()
                    diff = "".join(difflib.unified_diff(old.decode("utf-8").splitlines(True), new.decode("utf-8").splitlines(True), fromfile="a/" + name, tofile="b/" + name))
                    binary = False
                except UnicodeError:
                    diff, binary = "Binary content; inspect in your editor before accepting.", True
                total_diff += len(diff.encode("utf-8"))
                if total_diff > MAX_CHANGED_BYTES:
                    raise ValidationError("The returned diff exceeds the 16 MiB review limit.")
                files.append({"path": name, "beforeHash": hashlib.sha256(old).hexdigest() if name in before else None,
                              "afterHash": hashlib.sha256(new).hexdigest() if name in after else None,
                              "beforeMode": before.get(name, {}).get("mode"), "afterMode": after.get(name, {}).get("mode"), "diff": diff, "binary": binary})
            data = {"schema": RETURN_SCHEMA, "origin": "external", "verificationState": "External result reported",
                    "baseCommit": manifest["baseCommit"], "candidateCommit": candidate, "files": files,
                    "report": deepcopy(report), "reportTrust": "Untrusted external claims; no local checks were performed.",
                    "createdAt": now(), "contentHash": fingerprint({"candidateCommit": candidate, "files": files, "report": report})}
            key = str(uuid4())
            db.execute("INSERT INTO external_results VALUES(?,?,?,?,?,?)", (key, project_id, handoff_id, row["task_id"], encode(data), data["createdAt"]))
            return {"id": key, **data, "compatibilityIssues": self._compatibility(db, row, candidate)}

    def review(self, project_id, result_id, payload):
        obj(payload, {"decision", "note", "contentHash"}, "external review")
        if payload.get("decision") not in {"accepted", "changes_requested"}:
            raise ValidationError("Choose accepted or changes_requested for this review.")
        note = string(payload.get("note", ""), "Review note", 8000, True)
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM external_results WHERE project_id=? AND id=?", (project_id, result_id)).fetchone()
            if row is None:
                raise NotFoundError("External result not found in this project.")
            data = json.loads(row["data"])
            if data["contentHash"] != payload.get("contentHash"):
                raise ValidationError("Review the exact imported result before recording a decision.")
            issues = self._compatibility(db, self._handoff(db, project_id, row["handoff_id"]), data["candidateCommit"])
            if issues and payload["decision"] == "accepted":
                raise ValidationError("This result is stale: " + " ".join(issues))
            key = str(uuid4())
            db.execute("INSERT INTO external_reviews VALUES(?,?,?,?,?)", (key, result_id, payload["decision"], note, now()))
            return {"reviewId": key, "decision": payload["decision"], "authority": "Human review only. No task approval, execution, application or commit occurred."}

    def verification_binding(self, project_id, result_id):
        """Rechecked by the execution service at both preview and start."""
        identifier(result_id, "External result ID")
        with closing(self.store.connect()) as db:
            db.execute("BEGIN")
            row = db.execute("SELECT * FROM external_results WHERE project_id=? AND id=?", (project_id, result_id)).fetchone()
            if row is None:
                raise NotFoundError("External result not found in this project.")
            data = json.loads(row["data"])
            handoff = self._handoff(db, project_id, row["handoff_id"])
            issues = self._compatibility(db, handoff, data["candidateCommit"])
            if issues:
                raise ValidationError("This result is stale: " + " ".join(issues))
            grant = self.execution._repository(db, project_id)
            original = json.loads(handoff["repository"])
            if grant is None or any(grant[key] != original[key] for key in ("path", "gitDir", "commonDir")):
                raise ValidationError("Select this handoff's repository in Run step before preparing a local run.")
            source = self.execution.git.inspect_repository(grant["path"])
            if source["head"] != data["candidateCommit"] or source["dirty"]:
                raise ValidationError("Use your Git tools to check out the exact returned candidate with a clean working tree, then retry. PlanBranch will not change your checkout.")
            return {"taskId": row["task_id"], "candidateCommit": data["candidateCommit"],
                    "externalContentHash": data["contentHash"], "repository": source}

    def prepare_run(self, project_id, result_id, payload):
        """Legacy read-only preflight; never opens an editing run implicitly."""
        obj(payload, {"contentHash"}, "external result local run preview")
        bound = self.verification_binding(project_id, result_id)
        if payload.get("contentHash") != bound["externalContentHash"]:
            raise ValidationError("Refresh this external result before preparing local verification.")
        return {"taskId": bound["taskId"], "candidateCommit": bound["candidateCommit"], "externalResultId": result_id,
                "instruction": "Choose a check and preview verification without editing. This preflight grants no execution permission."}

    def preview_verification(self, project_id, result_id, payload):
        obj(payload, {"contentHash", "command", "timeoutSeconds"}, "external verification preview")
        bound = self.verification_binding(project_id, result_id)
        if payload.get("contentHash") != bound["externalContentHash"]:
            raise ValidationError("Refresh this external result before preparing local verification.")
        return self.execution.preview_verification(project_id, {
            "taskId": bound["taskId"], "externalResultId": result_id,
            "externalContentHash": bound["externalContentHash"], "candidateCommit": bound["candidateCommit"],
            "command": payload.get("command"), "timeoutSeconds": payload.get("timeoutSeconds")})

    def start_verification(self, project_id, result_id, payload):
        obj(payload, {"previewId", "mutationId", "confirmed"}, "external verification authorization")
        identifier(payload.get("previewId"), "Preview ID")
        with closing(self.store.connect()) as db:
            row = db.execute("SELECT snapshot FROM execution_previews WHERE project_id=? AND id=?",
                             (project_id, payload["previewId"])).fetchone()
        if row is None or json.loads(row["snapshot"]).get("externalResultId") != result_id:
            raise ValidationError("This verification preview does not belong to the selected external result.")
        return self.execution.start_verification(project_id, payload)


def register_handoff_routes(app, service):
    from flask import jsonify, request

    @app.get("/api/projects/<project_id>/handoffs")
    def handoff_state(project_id):
        return jsonify(service.state(project_id, request.args.get("taskId")))

    @app.post("/api/projects/<project_id>/handoffs")
    def handoff_create(project_id):
        return jsonify(service.create(project_id, request.get_json()))

    @app.get("/api/projects/<project_id>/handoffs/<handoff_id>")
    def handoff_detail(project_id, handoff_id):
        return jsonify(service.detail(project_id, handoff_id))

    @app.post("/api/projects/<project_id>/handoffs/<handoff_id>/results")
    def handoff_import(project_id, handoff_id):
        return jsonify(service.import_result(project_id, handoff_id, request.get_json()))

    @app.post("/api/projects/<project_id>/external-results/<result_id>/review")
    def external_review(project_id, result_id):
        return jsonify(service.review(project_id, result_id, request.get_json()))

    @app.post("/api/projects/<project_id>/external-results/<result_id>/prepare-run")
    def external_prepare_run(project_id, result_id):
        return jsonify(service.prepare_run(project_id, result_id, request.get_json()))

    @app.post("/api/projects/<project_id>/external-results/<result_id>/verification/preview")
    def external_verification_preview(project_id, result_id):
        return jsonify(service.preview_verification(project_id, result_id, request.get_json()))

    @app.post("/api/projects/<project_id>/external-results/<result_id>/verification/start")
    def external_verification_start(project_id, result_id):
        return jsonify(service.start_verification(project_id, result_id, request.get_json()))
