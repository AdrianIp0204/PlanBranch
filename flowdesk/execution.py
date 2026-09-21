"""Explicit one-step execution outside manual history and read-only source grants."""
from __future__ import annotations
from contextlib import closing
from copy import deepcopy
import json
import os
from pathlib import Path
import threading
from uuid import uuid4
import weakref
from .planning import fingerprint, manual_fingerprint
from .storage import ConflictError, NotFoundError, encode, now
from .validation import MAX_HISTORY, ValidationError, identifier, integer, obj, string, validate_content

ACTIVE = {"queued", "running", "cancelling"}
TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}


class ExecutionReceiptError(RuntimeError):
    """A definitive refusal, safe to replace with a new deliberate request."""
    def __init__(self, message, mutation_id):
        super().__init__(message)
        self.receipt = {"mutationId": mutation_id, "state": "failed"}


class ExecutionOwnership:
    """An OS-released lock prevents another server taking over live runs."""
    def __init__(self, directory):
        self.handle = None
        try:
            handle = (Path(directory) / "execution.lock").open("a+b")
        except OSError:
            return
        try:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"0"); handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.handle = handle
        except (OSError, BlockingIOError):
            handle.close()

    @property
    def available(self):
        return self.handle is not None

    def close(self):
        if self.handle is not None:
            self.handle.close()
            self.handle = None


class ExecutionService:
    def __init__(self, store, planning, executor=None, git=None):
        self.store, self.planning = store, planning
        self.data_dir = store.db_path.parent
        self._executor, self._git = executor, git
        self._mutex = threading.RLock()
        self._threads, self._cancels = {}, {}
        self.ownership = ExecutionOwnership(self.data_dir)
        self._finalizer = weakref.finalize(self, self.ownership.close)
        if self.ownership.available:
            with closing(store.connect()) as db, db:
                db.execute("UPDATE execution_runs SET state='interrupted',error=?,progress=?,updated_at=? "
                           "WHERE state IN ('queued','running','cancelling')",
                           ("Execution was interrupted. Inspect the preserved worktree; it has not been rerun.",
                            "Interrupted; review preserved work", now()))

    @property
    def executor(self):
        if self._executor is None:
            from .codex_executor import CodexExecutor
            self._executor = CodexExecutor()
        return self._executor

    @property
    def git(self):
        if self._git is None:
            from .execution_git import GitWorkspace
            self._git = GitWorkspace(self.data_dir)
        return self._git

    def close(self):
        for event in tuple(self._cancels.values()): event.set()
        for thread in tuple(self._threads.values()):
            if thread is not threading.current_thread(): thread.join(timeout=2)
        if not any(thread.is_alive() for thread in self._threads.values()): self.ownership.close()

    def _own(self):
        if not self.ownership.available:
            raise RuntimeError("Another PlanBranch server owns execution for this data folder. Manual planning remains available.")

    def _row(self, db, project_id, run_id):
        identifier(run_id, "Run ID")
        self.store._row(db, project_id)
        row = db.execute("SELECT * FROM execution_runs WHERE project_id=? AND id=?", (project_id, run_id)).fetchone()
        if row is None: raise NotFoundError("Execution run not found.")
        return row

    def _repository(self, db, project_id):
        row = db.execute("SELECT * FROM execution_repositories WHERE project_id=?", (project_id,)).fetchone()
        return None if row is None else {**json.loads(row["repository"]), "id": row["id"], "createdAt": row["created_at"]}

    def _receipt(self, db, project_id, action, payload):
        identifier(payload.get("mutationId"), "Mutation ID")
        digest = fingerprint({"action": action, "payload": payload})
        row = db.execute("SELECT * FROM execution_receipts WHERE project_id=? AND mutation_id=?", (project_id, payload["mutationId"])).fetchone()
        if row is not None:
            if row["payload_hash"] != digest: raise ValidationError("A mutation ID cannot be reused for a different execution action.")
            if row["state"] == "failed": raise ExecutionReceiptError(json.loads(row["result"])["error"], payload["mutationId"])
            return {"state": row["state"], "result": json.loads(row["result"]) if row["result"] else None}
        db.execute("INSERT INTO execution_receipts VALUES(?,?,?,?,'pending',NULL)", (project_id, payload["mutationId"], digest, action))
        return None

    def _done(self, db, project_id, payload, result):
        db.execute("UPDATE execution_receipts SET state='done',result=? WHERE project_id=? AND mutation_id=?", (encode(result), project_id, payload["mutationId"]))

    @staticmethod
    def _confirmed(payload):
        if payload.get("confirmed") is not True: raise ValidationError("Confirm this execution action before continuing.")

    @staticmethod
    def _summary(row):
        snapshot = json.loads(row["snapshot"])
        return {"id": row["id"], "previewId": row["preview_id"], "taskId": snapshot["task"]["id"], "taskTitle": snapshot["task"]["title"],
                "state": row["state"], "createdAt": row["created_at"], "updatedAt": row["updated_at"], "sourceCommit": snapshot["sourceCommit"],
                "summary": row["summary"], "error": row["error"], "progress": row["progress"], "acceptedDigest": row["accepted_digest"],
                "completedCursor": row["completed_cursor"], "applied": bool(row["applied"])}

    def state(self, project_id):
        with closing(self.store.connect()) as db:
            self.store._row(db, project_id)
            repository = self._repository(db, project_id)
            runs = [self._summary(row) for row in db.execute("SELECT * FROM execution_runs WHERE project_id=? ORDER BY created_at DESC,id DESC", (project_id,))]
        return {"repository": repository, "runs": runs, "agent": self.executor.status(), "ownership": {
            "available": self.ownership.available, **({} if self.ownership.available else {"reason": "Another PlanBranch server owns execution. Manual planning remains available."})}}

    def repository(self, project_id, payload):
        obj(payload, {"mutationId", "path", "confirmed"}, "execution repository selection")
        self._confirmed(payload); self._own(); string(payload.get("path"), "Execution repository path", 4096, True)
        with self._mutex, closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.store._row(db, project_id)
            if self._receipt(db, project_id, "repository", payload) is None:
                if db.execute("SELECT 1 FROM execution_runs WHERE project_id=? AND state IN ('queued','running','cancelling')", (project_id,)).fetchone():
                    raise RuntimeError("Wait for or cancel this project's active run before changing repositories.")
                if db.execute("SELECT 1 FROM execution_receipts WHERE project_id=? AND action LIKE 'apply:%' AND state='pending'", (project_id,)).fetchone():
                    raise RuntimeError("Recover the unfinished Apply before changing execution repositories.")
                inspected = self.git.inspect_repository(payload["path"])
                prior = self._repository(db, project_id)
                key = prior["id"] if prior and prior["path"] == inspected["path"] else str(uuid4())
                db.execute("INSERT INTO execution_repositories VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET id=excluded.id,repository=excluded.repository,created_at=excluded.created_at", (project_id, key, encode(inspected), now()))
                self._done(db, project_id, payload, {"repositoryId": key})
        return self.state(project_id)

    def preview(self, project_id, payload):
        obj(payload, {"taskId", "selection"}, "execution preview")
        identifier(payload.get("taskId"), "Build task ID")
        selection = self.planning._selection(payload.get("selection", {"mode": "default"}))
        with closing(self.store.connect()) as db:
            db.execute("BEGIN")
            project = self.planning._current(db, project_id)
            planning = self.planning._state(db, project_id)
            repository = self._repository(db, project_id)
            active = db.execute("SELECT 1 FROM execution_runs WHERE state IN ('queued','running','cancelling')").fetchone()
            applying = db.execute("SELECT 1 FROM execution_receipts WHERE action LIKE 'apply:%' AND state='pending'").fetchone()
        tasks = {task["id"]: task for task in project["content"]["buildTasks"]}
        task = tasks.get(payload["taskId"])
        if task is None: raise ValidationError("Choose a Build task in this project.")
        issues = []
        if not self.ownership.available: issues.append("Another PlanBranch server owns execution.")
        if active: issues.append("An execution run is already in progress. Finish or cancel it first.")
        if applying: issues.append("Recover the unfinished checkout Apply before running another step.")
        if not task["title"].strip(): issues.append("Give this task a meaningful title.")
        if not task["deliverable"].strip(): issues.append("Describe the intended deliverable.")
        if not any(check["text"].strip() for check in task["acceptanceChecks"]): issues.append("Add at least one acceptance check.")
        if task["status"] == "done": issues.append("This task is already done. Reopen it before running again.")
        if any(tasks[key]["status"] != "done" for key in task["prerequisiteIds"]): issues.append("Complete this task's prerequisites before running it.")
        if any(link["missing"] for link in task["nodeLinks"]): issues.append("Resolve this task's removed flow-node links before running it.")
        approval = planning["approval"]
        if not approval or not approval["current"]: issues.append("Approve the current saved plan before running a step.")
        source = None
        if repository is None: issues.append("Choose an execution repository. A scanner attachment does not grant execution permission.")
        else:
            try: source = self.git.inspect_repository(repository["path"])
            except (OSError, RuntimeError, ValueError) as exc: issues.append(str(exc))
        generation = None
        status = self.executor.status()
        if not status.get("available"): issues.append(status.get("reason", "Codex execution is unavailable."))
        else:
            try: generation = self.executor.configure(selection)
            except (RuntimeError, ValueError) as exc: issues.append(str(exc))
        linked = {link["nodeId"] for link in task["nodeLinks"]}
        snapshot = {"baseRevision": project["revision"], "repositoryId": repository["id"] if repository else None, "repository": source,
                    "approvalId": approval["id"] if approval and approval["current"] else None,
                    "approvalHash": approval["contentHash"] if approval and approval["current"] else None, "sourceCommit": source["head"] if source else None,
                    "task": deepcopy(task), "brief": deepcopy(project["content"]["brief"]), "content": deepcopy(project["content"]),
                    "linkedNodes": [deepcopy(node) for diagram in project["content"]["diagrams"] for node in diagram["nodes"] if node["id"] in linked], "generation": generation}
        key, timestamp = str(uuid4()), now()
        with closing(self.store.connect()) as db, db:
            self.store._row(db, project_id)
            db.execute("INSERT INTO execution_previews VALUES(?,?,?,?,?,?)", (key, project_id, encode(snapshot), int(not issues), encode(issues), timestamp))
        public = {name: value for name, value in snapshot.items() if name not in {"content", "approvalHash"}}
        return {"preview": {"id": key, "createdAt": timestamp, **public}, "ready": not issues, "issues": issues}

    def _grant_matches(self, db, project_id, snapshot):
        repository = self._repository(db, project_id)
        return repository is not None and all(repository.get(key) == snapshot["repository"].get(key) for key in ("path", "gitDir", "commonDir"))

    def _plan_current(self, db, project_id, snapshot):
        approval = self.planning._state(db, project_id)["approval"]
        return bool(approval and approval["current"] and approval["contentHash"] == snapshot["approvalHash"])

    def _source_current(self, snapshot):
        try:
            inspect = getattr(self.git, "repository_identity", self.git.inspect_repository)
            live = inspect(snapshot["repository"]["path"])
            return live["head"] == snapshot["sourceCommit"] and all(live.get(key) == snapshot["repository"].get(key) for key in ("path", "gitDir", "commonDir"))
        except (OSError, RuntimeError, ValueError): return False

    def start(self, project_id, payload):
        obj(payload, {"mutationId", "previewId", "confirmed"}, "run step")
        self._confirmed(payload); self._own(); identifier(payload.get("previewId"), "Execution preview ID")
        with self._mutex, closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.store._row(db, project_id)
            previous = self._receipt(db, project_id, "run", payload)
            if previous:
                run_id = previous["result"]["runId"]
            else:
                preview = db.execute("SELECT * FROM execution_previews WHERE project_id=? AND id=?", (project_id, payload["previewId"])).fetchone()
                if preview is None: raise NotFoundError("Execution preview not found.")
                if not preview["ready"]: raise ValidationError("This preview is not ready to run. Resolve its issues and review a new preview.")
                if db.execute("SELECT 1 FROM execution_runs WHERE preview_id=?", (payload["previewId"],)).fetchone():
                    raise RuntimeError("This preview already started a run. Open that run instead of starting it again.")
                if db.execute("SELECT 1 FROM execution_runs WHERE state IN ('queued','running','cancelling')").fetchone():
                    raise RuntimeError("Another execution run is active. Finish or cancel it first.")
                if db.execute("SELECT 1 FROM execution_receipts WHERE action LIKE 'apply:%' AND state='pending'").fetchone():
                    raise RuntimeError("Recover the unfinished checkout Apply before running another step.")
                snapshot = json.loads(preview["snapshot"])
                project = self.planning._current(db, project_id)
                if project["revision"] != snapshot["baseRevision"]: raise ConflictError(project["revision"])
                approval = self.planning._state(db, project_id)["approval"]
                if not self._plan_current(db, project_id, snapshot) or approval["id"] != snapshot["approvalId"]:
                    raise RuntimeError("The approved plan changed. Review a new Run preview.")
                repository = self._repository(db, project_id)
                if not repository or repository["id"] != snapshot["repositoryId"] or not self._grant_matches(db, project_id, snapshot):
                    raise RuntimeError("The selected execution repository changed. Review a new Run preview.")
                if not self._source_current(snapshot): raise RuntimeError("The source revision changed. Review a new Run preview.")
                run_id, timestamp = str(uuid4()), now()
                db.execute("INSERT INTO execution_runs(id,project_id,preview_id,state,snapshot,created_at,updated_at,progress) VALUES(?,?,?,'queued',?,?,?,?)",
                           (run_id, project_id, payload["previewId"], encode(snapshot), timestamp, timestamp, "Preparing isolated worktree"))
                self._done(db, project_id, payload, {"runId": run_id})
                # Commit intent before creating a worktree or invoking an agent.
                db.commit()
                cancel = threading.Event()
                thread = threading.Thread(target=self._worker, args=(project_id, run_id, cancel), daemon=True, name="planbranch-execution")
                self._cancels[run_id], self._threads[run_id] = cancel, thread
                thread.start()
        return self.detail(project_id, run_id)

    def _workspace(self, row):
        return json.loads(row["workspace"]) if row["workspace"] else self.git.load(row["id"])

    def _apply_plan_current(self, project, row, snapshot):
        expected = deepcopy(snapshot["content"])
        if manual_fingerprint(expected) == manual_fingerprint(project["content"]): return True
        if row["completed_cursor"]:
            for task in expected["buildTasks"]:
                if task["id"] == snapshot["task"]["id"]: task["status"] = "done"
        return manual_fingerprint(expected) == manual_fingerprint(project["content"])

    def detail(self, project_id, run_id):
        with closing(self.store.connect()) as db:
            db.execute("BEGIN")
            row = self._row(db, project_id, run_id)
            snapshot = json.loads(row["snapshot"])
            project = self.planning._current(db, project_id)
            plan_current = self._plan_current(db, project_id, snapshot)
            grant_current = self._grant_matches(db, project_id, snapshot)
            pending = db.execute("SELECT mutation_id,result FROM execution_receipts WHERE project_id=? AND action=? AND state='pending' ORDER BY rowid LIMIT 1",
                                 (project_id, "apply:" + run_id)).fetchone()
            result = {**self._summary(row), "repository": snapshot["repository"],
                      "context": {key: snapshot[key] for key in ("task", "brief", "linkedNodes", "sourceCommit", "generation")},
                      "commands": json.loads(row["commands"]), "events": json.loads(row["events"]), "planStale": not plan_current,
                      "applyPlanStale": not self._apply_plan_current(project, row, snapshot),
                      "applyRequest": json.loads(pending["result"])["request"] if pending and pending["result"] else None}
        workspace = self._workspace(row)
        result.update(worktreePath=workspace["path"] if workspace else None,
                      artifact=self.git.artifact(run_id, row["artifact_digest"]) if row["artifact_digest"] else None,
                      sourceStale=not grant_current or not self._source_current(snapshot),
                      applyState=self.git.inspect_apply(workspace, row["accepted_digest"]) if workspace and row["accepted_digest"] else None)
        return {"run": result}

    def _event(self, project_id, run_id, event):
        if not isinstance(event, dict): return
        with closing(self.store.connect()) as db, db:
            row = self._row(db, project_id, run_id)
            if row["state"] not in ACTIVE: return
            commands, events = json.loads(row["commands"]), json.loads(row["events"])
            progress = row["progress"]
            if event.get("type") == "command" and isinstance(event.get("command"), dict):
                command = event["command"]
                key = str(command.get("id", ""))[:200]
                if not key: return
                item = {"id": key, "command": str(command.get("command", ""))[:16000], "status": str(command.get("status", "unknown"))[:100],
                        "exitCode": command.get("exitCode") if type(command.get("exitCode")) is int else None, "output": str(command.get("output", ""))[-65536:]}
                old = next((index for index, value in enumerate(commands) if value["id"] == key), None)
                if old is not None: commands[old] = item
                elif len(commands) < 250: commands.append(item)
                progress = "Command activity recorded"
            elif event.get("type") in {"message", "progress"}:
                field = "text" if event["type"] == "message" else "message"
                value = str(event.get(field, ""))[:16000]
                events.append({"type": event["type"], field: value}); events = events[-100:]
                if event["type"] == "progress": progress = value[:500]
            else: return
            db.execute("UPDATE execution_runs SET commands=?,events=?,progress=?,updated_at=? WHERE id=?", (encode(commands), encode(events), progress, now(), run_id))

    def _worker(self, project_id, run_id, cancel):
        workspace, artifact = None, None
        result = {"status": "cancelled", "summary": "Cancelled before execution.", "commands": []}
        try:
            with closing(self.store.connect()) as db, db:
                row = self._row(db, project_id, run_id)
                snapshot = json.loads(row["snapshot"])
                db.execute("UPDATE execution_runs SET state=?,updated_at=? WHERE id=?", ("cancelling" if cancel.is_set() else "running", now(), run_id))
            if not cancel.is_set():
                workspace = self.git.create(snapshot["repository"], snapshot["sourceCommit"], run_id)
                with closing(self.store.connect()) as db, db:
                    db.execute("UPDATE execution_runs SET workspace=?,progress=?,updated_at=? WHERE id=?", (encode(workspace), "Codex is working in the isolated worktree", now(), run_id))
                context = {key: deepcopy(snapshot[key]) for key in ("task", "brief", "linkedNodes", "sourceCommit", "generation")}
                if not cancel.is_set():
                    # Creating a worktree may take time. Recheck immediately
                    # before launching; a previous preview never grants later edits.
                    with closing(self.store.connect()) as db:
                        if not self._plan_current(db, project_id, snapshot) or not self._grant_matches(db, project_id, snapshot):
                            raise RuntimeError("The approved plan or repository changed while preparing the worktree. The agent was not started.")
                    if not self._source_current(snapshot):
                        raise RuntimeError("The source revision changed while preparing the worktree. The agent was not started.")
                    result = self.executor.run(context, workspace["path"], cancel, lambda event: self._event(project_id, run_id, event))
                    for command in result.get("commands", []): self._event(project_id, run_id, {"type": "command", "command": command})
        except Exception as exc:
            result = {"status": "cancelled" if cancel.is_set() else "failed", "summary": "Execution did not finish.", "error": str(exc)[:4000]}
        try:
            workspace = workspace or self.git.load(run_id)
            if workspace is not None: artifact = self.git.capture(workspace)
        except Exception as exc:
            result["error"] = (result.get("error", "") + " Changes could not be captured: " + str(exc))[:4000]
            if result.get("status") == "succeeded": result["status"] = "failed"
        finally:
            with closing(self.store.connect()) as db, db:
                state = result.get("status") if result.get("status") in TERMINAL else "failed"
                if cancel.is_set() and state == "succeeded": state = "cancelled"
                db.execute("UPDATE execution_runs SET state=?,summary=?,error=?,artifact_digest=?,progress=?,updated_at=? WHERE id=? AND state IN ('queued','running','cancelling')",
                           (state, str(result.get("summary", ""))[:24000], result.get("error"), artifact["digest"] if artifact else None,
                            "Review the preserved changes" if artifact else "Inspect the run details", now(), run_id))
            self._cancels.pop(run_id, None); self._threads.pop(run_id, None)

    def cancel(self, project_id, run_id, payload):
        obj(payload, {"mutationId"}, "cancel execution")
        self._own()
        with self._mutex, closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = self._row(db, project_id, run_id)
            if self._receipt(db, project_id, "cancel:" + run_id, payload) is None:
                if row["state"] in ACTIVE:
                    db.execute("UPDATE execution_runs SET state='cancelling',progress='Cancellation requested',updated_at=? WHERE id=?", (now(), run_id))
                    if run_id in self._cancels: self._cancels[run_id].set()
                self._done(db, project_id, payload, {"runId": run_id})
        return self.detail(project_id, run_id)

    def _current_artifact(self, row, digest=None):
        if row["state"] in ACTIVE: raise RuntimeError("Wait for the run to stop before reviewing or applying its files.")
        workspace = self._workspace(row)
        if workspace is None: raise RuntimeError("This run has no recoverable worktree yet.")
        artifact = self.git.capture(workspace)
        if digest is not None and artifact["digest"] != digest: raise RuntimeError("The worktree changed. Refresh its changes and review the new diff.")
        return workspace, artifact

    def refresh(self, project_id, run_id, payload):
        obj(payload, {"mutationId"}, "refresh execution diff")
        self._own()
        with self._mutex, closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = self._row(db, project_id, run_id)
            if self._receipt(db, project_id, "refresh:" + run_id, payload) is None:
                workspace, artifact = self._current_artifact(row)
                db.execute("UPDATE execution_runs SET workspace=?,artifact_digest=?,updated_at=? WHERE id=?", (encode(workspace), artifact["digest"], now(), run_id))
                self._done(db, project_id, payload, {"runId": run_id, "digest": artifact["digest"]})
        return self.detail(project_id, run_id)

    def accept(self, project_id, run_id, payload):
        obj(payload, {"mutationId", "digest", "confirmed"}, "accept execution changes")
        self._confirmed(payload); self._own(); string(payload.get("digest"), "Change digest", 128, True)
        with self._mutex, closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = self._row(db, project_id, run_id)
            if self._receipt(db, project_id, "accept:" + run_id, payload) is None:
                snapshot = json.loads(row["snapshot"])
                if row["completed_cursor"] or row["applied"]: raise RuntimeError("This run already completed or applied its task. Start newly reviewed work for further changes.")
                if not self._plan_current(db, project_id, snapshot): raise RuntimeError("The approved plan changed. Restore and approve the reviewed plan before accepting this run.")
                if not self._grant_matches(db, project_id, snapshot) or not self._source_current(snapshot): raise RuntimeError("The selected source baseline changed. Review this run before accepting its changes.")
                if row["artifact_digest"] != payload["digest"]: raise RuntimeError("Review the current captured changes before accepting them.")
                self._current_artifact(row, payload["digest"])
                db.execute("UPDATE execution_runs SET accepted_digest=?,updated_at=? WHERE id=?", (payload["digest"], now(), run_id))
                self._done(db, project_id, payload, {"runId": run_id, "acceptedDigest": payload["digest"]})
        return self.detail(project_id, run_id)

    def complete(self, project_id, run_id, payload):
        obj(payload, {"mutationId", "digest", "baseRevision", "confirmed"}, "complete executed task")
        self._confirmed(payload); self._own(); integer(payload.get("baseRevision"), "Base revision")
        string(payload.get("digest"), "Change digest", 128, True)
        with self._mutex, closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = self._row(db, project_id, run_id)
            if self._receipt(db, project_id, "complete:" + run_id, payload) is None:
                project = self.store._envelope(db, project_id)
                if project["revision"] != payload["baseRevision"]: raise ConflictError(project["revision"])
                snapshot = json.loads(row["snapshot"])
                if row["completed_cursor"]: raise RuntimeError("This run already completed its task.")
                if row["accepted_digest"] != payload["digest"]: raise RuntimeError("Explicitly accept these changes before marking the task complete.")
                if not self._plan_current(db, project_id, snapshot): raise RuntimeError("The approved plan changed. Restore and approve the reviewed plan before completing this task.")
                if not self._grant_matches(db, project_id, snapshot) or not self._source_current(snapshot): raise RuntimeError("The source revision or repository changed. Review it before completing this task.")
                self._current_artifact(row, payload["digest"])
                content = deepcopy(project["content"])
                task = next((item for item in content["buildTasks"] if item["id"] == snapshot["task"]["id"]), None)
                if task is None: raise RuntimeError("The executed task no longer exists in this plan.")
                task["status"] = "done"
                content = validate_content(content, self.store._detected_ids(db, project_id))
                checkpoint = {"id": str(uuid4()), "label": ("Complete Build task: " + task["title"])[:200], "content": content}
                cursor = next(index for index, item in enumerate(project["history"]) if item["id"] == project["cursor"])
                history = (project["history"][:cursor + 1] + [checkpoint])[-MAX_HISTORY:]
                self.store._write_history(db, project_id, history)
                self.store._write_current(db, project_id, content)
                db.execute("UPDATE projects SET revision=revision+1,saved_at=?,cursor=? WHERE id=?", (now(), checkpoint["id"], project_id))
                db.execute("UPDATE execution_runs SET completed_cursor=?,updated_at=? WHERE id=?", (checkpoint["id"], now(), run_id))
                self._done(db, project_id, payload, {"runId": run_id, "completedCursor": checkpoint["id"]})
            envelope = self.store._envelope(db, project_id)
        return {**self.detail(project_id, run_id), "project": envelope}

    def apply(self, project_id, run_id, payload):
        obj(payload, {"mutationId", "digest", "confirmed"}, "apply accepted code to checkout")
        self._confirmed(payload); self._own(); string(payload.get("digest"), "Change digest", 128, True)
        with self._mutex:
            with closing(self.store.connect()) as db, db:
                db.execute("BEGIN IMMEDIATE")
                row = self._row(db, project_id, run_id)
                pending = db.execute("SELECT mutation_id FROM execution_receipts WHERE project_id=? AND action=? AND state='pending'", (project_id, "apply:" + run_id)).fetchone()
                if pending and pending["mutation_id"] != payload["mutationId"]:
                    raise RuntimeError("This run has an unfinished Apply. Recover its existing request before starting another.")
                receipt = self._receipt(db, project_id, "apply:" + run_id, payload)
                if receipt is not None and receipt["state"] == "done": return self.detail(project_id, run_id)
                try:
                    snapshot = json.loads(row["snapshot"])
                    if row["accepted_digest"] != payload["digest"]: raise RuntimeError("Accept this exact diff before applying it to the checkout.")
                    if not self._grant_matches(db, project_id, snapshot): raise RuntimeError("Select this run's execution repository before applying its changes.")
                    project = self.planning._current(db, project_id)
                    if not self._apply_plan_current(project, row, snapshot): raise RuntimeError("The reviewed plan changed beyond this run's completion. Review that change before applying this saved result.")
                    workspace, artifact = self._current_artifact(row, payload["digest"])
                except (RuntimeError, ValueError) as exc:
                    # A new request has not crossed the filesystem boundary.
                    # Record a definitive refusal so its UI can review a new
                    # digest. An older pending request may have partial writes
                    # and must keep the original identity for recovery.
                    if receipt is None:
                        db.execute("UPDATE execution_receipts SET state='failed',result=? WHERE project_id=? AND mutation_id=?", (encode({"error": str(exc)}), project_id, payload["mutationId"]))
                        db.commit()
                        raise ExecutionReceiptError(str(exc), payload["mutationId"]) from exc
                    raise
                db.execute("UPDATE execution_receipts SET result=? WHERE project_id=? AND mutation_id=?", (encode({"runId": run_id, "request": payload}), project_id, payload["mutationId"]))
                # Commit intent before crossing the SQLite/filesystem boundary.
                db.commit()
            try:
                result = self.git.apply(workspace, artifact["digest"])
            except (RuntimeError, ValueError) as exc:
                # Partial writes keep their receipt and journal for a deliberate
                # same-ID retry. Known preflight refusals are immutable failures.
                if self.git.inspect_apply(workspace, artifact["digest"]) is None:
                    with closing(self.store.connect()) as db, db:
                        db.execute("UPDATE execution_receipts SET state='failed',result=? WHERE project_id=? AND mutation_id=?", (encode({"error": str(exc)}), project_id, payload["mutationId"]))
                    raise ExecutionReceiptError(str(exc), payload["mutationId"]) from exc
                raise
            with closing(self.store.connect()) as db, db:
                db.execute("BEGIN IMMEDIATE")
                self._row(db, project_id, run_id)
                db.execute("UPDATE execution_runs SET applied=1,updated_at=? WHERE id=?", (now(), run_id))
                self._done(db, project_id, payload, {"runId": run_id, "digest": artifact["digest"], "result": result})
        return self.detail(project_id, run_id)
