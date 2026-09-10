from copy import deepcopy
import json

import pytest

from flowdesk.exports import (
    MAX_PORTABLE_BYTES, MAX_PORTABLE_SYMBOLS, check_portable_size,
    import_project, portable_project, portable_symbols, serialize_portable,
    validate_symbols,
)
from flowdesk.sample import sample_content
from flowdesk.storage import Store
from flowdesk.validation import ValidationError


def symbol(index, name="count"):
    return {"id": f"symbol-{index}", "name": name, "kind": "variable",
            "file": "importer.py", "scope": "process_records", "scopeKind": "function",
            "annotation": "unknown", "locations": [{"line": 1, "column": 0}],
            "declarations": [], "state": "current", "scanTime": "2026-09-10T00:00:00Z", "hash": "abc"}


def test_exact_utf8_limit_accepts_boundary_and_rejects_one_extra_byte():
    document = {"notes": "", "tail": ""}
    overhead = len(json.dumps(document, ensure_ascii=False, indent=2).encode("utf-8"))
    remaining = MAX_PORTABLE_BYTES - overhead
    document["notes"] = "é" * (remaining // 2)
    document["tail"] = "x" * (remaining % 2)
    serialized = serialize_portable(document)
    assert len(serialized.encode("utf-8")) == 10 * 1024 * 1024
    assert len(serialized) < MAX_PORTABLE_BYTES  # Count bytes, not characters.
    document["tail"] += "x"
    with pytest.raises(ValidationError, match="10 MiB"):
        serialize_portable(document)


def test_raw_import_size_counts_whitespace_and_accepts_exact_boundary():
    # The HTTP route uses this same check before parsing JSON. Whitespace still
    # counts toward the limit, even if JSON decoding would discard it.
    raw = b"{}" + b" " * (MAX_PORTABLE_BYTES - 2)
    check_portable_size(raw)
    with pytest.raises(ValidationError, match="10 MiB"):
        check_portable_size(raw + b" ")


def test_record_limit_is_shared_by_export_and_import():
    evidence = [symbol(index) for index in range(MAX_PORTABLE_SYMBOLS)]
    assert len(portable_symbols(evidence)) == MAX_PORTABLE_SYMBOLS
    assert len(validate_symbols(evidence)) == MAX_PORTABLE_SYMBOLS
    evidence.append(symbol(MAX_PORTABLE_SYMBOLS))
    for operation in (portable_symbols, validate_symbols):
        with pytest.raises(ValidationError, match="20,000 detected symbols"):
            operation(evidence)


def test_large_export_fails_without_silently_dropping_observations():
    evidence = [symbol(index, "é" * 20000) for index in range(270)]
    original = deepcopy(evidence)
    with pytest.raises(ValidationError, match="10 MiB"):
        portable_project({"content": sample_content(), "views": {}}, evidence)
    assert evidence == original
    assert all(item["state"] == "current" for item in evidence)


def test_export_applies_import_per_record_bounds_without_truncating_locations():
    observation = symbol(1)
    observation["locations"] = [{"line": index + 1, "column": 0} for index in range(10001)]
    with pytest.raises(ValidationError, match="symbol locations"):
        portable_project({"content": sample_content(), "views": {}}, [observation])
    assert len(observation["locations"]) == 10001


def test_oversized_import_leaves_existing_project_and_history_unchanged(tmp_path):
    store = Store(tmp_path / "flowdesk.sqlite3")
    existing = store.create_project(content=sample_content())
    document = {"format": "flowdesk", "version": 1, "content": sample_content(), "views": {},
                "symbols": [symbol(index, "é" * 20000) for index in range(270)]}
    with pytest.raises(ValidationError, match="10 MiB"):
        import_project(store, document)
    assert store.get_project(existing["id"]) == existing
    assert len(store.list_projects()) == 1


def test_ordinary_portable_json_roundtrips_under_shared_limits(tmp_path):
    store = Store(tmp_path / "flowdesk.sqlite3")
    original = store.create_project(content=sample_content())
    document = portable_project(original, [])
    downloaded = serialize_portable(document)
    check_portable_size(downloaded.encode("utf-8"))
    restored = import_project(store, json.loads(downloaded))
    assert restored["content"]["name"] == original["content"]["name"]
    assert restored["id"] != original["id"]
    assert len(restored["history"]) == 1


def test_import_route_rejects_raw_oversize_before_parsing_or_creating_data(tmp_path):
    from flowdesk.app import create_app

    app = create_app(tmp_path, testing=True)
    store = app.extensions["flowdesk_store"]
    existing = store.create_project(content=sample_content())
    client = app.test_client()
    token = client.get("/api/bootstrap").json["token"]
    raw = b"{}" + b" " * (MAX_PORTABLE_BYTES - 1)
    response = client.post("/api/import", data=raw, content_type="application/json",
                           headers={"X-FlowDesk-Token": token})
    assert response.status_code == 400
    assert "10 MiB" in response.json["error"]
    assert len(store.list_projects()) == 1
    assert store.get_project(existing["id"]) == existing


def test_markdown_remains_available_when_evidence_exceeds_json_limit(tmp_path, monkeypatch):
    from flowdesk.app import create_app

    app = create_app(tmp_path, testing=True)
    store = app.extensions["flowdesk_store"]
    existing = store.create_project(content=sample_content())
    too_many = [symbol(index) for index in range(MAX_PORTABLE_SYMBOLS + 1)]
    monkeypatch.setattr(app.extensions["flowdesk_scans"], "symbols", lambda project_id: too_many)
    client = app.test_client()
    token = client.get("/api/bootstrap").json["token"]
    headers = {"X-FlowDesk-Token": token}
    exported = client.get(f"/api/projects/{existing['id']}/export/json", headers=headers)
    assert exported.status_code == 400
    assert "20,000 detected symbols" in exported.json["error"]
    assert "Content-Disposition" not in exported.headers
    markdown = client.get(f"/api/projects/{existing['id']}/export/markdown", headers=headers)
    assert markdown.status_code == 200
    assert "## Planned variables" in markdown.text
    assert "text/markdown" in markdown.content_type
