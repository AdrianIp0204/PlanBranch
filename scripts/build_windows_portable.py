"""Build the Windows x64 ZIP from a wheel and verified, pinned runtime archives.

This is a maintainer build tool, not an installer. It never invokes a downloaded
executable, installs software, reads user data, or bundles credentials. Downloads
are optional when the cache is populated. The resulting application needs neither
pip nor Node. Python's embeddable distribution is used as documented at:
https://docs.python.org/3.14/using/windows.html#the-embeddable-package
"""
from __future__ import annotations

import argparse
from email.parser import BytesParser
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import tomllib
import urllib.parse
import urllib.request
import zipfile

from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.utils import canonicalize_name, parse_wheel_filename

ROOT = Path(__file__).resolve().parents[1]
LOCK = Path(__file__).with_name("windows-portable.lock.json")
MAX_ARCHIVE_BYTES = 40_000_000
MAX_EXPANDED_BYTES = 160_000_000
PTH = "python314.zip\n.\n../app\n"
RUNTIME_REQUIRED = {"python.exe", "python314.dll", "python3.dll", "python314.zip", "python314._pth",
                    "vcruntime140.dll", "vcruntime140_1.dll", "_sqlite3.pyd", "sqlite3.dll", "LICENSE.txt"}
APP_REQUIRED = {"flowdesk/__main__.py", "flowdesk/static/index.html", "flowdesk/scanner.py",
                "flowdesk/executor_worker.py", "flowdesk/executor_process.py", "flowdesk/prompts/executor-v1.md"}
LAUNCHER = '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%~dp0runtime\\python.exe" -I -X utf8 -m flowdesk %*\r\nexit /b %errorlevel%\r\n'


class PortableBuildError(ValueError):
    pass


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def plain_path(path):
    """Reject redirects before writing or recursively removing generated files."""
    path = Path(path).absolute()
    if path.resolve() != path:
        raise PortableBuildError(f"Build paths must not contain redirects or '..': {path}")
    for current in (path, *path.parents):
        if current.is_symlink() or current.is_junction():
            raise PortableBuildError(f"Build paths must not contain links or junctions: {current}")
    return path


def remove_staging(path, boundary):
    path, boundary = plain_path(path), plain_path(boundary)
    if path == boundary or not path.is_relative_to(boundary):
        raise PortableBuildError("Refusing to remove a directory outside the build staging area.")
    for directory, folders, files in os.walk(path):
        for name in folders + files:
            plain_path(Path(directory) / name)
    shutil.rmtree(path)


def load_lock(path=LOCK):
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if value.get("schemaVersion") != 1 or value.get("platform") != "win_amd64" or value.get("python", {}).get("version") != "3.14.7":
        raise PortableBuildError("Unsupported portable runtime lock.")
    artifacts = [value["python"], *value["wheels"]]
    names = set()
    for artifact in artifacts:
        name = artifact["filename"]
        url = urllib.parse.urlparse(artifact["url"])
        if (not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or name.casefold() in names
                or url.scheme != "https" or url.hostname not in {"www.python.org", "files.pythonhosted.org"}
                or not re.fullmatch(r"[a-f0-9]{64}", artifact["sha256"])
                or type(artifact.get("size")) is not int or not 0 < artifact["size"] <= MAX_ARCHIVE_BYTES):
            raise PortableBuildError("Invalid pinned download in portable runtime lock.")
        names.add(name.casefold())
    return value


def cached_artifact(artifact, cache, offline=False):
    target = plain_path(cache / artifact["filename"])
    if target.exists():
        if target.stat().st_size != artifact["size"] or sha256(target) != artifact["sha256"]:
            raise PortableBuildError(f"Cached checksum mismatch: {target.name}. Remove that cache file and retry.")
        return target
    if offline:
        raise PortableBuildError(f"Offline cache is missing {target.name}.")
    temporary = None
    try:
        request = urllib.request.Request(artifact["url"], headers={"User-Agent": "PlanBranch-portable-build/1"})
        with urllib.request.urlopen(request, timeout=60) as response, tempfile.NamedTemporaryFile(dir=cache, prefix=".download-", delete=False) as stream:
            temporary = Path(stream.name)
            final_url = urllib.parse.urlparse(response.geturl())
            if final_url.scheme != "https" or final_url.hostname not in {"www.python.org", "files.pythonhosted.org"}:
                raise PortableBuildError("Pinned download redirected to an unexpected host.")
            total = 0
            while chunk := response.read(64 * 1024):
                total += len(chunk)
                if total > artifact["size"]:
                    raise PortableBuildError(f"Download exceeded its pinned size: {target.name}")
                stream.write(chunk)
        if total != artifact["size"] or sha256(temporary) != artifact["sha256"]:
            raise PortableBuildError(f"Download checksum mismatch: {target.name}")
        temporary.replace(target)
        return target
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def safe_extract(archive, destination):
    """Only regular, bounded archives with unambiguous Windows paths are used."""
    destination = plain_path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    existing = {str(path.relative_to(destination)).replace("\\", "/").casefold() for path in destination.rglob("*") if path.is_file()}
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if len(entries) > 10_000 or sum(entry.file_size for entry in entries) > MAX_EXPANDED_BYTES:
            raise PortableBuildError("Archive exceeds portable packaging limits.")
        paths = set()
        for entry in entries:
            original_name = entry.orig_filename
            path = PurePosixPath(original_name)
            parts = path.parts
            mode = stat.S_IFMT(entry.external_attr >> 16)
            raw_parts = original_name.rstrip("/").split("/")
            if (not parts or path.is_absolute() or "\\" in original_name or original_name != entry.filename
                    or any(ord(char) < 32 for char in original_name) or any(part in {"", ".", ".."} for part in raw_parts)
                    or any(":" in part or part.endswith((" ", ".")) or re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", part) for part in parts)
                    or entry.flag_bits & 1 or mode not in {0, stat.S_IFREG, stat.S_IFDIR}
                    or path.as_posix().casefold() in paths or (not entry.is_dir() and path.as_posix().casefold() in existing)):
                raise PortableBuildError(f"Unsafe or colliding archive path: {entry.filename}")
            paths.add(path.as_posix().casefold())
        for entry in entries:
            target = destination.joinpath(*PurePosixPath(entry.filename).parts)
            plain_path(target)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(entry) as incoming, target.open("xb") as outgoing:
                    shutil.copyfileobj(incoming, outgoing)


def wheel_metadata(path):
    if path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise PortableBuildError("Application wheel exceeds portable packaging limits.")
    with zipfile.ZipFile(path) as archive:
        metadata = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
        if len(metadata) != 1 or any(".data/" in name for name in archive.namelist()):
            raise PortableBuildError(f"Unsupported wheel layout: {path.name}")
        if archive.getinfo(metadata[0]).file_size > 500_000:
            raise PortableBuildError("Wheel metadata exceeds portable packaging limits.")
        return BytesParser().parsebytes(archive.read(metadata[0]))


def check_dependencies(wheel, downloaded, lock):
    metas = [wheel_metadata(wheel)]
    for path, expected in zip(downloaded, lock["wheels"], strict=True):
        metadata = wheel_metadata(path)
        _, _, _, tags = parse_wheel_filename(path.name)
        if (canonicalize_name(metadata["Name"]) != canonicalize_name(expected["name"]) or metadata["Version"] != expected["version"]
                or not any(str(tag) in {"py3-none-any", "cp314-cp314-win_amd64"} for tag in tags)):
            raise PortableBuildError(f"Pinned wheel identity or ABI mismatch: {path.name}")
        metas.append(metadata)
    versions = {canonicalize_name(meta["Name"]): meta["Version"] for meta in metas}
    if len(versions) != len(metas) or canonicalize_name(metas[0]["Name"]) != "flowdesk":
        raise PortableBuildError("Expected one PlanBranch flowdesk wheel and distinct runtime dependencies.")
    environment = {**default_environment(), "sys_platform": "win32", "platform_system": "Windows", "os_name": "nt",
                   "platform_machine": "AMD64", "python_version": "3.14", "python_full_version": "3.14.7", "extra": ""}
    used = {"flowdesk"}
    for meta in metas:
        if "3.14.7" not in SpecifierSet(meta.get("Requires-Python", "")):
            raise PortableBuildError(f"Runtime Python version is incompatible with {meta['Name']}.")
        for text in meta.get_all("Requires-Dist", []):
            requirement = Requirement(text)
            if requirement.marker and not requirement.marker.evaluate(environment):
                continue
            name = canonicalize_name(requirement.name)
            if requirement.url or requirement.extras or name not in versions or versions[name] not in requirement.specifier:
                raise PortableBuildError(f"Runtime dependency is missing or incompatible: {text}")
            used.add(name)
    if used != set(versions):
        raise PortableBuildError("Portable lock includes unused runtime packages.")
    return metas[0]["Version"]


def frontend_notices(frontend):
    frontend = plain_path(frontend)
    # Isolated checkouts may intentionally share node_modules through a
    # junction. This input is read-only; containment is checked after resolve.
    dependency_root = (frontend / "node_modules").resolve(strict=True)
    lock = json.loads((frontend / "package-lock.json").read_text(encoding="utf-8"))
    notices = []
    for name, value in sorted(lock["packages"].items()):
        if not name or value.get("dev") or value.get("optional"):
            continue
        directory = (frontend / name).resolve(strict=True)
        if not directory.is_relative_to(dependency_root):
            raise PortableBuildError("Unexpected frontend dependency path.")
        licenses = sorted(file for file in directory.iterdir() if file.is_file() and file.name.lower().startswith(("license", "copying", "notice")))
        if not licenses:
            raise PortableBuildError(f"Frontend license is missing for {name}. Run npm ci before packaging.")
        for file in licenses:
            if not file.resolve(strict=True).is_relative_to(dependency_root) or file.stat().st_size > 1_000_000:
                raise PortableBuildError("Frontend license escapes the dependency input or is oversized.")
            notices.append(f"{name} {value['version']} â€” {file.name}\n" + file.read_text(encoding="utf-8"))
    return "\n\n".join(notices)


def build_portable(wheel, *, output_dir=ROOT / "dist", cache_dir=ROOT / "output" / "portable-downloads", offline=False,
                   lock_path=LOCK, frontend=ROOT / "frontend", license_path=ROOT / "LICENSE"):
    wheel, output, cache = plain_path(wheel), plain_path(output_dir), plain_path(cache_dir)
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    lock = load_lock(lock_path)
    runtime = cached_artifact(lock["python"], cache, offline)
    wheels = [cached_artifact(item, cache, offline) for item in lock["wheels"]]
    version = check_dependencies(wheel, wheels, lock)
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[a-z0-9.]+)?", version):
        raise PortableBuildError("Application version cannot be used as a portable filename.")
    notices = frontend_notices(frontend)
    archive_name = f"PlanBranch-{version}-windows-x64.zip"
    destination = plain_path(output / archive_name)
    receipt_path = plain_path(output / (archive_name + ".json"))
    staging = Path(tempfile.mkdtemp(prefix=".portable-build-", dir=output))
    try:
        bundle = staging / f"PlanBranch-{version}"
        safe_extract(runtime, bundle / "runtime")
        if not all((bundle / "runtime" / name).is_file() for name in RUNTIME_REQUIRED):
            raise PortableBuildError("The pinned Python runtime is missing required executables, DLLs or licenses.")
        (bundle / "runtime" / "python314._pth").write_text(PTH, encoding="utf-8", newline="\n")
        for dependency in [wheel, *wheels]:
            safe_extract(dependency, bundle / "app")
        if not all((bundle / "app" / name).is_file() for name in APP_REQUIRED):
            raise PortableBuildError("The application wheel is missing built frontend or worker resources.")
        if not list((bundle / "app" / "flowdesk" / "migrations").glob("[0-9]*.sql")):
            raise PortableBuildError("The application wheel has no database migrations.")
        for alias in ("planbranch.cmd", "flowdesk.cmd"):
            (bundle / alias).write_bytes(LAUNCHER.encode("ascii"))
        (bundle / "LICENSE.txt").write_bytes(Path(license_path).read_bytes())
        (bundle / "THIRD_PARTY_NOTICES.txt").write_text("Python's license is runtime/LICENSE.txt. Python dependency licenses are retained in app/*dist-info/.\n\nFrontend dependency notices:\n\n" + notices, encoding="utf-8", newline="\n")
        (bundle / "START_HERE.txt").write_text(f"""PlanBranch {version} â€” Windows x64 portable

Extract the entire ZIP to a folder you can write to. Run planbranch.cmd (flowdesk.cmd is the compatible alias).
Open the printed http://127.0.0.1:4310 address in your browser. Keep the terminal open; Ctrl+C stops the server.
Python and the built interface are included. Node, pip, an installer and administrator access are unnecessary.
Requires Windows 10 or newer, x64. No registry settings, services or system PATH entries are added.

If port 4310 is busy: planbranch.cmd --port 4311
For separate data: planbranch.cmd --data-dir "C:\\path\\to\\data"
Default data stays in %LOCALAPPDATA%\\FlowDesk, outside this application folder.
Make a consistent database backup: planbranch.cmd backup (include the same --data-dir if customized).
For execution recovery, stop the server and copy the entire data directory and your repositories as well.

To upgrade: stop PlanBranch, back up your data, extract the new release into a NEW folder, then launch it
with the same data directory. Database migrations run at startup; do not run two versions against that data.
Do not overwrite an open runtime or downgrade a migrated database. Keep the backup until the upgrade is checked.
To uninstall: stop the server and remove the extracted application folder. Your saved data is retained.
Delete data only deliberately after preserving any projects, backups and execution worktrees you need.

Manual planning works without a model. Settings > Agent supports local Ollama, OpenAI/Anthropic/Gemini
API connections, and optional Codex CLI sign-in. API keys stay in the server environment; no credentials
are bundled. Install runtimes/models separately. Git is required for coding. Ollama/API commands require
a local Docker Linux engine and an already prepared image selected with PLANBRANCH_EXECUTION_IMAGE.
Without that runtime, constrained file editing remains available and tests are marked not run. Codex
uses its own separate sandbox setup. Plan approval never starts coding or accepts a diff automatically.
Provider guide: https://github.com/AdrianIp0204/PlanBranch/blob/main/docs/Providers.md

Source and full documentation: https://github.com/AdrianIp0204/PlanBranch
""", encoding="utf-8", newline="\n")
        inputs = [{"filename": wheel.name, "sha256": sha256(wheel)}, lock["python"], *lock["wheels"]]
        files = {str(file.relative_to(bundle)).replace("\\", "/"): sha256(file) for file in sorted(bundle.rglob("*")) if file.is_file()}
        manifest = {"schemaVersion": 1, "product": "PlanBranch", "version": version, "platform": "windows-x64",
                    "pythonVersion": lock["python"]["version"], "inputs": inputs, "files": files}
        (bundle / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        temporary_zip = staging / archive_name
        with zipfile.ZipFile(temporary_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for file in sorted(bundle.rglob("*")):
                if file.is_file():
                    info = zipfile.ZipInfo(file.relative_to(staging).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = (stat.S_IFREG | 0o644) << 16
                    archive.writestr(info, file.read_bytes())
        receipt = {"archive": str(destination), "sha256": sha256(temporary_zip), "size": temporary_zip.stat().st_size,
                   "root": bundle.name, "version": version, "pythonVersion": lock["python"]["version"], "fileCount": len(files) + 1}
        temporary_zip.replace(destination)
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8", newline="\n")
        return receipt
    finally:
        remove_staging(staging, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    version = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    parser.add_argument("--wheel", type=Path, default=ROOT / "dist" / f"flowdesk-{version}-py3-none-any.whl")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    parser.add_argument("--cache-dir", type=Path, default=ROOT / "output" / "portable-downloads")
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(build_portable(args.wheel, output_dir=args.output_dir, cache_dir=args.cache_dir, offline=args.offline), indent=2))
    except (PortableBuildError, OSError, ValueError, zipfile.BadZipFile) as exc:
        print(f"Portable build failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
