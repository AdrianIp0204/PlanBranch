"""Synthetic artifacts verify release provenance without downloading runtimes."""
import hashlib
import json
import subprocess
import zipfile

import pytest

from scripts.release_receipt import receipt


def write_zip(path, files):
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)


def read_zip(path):
    with zipfile.ZipFile(path) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


@pytest.fixture
def release(tmp_path):
    root = tmp_path / "Release source 計劃"
    root.mkdir()
    sources = {"flowdesk/__init__.py": '__version__ = "0.3.0"\n',
               "flowdesk/migrations/011_workflow_evidence.sql": "SELECT 1;\n",
               "flowdesk/prompts/planner-v6.md": "Planning policy.\n"}
    for name, data in {**sources, "pyproject.toml": '[project]\nversion = "0.3.0"\n',
                       ".gitignore": "dist/\nfrontend/dist/\n"}.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data, encoding="utf-8", newline="\n")
    for args in (["init"], ["-c", "core.autocrlf=false", "add", "."],
                 ["-c", "user.name=Tests", "-c", "user.email=tests@example.invalid", "commit", "-m", "Release fixture"]):
        subprocess.run(["git", "-C", str(root), *args], capture_output=True, check=True)
    (root / "frontend/dist").mkdir(parents=True)
    (root / "frontend/dist/index.html").write_text("built interface", encoding="utf-8")
    (root / "dist").mkdir()
    wheel = root / "dist/flowdesk-0.3.0-py3-none-any.whl"
    wheel_files = {**sources, "flowdesk/static/index.html": "built interface",
                   "flowdesk-0.3.0.dist-info/METADATA": "Name: flowdesk\nVersion: 0.3.0\n"}
    write_zip(wheel, wheel_files)
    portable = root / "dist/PlanBranch-0.3.0-windows-x64.zip"
    prefix = "PlanBranch-0.3.0/"
    files = {"app/" + name: data.encode() for name, data in wheel_files.items()}
    files["runtime/python.exe"] = b"Synthetic runtime fixture; never executed."
    manifest = {"schemaVersion": 1, "version": "0.3.0", "platform": "windows-x64",
                "inputs": [{"filename": wheel.name, "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest()}],
                "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    write_zip(portable, {**{prefix + name: data for name, data in files.items()},
                         prefix + "manifest.json": json.dumps(manifest)})
    return root, wheel, portable, prefix


def test_release_receipt_audits_commit_frontend_and_portable_bytes(release):
    root, wheel, portable, _ = release
    result = receipt(root, "123")
    assert len(result["commit"]) == 40 and result["checksRun"] == "123"
    assert result["byteAudit"]["applicationFiles"] == 4
    assert result["byteAudit"]["source"] == "HEAD"
    assert json.loads((root / "dist/release-manifest.json").read_text()) == result
    for item, path in zip(result["artifacts"], (wheel, portable), strict=True):
        assert item["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize("change", ["stale_source", "missing_resource", "extra_source", "stale_frontend"])
def test_stale_or_incomplete_wheel_cannot_receive_current_commit_receipt(release, change):
    root, wheel, _, _ = release
    files = read_zip(wheel)
    if change == "stale_source":
        files["flowdesk/__init__.py"] = b"old source"
    elif change == "missing_resource":
        del files["flowdesk/migrations/011_workflow_evidence.sql"]
    elif change == "extra_source":
        files["flowdesk/unexpected.py"] = b"uncommitted source"
    else:
        files["flowdesk/static/index.html"] = b"old build"
    write_zip(wheel, files)
    with pytest.raises(ValueError, match="Wheel"):
        receipt(root)
    assert not (root / "dist/release-manifest.json").exists()


@pytest.mark.parametrize("change", ["wrong_wheel", "changed_member", "missing_manifest_entry", "wrong_file_hash"])
def test_portable_receipt_requires_wheel_and_complete_manifest_identity(release, change):
    root, _, portable, prefix = release
    files = read_zip(portable)
    manifest = json.loads(files[prefix + "manifest.json"])
    if change == "wrong_wheel":
        manifest["inputs"][0]["sha256"] = "0" * 64
    elif change == "changed_member":
        name = "app/flowdesk/__init__.py"
        files[prefix + name] = b"different source with internally valid manifest"
        manifest["files"][name] = hashlib.sha256(files[prefix + name]).hexdigest()
    elif change == "missing_manifest_entry":
        files[prefix + "unlisted.txt"] = b"unlisted"
    else:
        manifest["files"]["runtime/python.exe"] = "0" * 64
    files[prefix + "manifest.json"] = json.dumps(manifest).encode()
    write_zip(portable, files)
    with pytest.raises(ValueError, match="Portable"):
        receipt(root)
    assert not (root / "dist/release-manifest.json").exists()


def test_dirty_release_source_cannot_be_certified(release):
    root, _, _, _ = release
    (root / "flowdesk/__init__.py").write_text("changed source", encoding="utf-8")
    with pytest.raises(ValueError, match="Commit the release source"):
        receipt(root)
    assert not (root / "dist/SHA256SUMS.txt").exists()
