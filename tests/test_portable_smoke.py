"""Smoke-test inputs cannot escape their disposable verification directory."""
from pathlib import Path
import stat
import zipfile

import pytest

from scripts.smoke_windows_portable import extract_bundle, poisoned_environment, verify_backup
from flowdesk.storage import Store


def archive(path, extra=None):
    with zipfile.ZipFile(path, "w") as output:
        for name in ("runtime/python.exe", "planbranch.cmd", "flowdesk.cmd", "app/flowdesk/__init__.py"):
            output.writestr("PlanBranch/" + name, "fixture")
        if extra is not None:
            if isinstance(extra, str):
                raw = zipfile.ZipInfo(extra)
                raw.filename = extra  # Preserve malicious backslashes on Windows.
                extra = raw
            output.writestr(extra, "outside")


def test_portable_archive_stages_fresh_copy_without_changing_input(tmp_path):
    source = tmp_path / "bundle.zip"
    archive(source)
    before = source.read_bytes()
    root = extract_bundle(source, tmp_path / "copied bundle")
    assert root == tmp_path / "copied bundle" / "PlanBranch"
    assert (root / "runtime/python.exe").read_text() == "fixture"
    assert source.read_bytes() == before
    with pytest.raises(ValueError, match="must be new"):
        extract_bundle(source, root.parent)


@pytest.mark.parametrize("path", ["../escape", "/escape", "C:/escape", "PlanBranch/../../escape", "PlanBranch\\escape", "planbranch/PLANBRANCH.CMD",
                                  "PlanBranch/CON.txt", "PlanBranch/file.", "PlanBranch/file ", "PlanBranch/control\x01", "PlanBranch/double//slash"])
def test_portable_archive_rejects_redirects_and_case_aliases(tmp_path, path):
    source = tmp_path / "bundle.zip"
    archive(source, path)
    with pytest.raises(ValueError, match="unsafe|duplicate|escapes"):
        extract_bundle(source, tmp_path / "copy")
    assert not (tmp_path / "escape").exists()


def test_portable_archive_rejects_symlinks_and_oversized_input(tmp_path, monkeypatch):
    source = tmp_path / "bundle.zip"
    link = zipfile.ZipInfo("PlanBranch/link")
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    archive(source, link)
    with pytest.raises(ValueError, match="unsafe"):
        extract_bundle(source, tmp_path / "links")
    archive(source)
    monkeypatch.setattr("scripts.smoke_windows_portable.MAX_BYTES", 1)
    with pytest.raises(ValueError, match="bounded"):
        extract_bundle(source, tmp_path / "large")


def test_poisoned_environment_removes_host_python_and_path_without_changing_original(tmp_path):
    source = {"Path": "host-python;host-node", "PYTHONPATH": "host-packages", "PythonHome": "host-prefix",
              "SystemRoot": "C:/Windows", "PRESERVED_FIXTURE": "yes"}
    before = source.copy()
    env, marker = poisoned_environment(tmp_path / "Unrelated \u6e2c\u8a66", source)
    assert source == before
    assert env["PYTHONHOME"] == env["PYTHONPATH"] == env["PYTHONUSERBASE"] == str(marker.parent)
    assert "host-python" not in env["PATH"] and "Path" not in env and "PythonHome" not in env
    assert env["PRESERVED_FIXTURE"] == "yes" and not marker.exists()
    assert (marker.parent / "sitecustomize.py").is_file()
    assert (marker.parent / "flowdesk/__init__.py").is_file()


def test_backup_validation_checks_integrity_and_fixture_content(tmp_path):
    store = Store(tmp_path / "data.sqlite3")
    store.create_project("Portable fixture")
    verify_backup(Path(store.backup()))
    empty = Store(tmp_path / "empty.sqlite3")
    with pytest.raises(AssertionError, match="fixture project"):
        verify_backup(Path(empty.backup()))
