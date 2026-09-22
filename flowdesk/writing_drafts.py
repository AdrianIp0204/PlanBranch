"""Unsent writing and recoverable concurrent copies, outside manual history.

No draft operation sends a request, grants permission, or changes approval.
Delivery is recognized only by the existing exact planning receipt/payload.
"""
from contextlib import closing
from copy import deepcopy
import hashlib
import json
from uuid import uuid4

from .storage import encode, now, NotFoundError
from .validation import ValidationError, identifier, integer, obj, string, validate_brief, validate_content
from .storage import empty_content

MAX_BYTES = 6_000_000


def empty_writing():
    return {"message": "", "comments": {}, "questionDrafts": {}, "failedPrompt": None,
            "failedAnswer": None, "failedComment": None, "revision": None, "context": None,
            "versions": {"message": "", "comments": {}, "questions": {}}, "submitted": {}}


def _mapping(value, label, limit):
    if not isinstance(value, dict) or len(value) > limit:
        raise ValidationError(f"{label} must be an object with at most {limit} entries.")
    for key in value:
        identifier(key, label + " ID")
    return value


def _bounded_json(value, depth=0):
    if depth > 24:
        raise ValidationError("Draft nesting is too deep.")
    if value is None or type(value) in (bool, int, float):
        return
    if isinstance(value, str):
        string(value, "Draft text", 2_000_000)
    elif isinstance(value, list):
        if len(value) > 10000:
            raise ValidationError("Draft list is too large.")
        for item in value:
            _bounded_json(item, depth + 1)
    elif isinstance(value, dict):
        if len(value) > 10000:
            raise ValidationError("Draft object is too large.")
        for key, item in value.items():
            string(key, "Draft key", 128)
            _bounded_json(item, depth + 1)
    else:
        raise ValidationError("Draft content must be JSON.")


def _selection(value):
    obj(value, {"mode", "model", "reasoningEffort"}, "model selection")
    if value.get("mode") == "default":
        if set(value) != {"mode"}:
            raise ValidationError("CLI default has no explicit settings.")
    elif value.get("mode") == "explicit":
        string(value.get("model"), "Model", 200, True)
        if value.get("reasoningEffort") is not None:
            string(value["reasoningEffort"], "Reasoning effort", 40)
    else:
        raise ValidationError("Unsupported model selection.")


def _diagram(value):
    # Validate a copy; frozen retry payloads keep their original bytes/fields.
    content = empty_content()
    content["diagrams"] = [value]
    validate_content(content)


def _candidate(value):
    if "brief" in value:
        validate_brief(value["brief"])
    if "editableSections" in value:
        sections = value["editableSections"]
        if (not isinstance(sections, list) or not 1 <= len(sections) <= 3
                or any(section not in ("diagram", "brief", "buildTasks") for section in sections)):
            raise ValidationError("Unsupported proposal sections.")
    if "buildTasks" in value:
        # Full manual validator checks bounded task fields and dependencies;
        # missing node links are valid retained references.
        content = empty_content()
        content["buildTasks"] = value["buildTasks"]
        validate_content(content)


def validate_writing(raw):
    result = empty_writing()
    obj(raw, result, "unsent writing")
    result.update(deepcopy(raw))
    _bounded_json(result)
    try:
        if len(encode(result).encode("utf-8")) > MAX_BYTES:
            raise ValidationError("Unsent writing exceeds the 6 MB limit.")
    except (ValueError, OverflowError):
        raise ValidationError("Unsent writing must contain finite JSON values.") from None
    string(result["message"], "Unsent message", 12000)
    for text in _mapping(result["comments"], "Comment drafts", 500).values():
        string(text, "Unsent comment", 12000)
    for questions in _mapping(result["questionDrafts"], "Question drafts", 100).values():
        for answer in _mapping(questions, "Questions", 3).values():
            obj(answer, {"choice", "custom", "text"}, "unsent answer")
            if answer.get("choice") is not None:
                identifier(answer["choice"], "Choice")
            if type(answer.get("custom")) is not bool:
                raise ValidationError("Custom answer must be true or false.")
            string(answer.get("text"), "Unsent answer", 2000)
    versions = obj(result["versions"], {"message", "comments", "questions"}, "writing versions")
    string(versions.get("message"), "Message version", 128)
    for kind in ("comments", "questions"):
        for value in _mapping(versions.get(kind), kind + " versions", 500).values():
            identifier(value, "Writing version")
    submitted = obj(result["submitted"], {"message", "comment", "answer"}, "submitted writing versions")
    for value in submitted.values():
        identifier(value, "Submitted version")
    context = result["context"]
    if context is not None:
        obj(context, {"diagramId", "nodeId", "diagramName", "nodeTitle"}, "writing context")
        identifier(context.get("diagramId"), "Diagram ID")
        if context.get("nodeId") is not None:
            identifier(context["nodeId"], "Node ID")
        for field in ("diagramName", "nodeTitle"):
            string(context.get(field, ""), field, 500)
    for field in ("failedPrompt", "failedComment", "failedAnswer"):
        value = result[field]
        if value is not None:
            if not isinstance(value, dict):
                raise ValidationError("Uncertain request must be an object.")
            allowed = {"mutationId", "diagramId", "nodeId", "text"} if field == "failedComment" else ({"mutationId", "setId", "baseRevision", "answers", "selection"} if field == "failedAnswer" else {"mutationId", "diagramId", "nodeId", "text", "selection", "proposalId", "proposalDiagram", "proposalBrief", "proposalBuildTasks"})
            obj(value, allowed, "uncertain request")
            identifier(value.get("mutationId"), "Request ID")
            if "selection" in value:
                _selection(value["selection"])
            if field == "failedAnswer":
                identifier(value.get("setId"), "Question set ID")
                integer(value.get("baseRevision"), "Base revision")
                if not isinstance(value.get("answers"), list) or len(value["answers"]) > 3:
                    raise ValidationError("Answers must be a bounded list.")
                for answer in value["answers"]:
                    obj(answer, {"questionId", "optionId", "text"}, "submitted answer")
                    identifier(answer.get("questionId"), "Question ID")
                    if answer.get("optionId") is not None:
                        identifier(answer["optionId"], "Option ID")
                    if answer.get("text") is not None:
                        string(answer["text"], "Submitted answer", 2000)
            else:
                string(value.get("text"), "Submitted text", 12000, True)
                identifier(value.get("diagramId"), "Diagram ID")
                if field == "failedComment" or value.get("nodeId") is not None:
                    identifier(value.get("nodeId"), "Node ID")
                if "proposalId" in value:
                    identifier(value["proposalId"], "Proposal ID")
                if "proposalDiagram" in value:
                    _diagram(value["proposalDiagram"])
                _candidate({field: value[key] for field,key in (("brief","proposalBrief"),("buildTasks","proposalBuildTasks")) if key in value})
    if result["revision"] is not None:
        value = result["revision"]
        if not isinstance(value, dict):
            raise ValidationError("Proposal revision must be an object.")
        obj(value, {"proposalId", "title", "nonce", "diagram", "brief", "buildTasks", "editableSections"}, "proposal revision")
        identifier(value.get("proposalId"), "Proposal ID")
        string(value.get("title"), "Proposal title", 500)
        identifier(value.get("nonce"), "Revision ID")
        if not isinstance(value.get("diagram"), dict):
            raise ValidationError("Proposal revision requires its diagram context.")
        _diagram(value["diagram"])
        _candidate(value)
    return result


def fingerprint(value):
    return hashlib.sha256(encode(value).encode("utf-8")).hexdigest()


class WritingConflict(Exception):
    def __init__(self, response):
        self.response = response
        super().__init__(response["error"])


class WritingDrafts:
    def __init__(self, store):
        self.store = store

    def _retire(self, db, project_id, raw):
        value = deepcopy(raw)
        # Read existing receipts only. Recovery never retries an agent request.
        prompt = value["failedPrompt"]
        if prompt:
            row = db.execute("SELECT payload_hash FROM planning_requests WHERE project_id=? AND id=?",
                             (project_id, prompt["mutationId"])).fetchone()
            normalized = {**prompt, "nodeId": prompt.get("nodeId")}
            if row and row[0] == fingerprint(normalized):
                if value["submitted"].get("message") and value["submitted"]["message"] == value["versions"]["message"]:
                    value["message"] = ""
                    value["context"] = None
                    value["revision"] = None
                value["failedPrompt"] = None
                value["submitted"].pop("message", None)
        for field, kind, action, group, key in (
            ("failedComment", "comment", "comment", "comments", "nodeId"),
            ("failedAnswer", "answer", "answers:", "questions", "setId"),
        ):
            request = value[field]
            if not request:
                continue
            body = {k: v for k, v in request.items() if k != "setId"}
            receipt = db.execute("SELECT payload_hash FROM planning_receipts WHERE project_id=? AND mutation_id=?",
                                 (project_id, request["mutationId"])).fetchone()
            expected = fingerprint({"action": action + request[key] if kind == "answer" else action, "payload": body})
            if receipt and receipt[0] == expected:
                if value["submitted"].get(kind) and value["submitted"][kind] == value["versions"][group].get(request[key]):
                    value["comments" if kind == "comment" else "questionDrafts"].pop(request[key], None)
                value[field] = None
                value["submitted"].pop(kind, None)
        return value

    def _draft(self, db, project_id, row):
        if row is None:
            return {"id": "current", "revision": 0, "updatedAt": None, "payload": empty_writing()}
        return {"id": row["id"], "revision": row["revision"], "updatedAt": row["updated_at"],
                "payload": self._retire(db, project_id, json.loads(row["payload"]))}

    def _state(self, db, project_id):
        rows = db.execute("SELECT * FROM writing_drafts WHERE project_id=? ORDER BY updated_at DESC,id", (project_id,)).fetchall()
        return {"draft": self._draft(db, project_id, next((row for row in rows if row["id"] == "current"), None)),
                "copies": [self._draft(db, project_id, row) for row in rows if row["id"] != "current"]}

    def get(self, project_id):
        with closing(self.store.connect()) as db:
            db.execute("BEGIN")
            self.store._row(db, project_id)
            return self._state(db, project_id)

    def _copy(self, db, project_id, payload, *, deduplicate=False):
        if deduplicate:
            existing = db.execute("SELECT id FROM writing_drafts WHERE project_id=? AND id!='current' AND payload=? ORDER BY updated_at DESC LIMIT 1", (project_id, encode(payload))).fetchone()
            if existing:
                return existing[0]
        identifier_ = str(uuid4())
        timestamp = now()
        db.execute("INSERT INTO writing_drafts VALUES(?,?,1,?,?,?)", (project_id, identifier_, encode(payload), timestamp, timestamp))
        return identifier_

    def save(self, project_id, raw):
        obj(raw, {"mutationId", "baseRevision", "payload", "preserveCurrent", "copyOnly"}, "writing save")
        identifier(raw.get("mutationId"), "Mutation ID")
        integer(raw.get("baseRevision"), "Writing revision")
        for field in ("preserveCurrent", "copyOnly"):
            if field in raw and type(raw[field]) is not bool:
                raise ValidationError(field + " must be true or false.")
        payload = validate_writing(raw.get("payload"))
        request_hash = fingerprint(raw)
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.store._row(db, project_id)
            receipt = db.execute("SELECT * FROM writing_draft_receipts WHERE project_id=? AND mutation_id=?", (project_id, raw["mutationId"])).fetchone()
            if receipt:
                if receipt["payload_hash"] != request_hash:
                    raise ValidationError("A mutation ID cannot be reused for different writing.")
                response, status = json.loads(receipt["response"]), receipt["status_code"]
            else:
                row = db.execute("SELECT * FROM writing_drafts WHERE project_id=? AND id='current'", (project_id,)).fetchone()
                revision = row["revision"] if row else 0
                payload = self._retire(db, project_id, payload)
                recovery_id = None
                if raw.get("copyOnly") or revision != raw["baseRevision"]:
                    recovery_id = self._copy(db, project_id, payload, deduplicate=bool(raw.get("copyOnly")))
                    status = 200 if raw.get("copyOnly") else 409
                else:
                    if raw.get("preserveCurrent") and row:
                        self._copy(db, project_id, json.loads(row["payload"]))
                    timestamp = now()
                    db.execute("INSERT INTO writing_drafts VALUES(?,'current',?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at",
                               (project_id, revision + 1, encode(payload), timestamp, timestamp))
                    status = 200
                response = self._state(db, project_id)
                if recovery_id:
                    response["recoveryId"] = recovery_id
                if status == 409:
                    response.update(error="Writing changed in another tab. Both versions are saved.", writingConflict=True)
                db.execute("INSERT INTO writing_draft_receipts VALUES(?,?,?,?,?)", (project_id, raw["mutationId"], request_hash, encode(response), status))
        if status == 409:
            raise WritingConflict(response)
        return response

    def discard_copy(self, project_id, draft_id, payload):
        obj(payload, {"baseRevision"}, "discard writing copy")
        integer(payload.get("baseRevision"), "Copy revision")
        if draft_id == "current":
            raise ValidationError("Clear current writing through its revisioned save.")
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            self.store._row(db, project_id)
            row = db.execute("SELECT revision FROM writing_drafts WHERE project_id=? AND id=?", (project_id, draft_id)).fetchone()
            if row and row["revision"] != payload["baseRevision"]:
                raise ValidationError("This saved copy changed. Reload it before discarding.")
            db.execute("DELETE FROM writing_drafts WHERE project_id=? AND id=?", (project_id, draft_id))
            return self._state(db, project_id)
