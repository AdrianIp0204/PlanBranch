"""Offline, synthetic packaging inputs; no runtime download or installation."""
import hashlib
import json
from pathlib import Path
import stat
import zipfile

import pytest

from scripts import build_windows_portable as portable


def write_zip(path, files):
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in files.items():
            info = zipfile.ZipInfo("placeholder")
            info.filename = name  # retain malicious Windows separators in fixtures
            archive.writestr(info, data)
    return path


def pin(path, **extra):
    return {"filename": path.name, "url": "https://files.pythonhosted.org/test/" + path.name,
            "size": path.stat().st_size, "sha256": portable.sha256(path), **extra}


@pytest.fixture
def build_input(tmp_path):
    cache = tmp_path / "cache"
    cache.mkdir()
    runtime = write_zip(cache / "python-3.14.7-embed-amd64.zip", {name: "fixture " + name for name in portable.RUNTIME_REQUIRED})
    wheel = write_zip(cache / "flask-3.1.3-py3-none-any.whl", {
        "flask/__init__.py": "", "flask-3.1.3.dist-info/METADATA": "Name: Flask\nVersion: 3.1.3\n",
        "flask-3.1.3.dist-info/licenses/LICENSE.txt": "Runtime fixture license"})
    lock = {"schemaVersion": 1, "platform": "win_amd64", "python": pin(runtime, version="3.14.7"),
            "wheels": [pin(wheel, name="Flask", version="3.1.3")]}
    lock_path = tmp_path / "lock.json"
    lock_path.write_text(json.dumps(lock), encoding="utf8")
    app = write_zip(tmp_path / "flowdesk-0.2.0-py3-none-any.whl", {
        **{name: "fixture " + name for name in portable.APP_REQUIRED},
        "flowdesk/migrations/001_initial.sql": "SELECT 1;",
        "flowdesk-0.2.0.dist-info/METADATA": "Name: flowdesk\nVersion: 0.2.0\nRequires-Dist: Flask==3.1.3\n"})
    frontend = tmp_path / "frontend"
    (frontend / "node_modules" / "react").mkdir(parents=True)
    (frontend / "node_modules" / "react" / "LICENSE").write_text("Frontend fixture license", encoding="utf8")
    (frontend / "package-lock.json").write_text(json.dumps({"packages": {"": {"name": "frontend"},
        "node_modules/react": {"version": "19.3.0"}, "node_modules/test-only": {"version": "1", "dev": True}}}), encoding="utf8")
    license_file = tmp_path / "LICENSE"
    license_file.write_text("Application fixture license", encoding="utf8")
    return {"wheel": app, "output_dir": tmp_path / "dist", "cache_dir": cache, "offline": True,
            "lock_path": lock_path, "frontend": frontend, "license_path": license_file}


def test_offline_bundle_is_isolated_complete_repeatable_and_keeps_licenses(build_input, monkeypatch):
    monkeypatch.setattr(portable.urllib.request, "urlopen", lambda *_a, **_k: pytest.fail("Offline build must not use the network"))
    result = portable.build_portable(**build_input)
    archive = Path(result["archive"])
    original = archive.read_bytes()
    assert result["sha256"] == hashlib.sha256(original).hexdigest()
    with zipfile.ZipFile(archive) as bundle:
        prefix = "PlanBranch-0.2.0/"
        assert bundle.read(prefix + "runtime/python314._pth").decode() == portable.PTH
        assert "import site" not in portable.PTH
        assert bundle.read(prefix + "planbranch.cmd") == bundle.read(prefix + "flowdesk.cmd")
        assert b"-I -X utf8 -m flowdesk %*" in bundle.read(prefix + "planbranch.cmd")
        assert b"Application fixture license" in bundle.read(prefix + "LICENSE.txt")
        assert b"Frontend fixture license" in bundle.read(prefix + "THIRD_PARTY_NOTICES.txt")
        assert bundle.read(prefix + "app/flask-3.1.3.dist-info/licenses/LICENSE.txt") == b"Runtime fixture license"
        assert not any("test-only" in name or "node_modules" in name or "pip/" in name for name in bundle.namelist())
        manifest = json.loads(bundle.read(prefix + "manifest.json"))
        assert manifest["pythonVersion"] == "3.14.7"
        for name, digest in manifest["files"].items():
            assert hashlib.sha256(bundle.read(prefix + name)).hexdigest() == digest
        assert len(manifest["files"]) + 1 == result["fileCount"]
    assert portable.build_portable(**build_input)["sha256"] == result["sha256"]
    assert archive.read_bytes() == original
    assert not list(build_input["output_dir"].glob(".portable-build-*"))


def test_bad_cached_hash_does_not_replace_prior_release(build_input):
    result = portable.build_portable(**build_input)
    archive = Path(result["archive"])
    original = archive.read_bytes()
    (build_input["cache_dir"] / "flask-3.1.3-py3-none-any.whl").write_bytes(b"altered")
    with pytest.raises(portable.PortableBuildError, match="checksum mismatch"):
        portable.build_portable(**build_input)
    assert archive.read_bytes() == original


def test_missing_offline_download_does_not_fetch(build_input, monkeypatch):
    (build_input["cache_dir"] / "flask-3.1.3-py3-none-any.whl").unlink()
    monkeypatch.setattr(portable.urllib.request, "urlopen", lambda *_a, **_k: pytest.fail("No implicit network in offline mode"))
    with pytest.raises(portable.PortableBuildError, match="Offline cache is missing"):
        portable.build_portable(**build_input)


@pytest.mark.parametrize("name", ["../escape", "folder/../../escape", "/absolute", "C:/absolute", "folder\\escape", "a/./b", "a//b", "AUX.txt", "file:stream", "folder./file"])
def test_unsafe_archive_names_are_rejected_before_any_extraction(tmp_path, name):
    source = write_zip(tmp_path / "bad.zip", {"innocent": "not extracted", name: "unsafe"})
    destination = tmp_path / "unpacked"
    with pytest.raises(portable.PortableBuildError, match="Unsafe"):
        portable.safe_extract(source, destination)
    assert not list(destination.iterdir())
    assert not (tmp_path / "escape").exists()


def test_case_collisions_and_link_entries_are_rejected(tmp_path):
    source = write_zip(tmp_path / "case.zip", {"app/Module.py": "a", "app/module.py": "b"})
    with pytest.raises(portable.PortableBuildError, match="colliding"):
        portable.safe_extract(source, tmp_path / "one")
    with zipfile.ZipFile(source, "w") as archive:
        info = zipfile.ZipInfo("linked")
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(info, "../../private")
    with pytest.raises(portable.PortableBuildError, match="Unsafe"):
        portable.safe_extract(source, tmp_path / "two")


def replace_app(build_input, omit=None, requires="Flask==3.1.3"):
    files = {name: "fixture" for name in portable.APP_REQUIRED if name != omit}
    files["flowdesk/migrations/001_initial.sql"] = "SELECT 1;"
    files["flowdesk-0.2.0.dist-info/METADATA"] = "Name: flowdesk\nVersion: 0.2.0\nRequires-Dist: " + requires + "\n"
    write_zip(build_input["wheel"], files)


@pytest.mark.parametrize("missing", ["flowdesk/static/index.html", "flowdesk/scanner.py", "flowdesk/executor_worker.py"])
def test_missing_application_resources_preserve_prior_release(build_input, missing):
    result = portable.build_portable(**build_input)
    original = Path(result["archive"]).read_bytes()
    replace_app(build_input, omit=missing)
    with pytest.raises(portable.PortableBuildError, match="resources"):
        portable.build_portable(**build_input)
    assert Path(result["archive"]).read_bytes() == original
    assert not list(build_input["output_dir"].glob(".portable-build-*"))


@pytest.mark.parametrize("requires", ["Flask==99", "unbundled-library>=1", "Flask @ https://example.invalid/wheel"])
def test_runtime_dependency_drift_fails_before_packaging(build_input, requires):
    replace_app(build_input, requires=requires)
    with pytest.raises(portable.PortableBuildError, match="missing or incompatible"):
        portable.build_portable(**build_input)


def test_missing_frontend_notice_stops_packaging(build_input):
    (build_input["frontend"] / "node_modules" / "react" / "LICENSE").unlink()
    with pytest.raises(portable.PortableBuildError, match="license is missing"):
        portable.build_portable(**build_input)
