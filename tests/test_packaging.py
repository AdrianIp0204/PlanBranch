from pathlib import Path

import pytest

from scripts.build_release import AssetBuildError, stage_assets


@pytest.fixture
def project(tmp_path):
    (tmp_path / "flowdesk").mkdir()
    assets = tmp_path / "frontend" / "dist" / "assets"
    assets.mkdir(parents=True)
    (assets.parent / "index.html").write_text('<script src="/assets/app-new.js"></script>', encoding="utf-8")
    (assets / "app-new.js").write_text("console.log('local app');", encoding="utf-8")
    return tmp_path


def test_release_staging_replaces_assets_without_touching_source_or_other_build_files(project):
    package = project / "flowdesk"
    old_assets = package / "static" / "assets"
    old_assets.mkdir(parents=True)
    (old_assets / "app-old.js").write_text("obsolete", encoding="utf-8")
    cached = project / "build" / "lib" / "flowdesk"
    (cached / "static").mkdir(parents=True)
    (cached / "static" / "old.css").write_text("obsolete", encoding="utf-8")
    (cached / "storage.py").write_text("preserve cached Python", encoding="utf-8")
    (package / "storage.py").write_text("preserve source", encoding="utf-8")
    brief = project / "FlowDesk_Codex_Build_Prompt.md"
    brief.write_text("preserve the brief", encoding="utf-8")

    result = stage_assets(project)

    assert result == package / "static"
    assert (result / "index.html").read_text(encoding="utf-8").startswith("<script")
    assert (result / "assets" / "app-new.js").exists()
    assert not (result / "assets" / "app-old.js").exists()
    assert not (cached / "static").exists()
    assert (cached / "storage.py").read_text(encoding="utf-8") == "preserve cached Python"
    assert (package / "storage.py").read_text(encoding="utf-8") == "preserve source"
    assert brief.read_text(encoding="utf-8") == "preserve the brief"
    assert (project / "frontend" / "dist" / "assets" / "app-new.js").exists()
    assert not list(package.glob(".flowdesk-assets-*"))
    # Repeating a release preparation does not accumulate obsolete assets.
    assert stage_assets(project) == result


def test_missing_frontend_build_preserves_existing_packaged_assets(project):
    (project / "frontend" / "dist" / "index.html").unlink()
    old = project / "flowdesk" / "static"
    old.mkdir()
    (old / "index.html").write_text("existing release", encoding="utf-8")
    with pytest.raises(AssetBuildError, match="production assets are missing"):
        stage_assets(project)
    assert (old / "index.html").read_text(encoding="utf-8") == "existing release"


def test_linked_asset_is_rejected_before_replacing_existing_assets(project, tmp_path):
    outside = tmp_path / "private.txt"
    outside.write_text("must not be copied", encoding="utf-8")
    link = project / "frontend" / "dist" / "assets" / "linked.txt"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("Creating a symbolic link is unavailable on this Windows account.")
    destination = project / "flowdesk" / "static"
    destination.mkdir()
    (destination / "index.html").write_text("old release", encoding="utf-8")
    with pytest.raises(AssetBuildError, match="symbolic links or junctions"):
        stage_assets(project)
    assert outside.read_text(encoding="utf-8") == "must not be copied"
    assert (destination / "index.html").read_text(encoding="utf-8") == "old release"


def test_copy_failure_keeps_existing_assets(project, monkeypatch):
    import scripts.build_release as release

    destination = project / "flowdesk" / "static"
    destination.mkdir()
    (destination / "index.html").write_text("old release", encoding="utf-8")

    def fail_copy(*args, **kwargs):
        raise OSError("Injected copy failure")

    monkeypatch.setattr(release.shutil, "copytree", fail_copy)
    with pytest.raises(OSError, match="Injected copy failure"):
        stage_assets(project)
    assert (destination / "index.html").read_text(encoding="utf-8") == "old release"
    assert not list((project / "flowdesk").glob(".flowdesk-assets-*"))
