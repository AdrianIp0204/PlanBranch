"""Bind final distribution bytes to their source commit; never calls a provider."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tomllib
import zipfile


def _members(archive):
    members = [item.filename for item in archive.infolist() if not item.is_dir()]
    if len(members) != len(set(members)):
        raise ValueError("Release archives must not contain duplicate members.")
    return set(members)


def audit_artifacts(root, commit, version, git_bytes):
    """Verify package bytes against HEAD and the explicitly built UI output.

    This does not run tests or prove that frontend/dist was rebuilt. The release
    workflow builds it after checking out the exact successful checks commit.
    """
    names = git_bytes("ls-tree", "-r", "--name-only", "-z", commit, "flowdesk").decode("utf-8").split("\0")
    sources = [name for name in names if name.endswith(".py") or
               (name.startswith("flowdesk/migrations/") and name.endswith(".sql")) or
               (name.startswith("flowdesk/prompts/") and name.endswith(".md"))]
    expected = {name: git_bytes("show", f"{commit}:{name}") for name in sources}
    frontend = root / "frontend" / "dist"
    if not (frontend / "index.html").is_file():
        raise ValueError("Build the frontend before auditing release artifacts.")
    for path in frontend.rglob("*"):
        if path.is_file():
            expected["flowdesk/static/" + path.relative_to(frontend).as_posix()] = path.read_bytes()
    wheel_path = root / "dist" / f"flowdesk-{version}-py3-none-any.whl"
    portable_path = root / "dist" / f"PlanBranch-{version}-windows-x64.zip"
    with zipfile.ZipFile(wheel_path) as wheel:
        wheel_members = _members(wheel)
        application = {name for name in wheel_members if name.startswith("flowdesk/")}
        if application != set(expected):
            raise ValueError("Wheel application files differ from committed source and frontend build output.")
        for name, data in expected.items():
            if wheel.read(name) != data:
                raise ValueError(f"Wheel has stale or changed application bytes: {name}")
        prefix = f"PlanBranch-{version}/"
        with zipfile.ZipFile(portable_path) as portable:
            portable_members = _members(portable)
            manifest = json.loads(portable.read(prefix + "manifest.json"))
            if manifest.get("schemaVersion") != 1 or manifest.get("version") != version or manifest.get("platform") != "windows-x64":
                raise ValueError("Portable package manifest identity does not match this release.")
            wheel_hash = hashlib.sha256(wheel_path.read_bytes()).hexdigest()
            if not any(item.get("filename") == wheel_path.name and item.get("sha256") == wheel_hash for item in manifest.get("inputs", [])):
                raise ValueError("Portable package was not built from this release wheel.")
            files = manifest.get("files", {})
            if not isinstance(files, dict) or {prefix + name for name in files} | {prefix + "manifest.json"} != portable_members:
                raise ValueError("Portable manifest does not cover the exact archived files.")
            for name, sha in files.items():
                if hashlib.sha256(portable.read(prefix + name)).hexdigest() != sha:
                    raise ValueError(f"Portable package checksum mismatch: {name}")
            for name in wheel_members:
                if prefix + "app/" + name not in portable_members or portable.read(prefix + "app/" + name) != wheel.read(name):
                    raise ValueError(f"Portable package differs from its declared wheel: {name}")
            if {name.removeprefix(prefix + "app/") for name in portable_members if name.startswith(prefix + "app/flowdesk/")} != application:
                raise ValueError("Portable package contains unexpected application files.")
    return {"applicationFiles": len(expected), "portableFiles": len(portable_members),
            "source": "HEAD", "frontend": "current frontend/dist build output"}


def receipt(root, checks_run=None):
    root = Path(root).resolve()
    def git_bytes(*args):
        return subprocess.check_output(["git", "-c", f"safe.directory={root.as_posix()}", "-C", str(root), *args])
    def git(*args):
        return git_bytes(*args).decode("utf-8").strip()
    commit = git("rev-parse", "HEAD")
    if git("status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("Commit the release source and rerun its gates before recording artifacts.")
    version = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    audit = audit_artifacts(root, commit, version, git_bytes)
    names = [f"flowdesk-{version}-py3-none-any.whl", f"PlanBranch-{version}-windows-x64.zip"]
    artifacts = []
    for name in names:
        path = root / "dist" / name
        with path.open("rb") as stream:
            sha = hashlib.file_digest(stream, "sha256").hexdigest()
        artifacts.append({"name": name, "sha256": sha, "bytes": path.stat().st_size})
    if git("rev-parse", "HEAD") != commit or git("status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("Release source changed during the artifact audit. Rebuild and rerun the gates.")
    result = {"schemaVersion": 1, "version": version, "commit": commit, "checksRun": checks_run, "byteAudit": audit,
              "artifacts": artifacts, "note": "Checksums establish byte identity. They do not replace the recorded tests or authenticate a third-party copy."}
    (root / "dist" / "release-manifest.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    (root / "dist" / "SHA256SUMS.txt").write_text("".join(f"{item['sha256']}  {item['name']}\n" for item in artifacts), encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checks-run")
    args = parser.parse_args()
    print(json.dumps(receipt(Path(__file__).resolve().parents[1], args.checks_run), indent=2))
