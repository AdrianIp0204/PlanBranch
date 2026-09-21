"""SQLite persistence: human snapshots, relational projections, and durable history."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .content_versions import CONTENT_VERSION, SUPPORTED_CONTENT_VERSIONS, empty_brief, upgrade_content

from .validation import (
    MAX_HISTORY, ValidationError, array, identifier, integer, obj,
    validate_checkpoint, validate_content, validate_views,
)


class NotFoundError(LookupError):
    pass


class ConflictError(Exception):
    def __init__(self, current_revision):
        self.current_revision = current_revision
        super().__init__("This project changed in another tab. Your draft has been preserved.")


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


def empty_content(name="Untitled project"):
    return {
        "schemaVersion": CONTENT_VERSION, "name": name, "notes": "", "brief": empty_brief(),
        "diagrams": [{"id": str(uuid4()), "name": "Main flow", "nodes": [], "edges": []}],
        "variables": [], "nodeLinks": [], "matches": [],
    }



class Store:
    def __init__(self, db_path):
        self.db_path = Path(db_path).resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def connect(self):
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        return connection

    def initialize(self):
        from .migrations import migrate
        migrate(self)

    def _row(self, connection, project_id):
        identifier(project_id, "Project ID")
        row = connection.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if row is None:
            raise NotFoundError("Project not found.")
        return row

    def _detected_ids(self, connection, project_id):
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='detected_symbols'").fetchone():
            return set()
        return {r[0] for r in connection.execute("SELECT id FROM detected_symbols WHERE project_id=?", (project_id,))}

    def _history(self, connection, project_id):
        result = []
        for row in connection.execute("SELECT * FROM history_checkpoints WHERE project_id=? ORDER BY ordinal", (project_id,)):
            if row["schema_version"] not in SUPPORTED_CONTENT_VERSIONS:
                raise ValidationError("Unsupported saved history version.")
            checkpoint = {"id": row["id"], "label": row["label"], "content": upgrade_content(json.loads(row["content"]))}
            if row["diagram_id"] is not None:
                checkpoint["diagramId"] = row["diagram_id"]
            result.append(checkpoint)
        return result

    def list_projects(self):
        connection = self.connect()
        try:
            return [dict(row) for row in connection.execute(
                "SELECT p.id,p.name,p.revision,p.saved_at AS savedAt,COUNT(d.id) AS diagramCount "
                "FROM projects p LEFT JOIN diagrams d ON d.project_id=p.id GROUP BY p.id ORDER BY p.saved_at DESC"
            )]
        finally:
            connection.close()

    def _envelope(self, connection, project_id):
        row = self._row(connection, project_id)
        history = self._history(connection, project_id)
        current = next((h for h in history if h["id"] == row["cursor"]), None)
        if current is None:
            raise ValidationError("Saved project history is inconsistent; restore a database backup.")
        views = {r["diagram_id"]: {"x": r["x"], "y": r["y"], "zoom": r["zoom"]}
                 for r in connection.execute("SELECT * FROM diagram_views WHERE project_id=?", (project_id,))}
        # A deleted diagram's viewport must survive a restart followed by Undo.
        ids = {d["id"] for checkpoint in history for d in checkpoint["content"]["diagrams"]}
        views = {k: v for k, v in views.items() if k in ids}
        return {"id": project_id, "revision": row["revision"], "savedAt": row["saved_at"],
                "content": current["content"], "history": history, "cursor": row["cursor"], "views": views}

    def get_project(self, project_id):
        connection = self.connect()
        try:
            connection.execute("BEGIN")
            return self._envelope(connection, project_id)
        finally:
            connection.close()

    def create_project(self, name="Untitled project", content=None, evidence=None, views=None):
        content = validate_content(empty_content(name) if content is None else content)
        views = validate_views({} if views is None else views, {d["id"] for d in content["diagrams"]})
        project_id, checkpoint_id = str(uuid4()), str(uuid4())
        checkpoint = {"id": checkpoint_id, "label": "Project created", "content": content}
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("INSERT INTO projects VALUES(?,?,?,?,?,?)", (project_id, content["name"], content["notes"], 0, now(), checkpoint_id))
            if evidence:
                array(evidence, "Imported evidence", 20000)
                for symbol in evidence:
                    if not isinstance(symbol, dict):
                        raise ValidationError("Imported evidence must contain symbol objects.")
                    identifier(symbol.get("id"), "Evidence ID")
                    connection.execute("INSERT INTO detected_symbols(id,project_id,data) VALUES(?,?,?)", (symbol["id"], project_id, encode(symbol)))
            content = validate_content(content, self._detected_ids(connection, project_id))
            checkpoint["content"] = content
            self._write_history(connection, project_id, [checkpoint])
            self._write_current(connection, project_id, content)
            connection.executemany("INSERT INTO diagram_views VALUES(?,?,?,?,?)", [
                (project_id, diagram_id, view["x"], view["y"], view["zoom"]) for diagram_id, view in views.items()
            ])
            connection.commit()
            return self.get_project(project_id)
        except sqlite3.IntegrityError as exc:
            connection.rollback()
            raise ValidationError("Project IDs conflict with existing data; imports must remap IDs.") from exc
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _write_history(self, connection, project_id, history):
        connection.execute("DELETE FROM history_checkpoints WHERE project_id=?", (project_id,))
        connection.executemany("INSERT INTO history_checkpoints VALUES(?,?,?,?,?,?,?)", [
            (project_id, item["id"], ordinal, item["label"], item.get("diagramId"), CONTENT_VERSION, encode(item["content"]))
            for ordinal, item in enumerate(history)
        ])

    def _write_current(self, connection, project_id, content):
        # Child rows cascade; scanner facts and attachment permissions are untouched.
        connection.execute("DELETE FROM diagrams WHERE project_id=?", (project_id,))
        connection.execute("DELETE FROM planned_variables WHERE project_id=?", (project_id,))
        connection.execute("DELETE FROM symbol_matches WHERE project_id=?", (project_id,))
        connection.execute("UPDATE projects SET name=?,notes=? WHERE id=?", (content["name"], content["notes"], project_id))
        for ordinal, diagram in enumerate(content["diagrams"]):
            connection.execute("INSERT INTO diagrams VALUES(?,?,?,?)", (diagram["id"], project_id, diagram["name"], ordinal))
            for node_order, node in enumerate(diagram["nodes"]):
                data = {k: v for k, v in node.items() if k not in {"id", "type", "title", "position", "status", "checklist"}}
                connection.execute("INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?)", (node["id"], diagram["id"], node_order, node["type"], node["title"], node["position"]["x"], node["position"]["y"], node["status"], encode(data)))
                connection.executemany("INSERT INTO checklist_items VALUES(?,?,?,?,?)", [
                    (item["id"], node["id"], i, item["text"], int(item["checked"]))
                    for i, item in enumerate(node["checklist"])
                ])
            for edge_order, edge in enumerate(diagram["edges"]):
                data = {k: v for k, v in edge.items() if k not in {"id", "source", "target"}}
                connection.execute("INSERT INTO edges VALUES(?,?,?,?,?,?)", (edge["id"], diagram["id"], edge["source"], edge["target"], edge_order, encode(data)))
        for ordinal, variable in enumerate(content["variables"]):
            data = {k: v for k, v in variable.items() if k not in {"id", "name", "status"}}
            connection.execute("INSERT INTO planned_variables VALUES(?,?,?,?,?,?)", (variable["id"], project_id, ordinal, variable["name"], variable["status"], encode(data)))
        for link in content["nodeLinks"]:
            table = "planned_node_links" if link["origin"] == "planned" else "detected_node_links"
            connection.execute(f"INSERT INTO {table} VALUES(?,?,?,?,?)", (link["id"], project_id, link["nodeId"], link["variableId"], link["relationship"]))
        connection.executemany("INSERT INTO symbol_matches VALUES(?,?,?,?,?)", [
            (match["id"], project_id, match["plannedId"], match["symbolId"], match["decision"])
            for match in content["matches"]
        ])

    def save_project(self, project_id, payload):
        obj(payload, {"baseRevision", "mutationId", "anchorId", "append", "cursor", "views"}, "save request")
        integer(payload.get("baseRevision"), "Base revision")
        identifier(payload.get("mutationId"), "Mutation ID")
        identifier(payload.get("anchorId"), "History anchor ID")
        identifier(payload.get("cursor"), "History cursor")
        array(payload.get("append"), "Appended history", MAX_HISTORY)
        try:
            payload_hash = hashlib.sha256(encode(payload).encode("utf-8")).hexdigest()
        except (TypeError, ValueError, RecursionError) as exc:
            raise ValidationError("Save request must contain finite JSON values.") from exc
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            project = self._row(connection, project_id)
            receipt = connection.execute("SELECT * FROM save_receipts WHERE project_id=? AND mutation_id=?", (project_id, payload["mutationId"])).fetchone()
            if receipt is not None:
                if receipt["payload_hash"] != payload_hash:
                    raise ValidationError("A mutation ID cannot be reused for a different request.")
                return json.loads(receipt["acknowledgement"])
            if project["revision"] != payload["baseRevision"]:
                raise ConflictError(project["revision"])
            previous = self._history(connection, project_id)
            anchor = next((i for i, item in enumerate(previous) if item["id"] == payload["anchorId"]), None)
            if anchor is None:
                raise ValidationError("History anchor no longer exists; reload this project.")
            if not payload["append"] and anchor != len(previous) - 1:
                raise ValidationError("Cursor-only saves must anchor to the final retained checkpoint.")
            detected = self._detected_ids(connection, project_id)
            additions = [validate_checkpoint(item, detected) for item in payload["append"]]
            old_ids = {item["id"] for item in previous}
            addition_ids = [item["id"] for item in additions]
            if len(set(addition_ids)) != len(addition_ids) or old_ids.intersection(addition_ids):
                raise ValidationError("New checkpoints must have new, unique IDs.")
            history = previous[:anchor + 1] + additions
            current = next((item for item in history if item["id"] == payload["cursor"]), None)
            if current is None:
                raise ValidationError("History cursor references an unknown checkpoint.")
            if additions and len(history) > MAX_HISTORY:
                retained = history[-MAX_HISTORY:]
                if not any(item["id"] == payload["cursor"] for item in retained):
                    raise ValidationError("The selected history checkpoint would exceed the retained undo limit.")
                history = retained
            # Existing historical references may be stale, but never cross project.
            content = validate_content(current["content"], detected)
            known_diagrams = {d["id"] for item in history for d in item["content"]["diagrams"]}
            views = validate_views(payload.get("views", {}), known_diagrams)
            self._write_history(connection, project_id, history)
            self._write_current(connection, project_id, content)
            connection.execute("DELETE FROM diagram_views WHERE project_id=?", (project_id,))
            connection.executemany("INSERT INTO diagram_views VALUES(?,?,?,?,?)", [
                (project_id, diagram_id, view["x"], view["y"], view["zoom"]) for diagram_id, view in views.items()
            ])
            saved_at = now()
            revision = project["revision"] + 1
            connection.execute("UPDATE projects SET revision=?,saved_at=?,cursor=? WHERE id=?", (revision, saved_at, payload["cursor"], project_id))
            acknowledgement = {"revision": revision, "savedAt": saved_at, "historyIds": [item["id"] for item in history]}
            connection.execute("INSERT INTO save_receipts VALUES(?,?,?,?)", (project_id, payload["mutationId"], payload_hash, encode(acknowledgement)))
            connection.commit()
            return acknowledgement
        except sqlite3.IntegrityError as exc:
            connection.rollback()
            raise ValidationError("Save conflicts with existing project IDs or relationships.") from exc
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def delete_project(self, project_id, revision):
        integer(revision, "Expected revision")
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            project = self._row(connection, project_id)
            if project["revision"] != revision:
                raise ConflictError(project["revision"])
            # Remove authored links before source evidence cascades; symbol FKs
            # restrict direct scanner deletion while allowing project deletion.
            connection.execute("DELETE FROM detected_node_links WHERE project_id=?", (project_id,))
            connection.execute("DELETE FROM symbol_matches WHERE project_id=?", (project_id,))
            connection.execute("DELETE FROM projects WHERE id=?", (project_id,))
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def backup(self):
        from .migrations import verify_backup
        directory = self.db_path.parent / "backups"
        directory.mkdir(parents=True, exist_ok=True)
        destination = directory / f"flowdesk-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}-{uuid4().hex[:8]}.sqlite3"
        source = self.connect()
        try:
            target = sqlite3.connect(destination)
            try:
                source.backup(target)
            finally:
                target.close()
            verify_backup(destination)
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        finally:
            source.close()
        return str(destination)
