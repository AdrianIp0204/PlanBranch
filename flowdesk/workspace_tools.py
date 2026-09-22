"""Bounded, application-owned file operations inside one prepared worktree."""
from __future__ import annotations

import difflib
import hashlib
import os
from pathlib import Path
import stat
from uuid import uuid4

from .execution_git import (_checked, _plain, _relative, _read, MAX_FILES,
                            MAX_FILE_BYTES, MAX_TREE_BYTES, WorkspaceError)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def snapshot(root):
    root = Path(root)
    if not _plain(root) or not root.is_dir():
        raise WorkspaceError("The worktree must be an ordinary directory.")
    files, total, directories, visited = {}, 0, [root], 0
    while directories:
        directory = directories.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                visited += 1
                if visited > MAX_FILES * 2:
                    raise WorkspaceError("The coding workspace has too many entries.")
                if directory == root and entry.name.casefold() == ".git":
                    continue  # linked-worktree metadata is never exposed to tools
                path = Path(entry.path)
                name = path.relative_to(root).as_posix()
                _relative(name)
                if not _plain(path):
                    raise WorkspaceError("Links and junctions are not available to coding tools.")
                mode = path.stat(follow_symlinks=False)
                if stat.S_ISDIR(mode.st_mode):
                    directories.append(path)
                elif stat.S_ISREG(mode.st_mode) and mode.st_nlink == 1:
                    data = _read(path)
                    total += len(data)
                    files[name] = data
                    if len(files) > MAX_FILES or total > MAX_TREE_BYTES:
                        raise WorkspaceError("The coding workspace exceeds its file or size limit.")
                else:
                    raise WorkspaceError("Hard links and special files are not available to coding tools.")
    return files


def atomic_write(root, name, data, expected):
    path = _checked(Path(root), name)
    existing = _read(path) if path.exists() else None
    if path.exists() and path.stat().st_nlink != 1:
        raise WorkspaceError("Hard links cannot be edited.")
    if (digest(existing) if existing is not None else None) != expected:
        raise WorkspaceError("The file changed since it was read. Read it again before editing.")
    if data is None:
        if existing is None:
            raise WorkspaceError("The file to remove does not exist.")
        path.unlink()
        return
    if len(data) > MAX_FILE_BYTES:
        raise WorkspaceError("The edited file exceeds the review size limit.")
    path.parent.mkdir(parents=True, exist_ok=True)
    _checked(Path(root), name)
    temporary = path.parent / (".planbranch-write-" + uuid4().hex)
    try:
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if existing is not None:
            temporary.chmod(stat.S_IMODE(path.stat().st_mode) & 0o777)
        os.replace(temporary, path)
    finally:
        if temporary.exists() and _plain(temporary):
            temporary.unlink()


class WorkspaceTools:
    def __init__(self, root):
        if not _plain(Path(root)):
            raise WorkspaceError("The worktree must not be a link.")
        self.root = Path(root).resolve(strict=True)
        self.baseline = snapshot(self.root)

    def list_files(self, arguments):
        prefix = arguments.get("prefix", "")
        if prefix:
            _relative(prefix.rstrip("/"))
        names = sorted(name for name in snapshot(self.root) if name.startswith(prefix))
        return {"files": names[:500], "truncated": len(names) > 500}

    def read_file(self, arguments):
        path = _checked(self.root, arguments["path"], allow_absent=False)
        if path.stat().st_nlink != 1:
            raise WorkspaceError("Hard links cannot be read.")
        data = _read(path)
        try:
            text = data.decode("utf-8")
        except UnicodeError:
            raise WorkspaceError("Only UTF-8 text files can be read by this tool.") from None
        offset, limit = arguments.get("offset", 0), arguments.get("limit", 20000)
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 40000:
            raise WorkspaceError("Use a non-negative offset and a read limit from 1 to 40000.")
        return {"path": arguments["path"], "sha256": digest(data), "text": text[offset:offset + limit],
                "offset": offset, "nextOffset": offset + limit if len(text) > offset + limit else None}

    def search_files(self, arguments):
        query = arguments["query"]
        if not isinstance(query, str) or not 1 <= len(query) <= 200:
            raise WorkspaceError("Search requires 1 to 200 literal characters.")
        matches = []
        for name, data in sorted(snapshot(self.root).items()):
            try:
                text = data.decode("utf-8")
            except UnicodeError:
                continue
            for number, line in enumerate(text.splitlines(), 1):
                if query in line:
                    matches.append({"path": name, "line": number, "text": line[:500]})
                    if len(matches) == 100:
                        return {"matches": matches, "truncated": True}
        return {"matches": matches, "truncated": False}

    def write_file(self, arguments):
        text, expected = arguments["content"], arguments["expectedSha256"]
        if text is not None and not isinstance(text, str):
            raise WorkspaceError("File content must be text, or null to remove a file.")
        if expected is not None and (not isinstance(expected, str) or len(expected) != 64):
            raise WorkspaceError("Supply the hash returned by read_file, or null for a new file.")
        data = text.encode("utf-8") if text is not None else None
        current = snapshot(self.root)
        proposed = {**current, arguments["path"]: data} if data is not None else {key: value for key, value in current.items() if key != arguments["path"]}
        if len(proposed) > MAX_FILES or sum(len(value) for value in proposed.values()) > MAX_TREE_BYTES:
            raise WorkspaceError("The edited workspace exceeds its review limits.")
        atomic_write(self.root, arguments["path"], data, expected)
        return {"path": arguments["path"], "sha256": digest(data) if data is not None else None,
                "removed": data is None}

    def diff(self, arguments):
        current = snapshot(self.root)
        names = sorted(set(self.baseline) | set(current))
        if arguments.get("path"):
            _relative(arguments["path"])
            names = [arguments["path"]]
        chunks = []
        for name in names:
            before, after = self.baseline.get(name), current.get(name)
            if before == after:
                continue
            try:
                lines = difflib.unified_diff((before or b"").decode("utf-8").splitlines(True),
                    (after or b"").decode("utf-8").splitlines(True), fromfile="a/" + name, tofile="b/" + name)
                chunks.append("".join(lines))
            except UnicodeError:
                chunks.append(f"Binary file changed: {name}\n")
        text = "".join(chunks)
        return {"diff": text[:40000], "truncated": len(text) > 40000,
                "scope": "Changes since this explicit execution or question continuation began."}
