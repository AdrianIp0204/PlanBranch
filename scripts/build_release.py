"""Package the existing frontend production build into an installable wheel.

Run from any directory with the project's Python environment:
    python path/to/PlanBranch/scripts/build_release.py

Run ``npm ci && npm run build`` in frontend first. This script never downloads
dependencies: the environment must already contain build and setuptools.
"""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


class AssetBuildError(ValueError):
    pass


def _check_path(path: Path, boundary: Path) -> None:
    """Reject redirected paths before copying, renaming, or deleting anything."""
    if not path.is_absolute() or not path.is_relative_to(boundary):
        raise AssetBuildError(f"Asset path is outside its intended directory: {path}")
    current = boundary
    for part in path.relative_to(boundary).parts:
        current = current / part
        if current.is_symlink() or current.is_junction():
            raise AssetBuildError(f"Asset paths must not contain symbolic links or junctions: {current}")
    if path.resolve() != path or not path.resolve().is_relative_to(boundary):
        raise AssetBuildError(f"Asset path resolves outside its intended location: {path}")


def _check_tree(path: Path, boundary: Path) -> None:
    _check_path(path, boundary)
    if not path.exists():
        return
    if not path.is_dir():
        raise AssetBuildError(f"Expected an asset directory: {path}")
    pending = [path]
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                child = Path(entry.path)
                _check_path(child, boundary)
                if entry.is_dir(follow_symlinks=False):
                    pending.append(child)
                elif not entry.is_file(follow_symlinks=False):
                    raise AssetBuildError(f"Only ordinary files and directories may be packaged: {child}")


def _remove_generated_tree(path: Path, boundary: Path) -> None:
    # Never recursively remove a path without checking the resolved absolute
    # target and every descendant for links/junctions immediately beforehand.
    _check_tree(path, boundary)
    if path.exists():
        shutil.rmtree(path)


def stage_assets(project_root: Path) -> Path:
    root = Path(project_root).resolve(strict=True)
    source = root / "frontend" / "dist"
    package = root / "flowdesk"
    destination = package / "static"
    cached_assets = root / "build" / "lib" / "flowdesk" / "static"
    _check_path(package, root)
    if not package.is_dir():
        raise AssetBuildError(f"FlowDesk package directory is missing: {package}")
    _check_tree(source, root)
    if not (source / "index.html").is_file():
        raise AssetBuildError("Frontend production assets are missing. Run npm ci and npm run build in frontend first.")
    _check_tree(destination, root)
    _check_tree(cached_assets, root)

    staging = Path(tempfile.mkdtemp(prefix=".flowdesk-assets-", dir=package))
    backup = None
    installed = False
    try:
        shutil.copytree(source, staging, dirs_exist_ok=True)
        _check_tree(staging, root)
        if destination.exists():
            backup = Path(tempfile.mkdtemp(prefix=".flowdesk-assets-backup-", dir=package))
            _check_path(backup, root)
            backup.rmdir()  # Remove only the empty directory just created.
            _check_tree(destination, root)
            destination.rename(backup)
        staging.rename(destination)
        installed = True
        # setuptools may reuse this directory on subsequent wheel builds.
        # Leaving it intact would repackage stale hashed JavaScript/CSS files.
        _remove_generated_tree(cached_assets, root)
    except Exception:
        if not installed and backup is not None and backup.exists() and not destination.exists():
            _check_tree(backup, root)
            _check_path(destination, root)
            backup.rename(destination)
        raise
    finally:
        _remove_generated_tree(staging, root)
        if installed and backup is not None:
            _remove_generated_tree(backup, root)
    return destination


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    try:
        destination = stage_assets(root)
        print(f"Packaged frontend assets: {destination}", flush=True)
        subprocess.run([sys.executable, "-m", "build", "--wheel", "--no-isolation"], cwd=root, check=True)
    except (AssetBuildError, OSError, subprocess.CalledProcessError) as exc:
        print(f"Release build failed: {exc}", file=sys.stderr)
        return 1
    print(f"Wheel ready in {root / 'dist'}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
