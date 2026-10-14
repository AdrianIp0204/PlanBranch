"""Bind final distribution bytes to their source commit; never calls a provider."""
import argparse
import ast
from email.parser import BytesParser
import hashlib
import json
from pathlib import Path
import subprocess
import re
import tomllib
import zipfile

GATES = ["ubuntu-tests-and-installed-wheel-browser", "windows-tests-and-installed-wheel-browser",
         "windows-standalone-portable-smoke", "ubuntu-real-docker-isolation-and-verification"]


def release_metadata(root):
    root = Path(root)
    version = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Release version must be a concrete major.minor.patch version.")
    module = ast.parse((root / "flowdesk/__init__.py").read_text(encoding="utf-8"))
    values = [ast.literal_eval(node.value) for node in module.body if isinstance(node, ast.Assign)
              and any(isinstance(target, ast.Name) and target.id == "__version__" for target in node.targets)]
    notes = root / "docs" / f"Release_{version}.md"
    if values != [version] or not notes.is_file():
        raise ValueError("Package version, module version and versioned release notes must agree.")
    data = notes.read_bytes()
    if not data.decode("utf-8").startswith(f"# PlanBranch {version} "):
        raise ValueError("Release notes heading does not match the package version.")
    return {"version": version, "wheel": f"flowdesk-{version}-py3-none-any.whl",
            "portable": f"PlanBranch-{version}-windows-x64.zip", "notes": notes.relative_to(root).as_posix(),
            "notesSha256": hashlib.sha256(data).hexdigest()}


def verify_bundle(directory, *, commit=None, checks_run=None, attempt=None, repository=None, tested=False):
    directory = Path(directory)
    manifest = json.loads((directory / "release-manifest.json").read_text(encoding="utf-8"))
    version = manifest.get("version", "")
    if (manifest.get("schemaVersion") != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", version)
            or manifest.get("stage") not in {"built", "tested"}):
        raise ValueError("Unsupported release receipt or version.")
    for key, expected in (("commit", commit), ("checksRun", checks_run), ("runAttempt", attempt), ("repository", repository)):
        if expected is not None and manifest.get(key) != str(expected):
            raise ValueError(f"Release receipt {key} does not match the tested request.")
    if tested and (manifest["stage"] != "tested" or manifest.get("gates") != GATES or
                   not re.fullmatch(r"[1-9]\d*", str(manifest.get("candidateArtifactId", "")))):
        raise ValueError("Only a fully tested immutable candidate can be released.")
    names = [f"flowdesk-{version}-py3-none-any.whl", f"PlanBranch-{version}-windows-x64.zip"]
    artifacts = manifest.get("artifacts", [])
    if not isinstance(artifacts, list) or [item.get("name") for item in artifacts] != names:
        raise ValueError("Receipt artifact names must match this exact package version.")
    if {item.name for item in directory.iterdir()} != set(names) | {"release-manifest.json", "SHA256SUMS.txt"}:
        raise ValueError("The release bundle must contain exactly its four declared files.")
    for item in artifacts:
        path = directory / item["name"]
        if path.is_symlink() or path.is_junction() or not path.is_file():
            raise ValueError("Release assets must be ordinary files.")
        with path.open("rb") as stream:
            sha = hashlib.file_digest(stream, "sha256").hexdigest()
        if sha != item.get("sha256") or path.stat().st_size != item.get("bytes"):
            raise ValueError(f"Tested release bytes changed: {path.name}")
    sums = "".join(f"{item['sha256']}  {item['name']}\n" for item in artifacts)
    if (directory / "SHA256SUMS.txt").read_text(encoding="utf-8") != sums:
        raise ValueError("Release checksums do not match the receipt.")
    return manifest


def seal_bundle(directory, *, commit, checks_run, attempt, repository, candidate_artifact_id):
    manifest = verify_bundle(directory, commit=commit, checks_run=checks_run, attempt=attempt, repository=repository)
    if manifest["stage"] != "built" or not re.fullmatch(r"[1-9]\d*", str(candidate_artifact_id)):
        raise ValueError("Seal only the immutable build artifact after every required gate succeeds.")
    manifest.update(stage="tested", gates=GATES, candidateArtifactId=str(candidate_artifact_id))
    (Path(directory) / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def _members(archive):
    members = [item.filename for item in archive.infolist() if not item.is_dir()]
    if len(members) != len(set(members)):
        raise ValueError("Release archives must not contain duplicate members.")
    return set(members)


def audit_artifacts(root, commit, version, git_bytes):
    """Verify package bytes against HEAD and the explicitly built UI output.

    This does not run tests. CI builds once, tests these frozen bytes on both
    platforms, then seals a separate receipt only after every required gate.
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
        metadata_name = f"flowdesk-{version}.dist-info/METADATA"
        if {name for name in wheel_members if name.endswith(".dist-info/METADATA")} != {metadata_name}:
            raise ValueError("Wheel distribution metadata does not match this release version.")
        package = BytesParser().parsebytes(wheel.read(metadata_name))
        if package.get_all("Name") != ["flowdesk"] or package.get_all("Version") != [version]:
            raise ValueError("Wheel distribution metadata contains a mixed package version.")
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


def receipt(root, checks_run=None, *, attempt=None, repository=None):
    root = Path(root).resolve()
    def git_bytes(*args):
        return subprocess.check_output(["git", "-c", f"safe.directory={root.as_posix()}", "-C", str(root), *args])
    def git(*args):
        return git_bytes(*args).decode("utf-8").strip()
    commit = git("rev-parse", "HEAD")
    if git("status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("Commit the release source and rerun its gates before recording artifacts.")
    metadata = release_metadata(root)
    version = metadata["version"]
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
    result = {"schemaVersion": 2, "version": version, "commit": commit, "checksRun": checks_run, "byteAudit": audit,
              "repository": repository, "runAttempt": attempt, "stage": "built", "gates": [],
              "releaseNotes": {"path": metadata["notes"], "sha256": metadata["notesSha256"]},
              "artifacts": artifacts, "note": "Checksums establish byte identity. They do not replace the recorded tests or authenticate a third-party copy."}
    (root / "dist" / "release-manifest.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    (root / "dist" / "SHA256SUMS.txt").write_text("".join(f"{item['sha256']}  {item['name']}\n" for item in artifacts), encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["build", "verify", "seal", "metadata"], nargs="?", default="build")
    parser.add_argument("--checks-run")
    parser.add_argument("--attempt")
    parser.add_argument("--repository")
    parser.add_argument("--commit")
    parser.add_argument("--candidate-artifact-id")
    parser.add_argument("--directory", type=Path, default=Path("dist"))
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if args.action == "metadata":
        result = release_metadata(root)
        if args.github_output:
            with args.github_output.open("a", encoding="utf-8") as stream:
                stream.write("".join(f"{key}={value}\n" for key, value in result.items()))
    elif args.action == "build":
        result = receipt(root, args.checks_run, attempt=args.attempt, repository=args.repository)
    else:
        options = dict(commit=args.commit, checks_run=args.checks_run, attempt=args.attempt, repository=args.repository)
        if not all(options.values()):
            parser.error("verify/seal require commit, checks run, attempt and repository")
        result = (seal_bundle(args.directory, **options, candidate_artifact_id=args.candidate_artifact_id)
                  if args.action == "seal" else verify_bundle(args.directory, **options))
    print(json.dumps(result, indent=2))
