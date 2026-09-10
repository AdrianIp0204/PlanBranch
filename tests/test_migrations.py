"""Exercise real v1 database upgrades, including their saved redo branches."""
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

import pytest

from flowdesk import migrations
from flowdesk.sample import sample_content
from flowdesk.storage import Store, encode, now
from flowdesk.validation import ValidationError


class VersionOneStore(Store):
    """Build the released v1 schema without invoking the new migration runner."""
    def initialize(self):
        with closing(self.connect()) as connection, connection:
            migrations.apply_sql(connection, "001_initial.sql")
            connection.execute("INSERT INTO schema_migrations VALUES(1,?)", (now(),))
            # The original scanner created these outside the version ledger.
            scanner_sql = migrations.files(migrations.__package__).joinpath("002_scanner.sql").read_text(encoding="utf-8")
            for statement in scanner_sql.split(";"):
                if statement.strip() and not statement.strip().startswith("CREATE INDEX"):
                    connection.execute(statement)


def append(store, envelope, content):
    checkpoint = {"id": str(uuid4()), "label": "Saved metadata edit", "diagramId": content["diagrams"][0]["id"], "content": content}
    store.save_project(envelope["id"], {"baseRevision": envelope["revision"], "mutationId": str(uuid4()),
        "anchorId": envelope["history"][-1]["id"], "append": [checkpoint],
        "cursor": checkpoint["id"], "views": envelope["views"]})
    return store.get_project(envelope["id"])


def move_cursor(store, envelope, cursor):
    store.save_project(envelope["id"], {"baseRevision": envelope["revision"], "mutationId": str(uuid4()),
        "anchorId": envelope["history"][-1]["id"], "append": [],
        "cursor": cursor, "views": envelope["views"]})
    return store.get_project(envelope["id"])


def database_dump(path):
    with closing(sqlite3.connect(path)) as connection:
        return tuple(connection.iterdump())


def scanner_rows(path):
    with closing(sqlite3.connect(path)) as connection:
        return {table: connection.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
                for table in ("source_attachments", "source_files", "scan_runs", "detected_symbols")}


@pytest.fixture
def legacy(tmp_path):
    store = VersionOneStore(tmp_path / "data" / "flowdesk.sqlite3")
    source = tmp_path / "source"
    source.mkdir()
    source_file = source / "importer.py"
    source_file.write_bytes(b"count = 0\n")
    content = sample_content()
    content["diagrams"].append({"id": str(uuid4()), "name": "Recovery", "nodes": [], "edges": []})
    symbol_id = str(uuid4())
    content["matches"] = [{"id": str(uuid4()), "plannedId": content["variables"][0]["id"], "symbolId": symbol_id, "decision": "confirmed"}]
    content["nodeLinks"].append({"id": str(uuid4()), "nodeId": content["diagrams"][0]["nodes"][0]["id"], "variableId": symbol_id, "origin": "detected", "relationship": "reads"})
    evidence = [{"id": symbol_id, "name": "count", "state": "current", "file": "importer.py",
                 "scope": "<module>", "identity": "module-count", "attachmentGeneration": "existing-generation"}]
    views = {diagram["id"]: {"x": -381.25, "y": 42.5, "zoom": 0.7} for diagram in content["diagrams"]}
    created = store.create_project(content=content, evidence=evidence, views=views)
    first = deepcopy(content)
    first["notes"] += "\nKeep this user reasoning."
    edited = append(store, created, first)
    last = deepcopy(first)
    last["diagrams"][0]["nodes"][0]["position"]["x"] = 902.5
    last["variables"][0]["notes"] = "Preserve annotations and manual relationships."
    final = append(store, edited, last)
    expected = move_cursor(store, final, edited["cursor"])
    with closing(store.connect()) as connection, connection:
        connection.execute("INSERT INTO source_attachments VALUES(?,?,?,?)", (created["id"], str(source), '["ignore_*.py"]', "existing-generation"))
        connection.execute("INSERT INTO source_files VALUES(?,?,?)", (created["id"], "importer.py", '{"hash":"original-hash","state":"current"}'))
        connection.execute("INSERT INTO scan_runs VALUES(?,?,?)", ("retained-run", created["id"], '{"status":"completed","summary":{"analysed":1}}'))
        # Older checkpoints may omit optional v1 fields. Upgrade normalizes every
        # snapshot, not only the selected one, while retaining the whole redo tail.
        for checkpoint in expected["history"]:
            sparse = deepcopy(checkpoint["content"])
            for diagram in sparse["diagrams"]:
                for node in diagram["nodes"]:
                    for key in ("why", "alternatives", "blocker"):
                        if node[key] == "":
                            del node[key]
            connection.execute("UPDATE history_checkpoints SET content=? WHERE project_id=? AND id=?", (json.dumps(sparse), created["id"], checkpoint["id"]))
        for row in connection.execute("SELECT id,data FROM nodes").fetchall():
            data = json.loads(row["data"])
            if data.get("why") == "":
                data.pop("why")
            connection.execute("UPDATE nodes SET data=? WHERE id=?", (json.dumps(data), row["id"]))
    return store, expected, source_file


def test_blank_database_creates_both_numbered_schemas_without_backup(tmp_path, monkeypatch):
    def unexpected_backup(self):
        raise AssertionError("A blank database has nothing to back up")
    monkeypatch.setattr(Store, "backup", unexpected_backup)
    store = Store(tmp_path / "new.sqlite3")
    with closing(store.connect()) as connection:
        assert migrations.applied_versions(connection) == (1, 2)
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"projects", "history_checkpoints", "source_attachments", "source_files", "scan_runs", "detected_symbols"} <= tables
    assert not (tmp_path / "backups").exists()


def test_upgrade_canonicalizes_current_and_all_history_preserving_redo_and_source(legacy):
    old, expected, source = legacy
    before_dump = database_dump(old.db_path)
    before_scanner = scanner_rows(old.db_path)
    upgraded = Store(old.db_path)
    assert upgraded.get_project(expected["id"]) == expected
    assert scanner_rows(old.db_path) == before_scanner
    assert source.read_bytes() == b"count = 0\n"
    with closing(upgraded.connect()) as connection:
        assert migrations.applied_versions(connection) == (1, 2)
        assert {row[0] for row in connection.execute("SELECT schema_version FROM history_checkpoints")} == {1}
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        for row in connection.execute("SELECT data FROM nodes"):
            assert "why" in json.loads(row["data"])
    backups = list((old.db_path.parent / "backups").glob("*.sqlite3"))
    assert len(backups) == 1
    migrations.verify_backup(backups[0], expected_versions=(1,))
    assert database_dump(backups[0]) == before_dump
    # Opening the already upgraded database neither rewrites it nor backs it up again.
    assert Store(old.db_path).get_project(expected["id"]) == expected
    assert list((old.db_path.parent / "backups").glob("*.sqlite3")) == backups
    redone = move_cursor(upgraded, expected, expected["history"][-1]["id"])
    assert redone["content"] == expected["history"][-1]["content"]


def test_upgrade_adopts_version_one_database_without_preexisting_scanner_tables(tmp_path):
    old = VersionOneStore(tmp_path / "old.sqlite3")
    project = old.create_project()
    with closing(old.connect()) as connection, connection:
        for table in ("source_attachments", "source_files", "scan_runs"):
            connection.execute(f"DROP TABLE {table}")
    upgraded = Store(old.db_path)
    assert upgraded.get_project(project["id"]) == project
    with closing(upgraded.connect()) as connection:
        for table in ("source_attachments", "source_files", "scan_runs"):
            assert connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0


def test_backup_failure_prevents_any_schema_or_data_mutation(legacy, monkeypatch):
    old, _, source = legacy
    before_dump, before_bytes = database_dump(old.db_path), old.db_path.read_bytes()
    def fail_backup(self):
        raise OSError("Injected full backup disk")
    monkeypatch.setattr(Store, "backup", fail_backup)
    with pytest.raises(OSError, match="full backup disk"):
        Store(old.db_path)
    assert database_dump(old.db_path) == before_dump
    assert old.db_path.read_bytes() == before_bytes
    assert source.read_bytes() == b"count = 0\n"


def test_unverified_backup_is_rejected_before_mutation(legacy, tmp_path, monkeypatch):
    old, _, _ = legacy
    before = database_dump(old.db_path)
    broken_backup = tmp_path / "invalid-backup.sqlite3"
    broken_backup.write_bytes(b"not a SQLite database")
    monkeypatch.setattr(Store, "backup", lambda self: str(broken_backup))
    with pytest.raises(sqlite3.DatabaseError):
        Store(old.db_path)
    assert database_dump(old.db_path) == before


def test_later_upgrade_failure_rolls_back_schema_ledger_history_current_and_attachments(legacy, monkeypatch):
    old, expected, source = legacy
    before_dump, before_scanner = database_dump(old.db_path), scanner_rows(old.db_path)
    def fail_after_real_upgrade(connection, store):
        assert migrations.applied_versions(connection) == (1, 2)
        assert store._envelope(connection, expected["id"]) == expected
        connection.execute("ALTER TABLE projects ADD COLUMN failed_upgrade TEXT")
        connection.execute("UPDATE source_attachments SET root='should never persist'")
        raise RuntimeError("Injected failure after current and history migration")
    monkeypatch.setattr(migrations, "MIGRATIONS", migrations.MIGRATIONS + (
        migrations.Migration(3, "Failure injection", True, fail_after_real_upgrade),))
    with pytest.raises(RuntimeError, match="after current and history"):
        Store(old.db_path)
    assert database_dump(old.db_path) == before_dump
    assert scanner_rows(old.db_path) == before_scanner
    assert source.read_bytes() == b"count = 0\n"
    backups = list((old.db_path.parent / "backups").glob("*.sqlite3"))
    assert len(backups) == 1
    assert database_dump(backups[0]) == before_dump


def test_invalid_redo_checkpoint_aborts_entire_upgrade(legacy):
    old, expected, _ = legacy
    with closing(old.connect()) as connection, connection:
        last = deepcopy(expected["history"][-1]["content"])
        last["diagrams"][0]["edges"][0]["target"] = "missing-node"
        connection.execute("UPDATE history_checkpoints SET content=? WHERE id=?", (encode(last), expected["history"][-1]["id"]))
    before = database_dump(old.db_path)
    with pytest.raises(ValidationError, match="edge must reference"):
        Store(old.db_path)
    assert database_dump(old.db_path) == before


def test_commit_during_backup_stops_upgrade_with_stale_backup(legacy, monkeypatch):
    old, expected, _ = legacy
    original_backup = Store.backup
    changed = deepcopy(expected["content"])
    changed["notes"] = "A different server committed this while backup was running."
    def racing_backup(self):
        path = original_backup(self)
        append(old, expected, changed)
        return path
    monkeypatch.setattr(Store, "backup", racing_backup)
    with pytest.raises(ValidationError, match="changed while preparing"):
        Store(old.db_path)
    with closing(old.connect()) as connection:
        assert migrations.applied_versions(connection) == (1,)
    assert old.get_project(expected["id"])["content"] == changed


def test_unknown_newer_schema_is_rejected_without_backup_or_mutation(tmp_path, monkeypatch):
    store = Store(tmp_path / "future.sqlite3")
    with closing(store.connect()) as connection, connection:
        connection.execute("INSERT INTO schema_migrations VALUES(3,?)", (now(),))
    before = database_dump(store.db_path)
    monkeypatch.setattr(Store, "backup", lambda self: pytest.fail("Do not back up or edit an unsupported future database"))
    with pytest.raises(ValidationError, match="newer FlowDesk version"):
        Store(store.db_path)
    assert database_dump(store.db_path) == before


def test_live_wal_upgrade_backs_up_committed_current_redo_and_evidence(legacy):
    old, expected, source = legacy
    current_marker = "current-live-wal-" + str(uuid4())
    redo_marker = "redo-live-wal-" + str(uuid4())
    expected = deepcopy(expected)
    current = expected["content"]
    current["notes"] += "\n" + current_marker
    for checkpoint in expected["history"]:
        if checkpoint["id"] == expected["cursor"]:
            checkpoint["content"] = deepcopy(current)
    expected["history"][-1]["content"]["notes"] += "\n" + redo_marker
    # Keep a connection open so closing temporary readers cannot checkpoint and
    # remove the WAL. These committed rows must be read from SQLite's live WAL,
    # not copied from the older main database file.
    with closing(old.connect()) as keeper:
        assert keeper.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        keeper.execute("PRAGMA wal_autocheckpoint=0")
        with keeper:
            old._write_current(keeper, expected["id"], current)
            for checkpoint in expected["history"]:
                if checkpoint["id"] in (expected["cursor"], expected["history"][-1]["id"]):
                    keeper.execute("UPDATE history_checkpoints SET content=? WHERE project_id=? AND id=?",
                                   (encode(checkpoint["content"]), expected["id"], checkpoint["id"]))
            keeper.execute("UPDATE source_files SET data=? WHERE project_id=?",
                           (encode({"hash": "committed-live-wal-hash", "state": "current"}), expected["id"]))
        wal = Path(str(old.db_path) + "-wal")
        assert wal.is_file() and wal.stat().st_size > 0
        assert current_marker.encode() not in old.db_path.read_bytes()
        assert redo_marker.encode() not in old.db_path.read_bytes()
        before = database_dump(old.db_path)
        source_rows = scanner_rows(old.db_path)

        upgraded = Store(old.db_path)

        assert upgraded.get_project(expected["id"]) == expected
        assert scanner_rows(old.db_path) == source_rows
        backups = list((old.db_path.parent / "backups").glob("*.sqlite3"))
        assert len(backups) == 1
        migrations.verify_backup(backups[0], expected_versions=(1,))
        assert database_dump(backups[0]) == before
        with closing(sqlite3.connect(backups[0])) as backup:
            saved = backup.execute("SELECT notes,cursor FROM projects WHERE id=?", (expected["id"],)).fetchone()
            assert current_marker in saved[0]
            assert saved[1] == expected["cursor"]
            redo = backup.execute("SELECT content FROM history_checkpoints WHERE id=?", (expected["history"][-1]["id"],)).fetchone()[0]
            assert redo_marker in redo
        redone = move_cursor(upgraded, expected, expected["history"][-1]["id"])
        assert redo_marker in redone["content"]["notes"]
        assert source.read_bytes() == b"count = 0\n"
