"""Execution records are additive and never enter portable planning content."""
from contextlib import closing
from copy import deepcopy
import json
from uuid import uuid4

import pytest

from flowdesk import migrations
from flowdesk.exports import portable_project
from flowdesk.planning import PlanningService
from flowdesk.sample import sample_content
from flowdesk.storage import Store
from test_build_tasks import task
from test_planning import FakePlanner, save


def previous_store(tmp_path, monkeypatch):
    with monkeypatch.context() as patch:
        patch.setattr(migrations, "MIGRATIONS", migrations.MIGRATIONS[:7])
        patch.setattr(migrations, "DATABASE_VERSION", 7)
        store = Store(tmp_path / "data.sqlite3")
    content = sample_content()
    content["buildTasks"] = [task()]
    project = store.create_project(content=content)
    revised = deepcopy(project["content"])
    revised["brief"]["goal"] = "Retained redo goal"
    changed = save(store, project, revised)
    restored = save(store, changed, cursor=project["cursor"])
    service = PlanningService(store, FakePlanner())
    service.approve(project["id"], {"mutationId": str(uuid4()), "baseRevision": restored["revision"]})
    return store, restored


def raw_content(store):
    with closing(store.connect()) as db:
        return {table: [tuple(row) for row in db.execute(f"SELECT * FROM {table} ORDER BY 1")]
                for table in ("projects", "history_checkpoints", "save_receipts", "planning_approvals", "planning_requests")}


def test_execution_migration_preserves_manual_history_frozen_approval_and_receipts(tmp_path, monkeypatch):
    previous, project = previous_store(tmp_path, monkeypatch)
    before = raw_content(previous)
    upgraded = Store(previous.db_path)
    assert raw_content(upgraded) == before
    assert upgraded.get_project(project["id"]) == project
    assert PlanningService(upgraded, FakePlanner()).state(project["id"])["approval"]["current"]
    with closing(upgraded.connect()) as db:
        assert migrations.applied_versions(db) == tuple(range(1, migrations.DATABASE_VERSION + 1))
        assert db.execute("SELECT COUNT(*) FROM execution_runs").fetchone()[0] == 0
    portable = portable_project(project, [])
    assert set(portable) == {"format", "version", "content", "views", "symbols"}
    assert "execution" not in json.dumps(portable)


def test_execution_migration_failure_rolls_back_new_tables_without_manual_changes(tmp_path, monkeypatch):
    previous, project = previous_store(tmp_path, monkeypatch)
    before = raw_content(previous)
    original = next(item for item in migrations.MIGRATIONS if item.version == 8)
    def fail(db, owner):
        original.apply(db, owner)
        raise RuntimeError("Interrupted additive migration")
    monkeypatch.setattr(migrations, "MIGRATIONS", tuple(migrations.Migration(8, original.name, False, fail) if item.version == 8 else item for item in migrations.MIGRATIONS))
    with pytest.raises(RuntimeError, match="Interrupted additive"):
        Store(previous.db_path)
    assert raw_content(previous) == before
    with closing(previous.connect()) as db:
        assert migrations.applied_versions(db) == tuple(range(1, 8))
        assert db.execute("SELECT 1 FROM sqlite_master WHERE name='execution_runs'").fetchone() is None
