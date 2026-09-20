"""Numbered, atomic SQLite upgrades; portable content remains schema version 1."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from importlib.resources import files
from pathlib import Path
import sqlite3
from typing import Callable

from ..validation import ValidationError, validate_checkpoint


DATABASE_VERSION = 3


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    destructive: bool
    apply: Callable


def apply_sql(connection, filename):
    """Execute our ordinary DDL statements without executescript's implicit commit."""
    script = files(__package__).joinpath(filename).read_text(encoding="utf-8")
    for statement in script.split(";"):
        if statement.strip():
            connection.execute(statement)


def initial_schema(connection, store):
    apply_sql(connection, "001_initial.sql")


def managed_scanner_and_snapshots(connection, store):
    # Earlier releases created scanner tables outside the migration ledger.
    # IF NOT EXISTS adopts them without resetting attachments or observations.
    apply_sql(connection, "002_scanner.sql")
    for project in connection.execute("SELECT id,cursor FROM projects ORDER BY id").fetchall():
        project_id = project["id"]
        detected_ids = store._detected_ids(connection, project_id)
        history = [validate_checkpoint(item, detected_ids) for item in store._history(connection, project_id)]
        current = next((item for item in history if item["id"] == project["cursor"]), None)
        if current is None:
            raise ValidationError("Cannot upgrade a project whose saved history cursor is missing. Restore a valid backup.")
        # Validate and normalize every retained checkpoint, including redo. Its
        # IDs, order, labels and cursor survive; the selected snapshot determines
        # the relational projection in this same schema transaction.
        store._write_history(connection, project_id, history)
        store._write_current(connection, project_id, current["content"])


def planning_workspace(connection, store):
    apply_sql(connection, "003_planning.sql")


MIGRATIONS = (
    Migration(1, "Initial project storage", False, initial_schema),
    Migration(2, "Managed scanner schema and canonical snapshots", True, managed_scanner_and_snapshots),
    Migration(3, "Planning chat, reviews and approvals", False, planning_workspace),
)


def applied_versions(connection):
    exists = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").fetchone()
    if not exists:
        return ()
    return tuple(row[0] for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version"))


def verify_backup(path, expected_versions=None):
    """Open the completed backup read-only and verify its SQLite integrity."""
    path = Path(path).resolve()
    if not path.is_file() or path.stat().st_size == 0:
        raise ValidationError("Database backup was not created; the upgrade has been stopped.")
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    try:
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValidationError("Database backup failed its integrity check; the upgrade has been stopped.")
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValidationError("Database backup contains broken relationships; the upgrade has been stopped.")
        if expected_versions is not None and applied_versions(connection) != expected_versions:
            raise ValidationError("Database backup has an unexpected schema version; the upgrade has been stopped.")
    finally:
        connection.close()


def migrate(store):
    """Back up existing data first, then commit every pending upgrade atomically."""
    connection = store.connect()
    try:
        versions = applied_versions(connection)
        latest = MIGRATIONS[-1].version
        if versions and versions[-1] > latest:
            raise ValidationError("This database was created by a newer FlowDesk version.")
        if versions != tuple(range(1, len(versions) + 1)):
            raise ValidationError("Database migration history is incomplete. Restore a valid backup.")
        if not versions and connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations'"
        ).fetchone():
            raise ValidationError("This database has no FlowDesk migration history. Use another data directory.")
        pending = [migration for migration in MIGRATIONS if migration.version not in versions]
        if not pending:
            return
        if not versions:
            # A blank database has no user data to protect. Configure its journal
            # before the transaction so nothing fallible remains after commit.
            connection.execute("PRAGMA journal_mode=WAL")
        # A second process may still write while the backup is being made.
        # Compare this connection's data_version after obtaining the write lock
        # so no migration can run against data newer than its verified backup.
        data_version = connection.execute("PRAGMA data_version").fetchone()[0]
        if versions and any(migration.destructive for migration in pending):
            verify_backup(store.backup(), expected_versions=versions)
        connection.execute("BEGIN IMMEDIATE")
        if (connection.execute("PRAGMA data_version").fetchone()[0] != data_version
                or applied_versions(connection) != versions):
            raise ValidationError("The database changed while preparing its upgrade. Close other FlowDesk servers and retry.")
        for migration in pending:
            migration.apply(connection, store)
            connection.execute("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)",
                               (migration.version, datetime.now(timezone.utc).isoformat(timespec="microseconds")))
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValidationError("The database upgrade produced an invalid relationship; all changes were rolled back.")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
