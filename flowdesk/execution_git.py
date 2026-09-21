"""Explicit, bounded Git workspaces and reviewed checkout application.

Git never runs repository checkout hooks, filters, textconv or diff helpers here.
The original index is never changed. All generated work is retained for recovery.
"""
from __future__ import annotations

import base64
from copy import deepcopy
from datetime import datetime, timezone
import difflib
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
import threading
from uuid import UUID, uuid4

MAX_FILES = 5000
MAX_TREE_BYTES = 128 * 1024 * 1024
MAX_CHANGED_FILES = 512
MAX_CHANGED_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 2 * 1024 * 1024
_HEX = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
_RESERVED = re.compile(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?\Z", re.I)


class WorkspaceError(ValueError):
    pass


def _encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _hash(value):
    return hashlib.sha256(value).hexdigest()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _plain(path):
    return not path.is_symlink() and not path.is_junction()


def _relative(name):
    if not isinstance(name, str) or not name or len(name) > 2000:
        raise WorkspaceError("A repository filename is unsupported or too long.")
    path = PurePosixPath(name)
    parts = name.split("/")
    if (path.is_absolute() or any(p in {"", ".", ".."} for p in parts)
            or any(p.casefold() == ".git" for p in parts)
            or any(any(ord(c) < 32 or c in '<>:"\\|?*' for c in p) or p[-1] in " ."
                   or _RESERVED.fullmatch(p) for p in parts)):
        raise WorkspaceError("This repository contains a filename that cannot be safely used in a portable worktree.")
    return name


def _checked(root, name, *, allow_absent=True):
    name = _relative(name)
    candidate = root.joinpath(*name.split("/"))
    current = root
    if not _plain(root) or not root.is_dir():
        raise WorkspaceError("The workspace directory has moved or become a link.")
    for part in name.split("/"):
        current = current / part
        if not _plain(current):
            raise WorkspaceError("Symbolic links and junctions are not supported for coding work.")
    if not candidate.resolve().is_relative_to(root.resolve()):
        raise WorkspaceError("A changed file points outside its workspace.")
    if candidate.exists() and not candidate.is_file():
        raise WorkspaceError("A changed file was replaced by a directory or special file.")
    if not allow_absent and not candidate.is_file():
        raise WorkspaceError("A required workspace file is missing.")
    return candidate


def _read(path, limit=MAX_FILE_BYTES):
    if not _plain(path) or not path.is_file():
        raise WorkspaceError("Only ordinary files can be reviewed or applied.")
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise WorkspaceError(f"A changed file exceeds the {limit // 1024 // 1024} MiB review limit. Work has been preserved.")
    return data


def _atomic_json(path, value):
    if not _plain(path) or not _plain(path.parent):
        raise WorkspaceError("The execution record path has become a link.")
    temporary = path.with_name(f".tmp-{uuid4().hex[:12]}")
    try:
        with temporary.open("xb") as stream:
            stream.write(_encode(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.is_file() and _plain(temporary):
            temporary.unlink()


def _text(data):
    if data is None:
        return ""
    if b"\0" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeError:
        return None


def _mode(path, original=None):
    if os.name == "nt":
        return original or "100644"
    return "100755" if path.stat().st_mode & stat.S_IXUSR else "100644"


def _b64(data):
    return None if data is None else base64.b64encode(data).decode("ascii")


def _un64(value):
    return None if value is None else base64.b64decode(value, validate=True)


def _crlf_checkout(current, before):
    return (current is not None and before is not None and _text(before) is not None
            and b"\r\n" in current and current.replace(b"\r\n", b"\n") == before.replace(b"\r\n", b"\n")
            and b"\r" not in current.replace(b"\r\n", b"")
            and b"\n" not in current.replace(b"\r\n", b""))


def _validate_apply_journal(journal, artifact, digest):
    """Recovery can only write the exact reviewed artifact, with recorded CRLFs."""
    try:
        files = {file["path"]: file for file in artifact["files"]}
        if (not isinstance(journal, dict) or journal["digest"] != digest
                or journal["state"] not in {"prepared", "applying", "applied"}
                or not isinstance(journal["entries"], list)
                or not isinstance(journal["completed"], list)
                or journal["fileCount"] != len(files)):
            raise ValueError
        paths = [item["path"] for item in journal["entries"]]
        completed = journal["completed"]
        if (len(paths) != len(files) or set(paths) != set(files)
                or len(completed) != len(set(completed)) or not set(completed).issubset(files)
                or (journal["state"] == "applied" and set(completed) != set(files))):
            raise ValueError
        for item in journal["entries"]:
            file = files[item["path"]]
            original_before, original_after = _un64(file["before"]), _un64(file["after"])
            before, after = _un64(item["before"]), _un64(item["after"])
            crlf = _crlf_checkout(before, original_before)
            if before != original_before and not crlf:
                raise ValueError
            expected_after = original_after
            if crlf and expected_after is not None and _text(expected_after) is not None:
                expected_after = expected_after.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            if after != expected_after:
                raise ValueError
            # Upgrade earlier journals using the immutable artifact; never infer
            # a missing baseline mode from the potentially modified checkout.
            item.setdefault("beforeMode", file["oldMode"])
            item.setdefault("afterMode", item.get("mode", file["newMode"]))
            if (item["beforeMode"] != file["oldMode"] or item["afterMode"] != file["newMode"]
                    or item.get("mode", file["newMode"]) != file["newMode"]):
                raise ValueError
            if "beforePermissions" in item or "afterPermissions" in item:
                permissions = item["beforePermissions"]
                if before is None:
                    if permissions is not None:
                        raise ValueError
                elif (type(permissions) is not int or not 0 <= permissions <= 0o7777
                        or ("100755" if permissions & stat.S_IXUSR else "100644") != file["oldMode"]):
                    raise ValueError
                expected_permissions = (permissions & 0o777) if permissions is not None else 0o644
                if file["newMode"] == "100755":
                    expected_permissions |= (expected_permissions & 0o444) >> 2
                else:
                    expected_permissions &= ~0o111
                if item["afterPermissions"] != (expected_permissions if after is not None else None):
                    raise ValueError
        return journal
    except (KeyError, TypeError, ValueError):
        raise WorkspaceError("The apply recovery record does not match the accepted result. Its files have been preserved.") from None


class GitWorkspace:
    def __init__(self, data_dir):
        self.root = Path(data_dir).resolve() / "execution"
        if self.root.exists() and (not _plain(self.root) or not self.root.is_dir()):
            raise WorkspaceError("The execution data directory must be an ordinary directory.")
        self.root.mkdir(parents=True, exist_ok=True)
        self._apply_lock = threading.Lock()

    def _run_dir(self, run_id, *, create=False):
        try:
            if str(UUID(run_id)) != run_id:
                raise ValueError
        except (ValueError, TypeError, AttributeError):
            raise WorkspaceError("Invalid execution workspace identity.") from None
        directory = self.root / run_id
        if not _plain(self.root) or not _plain(directory) or directory.resolve() != directory:
            raise WorkspaceError("The execution directory has moved or become a link.")
        if create:
            directory.mkdir(exist_ok=True)
        return directory

    def _git(self, root, args, *, input=None, limit=8 * 1024 * 1024, timeout=30):
        executable = shutil.which("git")
        if not executable:
            raise WorkspaceError("Install Git before selecting an execution repository.")
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith("GIT_")}
        env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull,
                   GIT_TERMINAL_PROMPT="0", GIT_NO_LAZY_FETCH="1", GIT_NO_REPLACE_OBJECTS="1", GIT_OPTIONAL_LOCKS="0")
        command = [executable, "--no-pager", "--literal-pathspecs", "-c", f"safe.directory={root}",
                   "-c", "core.hooksPath=" + str(self.root / "no-hooks"), "-c", "core.fsmonitor=false",
                   "-c", "core.untrackedCache=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
                   "-c", "protocol.allow=never", "-C", str(root), *args]
        try:
            with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
                result = subprocess.run(command, input=input, stdout=output, stderr=errors, env=env,
                                        shell=False, timeout=timeout,
                                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
                if result.returncode:
                    raise WorkspaceError("Git could not complete the local operation. Check that this repository has a commit and its files are available locally.")
                if output.tell() > limit:
                    raise WorkspaceError("The repository exceeds the bounded execution review limit.")
                output.seek(0)
                return output.read(limit + 1)
        except subprocess.TimeoutExpired:
            raise WorkspaceError("The local Git operation timed out. No coding agent was restarted.") from None
        except OSError:
            raise WorkspaceError("Git could not start. Check its installation and folder permissions.") from None

    def inspect_repository(self, path, *, include_dirty=True):
        if not isinstance(path, (str, Path)) or not str(path).strip():
            raise WorkspaceError("Choose an existing local Git repository.")
        if not Path(path).is_absolute():
            raise WorkspaceError("Choose the full path of the repository folder.")
        original = Path(path).absolute()
        if not original.is_absolute() or not original.is_dir() or not _plain(original):
            raise WorkspaceError("Choose an existing ordinary repository directory.")
        root = original.resolve()
        if root == self.root or root.is_relative_to(self.root):
            raise WorkspaceError("Select your source repository, not a generated execution worktree.")
        try:
            top = Path(self._git(root, ["rev-parse", "--show-toplevel"]).decode("utf-8").strip()).resolve()
            if top != root:
                raise WorkspaceError("Select the repository's top-level folder, not a subfolder.")
            head = self._git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).decode("ascii").strip()
            git_dir = self._git(root, ["rev-parse", "--absolute-git-dir"]).decode("utf-8").strip()
            common = self._git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).decode("utf-8").strip()
            dirty = self._dirty(root, head) if include_dirty else None
        except UnicodeError:
            raise WorkspaceError("The repository path cannot be decoded as UTF-8.") from None
        if not _HEX.fullmatch(head):
            raise WorkspaceError("The repository has an unsupported commit identity.")
        return {"path": str(root), "gitDir": str(Path(git_dir).resolve()), "commonDir": str(Path(common).resolve()), "head": head, "dirty": dirty}

    def repository_identity(self, path):
        """Read source identity for polling without reading the checkout's files."""
        return self.inspect_repository(path, include_dirty=False)

    def _dirty(self, root, commit):
        # `git status` may execute repository clean/process filters. Compare raw
        # objects ourselves instead, leaving hooks, filters and the index alone.
        tree, index = self._tree(root, commit), self._index(root)
        if set(tree) != set(index):
            return True
        for name, entry in tree.items():
            indexed = index[name]
            if indexed["stage"] != "0" or any(indexed[key] != entry[key] for key in ("mode", "oid")):
                return True
            path = _checked(root, name)
            if not path.exists() or _mode(path, entry["mode"]) != entry["mode"]:
                return True
            if path.stat().st_size > MAX_TREE_BYTES:
                return True
            data = _read(path, MAX_TREE_BYTES)
            algorithm = hashlib.sha1 if len(entry["oid"]) == 40 else hashlib.sha256
            def oid(value):
                return algorithm(b"blob " + str(len(value)).encode() + b"\0" + value).hexdigest()
            if oid(data) != entry["oid"] and not (b"\r\n" in data and oid(data.replace(b"\r\n", b"\n")) == entry["oid"]):
                return True
        return bool(self._git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))

    def _tree(self, root, commit):
        if not isinstance(commit, str) or not _HEX.fullmatch(commit):
            raise WorkspaceError("Invalid source commit.")
        rows = self._git(root, ["ls-tree", "-r", "-l", "-z", commit])
        tree, folded, total = {}, set(), 0
        for row in rows.split(b"\0"):
            if not row:
                continue
            try:
                header, name = row.split(b"\t", 1)
                mode, kind, oid, size = header.split()
                name = _relative(name.decode("utf-8"))
                if kind != b"blob" or mode not in {b"100644", b"100755"}:
                    raise WorkspaceError("Execution repositories cannot contain symbolic links or submodules in this release.")
                length = int(size)
            except (UnicodeError, ValueError):
                raise WorkspaceError("The repository has an unsupported tree entry.") from None
            if name.casefold() in folded:
                raise WorkspaceError("The repository contains filenames that collide on Windows.")
            folded.add(name.casefold())
            tree[name] = {"mode": mode.decode(), "oid": oid.decode(), "size": length}
            total += length
            if len(tree) > MAX_FILES or total > MAX_TREE_BYTES:
                raise WorkspaceError("Execution supports at most 5,000 tracked files and 128 MiB per source snapshot.")
        return tree

    def _blobs(self, root, entries):
        if not entries:
            return {}
        unique = {entry["oid"]: entry["size"] for entry in entries}
        expected = sum(unique.values())
        raw = self._git(root, ["cat-file", "--batch"], input=("\n".join(unique) + "\n").encode(),
                        limit=expected + len(unique) * 128, timeout=60)
        stream, blobs = io.BytesIO(raw), {}
        for oid, expected_size in unique.items():
            header = stream.readline(200).split()
            if header != [oid.encode(), b"blob", str(expected_size).encode()]:
                raise WorkspaceError("A source object is missing or changed. Fetch it yourself before running a task.")
            data = stream.read(expected_size)
            if len(data) != expected_size or stream.read(1) != b"\n":
                raise WorkspaceError("Git returned an incomplete source snapshot.")
            blobs[oid] = data
        if stream.read(1):
            raise WorkspaceError("Git returned extra source data.")
        return blobs

    def create(self, repository, source_commit, run_id):
        source = self.inspect_repository(repository["path"])
        if any(source[key] != repository[key] for key in ("path", "gitDir", "commonDir")) or source["head"] != source_commit:
            raise WorkspaceError("The selected source revision changed. Review a new run preview.")
        tree = self._tree(Path(source["path"]), source_commit)
        blobs = self._blobs(Path(source["path"]), list(tree.values()))
        directory = self._run_dir(run_id, create=True)
        worktree = directory / "worktree"
        if worktree.exists() or (directory / "workspace.json").exists():
            raise WorkspaceError("This execution already has a workspace. Review the existing run; it will not restart automatically.")
        # Registration deliberately excludes checkout: no hooks, smudge filters,
        # LFS download or repository-configured programs execute in the host.
        self._git(Path(source["path"]), ["worktree", "add", "--no-checkout", "--detach", "--lock", "--reason", "PlanBranch execution recovery", str(worktree), source_commit])
        self._git(worktree, ["read-tree", source_commit])
        for name, entry in tree.items():
            target = _checked(worktree, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            data = blobs[entry["oid"]]
            with target.open("xb") as stream:
                stream.write(data)
            if os.name != "nt":
                target.chmod(0o755 if entry["mode"] == "100755" else 0o644)
            entry["hash"] = _hash(data)
        pointer = _read(worktree / ".git", 8192).decode("utf-8")
        record = {"id": run_id, "path": str(worktree), "repository": source, "sourceCommit": source_commit,
                  "gitPointer": pointer, "baseline": tree, "createdAt": _now()}
        _atomic_json(directory / "workspace.json", record)
        return {key: record[key] for key in ("id", "path", "repository", "sourceCommit", "createdAt")}

    def load(self, run_id):
        path = self._run_dir(run_id) / "workspace.json"
        if not path.exists():
            return None
        record = json.loads(_read(path, 4 * 1024 * 1024))
        if record.get("id") != run_id or record.get("path") != str(path.parent / "worktree"):
            raise WorkspaceError("The saved execution workspace identity is invalid.")
        return {key: record[key] for key in ("id", "path", "repository", "sourceCommit", "createdAt")}

    def _workspace(self, workspace):
        public = self.load(workspace["id"])
        if public is None or any(public[key] != workspace[key] for key in ("path", "sourceCommit", "repository")):
            raise WorkspaceError("The execution workspace changed or is unavailable.")
        record = json.loads(_read(self._run_dir(workspace["id"]) / "workspace.json", 4 * 1024 * 1024))
        worktree = Path(record["path"])
        if not _plain(worktree) or not worktree.is_dir() or _read(worktree / ".git", 8192).decode("utf-8") != record["gitPointer"]:
            raise WorkspaceError("The execution worktree's Git pointer changed. Automatic review and application are disabled.")
        if self._git(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]).decode().strip() != record["sourceCommit"]:
            raise WorkspaceError("The execution worktree's source revision changed. Its files have been preserved.")
        return record

    def capture(self, workspace):
        record = self._workspace(workspace)
        root, baseline = Path(record["path"]), record["baseline"]
        listed = self._git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        try:
            names = set(baseline) | {_relative(value.decode("utf-8")) for value in listed.split(b"\0") if value}
        except UnicodeError:
            raise WorkspaceError("A changed filename is not valid UTF-8.") from None
        if len(names) > MAX_FILES:
            raise WorkspaceError("The workspace contains too many files to review. Work is preserved.")
        changed, total = [], 0
        for name in sorted(names):
            path = _checked(root, name)
            old = baseline.get(name)
            if path.exists() and path.stat().st_size > MAX_FILE_BYTES:
                unchanged = False
                if old and path.stat().st_size == old["size"] and _mode(path, old["mode"]) == old["mode"]:
                    digest = hashlib.sha256()
                    with path.open("rb") as stream:
                        while chunk := stream.read(1024 * 1024):
                            digest.update(chunk)
                    unchanged = digest.hexdigest() == old["hash"]
                if unchanged:
                    continue
                raise WorkspaceError("A changed file exceeds the 2 MiB review limit. Work is preserved.")
            data = _read(path) if path.exists() else None
            mode = _mode(path, old["mode"] if old else None) if data is not None else None
            if old is None and data is None:
                continue
            if old is not None and data is not None and _hash(data) == old["hash"] and mode == old["mode"]:
                continue
            if old and old["size"] > MAX_FILE_BYTES:
                raise WorkspaceError("A changed source file exceeds the 2 MiB review limit. Work is preserved.")
            total += len(data or b"") + (old["size"] if old else 0)
            changed.append((name, old, data, mode))
            if len(changed) > MAX_CHANGED_FILES or total > MAX_CHANGED_BYTES:
                raise WorkspaceError("A review is limited to 512 changed files and 16 MiB of before/after data. Work is preserved.")
        old_blobs = self._blobs(root, [old for _, old, _, _ in changed if old])
        files = []
        for name, old, after, mode in changed:
            before = old_blobs[old["oid"]] if old else None
            left, right = _text(before), _text(after)
            binary = left is None or right is None
            patch = ""
            if not binary:
                patch = "".join(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n"
                    for line in difflib.unified_diff(left.splitlines(keepends=True), right.splitlines(keepends=True),
                        fromfile="a/" + name if before is not None else "/dev/null",
                        tofile="b/" + name if after is not None else "/dev/null"))
            files.append({"path": name, "kind": "added" if old is None else "removed" if after is None else "modified",
                          "binary": binary, "oldSize": len(before or b""), "newSize": len(after or b""),
                          "oldMode": old["mode"] if old else None, "newMode": mode, "patch": patch,
                          "before": _b64(before), "after": _b64(after)})
        artifact = {"version": 1, "sourceCommit": record["sourceCommit"], "files": files}
        digest = _hash(_encode(artifact))
        directory = self._run_dir(record["id"]) / "artifacts"
        if not _plain(directory):
            raise WorkspaceError("The artifact directory has become a link.")
        directory.mkdir(exist_ok=True)
        path = directory / (digest + ".json")
        if not path.exists():
            _atomic_json(path, artifact)
        return self.artifact(record["id"], digest)

    def _artifact(self, run_id, digest):
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise WorkspaceError("Invalid review identity.")
        directory = self._run_dir(run_id) / "artifacts"
        if not _plain(directory):
            raise WorkspaceError("The artifact directory has become a link.")
        raw = _read(directory / (digest + ".json"), 64 * 1024 * 1024)
        value = json.loads(raw)
        if _hash(_encode(value)) != digest:
            raise WorkspaceError("The reviewed artifact changed. Application is disabled.")
        return value

    def artifact(self, run_id, digest):
        artifact = self._artifact(run_id, digest)
        return {"digest": digest, "sourceCommit": artifact["sourceCommit"],
                "files": [{key: value for key, value in file.items() if key not in {"before", "after"}} for file in artifact["files"]]}

    def inspect_apply(self, workspace, digest):
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise WorkspaceError("Invalid review identity.")
        path = self._run_dir(workspace["id"]) / ("apply-" + digest + ".json")
        if not path.exists():
            return None
        value = json.loads(_read(path, 64 * 1024 * 1024))
        return {key: value[key] for key in ("state", "digest", "updatedAt", "completed", "fileCount")}

    def _index(self, root):
        entries = {}
        for row in self._git(root, ["ls-files", "--stage", "-z"]).split(b"\0"):
            if not row:
                continue
            header, name = row.split(b"\t", 1)
            mode, oid, stage = header.split()
            name = name.decode("utf-8")
            entries[name] = {"mode": mode.decode(), "oid": oid.decode(), "stage": stage.decode()}
        return entries

    def apply(self, workspace, digest):
        """Explicit and idempotent; caller must authorize the accepted digest.

        No rollback overwrites new user edits. A partial application is journaled
        and requires another explicit Apply action after any conflict is resolved.
        """
        with self._apply_lock:
            record = self._workspace(workspace)
            artifact = self._artifact(record["id"], digest)
            if artifact["sourceCommit"] != record["sourceCommit"]:
                raise WorkspaceError("The review belongs to another source revision.")
            journal_path = self._run_dir(record["id"]) / ("apply-" + digest + ".json")
            journal = json.loads(_read(journal_path, 64 * 1024 * 1024)) if journal_path.exists() else None
            if journal is not None:
                journal = _validate_apply_journal(journal, artifact, digest)
            if journal and journal["state"] == "applied":
                return {"applied": True, "digest": digest, "files": journal["completed"], "replayed": True}
            repository = self.inspect_repository(record["repository"]["path"])
            if (repository["head"] != record["sourceCommit"] or any(repository[key] != record["repository"][key] for key in ("path", "gitDir", "commonDir"))):
                raise WorkspaceError("The source checkout revision changed. Its files were not overwritten; review or transfer the work manually.")
            root, index = Path(repository["path"]), self._index(Path(repository["path"]))
            for file in artifact["files"]:
                old, indexed = record["baseline"].get(file["path"]), index.get(file["path"])
                if (old is None and indexed is not None) or (old is not None and (indexed is None or indexed["stage"] != "0" or any(indexed[key] != old[key] for key in ("mode", "oid")))):
                    raise WorkspaceError(f"A staged change conflicts with {file['path']}. Resolve it before applying.")
            if journal is None:
                entries = []
                for file in artifact["files"]:
                    target = _checked(root, file["path"])
                    current = _read(target) if target.exists() else None
                    before, after = _un64(file["before"]), _un64(file["after"])
                    current_mode = _mode(target, file["oldMode"]) if current is not None else None
                    if os.name != "nt" and current_mode != file["oldMode"]:
                        raise WorkspaceError(f"An uncommitted mode change conflicts with {file['path']}. Your checkout is unchanged.")
                    crlf = _crlf_checkout(current, before)
                    if current != before and not crlf:
                        raise WorkspaceError(f"An uncommitted change conflicts with {file['path']}. Your checkout is unchanged.")
                    if crlf and after is not None and _text(after) is not None:
                        after = after.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
                    entry = {"path": file["path"], "before": _b64(current), "after": _b64(after),
                             "beforeMode": current_mode, "afterMode": file["newMode"], "mode": file["newMode"]}
                    if os.name != "nt":
                        permissions = stat.S_IMODE(target.stat().st_mode) if current is not None else None
                        # Preserve local read/write permissions; only the reviewed
                        # executable-bit change may alter them.
                        after_permissions = (permissions & 0o777) if permissions is not None else 0o644
                        if file["newMode"] == "100755":
                            after_permissions |= (after_permissions & 0o444) >> 2
                        else:
                            after_permissions &= ~0o111
                        entry.update(beforePermissions=permissions, afterPermissions=after_permissions if after is not None else None)
                    entries.append(entry)
                journal = {"state": "prepared", "digest": digest, "updatedAt": _now(), "completed": [], "fileCount": len(entries), "entries": entries}
                _atomic_json(journal_path, journal)
            def state_of(item):
                target = _checked(root, item["path"])
                data = _read(target) if target.exists() else None
                mode = _mode(target, item["beforeMode"]) if data is not None else None
                permissions = stat.S_IMODE(target.stat().st_mode) if data is not None else None
                return target, data, mode, permissions

            def matches(item, observed, which):
                return (observed[1] == _un64(item[which]) and
                        (os.name == "nt" or (observed[2] == item[which + "Mode"] and
                         (which + "Permissions" not in item or observed[3] == item[which + "Permissions"]))))

            def checked_state(item):
                observed = state_of(item)
                # A completed path can no longer return to its earlier state
                # without a user edit. Never replay over that deliberate change.
                allowed = matches(item, observed, "after") or (
                    item["path"] not in journal["completed"] and matches(item, observed, "before"))
                if not allowed:
                    raise WorkspaceError(f"A newer edit conflicts with {item['path']}. Completed files remain recorded for recovery.")
                return observed

            # Validate the entire affected set before continuing a partial apply.
            for item in journal["entries"]:
                checked_state(item)
            journal["state"] = "applying"
            _atomic_json(journal_path, journal)
            for item in journal["entries"]:
                observed = checked_state(item)
                target, current = observed[:2]
                after = _un64(item["after"])
                if not matches(item, observed, "after"):
                    if after is None:
                        target.unlink()
                    elif current != after:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        # Recheck newly created parents immediately before writing.
                        _checked(root, item["path"])
                        temporary = target.with_name(f".planbranch-{uuid4().hex}.tmp")
                        try:
                            with temporary.open("xb") as stream:
                                stream.write(after)
                                stream.flush()
                                os.fsync(stream.fileno())
                            if os.name != "nt":
                                temporary.chmod(item.get("afterPermissions", 0o755 if item["afterMode"] == "100755" else 0o644))
                            # Preparing/fsyncing the replacement can take time.
                            # Recheck the exact previously observed state before
                            # replacing; this is a bounded check, not OS-level CAS.
                            if state_of(item)[1:] != observed[1:]:
                                raise WorkspaceError(f"The checkout changed while preparing {item['path']}. Its newer contents were preserved.")
                            os.replace(temporary, target)
                        finally:
                            if temporary.is_file() and _plain(temporary):
                                temporary.unlink()
                    elif os.name != "nt":
                        target.chmod(item.get("afterPermissions", 0o755 if item["afterMode"] == "100755" else 0o644))
                if item["path"] not in journal["completed"]:
                    journal["completed"].append(item["path"])
                journal["updatedAt"] = _now()
                _atomic_json(journal_path, journal)
            journal["state"] = "applied"
            journal["updatedAt"] = _now()
            _atomic_json(journal_path, journal)
            return {"applied": True, "digest": digest, "files": journal["completed"], "replayed": False}
