"""Revision-checked candidate storage, independent of manual project history.

Apply has a durable prepare boundary. A prepared candidate is immutable until
the user accepts, cancels, or discards it. Restart never executes an intent.
"""
from contextlib import closing
import json
from uuid import uuid4

from .planning import fingerprint, manual_fingerprint, apply_candidate_sections, edit_candidate_sections
from .content_versions import upgrade_content
from .storage import ConflictError, NotFoundError, encode, now
from .validation import ValidationError, identifier, integer, obj, string


class DraftConflictError(Exception):
    def __init__(self, response):
        self.response = response
        super().__init__(response["error"])


class ProposalDrafts:
    def __init__(self, planning):
        self.planning = planning
        self.store = planning.store

    def _row(self, db, project_id, proposal_id, draft_id, *, required=True):
        identifier(draft_id, "Draft ID")
        row = db.execute("SELECT * FROM proposal_drafts WHERE project_id=? AND id=?",
                         (project_id, draft_id)).fetchone()
        if row is not None and row["proposal_id"] != proposal_id:
            raise NotFoundError("Draft not found in this proposal.")
        if row is None and required:
            raise NotFoundError("Draft not found.")
        return row

    def _summary(self, row, current_hash):
        return {"id": row["id"], "proposalId": row["proposal_id"], "diagramId": row["diagram_id"],
                "draftRevision": row["revision"], "state": row["state"],
                "createdAt": row["created_at"], "updatedAt": row["updated_at"],
                "baseRevision": row["base_revision"], "baseHash": row["base_hash"],
                "proposalHash": row["proposal_hash"], "conflictOf": row["conflict_of"],
                "stale": row["base_hash"] != current_hash, "appliedCursor": row["applied_cursor"]}

    def _list(self, db, project_id, proposal, current_hash):
        drafts = [self._summary(row, current_hash) for row in db.execute(
            "SELECT * FROM proposal_drafts WHERE project_id=? AND proposal_id=? ORDER BY updated_at DESC,id DESC",
            (project_id, proposal["id"]))]
        default = None
        if proposal["state"] == "pending":
            default = next((d["id"] for d in drafts if d["state"] == "applying"), None)
            if default is None:
                default = next((d["id"] for d in drafts if d["state"] == "active"), None)
        return {"drafts": drafts, "defaultDraftId": default}

    def list(self, project_id, proposal_id):
        with closing(self.store.connect()) as db:
            db.execute("BEGIN")
            project = self.planning._current(db, project_id)
            proposal = self.planning._proposal(db, project_id, proposal_id)
            return self._list(db, project_id, proposal, manual_fingerprint(project["content"]))

    def get(self, project_id, proposal_id, draft_id):
        with closing(self.store.connect()) as db:
            db.execute("BEGIN")
            project = self.planning._current(db, project_id)
            self.planning._proposal(db, project_id, proposal_id)
            row = self._row(db, project_id, proposal_id, draft_id)
            return {"draft": {**self._summary(row, manual_fingerprint(project["content"])),
                              "candidate": upgrade_content(json.loads(row["candidate"])),
                              "applyRequest": json.loads(row["apply_request"]) if row["apply_request"] else None}}

    def _operation(self, project_id, proposal_id, draft_id, payload, action, edit):
        identifier(payload.get("mutationId"), "Mutation ID")
        identifier(draft_id, "Draft ID")
        integer(payload.get("baseDraftRevision"), "Base draft revision")
        request_hash = fingerprint({"action": action, "proposalId": proposal_id, "draftId": draft_id, "payload": payload})
        with closing(self.store.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            project = self.planning._current(db, project_id)
            proposal = self.planning._proposal(db, project_id, proposal_id)
            receipt = db.execute("SELECT * FROM proposal_draft_receipts WHERE project_id=? AND mutation_id=?",
                                 (project_id, payload["mutationId"])).fetchone()
            if receipt is not None:
                if receipt["payload_hash"] != request_hash:
                    raise ValidationError("A mutation ID cannot be reused for a different draft request.")
                response, status = json.loads(receipt["acknowledgement"]), receipt["status_code"]
            else:
                response, status = edit(db, project, proposal, manual_fingerprint(project["content"]))
                db.execute("INSERT INTO proposal_draft_receipts VALUES(?,?,?,?,?)",
                           (project_id, payload["mutationId"], request_hash, encode(response), status))
        # A conflicting candidate and its receipt must COMMIT before returning
        # HTTP 409. Raising inside the transaction would lose its recovery copy.
        if status == 409:
            raise DraftConflictError(response)
        return response

    def _conflict(self, row, current_hash, recovery=None):
        result = {"error": "This draft changed in another tab. Choose which saved draft to continue.",
                  "draftConflict": True, "draftRevision": row["revision"],
                  "latestDraft": self._summary(row, current_hash)}
        if recovery is not None:
            result["error"] = "This draft changed in another tab. Your edits were saved as a separate recovery draft."
            result["recoveryDraft"] = self._summary(recovery, current_hash)
        return result, 409

    def _insert(self, db, project_id, proposal, draft_id, candidate, proposal_hash, conflict_of=None):
        timestamp = now()
        db.execute("INSERT INTO proposal_drafts VALUES(?,?,?,?,1,'active',?,?,?,?,?,NULL,NULL,?,?)",
                   (draft_id, project_id, proposal["id"], proposal["diagram_id"], proposal["base_revision"],
                    proposal["base_hash"], proposal_hash, encode(candidate), conflict_of, timestamp, timestamp))
        return self._row(db, project_id, proposal["id"], draft_id)

    def save(self, project_id, proposal_id, draft_id, payload):
        obj(payload, {"baseDraftRevision", "mutationId", "contentHash", "diagram", "brief", "buildTasks"}, "proposal draft save")
        string(payload.get("contentHash"), "Proposal content hash", 64, True)

        def edit(db, project, proposal, current_hash):
            if proposal["state"] != "pending":
                raise RuntimeError("This proposal has already been reviewed. Its saved drafts remain available.")
            original = json.loads(proposal["content"])
            original_hash = fingerprint(original)
            if payload["contentHash"] != original_hash:
                raise RuntimeError("The proposal identity changed. Reload its saved drafts before continuing.")
            baseline = self.planning._proposal_base(db, project_id, proposal)
            candidate = edit_candidate_sections(baseline if baseline is not None else original, original, proposal,
                                                 payload, self.store._detected_ids(db, project_id))
            row = self._row(db, project_id, proposal_id, draft_id, required=False)
            if row is None:
                if payload["baseDraftRevision"] != 0:
                    raise NotFoundError("The saved draft no longer exists.")
                row = self._insert(db, project_id, proposal, draft_id, candidate, original_hash)
            else:
                if row["state"] in ("applied", "discarded"):
                    raise RuntimeError("This draft has already been applied or discarded. Reload the proposal to continue.")
                if row["revision"] != payload["baseDraftRevision"] or row["state"] == "applying":
                    recovery = self._insert(db, project_id, proposal, str(uuid4()), candidate, original_hash, row["id"])
                    return self._conflict(row, current_hash, recovery)
                db.execute("UPDATE proposal_drafts SET candidate=?,revision=revision+1,updated_at=? WHERE project_id=? AND id=?",
                           (encode(candidate), now(), project_id, draft_id))
                row = self._row(db, project_id, proposal_id, draft_id)
            return {"draft": self._summary(row, current_hash)}, 200

        return self._operation(project_id, proposal_id, draft_id, payload, "save", edit)

    def prepare(self, project_id, proposal_id, draft_id, payload):
        obj(payload, {"baseDraftRevision", "baseRevision", "mutationId"}, "prepare proposal apply")
        integer(payload.get("baseRevision"), "Base revision")

        def edit(db, project, proposal, current_hash):
            row = self._row(db, project_id, proposal_id, draft_id)
            if row["revision"] != payload["baseDraftRevision"]:
                return self._conflict(row, current_hash)
            if row["state"] != "active":
                raise RuntimeError("This draft is not editable. Recover or cancel its existing Apply first.")
            if proposal["state"] != "pending":
                raise RuntimeError("This proposal has already been reviewed.")
            if project["revision"] != payload["baseRevision"]:
                raise ConflictError(project["revision"])
            if proposal["base_hash"] != current_hash:
                raise RuntimeError("The plan changed after this proposal was created. Ask the agent for an updated proposal.")
            if db.execute("SELECT 1 FROM proposal_drafts WHERE project_id=? AND proposal_id=? AND state='applying'",
                          (project_id, proposal_id)).fetchone():
                raise RuntimeError("Another draft has an unfinished Apply. Recover or cancel it first.")
            candidate = json.loads(row["candidate"])
            content = apply_candidate_sections(project["content"], candidate, proposal, self.store._detected_ids(db, project_id))
            if content == project["content"]:
                raise ValidationError("The edited proposal has no changes. Discard it or make a change before applying.")
            apply_request = {"baseRevision": payload["baseRevision"], "mutationId": payload["mutationId"],
                             "contentHash": row["proposal_hash"], "draftId": draft_id, "draftRevision": row["revision"] + 1}
            db.execute("UPDATE proposal_drafts SET state='applying',revision=revision+1,apply_request=?,updated_at=? WHERE project_id=? AND id=?",
                       (encode(apply_request), now(), project_id, draft_id))
            return {"draft": self._summary(self._row(db, project_id, proposal_id, draft_id), current_hash),
                    "applyRequest": apply_request}, 200

        return self._operation(project_id, proposal_id, draft_id, payload, "prepare", edit)

    def finish(self, project_id, proposal_id, draft_id, payload, *, discard=False):
        obj(payload, {"baseDraftRevision", "mutationId"}, "discard draft" if discard else "cancel draft apply")

        def edit(db, project, proposal, current_hash):
            row = self._row(db, project_id, proposal_id, draft_id)
            if row["revision"] != payload["baseDraftRevision"]:
                return self._conflict(row, current_hash)
            if row["state"] not in (("active", "applying") if discard else ("applying",)):
                raise RuntimeError("This draft has already changed. Reload its saved state before continuing.")
            db.execute("UPDATE proposal_drafts SET state=?,revision=revision+1,apply_request=NULL,updated_at=? WHERE project_id=? AND id=?",
                       ("discarded" if discard else "active", now(), project_id, draft_id))
            return {"draft": self._summary(self._row(db, project_id, proposal_id, draft_id), current_hash)}, 200

        return self._operation(project_id, proposal_id, draft_id, payload, "discard" if discard else "cancel", edit)

    def candidate_for_apply(self, db, project_id, proposal_id, payload):
        row = self._row(db, project_id, proposal_id, payload["draftId"])
        if row["state"] != "applying" or row["revision"] != payload["draftRevision"]:
            raise RuntimeError("This Apply is no longer current. Reload the saved draft to recover it.")
        if row["apply_request"] is None or json.loads(row["apply_request"]) != payload:
            raise ValidationError("Apply must use the exact prepared request for this saved draft.")
        return json.loads(row["candidate"])

    def mark_applied(self, db, project_id, draft_id, checkpoint_id):
        db.execute("UPDATE proposal_drafts SET state='applied',revision=revision+1,applied_cursor=?,updated_at=? WHERE project_id=? AND id=?",
                   (checkpoint_id, now(), project_id, draft_id))

    def reject_all(self, db, project_id, proposal_id):
        db.execute("UPDATE proposal_drafts SET state='discarded',revision=revision+1,apply_request=NULL,updated_at=? "
                   "WHERE project_id=? AND proposal_id=? AND state IN ('active','applying')", (now(), project_id, proposal_id))
