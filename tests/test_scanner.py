"""Scanner acceptance tests use real isolated parser subprocesses and SQLite."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import threading
import time

import pytest

from flowdesk.reconciliation import reconcile
from flowdesk.scanner import UnsupportedSyntax, analyze_source
from flowdesk.scans import ScanService, safe_path
from flowdesk.storage import Store, empty_content, now


class ScannerStore(Store):
    def __init__(self, path):
        super().__init__(path)
        with closing(self.connect()) as db, db:
            content = empty_content("Scanner fixture")
            db.execute("INSERT INTO projects VALUES(?,?,?,?,?,?)", ("project", content["name"], "", 0, now(), "baseline"))
            self._write_history(db, "project", [{"id": "baseline", "label": "Fixture created", "content": content}])
            self._write_current(db, "project", content)


@pytest.fixture
def workspace(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    source = tmp_path / "source"
    source.mkdir()
    store = ScannerStore(data / "flowdesk.sqlite3")
    service = ScanService(store)
    service.attach("project", str(source), [], True)
    return source, store, service


def scan(service):
    started = service.start("project")
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        result = service.status("project", started["id"])
        if result["status"] not in ("queued", "running"):
            with service.lock:
                pass
            return result
        time.sleep(0.01)
    pytest.fail("Scan did not finish in the bounded test time.")


def named(symbols, name, scope="<module>"):
    return next(symbol for symbol in symbols if symbol["name"] == name and symbol["scope"] == scope)


def test_scope_bindings_imports_parameters_and_declarations():
    source = '''from math import sqrt as root
module_count: int = 0
def first(value: str, /, *, enabled=False, **options):
    count: int = 1
    def nested(delta):
        nonlocal count
        global module_count
        count += delta
        module_count += 1
    return count
def second():
    count = 2
class Queue:
    capacity: int = 3
    def __init__(self):
        self.pending: list[str] = []
'''
    symbols = analyze_source(source, "worker.py")
    assert named(symbols, "root")["kind"] == "import"
    assert named(symbols, "root")["importedFrom"] == "math.sqrt"
    assert named(symbols, "value", "first")["kind"] == "parameter"
    assert named(symbols, "value", "first")["annotation"] == "str"
    assert named(symbols, "options", "first")["kind"] == "parameter"
    first, second = named(symbols, "count", "first"), named(symbols, "count", "second")
    assert first["identity"] != second["identity"]
    assert first["annotation"] == "int"
    assert first["declarations"] == [{"kind": "nonlocal", "scope": "first.nested", "line": 6}]
    assert named(symbols, "module_count")["declarations"] == [{"kind": "global", "scope": "first.nested", "line": 7}]
    assert not any(s["name"] == "module_count" and s["scope"] != "<module>" for s in symbols)
    assert named(symbols, "capacity", "Queue")["kind"] == "class attribute"
    attribute = named(symbols, "self.pending", "Queue")
    assert attribute["heuristic"] is True
    assert attribute["annotation"] == "list[str]"
    assert attribute["kind"] == "instance attribute"


def test_comprehension_and_named_expression_do_not_leak_iteration_names():
    symbols = analyze_source('''def work(items):
    result = [(last := item) for item in items if item]
    nested = [[cell for cell in row] for row in items]
    return result
''')
    assert named(symbols, "last", "work")["scopeKind"] == "function"
    assert not any(s["name"] in ("item", "row", "cell") and s["scope"] == "work" for s in symbols)
    assert all(s["scopeKind"] == "comprehension" for s in symbols if s["name"] in ("item", "row", "cell"))


def test_duplicate_function_scopes_are_explicitly_ambiguous():
    symbols = analyze_source("def repeat():\n    count = 1\ndef repeat():\n    count = 2\n")
    counts = [s for s in symbols if s["name"] == "count"]
    assert len(counts) == 2
    assert all(s["ambiguousIdentity"] for s in counts)
    assert counts[0]["locations"] != counts[1]["locations"]


@pytest.mark.parametrize("source", ["from package import *", "type Alias = int", "def generic[T](value: T): pass"])
def test_unsupported_constructs_are_reported(source):
    with pytest.raises(UnsupportedSyntax):
        analyze_source(source)


def test_scan_preserves_ids_line_changes_and_failed_observations(workspace):
    root, store, service = workspace
    path = root / "worker.py"
    path.write_text("count: int = 1\ndef nested():\n    count = 2\n")
    first_run = scan(service)
    assert first_run["summary"]["analysed"] == 1
    initial = service.symbols("project")
    ids = {s["identity"]: s["id"] for s in initial}
    path.write_text("\n\ncount: int = 1\ndef nested():\n    count = 2\n")
    assert scan(service)["summary"]["additions"] == 0
    updated = service.symbols("project")
    assert {s["identity"]: s["id"] for s in updated} == ids
    assert named(updated, "count")["locations"][0]["line"] == 3
    path.write_text("def broken(:\n")
    failed = scan(service)
    assert failed["summary"]["errors"] == 1
    assert all(s["state"] == "stale" for s in service.symbols("project"))
    assert failed["summary"]["notDetected"] == 0
    # Remove a binding in a successfully analysed file: keep its original ID.
    path.write_text("count: int = 1\n")
    removed = scan(service)
    assert removed["summary"]["notDetected"] == 2
    absent = named(service.symbols("project"), "count", "nested")
    assert absent["id"] == named(initial, "count", "nested")["id"]
    assert absent["state"] == "not_detected"
    # Deleting the file is also evidence of absence after complete traversal.
    path.unlink()
    scan(service)
    assert all(s["state"] == "not_detected" for s in service.symbols("project"))


def test_parser_never_executes_source_and_respects_encoding(workspace):
    root, _, service = workspace
    marker = root / "executed.txt"
    (root / "unsafe.py").write_text(f"from pathlib import Path\nPath({str(marker)!r}).write_text('executed')\nraise RuntimeError('must not run')\nvalue=1\n")
    (root / "encoded.py").write_bytes(b"# coding: latin-1\nname = 'caf\xe9'\n")
    result = scan(service)
    assert result["summary"]["analysed"] == 2
    assert marker.exists() is False
    assert named(service.symbols("project"), "value")["state"] == "current"


def test_preview_checks_hash_and_attachment_generation(workspace, tmp_path):
    root, _, service = workspace
    path = root / "main.py"
    path.write_text("value: int = 1\n")
    scan(service)
    symbol = service.symbols("project")[0]
    assert service.preview("project", symbol["id"])["stale"] is False
    path.write_text("value: str = 'changed'\n")
    preview = service.preview("project", symbol["id"])
    assert preview["stale"] is True and "changed" in preview["text"]
    other = tmp_path / "other"
    other.mkdir()
    (other / "main.py").write_text("value: str = 'other'\n")
    service.attach("project", str(other), [], True)
    with pytest.raises(ValueError, match="another attachment"):
        service.preview("project", symbol["id"])
    scan(service)
    assert len(service.symbols("project")) == 2
    assert next(s for s in service.symbols("project") if s["id"] == symbol["id"])["state"] == "stale"


@pytest.mark.parametrize("relative", ["../secret.py", "folder/../../secret.py", "C:\\secret.py", "C:secret.py", "/etc/secret.py", "\\\\host\\share\\secret.py"])
def test_path_escapes_rejected(workspace, relative):
    root, _, _ = workspace
    with pytest.raises(ValueError):
        safe_path(root, relative)


def test_attachment_requires_explicit_specific_local_root(workspace):
    root, _, service = workspace
    with pytest.raises(ValueError, match="Confirm"):
        service.attach("project", str(root), [], False)
    with pytest.raises(ValueError, match="specific"):
        service.attach("project", str(Path(root.anchor)), [], True)
    with pytest.raises(ValueError, match="network"):
        service.attach("project", "\\\\server\\share", [], True)


def test_symlinks_skipped_and_previews_reject_links(workspace, tmp_path):
    root, _, service = workspace
    outside = tmp_path / "outside.py"
    outside.write_text("outside = True\n")
    link = root / "link.py"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("Host does not grant symlink creation permission.")
    with pytest.raises(ValueError, match="Symlinks"):
        safe_path(root, "link.py")
    result = scan(service)
    assert result["summary"]["skipped"] == 1
    assert service.symbols("project") == []


@pytest.mark.skipif(os.name != "nt", reason="Windows junction behavior")
def test_windows_junction_is_not_traversed(workspace, tmp_path):
    root, _, service = workspace
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.py").write_text("should_not_be_read = True\n")
    junction = root / "junction"
    result = subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(outside)], capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        pytest.skip("Host cannot create a test junction.")
    assert os.path.isjunction(junction)
    with pytest.raises(ValueError, match="junctions"):
        safe_path(root, "junction/secret.py")
    run = scan(service)
    assert run["summary"]["skipped"] == 1
    assert service.symbols("project") == []


def test_limit_and_ignore_preserve_unchecked_evidence(workspace):
    root, store, service = workspace
    path = root / "main.py"
    path.write_text("value=1\n")
    scan(service)
    service.attach("project", str(root), ["main.py"], True)
    assert scan(service)["summary"]["skipped"] == 1
    assert service.symbols("project")[0]["state"] == "stale"
    service.attach("project", str(root), [], True)
    service.max_bytes = 4
    assert scan(service)["summary"]["skipped"] == 1
    assert service.symbols("project")[0]["state"] == "stale"
    service.max_bytes = 10000
    service.max_entries = 0
    limited = scan(service)
    assert limited["status"] == "partial"
    assert limited["summary"]["complete"] is False
    assert service.symbols("project")[0]["state"] == "stale"


def test_cancellation_and_timeout_are_bounded(workspace, monkeypatch):
    root, _, service = workspace
    (root / "main.py").write_text("value=1\n")
    scan(service)
    entered = threading.Event()

    def wait_for_cancel(raw, relative, cancelled, deadline):
        entered.set()
        assert cancelled.wait(2)
        raise InterruptedError("cancelled")

    monkeypatch.setattr(service, "_parse", wait_for_cancel)
    started = service.start("project")
    assert entered.wait(2)
    service.cancel("project", started["id"])
    with service.lock:
        job = service.jobs.get("project")
    if job:
        job["thread"].join(3)
    assert service.status("project", started["id"])["status"] == "cancelled"
    assert service.symbols("project")[0]["state"] == "stale"
    monkeypatch.undo()
    service.parse_timeout = 0
    assert scan(service)["summary"]["skipped"] == 1


def test_interrupted_scan_is_recovered_stale(workspace):
    root, store, service = workspace
    (root / "main.py").write_text("value=1\n")
    previous = scan(service)
    previous["status"] = "running"
    with closing(store.connect()) as db, db:
        db.execute("UPDATE scan_runs SET data=? WHERE id=?", (json.dumps(previous), previous["id"]))
    restarted = ScanService(store)
    assert restarted.status("project", previous["id"])["status"] == "interrupted"
    assert restarted.symbols("project")[0]["state"] == "stale"


def test_reconciliation_suggests_only_corroborated_matches_and_preserves_choices():
    plan = {"id": "plan", "name": "count", "intendedFile": "future.py", "scope": "work", "scopeKind": "unknown", "intendedType": "int", "notes": "Keep my notes", "status": "blocked"}
    symbol = {"id": "symbol", "name": "count", "file": "actual.py", "scope": "work", "scopeKind": "function", "annotation": "str", "state": "current"}
    content = {"variables": [plan], "matches": []}
    original = json.dumps(content, sort_keys=True)
    assert len(reconcile(content, [symbol])["suggestions"]) == 1
    bare = {**plan, "intendedFile": "", "scope": ""}
    assert reconcile({"variables": [bare]}, [symbol])["suggestions"] == []
    content["matches"] = [{"id": "match", "plannedId": "plan", "symbolId": "symbol", "decision": "rejected"}]
    assert reconcile(content, [symbol])["suggestions"] == []
    content["matches"][0]["decision"] = "confirmed"
    review = reconcile(content, [symbol])["reviews"][0]
    assert review["state"] == "linked_detected"
    assert len(review["differences"]) == 2
    assert not any("Scope kind" in difference for difference in review["differences"])
    symbol["state"] = "not_detected"
    assert reconcile(content, [symbol])["reviews"][0]["state"] == "linked_not_detected"
    assert plan["notes"] == "Keep my notes" and plan["status"] == "blocked"


def test_source_changed_during_parse_is_stale(workspace, monkeypatch):
    root, _, service = workspace
    path = root / "main.py"
    path.write_text("original: int = 1\n")
    scan(service)
    initial = service.symbols("project")[0]

    def changing_source(raw, relative, cancelled, deadline):
        facts = analyze_source(raw.decode(), relative)
        path.write_text("changed: str = 'new'\n")
        return facts

    monkeypatch.setattr(service, "_parse", changing_source)
    result = scan(service)
    assert result["summary"]["errors"] == 1
    assert service.symbols("project")[0]["id"] == initial["id"]
    assert service.symbols("project")[0]["state"] == "stale"


def test_default_ignores_and_app_data_are_not_scanned(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    data = root / "flowdesk-data"
    data.mkdir()
    (data / "private.py").write_text("must_not_be_scanned = True\n")
    ignored = root / ".venv"
    ignored.mkdir()
    (ignored / "dependency.py").write_text("also_excluded = True\n")
    (root / "main.py").write_text("visible = True\n")
    store = ScannerStore(data / "flowdesk.sqlite3")
    service = ScanService(store)
    service.attach("project", str(root), [], True)
    before = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*.py")}
    result = scan(service)
    assert result["summary"]["analysed"] == 1
    assert result["summary"]["skipped"] == 2
    assert [symbol["name"] for symbol in service.symbols("project")] == ["visible"]
    assert {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*.py")} == before
