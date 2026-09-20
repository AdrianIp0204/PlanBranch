"""Durable planning conversation and explicit review, separate from graph history.

The provider can propose one diagram, never write project content. Acceptance is
the sole boundary that projects a proposal into ordinary undoable manual content.
"""
from __future__ import annotations

from contextlib import closing
from copy import deepcopy
import hashlib
import json
import threading
from uuid import uuid4

from .storage import ConflictError, NotFoundError, encode, now
from .validation import MAX_HISTORY, ValidationError, identifier, integer, obj, string, validate_content


def fingerprint(value):
    return hashlib.sha256(encode(value).encode("utf-8")).hexdigest()


def diagram_in(content, diagram_id):
    identifier(diagram_id, "Diagram ID")
    diagram = next((d for d in content["diagrams"] if d["id"] == diagram_id), None)
    if diagram is None:
        raise ValidationError("Choose a diagram in this project.")
    return diagram


def node_in(diagram, node_id):
    identifier(node_id, "Node ID")
    node = next((n for n in diagram["nodes"] if n["id"] == node_id), None)
    if node is None:
        raise ValidationError("Choose a node in the selected diagram.")
    return node


def changes_between(before, after, old_links, new_links):
    """Return inspectable field changes, including discarded variable links."""
    changes = []
    for collection, kind, id_key in (("nodes", "node", "nodeId"), ("edges", "edge", "edgeId")):
        previous = {item["id"]: item for item in before[collection]}
        proposed = {item["id"]: item for item in after[collection]}
        for item_id in dict.fromkeys([*previous, *proposed]):
            old, new = previous.get(item_id), proposed.get(item_id)
            item = old or new
            label = item.get("title") or item.get("label") or (f'{item.get("source")} → {item.get("target")}' if kind == "edge" else "Untitled node")
            if old is None or new is None:
                verb = "Add" if old is None else "Remove"
                changes.append({"kind": f'{verb.lower()}_{kind}', id_key: item_id,
                                "label": f"{verb} {kind}: {label}", "before": old, "after": new})
            else:
                for field in sorted(set(old) | set(new)):
                    if old.get(field) != new.get(field):
                        changes.append({"kind": f"update_{kind}", id_key: item_id, "field": field,
                                        "label": f"{label}: {field}", "before": old.get(field), "after": new.get(field)})
        # Order is part of the manual snapshot and may affect presentation.
        shared_old = [item["id"] for item in before[collection] if item["id"] in proposed]
        shared_new = [item["id"] for item in after[collection] if item["id"] in previous]
        if shared_old != shared_new:
            changes.append({"kind": f"reorder_{collection}", "label": f"Reorder {collection}",
                            "before": shared_old, "after": shared_new})
    retained = {link["id"] for link in new_links}
    for link in old_links:
        if link["id"] not in retained:
            changes.append({"kind": "remove_link", "nodeId": link["nodeId"],
                            "label": "Remove variable link from deleted node", "before": link, "after": None})
    return changes


def provider_context_for(context):
    """Bound conversation history without silently omitting open user concerns."""
    result = deepcopy(context)
    result["content"]["nodeLinks"] = [link for link in result["content"]["nodeLinks"] if link["origin"] == "planned"]
    result["content"]["matches"] = []
    result.setdefault("omittedMessageCount", 0)
    result["omittedResolvedCommentCount"] = 0
    while len(encode(result).encode("utf-8")) > 450_000:
        resolved = next((i for i, comment in enumerate(result["comments"]) if comment["resolved"]), None)
        if resolved is not None:
            result["comments"].pop(resolved)
            result["omittedResolvedCommentCount"] += 1
        elif len(result["messages"]) > 1:
            result["messages"].pop(0)
            result["omittedMessageCount"] += 1
        else:
            break
    return result


class PlanningService:
    def __init__(self, store, planner=None):
        if planner is None:
            from .codex_planner import CodexPlanner
            planner = CodexPlanner()
        self.store = store
        self.planner = planner
        self._threads = {}
        self._thread_lock = threading.Lock()
        # A request interrupted by shutdown cannot be resumed blindly. It retains
        # its original context and can be explicitly retried with the same ID.
        with closing(store.connect()) as db, db:
            db.execute("UPDATE planning_requests SET status='failed',error=?,updated_at=? WHERE status='running'",
                       ("Planning was interrupted when FlowDesk stopped. Retry this message to continue.", now()))

    def _current(self, db, project_id):
        """Read the selected snapshot without decoding the retained undo branch."""
        project = self.store._row(db, project_id)
        checkpoint = db.execute("SELECT schema_version,content FROM history_checkpoints WHERE project_id=? AND id=?",
                                (project_id, project["cursor"])).fetchone()
        if checkpoint is None:
            raise ValidationError("Saved project history is inconsistent; restore a database backup.")
        if checkpoint["schema_version"] != 1:
            raise ValidationError("Unsupported saved history version.")
        return {"id": project_id, "revision": project["revision"], "savedAt": project["saved_at"],
                "cursor": project["cursor"], "content": json.loads(checkpoint["content"])}

    def _state(self, db, project_id):
        project = self._current(db, project_id)
        content_hash = fingerprint(project["content"])
        messages = []
        for row in db.execute("SELECT * FROM planning_messages WHERE project_id=? ORDER BY created_at,id", (project_id,)):
            message = {"id": row["id"], "role": row["role"], "text": row["text"], "createdAt": row["created_at"]}
            for source, target in (("diagram_id", "diagramId"), ("node_id", "nodeId"), ("node_title", "nodeTitle"), ("proposal_id", "proposalId")):
                if row[source] is not None:
                    message[target] = row[source]
            messages.append(message)
        comments = [{"id": r["id"], "diagramId": r["diagram_id"], "nodeId": r["node_id"],
                     "nodeTitle": r["node_title"], "text": r["text"], "createdAt": r["created_at"], "resolved": bool(r["resolved"])}
                    for r in db.execute("SELECT * FROM planning_comments WHERE project_id=? ORDER BY created_at,id", (project_id,))]
        proposals = []
        for row in db.execute("SELECT * FROM planning_proposals WHERE project_id=? ORDER BY created_at,id", (project_id,)):
            state = row["state"]
            if state == "pending" and row["base_hash"] != content_hash:
                state = "stale"
            proposals.append({"id": row["id"], "title": row["title"], "summary": row["summary"], "diagramId": row["diagram_id"],
                              "baseRevision": row["base_revision"], "baseCursor": row["base_cursor"], "baseHash": row["base_hash"],
                              "state": state, "createdAt": row["created_at"], "changes": json.loads(row["changes"])})
        row = db.execute("SELECT * FROM planning_approvals WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 1", (project_id,)).fetchone()
        approval = None if row is None else {"id": row["id"], "revision": row["revision"], "cursor": row["cursor"],
                   "contentHash": row["content_hash"], "snapshot": json.loads(row["content"]), "createdAt": row["created_at"],
                   "current": not bool(row["revoked"]) and row["content_hash"] == content_hash}
        row = db.execute("SELECT * FROM planning_requests WHERE project_id=? ORDER BY updated_at DESC,id DESC LIMIT 1", (project_id,)).fetchone()
        request = None
        if row is not None:
            payload = json.loads(row["payload"])
            request = {"id": row["id"], "status": row["status"], "text": payload["text"], "diagramId": payload["diagramId"]}
            if payload.get("nodeId") is not None:
                request["nodeId"] = payload["nodeId"]
            if row["error"]:
                request["error"] = row["error"]
        if approval is not None:
            approval["current"] = approval["current"] and not any(not c["resolved"] for c in comments) and not any(
                p["state"] == "pending" for p in proposals) and not (request and request["status"] == "running")
        return {"messages": messages, "comments": comments, "proposals": proposals, "approval": approval, "request": request}

    def state(self, project_id):
        with closing(self.store.connect()) as db:
            db.execute("BEGIN")
            state = self._state(db, project_id)
        state["agent"] = self.planner.status()
        return state

    def _receipt(self, db, project_id, action, payload):
        identifier(payload.get("mutationId"), "Mutation ID")
        payload_hash = fingerprint({"action": action, "payload": payload})
        previous = db.execute("SELECT payload_hash FROM planning_receipts WHERE project_id=? AND mutation_id=?", (project_id, payload["mutationId"])).fetchone()
        if previous:
            if previous[0] != payload_hash:
                raise ValidationError("A mutation ID cannot be reused for a different planning request.")
            return True
        db.execute("INSERT INTO planning_receipts VALUES(?,?,?)", (project_id, payload["mutationId"], payload_hash))
        return False

    def _revoke(self, db, project_id):
        db.execute("UPDATE planning_approvals SET revoked=1 WHERE project_id=? AND revoked=0", (project_id,))

    def add_comment(self, project_id, payload):
        obj(payload, {"mutationId", "diagramId", "nodeId", "text"}, "node comment")
        string(payload.get("text"), "Comment", 12000, True)
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            project = self._current(db, project_id)
            if not self._receipt(db, project_id, "comment", payload):
                diagram = diagram_in(project["content"], payload.get("diagramId"))
                node = node_in(diagram, payload.get("nodeId"))
                db.execute("INSERT INTO planning_comments VALUES(?,?,?,?,?,?,?,0)",
                           (str(uuid4()), project_id, diagram["id"], node["id"], node["title"], payload["text"], now()))
                self._revoke(db, project_id)
        return self.state(project_id)

    def resolve_comment(self, project_id, comment_id, payload):
        obj(payload, {"resolved"}, "comment resolution")
        if type(payload.get("resolved")) is not bool:
            raise ValidationError("Resolved must be true or false.")
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.store._row(db, project_id)
            result = db.execute("UPDATE planning_comments SET resolved=? WHERE project_id=? AND id=?", (int(payload["resolved"]), project_id, comment_id))
            if not result.rowcount:
                raise NotFoundError("Comment not found.")
            if not payload["resolved"]:
                self._revoke(db, project_id)
        return self.state(project_id)

    def send_message(self, project_id, payload):
        obj(payload, {"mutationId", "text", "diagramId", "nodeId"}, "planning message")
        identifier(payload.get("mutationId"), "Mutation ID")
        string(payload.get("text"), "Message", 12000, True)
        diagram_id = identifier(payload.get("diagramId"), "Diagram ID")
        if payload.get("nodeId") is not None:
            identifier(payload["nodeId"], "Node ID")
        payload = {**payload, "nodeId": payload.get("nodeId")}
        request_id = payload["mutationId"]
        attempt_id = str(uuid4())
        should_start = False
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            project = self._current(db, project_id)
            previous = db.execute("SELECT * FROM planning_requests WHERE project_id=? AND id=?", (project_id, request_id)).fetchone()
            if previous:
                if previous["payload_hash"] != fingerprint(payload):
                    raise ValidationError("A mutation ID cannot be reused for a different message.")
                if previous["status"] != "failed":
                    state = self._state(db, project_id)
                    # CLI availability can take time. Release the write lock
                    # before probing it, including on idempotent retries.
                    db.commit()
                    return self._with_agent(state)
            if db.execute("SELECT 1 FROM planning_requests WHERE project_id=? AND status='running'", (project_id,)).fetchone():
                raise RuntimeError("Wait for the current planning reply before sending another message.")
            timestamp = now()
            if previous:
                db.execute("UPDATE planning_requests SET status='running',attempt_id=?,error=NULL,updated_at=? WHERE project_id=? AND id=?", (attempt_id, timestamp, project_id, request_id))
            else:
                diagram = diagram_in(project["content"], diagram_id)
                node = node_in(diagram, payload["nodeId"]) if payload.get("nodeId") is not None else None
                db.execute("INSERT INTO planning_messages VALUES(?,?,?,?,?,?,?,?,NULL)",
                           (str(uuid4()), project_id, "user", payload["text"], timestamp, diagram_id,
                            node["id"] if node else None, node["title"] if node else None))
                state = self._state(db, project_id)
                context = {"content": project["content"], "activeDiagramId": diagram_id, "nodeId": payload.get("nodeId"),
                           "messages": state["messages"][-200:], "comments": state["comments"],
                           "omittedMessageCount": max(0, len(state["messages"]) - 200)}
                db.execute("INSERT INTO planning_requests VALUES(?,?,?,?,?,?,?,?,?,'running',NULL,?,?)",
                           (request_id, project_id, fingerprint(payload), encode(payload), encode(context),
                            project["revision"], project["cursor"], fingerprint(project["content"]), attempt_id, timestamp, timestamp))
            self._revoke(db, project_id)
            should_start = True
        if should_start:
            thread = threading.Thread(target=self._generate, args=(project_id, request_id, attempt_id), daemon=True, name="flowdesk-planning")
            with self._thread_lock:
                self._threads[(project_id, request_id)] = thread
            thread.start()
        return self.state(project_id)

    def _with_agent(self, state):
        state["agent"] = self.planner.status()
        return state

    def _generate(self, project_id, request_id, attempt_id):
        try:
            with closing(self.store.connect()) as db:
                request = db.execute("SELECT * FROM planning_requests WHERE project_id=? AND id=?", (project_id, request_id)).fetchone()
                if request is None or request["status"] != "running" or request["attempt_id"] != attempt_id:
                    return
                context = json.loads(request["context"])
            # Authored planning text is allowed. Scanner evidence, confirmed
            # symbol relationships, source-root grants and filesystem data are not.
            response = self.planner.generate(provider_context_for(context))
            obj(response, {"message", "proposal"}, "agent reply")
            string(response.get("message"), "Agent message", 24000, True)
            proposed = response.get("proposal")
            proposal_id = None
            with closing(self.store.connect()) as db, db:
                db.execute("BEGIN IMMEDIATE")
                live = db.execute("SELECT status,attempt_id FROM planning_requests WHERE project_id=? AND id=?", (project_id, request_id)).fetchone()
                if live is None or live["status"] != "running" or live["attempt_id"] != attempt_id:
                    return
                if proposed is not None:
                    obj(proposed, {"title", "summary", "diagramId", "nodes", "edges"}, "agent proposal")
                    string(proposed.get("title"), "Proposal title", 200, True)
                    string(proposed.get("summary"), "Proposal summary", 12000, True)
                    if proposed.get("diagramId") != context["activeDiagramId"]:
                        raise ValidationError("The agent may propose changes only to the selected diagram.")
                    content = deepcopy(context["content"])
                    diagram = diagram_in(content, proposed["diagramId"])
                    before = deepcopy(diagram)
                    diagram["nodes"], diagram["edges"] = proposed.get("nodes"), proposed.get("edges")
                    # Validate shape before computing deletion IDs. All remaining
                    # links must keep their exact authored relationship and ID.
                    if not isinstance(diagram["nodes"], list):
                        raise ValidationError("Proposed nodes must be a list.")
                    new_ids = {n.get("id") for n in diagram["nodes"] if isinstance(n, dict) and isinstance(n.get("id"), str)}
                    deleted = {n["id"] for n in before["nodes"]} - new_ids
                    content["nodeLinks"] = [link for link in content["nodeLinks"] if link["nodeId"] not in deleted]
                    content = validate_content(content, self.store._detected_ids(db, project_id))
                    diagram = diagram_in(content, proposed["diagramId"])
                    changes = changes_between(before, diagram, context["content"]["nodeLinks"], content["nodeLinks"])
                    if not changes:
                        raise ValidationError("The proposed diagram contains no changes. Ask for a reply without a proposal instead.")
                    proposal_id = str(uuid4())
                    db.execute("INSERT INTO planning_proposals VALUES(?,?,?,?,?,?,?,?,?,?, 'pending',?)",
                               (proposal_id, project_id, proposed["title"], proposed["summary"], proposed["diagramId"],
                                request["base_revision"], request["base_cursor"], request["base_hash"], encode(content), encode(changes), now()))
                source = json.loads(request["payload"])
                original_node = node_in(diagram_in(context["content"], source["diagramId"]), source["nodeId"]) if source.get("nodeId") else None
                db.execute("INSERT INTO planning_messages VALUES(?,?,?,?,?,?,?,?,?)",
                           (str(uuid4()), project_id, "assistant", response["message"], now(), source["diagramId"],
                            source.get("nodeId"), original_node["title"] if original_node else None, proposal_id))
                db.execute("UPDATE planning_requests SET status='succeeded',error=NULL,updated_at=? WHERE project_id=? AND id=?", (now(), project_id, request_id))
        except Exception as exc:
            # Connector errors and validation messages are deliberately user-safe.
            error = str(exc) if isinstance(exc, (ValidationError, RuntimeError)) else "The planning reply could not be saved. Retry this message."
            with closing(self.store.connect()) as db, db:
                db.execute("UPDATE planning_requests SET status='failed',error=?,updated_at=? WHERE project_id=? AND id=? AND attempt_id=? AND status='running'",
                           (error[:2000], now(), project_id, request_id, attempt_id))
        finally:
            with self._thread_lock:
                self._threads.pop((project_id, request_id), None)

    def accept(self, project_id, proposal_id, payload):
        obj(payload, {"baseRevision", "mutationId"}, "proposal acceptance")
        integer(payload.get("baseRevision"), "Base revision")
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            project = self.store._envelope(db, project_id)
            if not self._receipt(db, project_id, "accept:" + proposal_id, payload):
                proposal = db.execute("SELECT * FROM planning_proposals WHERE project_id=? AND id=?", (project_id, proposal_id)).fetchone()
                if proposal is None:
                    raise NotFoundError("Proposal not found.")
                if project["revision"] != payload["baseRevision"]:
                    raise ConflictError(project["revision"])
                if proposal["state"] != "pending":
                    raise RuntimeError("This proposal has already been reviewed.")
                if proposal["base_hash"] != fingerprint(project["content"]):
                    raise RuntimeError("The plan changed after this proposal was created. Ask the agent for an updated proposal.")
                content = validate_content(json.loads(proposal["content"]), self.store._detected_ids(db, project_id))
                checkpoint = {"id": str(uuid4()), "label": ("Accept proposal: " + proposal["title"])[:200],
                              "diagramId": proposal["diagram_id"], "content": content}
                cursor = next(i for i, h in enumerate(project["history"]) if h["id"] == project["cursor"])
                history = (project["history"][:cursor + 1] + [checkpoint])[-MAX_HISTORY:]
                self.store._write_history(db, project_id, history)
                self.store._write_current(db, project_id, content)
                db.execute("UPDATE projects SET revision=?,saved_at=?,cursor=? WHERE id=?", (project["revision"] + 1, now(), checkpoint["id"], project_id))
                db.execute("UPDATE planning_proposals SET state='accepted' WHERE id=? AND project_id=?", (proposal_id, project_id))
                self._revoke(db, project_id)
            result = {"project": self.store._envelope(db, project_id), "planning": self._state(db, project_id)}
        result["planning"]["agent"] = self.planner.status()
        return result

    def reject(self, project_id, proposal_id, payload):
        obj(payload, {"mutationId"}, "proposal rejection")
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.store._row(db, project_id)
            if not self._receipt(db, project_id, "reject:" + proposal_id, payload):
                proposal = db.execute("SELECT state FROM planning_proposals WHERE project_id=? AND id=?", (project_id, proposal_id)).fetchone()
                if proposal is None:
                    raise NotFoundError("Proposal not found.")
                if proposal["state"] != "pending":
                    raise RuntimeError("This proposal has already been reviewed.")
                db.execute("UPDATE planning_proposals SET state='rejected' WHERE project_id=? AND id=?", (project_id, proposal_id))
        return self.state(project_id)

    def approve(self, project_id, payload):
        obj(payload, {"baseRevision", "mutationId"}, "plan approval")
        integer(payload.get("baseRevision"), "Base revision")
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            project = self._current(db, project_id)
            if not self._receipt(db, project_id, "approve", payload):
                if project["revision"] != payload["baseRevision"]:
                    raise ConflictError(project["revision"])
                state = self._state(db, project_id)
                if not any(n["type"] != "note" for d in project["content"]["diagrams"] for n in d["nodes"]):
                    raise ValidationError("Add at least one planning step before approving the plan.")
                if state["request"] and state["request"]["status"] == "running":
                    raise RuntimeError("Wait for the planning reply before approving.")
                if any(p["state"] == "pending" for p in state["proposals"]):
                    raise RuntimeError("Accept or reject the pending proposals before approving.")
                if any(not c["resolved"] for c in state["comments"]):
                    raise RuntimeError("Resolve the open node comments before approving.")
                self._revoke(db, project_id)
                db.execute("INSERT INTO planning_approvals VALUES(?,?,?,?,?,?,?,0)",
                           (str(uuid4()), project_id, project["revision"], project["cursor"], fingerprint(project["content"]), encode(project["content"]), now()))
        return self.state(project_id)

    def reopen(self, project_id, payload):
        obj(payload, {"mutationId"}, "reopen planning")
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.store._row(db, project_id)
            if not self._receipt(db, project_id, "reopen", payload):
                self._revoke(db, project_id)
        return self.state(project_id)
