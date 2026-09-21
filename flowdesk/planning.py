"""Durable planning conversation and explicit review, separate from graph history.

The provider can propose a diagram and brief, never write project content. Acceptance is
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
from .validation import MAX_HISTORY, ValidationError, identifier, integer, obj, string, validate_brief, validate_content
from .content_versions import BRIEF_FIELDS, SUPPORTED_CONTENT_VERSIONS, manual_identity, upgrade_content
from .planning_questions import answer_summary, validate_answers, validate_envelope


def fingerprint(value):
    return hashlib.sha256(encode(value).encode("utf-8")).hexdigest()


def manual_fingerprint(content):
    return fingerprint(manual_identity(content))


def editable_sections(proposal):
    return json.loads(proposal["editable_sections"])


def apply_candidate_sections(base, candidate, proposal, detected_ids):
    result = upgrade_content(base)
    candidate = upgrade_content(candidate)
    sections = editable_sections(proposal)
    if "diagram" in sections:
        result = replace_diagram(result, diagram_in(candidate, proposal["diagram_id"]), proposal["diagram_id"], detected_ids)
    if "brief" in sections:
        result["brief"] = validate_brief(candidate["brief"])
    return validate_content(result, detected_ids)


def edit_candidate_sections(base, original, proposal, payload, detected_ids, *, prefix=""):
    """Only authored sections are editable; use base links when nodes return."""
    sections = editable_sections(proposal)
    original = upgrade_content(original)
    for section in ("diagram", "brief"):
        field = prefix + section.capitalize() if prefix else section
        if field in payload and section not in sections:
            raise ValidationError(f"This proposal does not include {section} changes.")
    candidate = apply_candidate_sections(base, original, proposal, detected_ids)
    graph_key, brief_key = (prefix + "Diagram", prefix + "Brief") if prefix else ("diagram", "brief")
    if graph_key in payload:
        # Start with original base links so restoring a node also restores its links.
        candidate = replace_diagram(base, payload[graph_key], proposal["diagram_id"], detected_ids)
        if "brief" in sections:
            candidate["brief"] = original["brief"]
    if brief_key in payload:
        candidate["brief"] = validate_brief(payload[brief_key])
    return validate_content(candidate, detected_ids)


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


def replace_diagram(content, proposed, diagram_id, detected_ids):
    """Apply only a diagram's nodes/edges; preserve all other manual content."""
    obj(proposed, {"id", "name", "nodes", "edges"}, "proposal diagram")
    result = deepcopy(content)
    diagram = diagram_in(result, diagram_id)
    if proposed.get("id") != diagram_id or proposed.get("name") != diagram["name"]:
        raise ValidationError("The proposal must keep its diagram ID and name.")
    if not isinstance(proposed.get("nodes"), list):
        raise ValidationError("Proposed nodes must be a list.")
    new_ids = {n.get("id") for n in proposed["nodes"] if isinstance(n, dict) and isinstance(n.get("id"), str)}
    deleted = {n["id"] for n in diagram["nodes"]} - new_ids
    diagram["nodes"], diagram["edges"] = proposed["nodes"], proposed.get("edges")
    result["nodeLinks"] = [link for link in result["nodeLinks"] if link["nodeId"] not in deleted]
    return validate_content(result, detected_ids)


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
        from .proposal_drafts import ProposalDrafts
        self.drafts = ProposalDrafts(self)
        self._threads = {}
        self._thread_lock = threading.Lock()
        # A request interrupted by shutdown cannot be resumed blindly. It retains
        # its original context and can be explicitly retried with the same ID.
        with closing(store.connect()) as db, db:
            db.execute("UPDATE planning_requests SET status='failed',error=?,updated_at=? WHERE status='running'",
                       ("Planning was interrupted when PlanBranch stopped. Retry this message to continue.", now()))

    def _current(self, db, project_id):
        """Read the selected snapshot without decoding the retained undo branch."""
        project = self.store._row(db, project_id)
        checkpoint = db.execute("SELECT schema_version,content FROM history_checkpoints WHERE project_id=? AND id=?",
                                (project_id, project["cursor"])).fetchone()
        if checkpoint is None:
            raise ValidationError("Saved project history is inconsistent; restore a database backup.")
        if checkpoint["schema_version"] not in SUPPORTED_CONTENT_VERSIONS:
            raise ValidationError("Unsupported saved history version.")
        return {"id": project_id, "revision": project["revision"], "savedAt": project["saved_at"],
                "cursor": project["cursor"], "content": upgrade_content(json.loads(checkpoint["content"]))}

    def _state(self, db, project_id):
        project = self._current(db, project_id)
        content_hash = manual_fingerprint(project["content"])
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
                              "state": state, "createdAt": row["created_at"], "changes": json.loads(row["changes"]),
                              "editableSections": editable_sections(row)})
        row = db.execute("SELECT * FROM planning_approvals WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 1", (project_id,)).fetchone()
        approval = None if row is None else {"id": row["id"], "revision": row["revision"], "cursor": row["cursor"],
                   "contentHash": row["content_hash"], "snapshot": upgrade_content(json.loads(row["content"])), "createdAt": row["created_at"],
                   "current": not bool(row["revoked"]) and row["content_hash"] == content_hash}
        row = db.execute("SELECT * FROM planning_requests WHERE project_id=? ORDER BY updated_at DESC,id DESC LIMIT 1", (project_id,)).fetchone()
        request = None
        if row is not None:
            payload = json.loads(row["payload"])
            request = {"id": row["id"], "status": row["status"], "text": payload["text"], "diagramId": payload["diagramId"],
                       "payload": payload, "selection": payload.get("selection", {"mode": "default"})}
            generation = json.loads(row["context"]).get("generation")
            if generation is not None:
                request["generation"] = {key: generation.get(key) for key in (
                    "selection", "cliVersion", "instructionVersion", "instructionHash", "protocolVersion")}
            if payload.get("nodeId") is not None:
                request["nodeId"] = payload["nodeId"]
            if row["error"]:
                request["error"] = row["error"]
        question_sets = []
        for row in db.execute("SELECT * FROM planning_question_sets WHERE project_id=? ORDER BY created_at,id", (project_id,)):
            question_state = row["state"]
            if question_state == "open" and row["base_hash"] != content_hash:
                question_state = "stale"
            item = {"id": row["id"], "requestId": row["request_id"], "messageId": row["message_id"],
                    "diagramId": row["diagram_id"], "nodeId": row["node_id"], "baseHash": row["base_hash"],
                    "state": question_state, "questions": json.loads(row["questions"]),
                    "answers": json.loads(row["answers"]) if row["answers"] else None,
                    "createdAt": row["created_at"], "answeredAt": row["answered_at"],
                    "continuationRequestId": row["continuation_request_id"]}
            if row["state"] == "open":
                original = db.execute("SELECT context FROM planning_requests WHERE project_id=? AND id=?",
                                      (project_id, row["request_id"])).fetchone()
                item["baseSnapshot"] = upgrade_content(json.loads(original[0])["content"])
            question_sets.append(item)
        if approval is not None:
            approval["current"] = approval["current"] and not any(not c["resolved"] for c in comments) and not any(
                p["state"] == "pending" for p in proposals) and not (request and request["status"] == "running") and not any(
                q["state"] == "open" for q in question_sets)
        return {"messages": messages, "comments": comments, "proposals": proposals, "approval": approval,
                "request": request, "questionSets": question_sets}

    def state(self, project_id):
        with closing(self.store.connect()) as db:
            db.execute("BEGIN")
            state = self._state(db, project_id)
        state["agent"] = self.planner.status()
        return state

    def _proposal(self, db, project_id, proposal_id):
        identifier(proposal_id, "Proposal ID")
        row = db.execute("SELECT * FROM planning_proposals WHERE project_id=? AND id=?", (project_id, proposal_id)).fetchone()
        if row is None:
            raise NotFoundError("Proposal not found.")
        return row

    def _proposal_base(self, db, project_id, proposal):
        # Request snapshots survive retained undo history being trimmed.
        for row in db.execute("SELECT context FROM planning_requests WHERE project_id=? AND base_hash=? ORDER BY created_at DESC",
                              (project_id, proposal["base_hash"])):
            content = json.loads(row["context"]).get("content")
            if content is not None and manual_fingerprint(content) == proposal["base_hash"]:
                return upgrade_content(content)
        checkpoint = db.execute("SELECT content FROM history_checkpoints WHERE project_id=? AND id=?",
                                (project_id, proposal["base_cursor"])).fetchone()
        if checkpoint is not None:
            content = json.loads(checkpoint["content"])
            if manual_fingerprint(content) == proposal["base_hash"]:
                return upgrade_content(content)
        return None

    def proposal_detail(self, project_id, proposal_id):
        with closing(self.store.connect()) as db:
            db.execute("BEGIN")
            project = self._current(db, project_id)
            row = self._proposal(db, project_id, proposal_id)
            content = json.loads(row["content"])
            state = row["state"]
            if state == "pending" and row["base_hash"] != manual_fingerprint(project["content"]):
                state = "stale"
            summary = {"id": row["id"], "title": row["title"], "summary": row["summary"], "diagramId": row["diagram_id"],
                       "baseRevision": row["base_revision"], "baseCursor": row["base_cursor"], "baseHash": row["base_hash"],
                       "state": state, "createdAt": row["created_at"], "changes": json.loads(row["changes"]),
                       "editableSections": editable_sections(row)}
            return {"proposal": summary, "content": upgrade_content(content), "baseContent": self._proposal_base(db, project_id, row),
                    "contentHash": fingerprint(content),
                    **self.drafts._list(db, project_id, row, manual_fingerprint(project["content"]))}

    def _review_context(self, db, project_id, project, payload):
        proposal = self._proposal(db, project_id, payload["proposalId"])
        if proposal["state"] != "pending":
            raise ValidationError("This proposal has already been reviewed. Start a new planning message.")
        if proposal["diagram_id"] != payload["diagramId"]:
            raise ValidationError("Choose the proposal's diagram before requesting a revision.")
        candidate = json.loads(proposal["content"])
        base = self._proposal_base(db, project_id, proposal)
        candidate = edit_candidate_sections(base if base is not None else candidate, candidate, proposal, payload,
                                             self.store._detected_ids(db, project_id), prefix="proposal")
        result = {"id": proposal["id"], "title": proposal["title"], "summary": proposal["summary"],
                "diagram": deepcopy(diagram_in(candidate, proposal["diagram_id"])),
                "stale": proposal["base_hash"] != manual_fingerprint(project["content"])}
        if "brief" in editable_sections(proposal):
            result.update(brief=candidate["brief"], editableSections=editable_sections(proposal))
        return result

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

    def _context(self, project, state, diagram_id, node_id, generation):
        context = {"content": project["content"], "activeDiagramId": diagram_id, "nodeId": node_id,
                   "messages": state["messages"][-200:], "comments": state["comments"],
                   "omittedMessageCount": max(0, len(state["messages"]) - 200),
                   "questionSets": [{key: value for key, value in item.items() if key != "baseSnapshot"}
                                    for item in state["questionSets"]]}
        if generation is not None:
            context["generation"] = generation
        return context

    def _start(self, project_id, request_id, attempt_id):
        thread = threading.Thread(target=self._generate, args=(project_id, request_id, attempt_id), daemon=True, name="flowdesk-planning")
        with self._thread_lock:
            self._threads[(project_id, request_id)] = thread
        thread.start()

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
        obj(payload, {"mutationId", "text", "diagramId", "nodeId", "selection", "proposalId", "proposalDiagram", "proposalBrief"}, "planning message")
        identifier(payload.get("mutationId"), "Mutation ID")
        string(payload.get("text"), "Message", 12000, True)
        diagram_id = identifier(payload.get("diagramId"), "Diagram ID")
        if payload.get("nodeId") is not None:
            identifier(payload["nodeId"], "Node ID")
        if "proposalId" in payload:
            identifier(payload["proposalId"], "Proposal ID")
        elif "proposalDiagram" in payload or "proposalBrief" in payload:
            raise ValidationError("Choose a proposal before submitting its edited content.")
        payload = {**payload, "nodeId": payload.get("nodeId")}
        selection = self._selection(payload.get("selection", {"mode": "default"}))
        request_id = payload["mutationId"]
        # A catalogue probe must not hold a database write lock. A retry uses
        # its stored contract even if the catalogue/preferences have changed.
        with closing(self.store.connect()) as db:
            self.store._row(db, project_id)
            known = db.execute("SELECT 1 FROM planning_requests WHERE project_id=? AND id=?", (project_id, request_id)).fetchone()
        generation = None if known else self._configuration(selection)
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
                review = self._review_context(db, project_id, project, payload) if "proposalId" in payload else None
                node = node_in(diagram, payload["nodeId"]) if payload.get("nodeId") is not None else None
                db.execute("UPDATE planning_question_sets SET state='superseded' WHERE project_id=? AND state='open'", (project_id,))
                db.execute("INSERT INTO planning_messages VALUES(?,?,?,?,?,?,?,?,NULL)",
                           (str(uuid4()), project_id, "user", payload["text"], timestamp, diagram_id,
                            node["id"] if node else None, node["title"] if node else None))
                state = self._state(db, project_id)
                context = self._context(project, state, diagram_id, payload.get("nodeId"), generation)
                if review is not None:
                    context["reviewProposal"] = review
                db.execute("INSERT INTO planning_requests VALUES(?,?,?,?,?,?,?,?,?,'running',NULL,?,?)",
                           (request_id, project_id, fingerprint(payload), encode(payload), encode(context),
                            project["revision"], project["cursor"], manual_fingerprint(project["content"]), attempt_id, timestamp, timestamp))
            self._revoke(db, project_id)
            should_start = True
        if should_start:
            self._start(project_id, request_id, attempt_id)
        return self.state(project_id)

    def answer_questions(self, project_id, set_id, payload):
        obj(payload, {"mutationId", "baseRevision", "answers", "selection"}, "question answers")
        identifier(payload.get("mutationId"), "Mutation ID")
        integer(payload.get("baseRevision"), "Base revision")
        identifier(set_id, "Question set ID")
        selection = self._selection(payload.get("selection", {"mode": "default"}))
        action = "answers:" + set_id
        request_id = payload["mutationId"]
        # Receipt lookup precedes discovery, revision and open-state checks.
        with closing(self.store.connect()) as db:
            self.store._row(db, project_id)
            question = db.execute("SELECT * FROM planning_question_sets WHERE project_id=? AND id=?", (project_id, set_id)).fetchone()
            if question is None:
                raise NotFoundError("Question set not found.")
            previous = db.execute("SELECT payload_hash FROM planning_receipts WHERE project_id=? AND mutation_id=?", (project_id, request_id)).fetchone()
            if previous and previous[0] != fingerprint({"action": action, "payload": payload}):
                raise ValidationError("A mutation ID cannot be reused for different answers.")
        generation = None if previous else self._configuration(selection)
        attempt_id = str(uuid4())
        should_start = False
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            project = self._current(db, project_id)
            question = db.execute("SELECT * FROM planning_question_sets WHERE project_id=? AND id=?", (project_id, set_id)).fetchone()
            if question is None:
                raise NotFoundError("Question set not found.")
            if not self._receipt(db, project_id, action, payload):
                if project["revision"] != payload["baseRevision"]:
                    raise ConflictError(project["revision"])
                if question["state"] != "open":
                    raise ValidationError("This question has already been answered or replaced.")
                if question["base_hash"] != manual_fingerprint(project["content"]):
                    raise ValidationError("These questions are outdated. Ask again using this plan.")
                if db.execute("SELECT 1 FROM planning_requests WHERE project_id=? AND status='running'", (project_id,)).fetchone():
                    raise RuntimeError("Wait for the current planning reply before continuing.")
                questions = json.loads(question["questions"])
                answers = validate_answers(questions, payload.get("answers"))
                text = answer_summary(questions, answers)
                diagram = diagram_in(project["content"], question["diagram_id"])
                node = node_in(diagram, question["node_id"]) if question["node_id"] else None
                timestamp = now()
                db.execute("INSERT INTO planning_messages VALUES(?,?,?,?,?,?,?,?,NULL)",
                           (str(uuid4()), project_id, "user", text, timestamp, diagram["id"],
                            node["id"] if node else None, node["title"] if node else None))
                # Mark answered before building context; continuation receives confirmed answers.
                db.execute("UPDATE planning_question_sets SET state='answered',answers=?,answered_at=? WHERE project_id=? AND id=?",
                           (encode(answers), timestamp, project_id, set_id))
                context = self._context(project, self._state(db, project_id), diagram["id"], question["node_id"], generation)
                original = db.execute("SELECT context FROM planning_requests WHERE project_id=? AND id=?",
                                      (project_id, question["request_id"])).fetchone()
                review = json.loads(original["context"]).get("reviewProposal")
                if review is not None:
                    context["reviewProposal"] = review
                request_payload = {"mutationId": request_id, "text": text, "diagramId": diagram["id"],
                                   "nodeId": question["node_id"], "selection": selection}
                if review is not None:
                    request_payload["proposalId"] = review["id"]
                    if "diagram" in review.get("editableSections", ["diagram"]):
                        request_payload["proposalDiagram"] = review["diagram"]
                    if "brief" in review:
                        request_payload["proposalBrief"] = review["brief"]
                db.execute("INSERT INTO planning_requests VALUES(?,?,?,?,?,?,?,?,?,'running',NULL,?,?)",
                           (request_id, project_id, fingerprint(request_payload), encode(request_payload), encode(context),
                            project["revision"], project["cursor"], manual_fingerprint(project["content"]), attempt_id, timestamp, timestamp))
                db.execute("UPDATE planning_question_sets SET continuation_request_id=? WHERE project_id=? AND id=?", (request_id, project_id, set_id))
                self._revoke(db, project_id)
                should_start = True
            continuation_id = db.execute("SELECT continuation_request_id FROM planning_question_sets WHERE project_id=? AND id=?", (project_id, set_id)).fetchone()[0]
        if should_start:
            self._start(project_id, request_id, attempt_id)
        state = self.state(project_id)
        state["answerReceipt"] = {"questionSetId": set_id, "requestId": continuation_id}
        return state

    def capabilities(self, refresh=False):
        if hasattr(self.planner, "capabilities"):
            return self.planner.capabilities(refresh=refresh)
        return {"status": "unavailable", "source": "cli_catalogue", "cliVersion": None,
                "fetchedAt": None, "models": [], "reason": "Model selection is unavailable for this provider. Use CLI default."}

    @staticmethod
    def _selection(value):
        obj(value, {"mode", "model", "reasoningEffort"}, "model selection")
        if value.get("mode") == "default":
            obj(value, {"mode"}, "default model selection")
        elif value.get("mode") == "explicit":
            string(value.get("model"), "Model", 200, True)
            if "reasoningEffort" not in value:
                raise ValidationError("Choose a reasoning level for the selected model.")
            if value["reasoningEffort"] is not None:
                string(value["reasoningEffort"], "Reasoning level", 80, True)
        else:
            raise ValidationError("Choose CLI default or an available model.")
        return deepcopy(value)

    def _configuration(self, selection):
        # Test providers can remain minimal; the actual CLI always freezes a
        # complete instruction/model contract before a request is persisted.
        if hasattr(self.planner, "configure"):
            return self.planner.configure(selection)
        if selection != {"mode": "default"}:
            raise ValidationError("Model selection is unavailable for this provider.")
        return None

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
            response = validate_envelope(self.planner.generate(provider_context_for(context)), context.get("generation", {}).get("protocolVersion", 1))
            proposed = response.get("proposal")
            proposal_id = None
            with closing(self.store.connect()) as db, db:
                db.execute("BEGIN IMMEDIATE")
                live = db.execute("SELECT status,attempt_id FROM planning_requests WHERE project_id=? AND id=?", (project_id, request_id)).fetchone()
                if live is None or live["status"] != "running" or live["attempt_id"] != attempt_id:
                    return
                if proposed is not None:
                    version = context.get("generation", {}).get("protocolVersion", 1)
                    obj(proposed, {"title", "summary", "diagramId", "nodes", "edges"} | ({"brief"} if version >= 3 else set()), "agent proposal")
                    string(proposed.get("title"), "Proposal title", 200, True)
                    string(proposed.get("summary"), "Proposal summary", 12000, True)
                    if proposed.get("diagramId") != context["activeDiagramId"]:
                        raise ValidationError("The agent may propose changes only to the selected diagram.")
                    content = upgrade_content(context["content"])
                    diagram = diagram_in(content, proposed["diagramId"])
                    before = deepcopy(diagram)
                    graph = proposed.get("nodes") is not None or proposed.get("edges") is not None
                    sections = (["diagram"] if graph else []) + (["brief"] if proposed.get("brief") is not None else [])
                    if (version < 3 and not graph) or not sections:
                        raise ValidationError("The proposal must include diagram or brief changes.")
                    if version >= 3 and not {"nodes", "edges", "brief"}.issubset(proposed):
                        raise ValidationError("A proposal must specify nodes, edges, and brief, using null for unchanged sections.")
                    if graph:
                        diagram["nodes"], diagram["edges"] = proposed.get("nodes"), proposed.get("edges")
                    if "brief" in sections:
                        content["brief"] = validate_brief(proposed["brief"])
                    # Validate shape before computing deletion IDs. All remaining
                    # links must keep their exact authored relationship and ID.
                    if not isinstance(diagram["nodes"], list):
                        raise ValidationError("Proposed nodes must be a list.")
                    # Frozen planner protocols predate the optional layout pin.
                    # Their exact output schema cannot express it, so retained
                    # nodes keep the human's layout preference when omitted.
                    prior_nodes = {node["id"]: node for node in before["nodes"]}
                    for node in diagram["nodes"]:
                        if isinstance(node, dict) and isinstance(node.get("id"), str):
                            previous = prior_nodes.get(node["id"], {})
                            if "pinned" not in node and "pinned" in previous:
                                node["pinned"] = previous["pinned"]
                    new_ids = {n.get("id") for n in diagram["nodes"] if isinstance(n, dict) and isinstance(n.get("id"), str)}
                    deleted = {n["id"] for n in before["nodes"]} - new_ids
                    content["nodeLinks"] = [link for link in content["nodeLinks"] if link["nodeId"] not in deleted]
                    content = validate_content(content, self.store._detected_ids(db, project_id))
                    diagram = diagram_in(content, proposed["diagramId"])
                    changes = changes_between(before, diagram, context["content"]["nodeLinks"], content["nodeLinks"])
                    old_brief = upgrade_content(context["content"])["brief"]
                    for field in BRIEF_FIELDS:
                        if old_brief[field] != content["brief"][field]:
                            changes.append({"kind": "update_brief", "field": field, "label": "Project brief: " + field,
                                            "before": old_brief[field], "after": content["brief"][field]})
                    if not changes:
                        raise ValidationError("The proposed plan contains no changes. Ask for a reply without a proposal instead.")
                    proposal_id = str(uuid4())
                    db.execute("INSERT INTO planning_proposals VALUES(?,?,?,?,?,?,?,?,?,?, 'pending',?,?)",
                               (proposal_id, project_id, proposed["title"], proposed["summary"], proposed["diagramId"],
                                request["base_revision"], request["base_cursor"], request["base_hash"], encode(content), encode(changes), now(), encode(sections)))
                source = json.loads(request["payload"])
                original_node = node_in(diagram_in(context["content"], source["diagramId"]), source["nodeId"]) if source.get("nodeId") else None
                message_id = str(uuid4())
                db.execute("INSERT INTO planning_messages VALUES(?,?,?,?,?,?,?,?,?)",
                           (message_id, project_id, "assistant", response["message"], now(), source["diagramId"],
                            source.get("nodeId"), original_node["title"] if original_node else None, proposal_id))
                if response["kind"] == "questions":
                    db.execute("UPDATE planning_question_sets SET state='superseded' WHERE project_id=? AND state='open'", (project_id,))
                    db.execute("INSERT INTO planning_question_sets VALUES(?,?,?,?,?,?,?,2,?,NULL,'open',?,NULL,NULL)",
                               (str(uuid4()), project_id, request_id, message_id, source["diagramId"], source.get("nodeId"),
                                request["base_hash"], encode(response["questions"]), now()))
                    self._revoke(db, project_id)
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
        obj(payload, {"baseRevision", "mutationId", "diagram", "contentHash", "draftId", "draftRevision"}, "proposal acceptance")
        integer(payload.get("baseRevision"), "Base revision")
        if "draftId" in payload:
            identifier(payload["draftId"], "Draft ID")
            integer(payload.get("draftRevision"), "Draft revision", 1)
        elif "draftRevision" in payload:
            raise ValidationError("A draft revision requires its draft ID.")
        if "contentHash" in payload:
            string(payload["contentHash"], "Proposal content hash", 64, True)
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
                if proposal["base_hash"] != manual_fingerprint(project["content"]):
                    raise RuntimeError("The plan changed after this proposal was created. Ask the agent for an updated proposal.")
                candidate = json.loads(proposal["content"])
                if "contentHash" in payload and payload["contentHash"] != fingerprint(candidate):
                    raise RuntimeError("The proposal changed. Reload its preview before applying changes.")
                if "draftId" in payload:
                    candidate = self.drafts.candidate_for_apply(db, project_id, proposal_id, payload)
                else:
                    if db.execute("SELECT 1 FROM proposal_drafts WHERE project_id=? AND proposal_id=? AND state IN ('active','applying')",
                                  (project_id, proposal_id)).fetchone():
                        raise RuntimeError("This proposal has saved drafts. Apply a reviewed saved draft instead.")
                    candidate = edit_candidate_sections(project["content"], candidate, proposal, payload,
                                                         self.store._detected_ids(db, project_id))
                content = apply_candidate_sections(project["content"], candidate, proposal, self.store._detected_ids(db, project_id))
                if content == project["content"]:
                    raise ValidationError("The edited proposal has no changes. Discard it or make a change before applying.")
                checkpoint = {"id": str(uuid4()), "label": ("Accept proposal: " + proposal["title"])[:200],
                              "diagramId": proposal["diagram_id"], "content": content}
                cursor = next(i for i, h in enumerate(project["history"]) if h["id"] == project["cursor"])
                history = (project["history"][:cursor + 1] + [checkpoint])[-MAX_HISTORY:]
                self.store._write_history(db, project_id, history)
                self.store._write_current(db, project_id, content)
                db.execute("UPDATE projects SET revision=?,saved_at=?,cursor=? WHERE id=?", (project["revision"] + 1, now(), checkpoint["id"], project_id))
                db.execute("UPDATE planning_proposals SET state='accepted' WHERE id=? AND project_id=?", (proposal_id, project_id))
                if "draftId" in payload:
                    self.drafts.mark_applied(db, project_id, payload["draftId"], checkpoint["id"])
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
                self.drafts.reject_all(db, project_id, proposal_id)
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
                if any(q["state"] == "open" for q in state["questionSets"]):
                    raise RuntimeError("Answer the open planning questions or change direction before approving.")
                self._revoke(db, project_id)
                db.execute("INSERT INTO planning_approvals VALUES(?,?,?,?,?,?,?,0)",
                           (str(uuid4()), project_id, project["revision"], project["cursor"], manual_fingerprint(project["content"]), encode(project["content"]), now()))
        return self.state(project_id)

    def reopen(self, project_id, payload):
        obj(payload, {"mutationId"}, "reopen planning")
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.store._row(db, project_id)
            if not self._receipt(db, project_id, "reopen", payload):
                self._revoke(db, project_id)
        return self.state(project_id)
