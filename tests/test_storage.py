from copy import deepcopy
from pathlib import Path
import sqlite3
from uuid import uuid4

import pytest

from flowdesk.sample import sample_content
from flowdesk.storage import ConflictError, NotFoundError, Store, empty_content
from flowdesk.validation import ValidationError, validate_content


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "flowdesk.sqlite3")


def checkpoint(content, label="Edit diagram"):
    return {"id": str(uuid4()), "label": label, "diagramId": content["diagrams"][0]["id"], "content": content}


def payload(envelope, appended=None, cursor=None, anchor=None, views=None):
    appended = appended or []
    return {"baseRevision": envelope["revision"], "mutationId": str(uuid4()),
            "anchorId": anchor or envelope["history"][-1]["id"], "append": appended,
            "cursor": cursor or (appended[-1]["id"] if appended else envelope["cursor"]),
            "views": envelope["views"] if views is None else views}


def edit(store, envelope, content):
    store.save_project(envelope["id"], payload(envelope, [checkpoint(content)]))
    return store.get_project(envelope["id"])


def test_create_and_restart_preserves_entire_branching_loop_project(store):
    content = sample_content()
    content["diagrams"].append({"id": str(uuid4()), "name": "Failure recovery", "nodes": [], "edges": []})
    views = {d["id"]: {"x": -275.25, "y": 92.5, "zoom": 0.8} for d in content["diagrams"]}
    created = store.create_project(content=content, views=views)
    restarted = Store(store.db_path).get_project(created["id"])
    assert restarted["content"] == content
    assert restarted["views"] == views
    assert restarted["history"][0]["content"] == content
    with store.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM diagrams").fetchone()[0] == 2
        assert con.execute("SELECT COUNT(*) FROM nodes").fetchone()[0] == 7
        assert con.execute("SELECT COUNT(*) FROM edges").fetchone()[0] == 7
        assert con.execute("PRAGMA foreign_key_check").fetchall() == []


def test_undo_redo_cursor_and_redo_branch_survive_restart(store):
    created = store.create_project(content=sample_content())
    first = deepcopy(created["content"])
    first["notes"] = "First saved edit"
    after_first = edit(store, created, first)
    second = deepcopy(first)
    second["diagrams"][0]["nodes"][0]["position"]["x"] = 980
    after_second = edit(store, after_first, second)
    store.save_project(created["id"], payload(after_second, cursor=created["cursor"]))
    restarted = Store(store.db_path).get_project(created["id"])
    assert restarted["content"] == created["content"]
    assert len(restarted["history"]) == 3
    store.save_project(created["id"], payload(restarted, cursor=after_second["cursor"]))
    assert store.get_project(created["id"])["content"] == second


def test_node_delete_and_undo_restore_checklist_edges_and_variable_links(store):
    created = store.create_project(content=sample_content())
    changed = deepcopy(created["content"])
    diagram = changed["diagrams"][0]
    removed_id = next(node["id"] for node in diagram["nodes"] if node["type"] == "decision")
    diagram["nodes"] = [n for n in diagram["nodes"] if n["id"] != removed_id]
    diagram["edges"] = [e for e in diagram["edges"] if removed_id not in (e["source"], e["target"])]
    changed["nodeLinks"] = [link for link in changed["nodeLinks"] if link["nodeId"] != removed_id]
    deleted = edit(store, created, changed)
    with store.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM checklist_items").fetchone()[0] == 0
    restarted = Store(store.db_path).get_project(created["id"])
    store.save_project(created["id"], payload(restarted, cursor=created["cursor"]))
    restored = store.get_project(created["id"])
    assert restored["content"] == created["content"]
    with store.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM checklist_items").fetchone()[0] == 2
        assert con.execute("SELECT COUNT(*) FROM planned_node_links").fetchone()[0] == 3
    store.save_project(created["id"], payload(restored, cursor=deleted["cursor"]))
    assert store.get_project(created["id"])["content"] == changed


def test_edit_after_undo_discards_redo_branch(store):
    created = store.create_project()
    content = deepcopy(created["content"])
    content["notes"] = "Old future"
    future = edit(store, created, content)
    store.save_project(created["id"], payload(future, cursor=created["cursor"]))
    undone = store.get_project(created["id"])
    branch_content = deepcopy(created["content"])
    branch_content["notes"] = "New future"
    branch = checkpoint(branch_content)
    store.save_project(created["id"], payload(undone, [branch], anchor=created["cursor"]))
    restored = store.get_project(created["id"])
    assert [h["id"] for h in restored["history"]] == [created["cursor"], branch["id"]]
    assert restored["content"]["notes"] == "New future"


def test_history_keeps_one_baseline_and_100_actions(store):
    created = store.create_project()
    additions = []
    for index in range(101):
        content = deepcopy(created["content"])
        content["notes"] = f"Edit {index}"
        additions.append(checkpoint(content))
    ack = store.save_project(created["id"], payload(created, additions))
    restored = store.get_project(created["id"])
    assert len(restored["history"]) == 101
    assert ack["historyIds"] == [h["id"] for h in restored["history"]]
    assert restored["history"][0]["id"] == additions[0]["id"]
    assert restored["cursor"] == additions[-1]["id"]
    assert restored["content"]["notes"] == "Edit 100"


def test_save_rolls_back_history_and_relational_rows_when_projection_fails(store, monkeypatch):
    created = store.create_project(content=sample_content())
    content = deepcopy(created["content"])
    content["diagrams"][0]["nodes"][0]["title"] = "Never committed"
    original = store._write_current

    def fail_after_writing(connection, project_id, current):
        original(connection, project_id, current)
        raise RuntimeError("Injected disk failure")

    monkeypatch.setattr(store, "_write_current", fail_after_writing)
    with pytest.raises(RuntimeError, match="Injected disk failure"):
        store.save_project(created["id"], payload(created, [checkpoint(content)]))
    assert store.get_project(created["id"]) == created
    with store.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM nodes WHERE title='Never committed'").fetchone()[0] == 0
        assert con.execute("SELECT COUNT(*) FROM save_receipts").fetchone()[0] == 0


def test_stale_save_cannot_overwrite_newer_revision(store):
    created = store.create_project()
    first, second = deepcopy(created["content"]), deepcopy(created["content"])
    first["notes"], second["notes"] = "First tab", "Stale tab"
    edit(store, created, first)
    with pytest.raises(ConflictError) as error:
        store.save_project(created["id"], payload(created, [checkpoint(second)]))
    assert error.value.current_revision == 1
    assert store.get_project(created["id"])["content"]["notes"] == "First tab"


def test_lost_response_retry_is_idempotent_even_after_restart(store):
    created = store.create_project()
    content = deepcopy(created["content"])
    content["notes"] = "Committed once"
    request = payload(created, [checkpoint(content)])
    ack = store.save_project(created["id"], request)
    restarted = Store(store.db_path)
    assert restarted.save_project(created["id"], request) == ack
    assert restarted.get_project(created["id"])["revision"] == 1
    assert len(restarted.get_project(created["id"])["history"]) == 2
    request["views"] = {content["diagrams"][0]["id"]: {"x": 1, "y": 0, "zoom": 1}}
    with pytest.raises(ValidationError, match="mutation ID"):
        restarted.save_project(created["id"], request)


def test_planned_variable_can_reference_nonexistent_file_and_expression_is_inert(store, tmp_path):
    content = sample_content()
    variable = content["variables"][0]
    variable.update({"name": "not decided yet", "intendedType": "", "intendedFile": "future/new_module.py", "scope": "", "initialExpression": "__import__('pathlib').Path('executed').touch()"})
    created = store.create_project(content=content)
    assert store.get_project(created["id"])["content"]["variables"][0] == variable
    assert not (tmp_path / "future").exists()
    assert not Path("executed").exists()


def test_detected_evidence_separate_from_manual_history(store):
    content = sample_content()
    symbol_id = str(uuid4())
    content["matches"] = [{"id": str(uuid4()), "plannedId": content["variables"][0]["id"], "symbolId": symbol_id, "decision": "confirmed"}]
    content["nodeLinks"].append({"id": str(uuid4()), "nodeId": content["diagrams"][0]["nodes"][0]["id"], "variableId": symbol_id, "origin": "detected", "relationship": "reads"})
    created = store.create_project(content=content, evidence=[{"id": symbol_id, "name": "count", "state": "unverified"}])
    changed = deepcopy(content)
    changed["notes"] = "A manual change"
    edited = edit(store, created, changed)
    with store.connect() as con:
        con.execute("UPDATE detected_symbols SET data=? WHERE id=?", ('{"name":"count","state":"stale"}', symbol_id))
    store.save_project(created["id"], payload(edited, cursor=created["cursor"]))
    assert store.get_project(created["id"])["content"] == content
    with store.connect() as con:
        assert '"stale"' in con.execute("SELECT data FROM detected_symbols WHERE id=?", (symbol_id,)).fetchone()[0]


def test_detected_symbol_cannot_link_across_projects(store):
    symbol_id = str(uuid4())
    store.create_project(evidence=[{"id": symbol_id}])
    content = sample_content()
    content["matches"] = [{"id": str(uuid4()), "plannedId": content["variables"][0]["id"], "symbolId": symbol_id, "decision": "confirmed"}]
    with pytest.raises(ValidationError, match="unknown detected symbol"):
        store.create_project(content=content)
    assert len(store.list_projects()) == 1


@pytest.mark.parametrize("corruption", ["duplicate_id", "wrong_edge", "cross_diagram", "nan_position", "unknown_field", "detected_field", "absolute_file", "escaped_file", "bad_status", "bad_link", "bad_type", "bad_edge_type"])
def test_invalid_content_is_rejected_without_partial_commit(store, corruption):
    created = store.create_project(content=sample_content())
    content = deepcopy(created["content"])
    diagram = content["diagrams"][0]
    if corruption == "duplicate_id":
        diagram["nodes"][1]["id"] = diagram["nodes"][0]["id"]
    elif corruption == "wrong_edge":
        diagram["edges"][0]["target"] = "unknown"
    elif corruption == "cross_diagram":
        moved = diagram["nodes"].pop(0)
        content["diagrams"].append({"id": str(uuid4()), "name": "Other", "nodes": [moved], "edges": []})
    elif corruption == "nan_position":
        diagram["nodes"][0]["position"]["x"] = float("nan")
    elif corruption == "unknown_field":
        diagram["nodes"][0]["done"] = True
    elif corruption == "detected_field":
        content["variables"][0]["annotation"] = "str"
    elif corruption == "absolute_file":
        content["variables"][0]["intendedFile"] = "C:\\private\\file.py"
    elif corruption == "escaped_file":
        content["variables"][0]["intendedFile"] = "../outside.py"
    elif corruption == "bad_status":
        diagram["nodes"][0]["status"] = "complete"
    elif corruption == "bad_link":
        content["nodeLinks"][0]["variableId"] = "unknown"
    elif corruption == "bad_type":
        diagram["nodes"][0]["type"] = []
    elif corruption == "bad_edge_type":
        diagram["edges"][0]["source"] = []
    with pytest.raises(ValidationError):
        store.save_project(created["id"], payload(created, [checkpoint(content)]))
    assert store.get_project(created["id"]) == created


def test_failed_creation_with_conflicting_ids_is_atomic(store):
    content = sample_content()
    store.create_project(content=content)
    with pytest.raises(ValidationError, match="conflict"):
        store.create_project(content=content)
    assert len(store.list_projects()) == 1


def test_backup_opens_as_a_consistent_independent_database(store):
    created = store.create_project(content=sample_content())
    backup = Path(store.backup())
    assert backup.parent == store.db_path.parent / "backups"
    with sqlite3.connect(backup) as con:
        assert con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert con.execute("PRAGMA foreign_key_check").fetchall() == []
        assert con.execute("SELECT name FROM projects WHERE id=?", (created["id"],)).fetchone()[0] == created["content"]["name"]
    store.delete_project(created["id"], created["revision"])
    assert Store(backup).get_project(created["id"])["content"] == created["content"]


def test_project_deletion_checks_revision_and_only_removes_planning_data(store, tmp_path):
    source = tmp_path / "source.py"
    source.write_text("count = 0\n", encoding="utf-8")
    created = store.create_project(content=sample_content())
    with pytest.raises(ConflictError):
        store.delete_project(created["id"], created["revision"] + 1)
    store.delete_project(created["id"], created["revision"])
    with pytest.raises(NotFoundError):
        store.get_project(created["id"])
    assert source.read_text(encoding="utf-8") == "count = 0\n"
    with store.connect() as con:
        for table in ("projects", "diagrams", "nodes", "edges", "checklist_items", "planned_variables", "planned_node_links", "history_checkpoints", "save_receipts"):
            assert con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0


def test_hostile_looking_notes_are_preserved_as_plain_text(store):
    content = empty_content()
    content["notes"] = '<script>alert("x")</script><img src=x onerror=alert(1)>'
    created = store.create_project(content=content)
    assert created["content"]["notes"] == content["notes"]


def test_validation_does_not_mutate_input():
    content = empty_content()
    original = deepcopy(content)
    validate_content(content)
    assert content == original


def test_viewport_validation_and_save_keeps_history_unchanged(store):
    created = store.create_project()
    diagram_id = created["content"]["diagrams"][0]["id"]
    views = {diagram_id: {"x": -10.5, "y": 50, "zoom": 0.7}}
    store.save_project(created["id"], payload(created, views=views))
    saved = store.get_project(created["id"])
    assert saved["views"] == views
    assert saved["history"] == created["history"]
    with pytest.raises(ValidationError, match="zoom"):
        store.save_project(created["id"], payload(saved, views={diagram_id: {"x": 0, "y": 0, "zoom": 0}}))
    assert store.get_project(created["id"]) == saved


def test_deleted_diagram_viewport_survives_restart_and_later_saves(store):
    content = empty_content()
    removed_id = str(uuid4())
    content["diagrams"].append({"id": removed_id, "name": "Restore me", "nodes": [], "edges": []})
    view = {"x": -833.3, "y": 27.5, "zoom": 0.4}
    created = store.create_project(content=content, views={removed_id: view})
    changed = deepcopy(content)
    changed["diagrams"].pop()
    deleted = edit(store, created, changed)
    restarted = Store(store.db_path).get_project(created["id"])
    assert restarted["views"][removed_id] == view
    changed["notes"] = "Edited after restart"
    another = edit(store, restarted, changed)
    store.save_project(created["id"], payload(another, cursor=created["cursor"]))
    restored = store.get_project(created["id"])
    assert restored["content"] == content
    assert restored["views"][removed_id] == view
    assert deleted["cursor"] != created["cursor"]


def test_detected_symbol_fk_restricts_direct_deletion_but_project_deletion_works(store):
    content = sample_content()
    symbol_id = str(uuid4())
    content["matches"] = [{"id": str(uuid4()), "plannedId": content["variables"][0]["id"], "symbolId": symbol_id, "decision": "confirmed"}]
    content["nodeLinks"].append({"id": str(uuid4()), "nodeId": content["diagrams"][0]["nodes"][0]["id"], "variableId": symbol_id, "origin": "detected", "relationship": "reads"})
    created = store.create_project(content=content, evidence=[{"id": symbol_id}])
    with store.connect() as con:
        with pytest.raises(sqlite3.IntegrityError):
            con.execute("DELETE FROM detected_symbols WHERE id=?", (symbol_id,))
    store.delete_project(created["id"], created["revision"])
    with store.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM detected_symbols").fetchone()[0] == 0
        assert con.execute("PRAGMA foreign_key_check").fetchall() == []
