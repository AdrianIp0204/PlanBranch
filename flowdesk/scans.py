"""Bounded, read-only source attachment and background scan service."""
from __future__ import annotations

from contextlib import contextmanager
import atexit
from datetime import datetime, timezone
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import stat
import subprocess
import sys
import threading
import time
import uuid

from .scanner import decode_source


DEFAULT_IGNORES = {
    ".git", ".hg", ".svn", ".venv", "venv", "env", "node_modules",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cache",
    "dist", "build", ".next", "htmlcov", ".tox", ".nox", "site-packages",
}


def now():
    return datetime.now(timezone.utc).isoformat()


def _linked(path):
    return path.is_symlink() or (hasattr(os.path, "isjunction") and os.path.isjunction(path))


def _no_link_components(path):
    # Checking parents also prevents accepting a root reached through a link.
    for component in [*reversed(path.parents), path]:
        if _linked(component):
            raise ValueError("Symlinks and directory junctions are not followed.")


def safe_path(root: Path, relative: str) -> Path:
    """Validate a project-relative path and its existing ancestor chain."""
    if not isinstance(relative, str) or not relative or "\x00" in relative:
        raise ValueError("A nonempty relative source path is required.")
    normalized = relative.replace("\\", "/")
    if Path(normalized).is_absolute() or PureWindowsPath(relative).is_absolute() or PureWindowsPath(relative).drive:
        raise ValueError("Absolute source paths are not allowed.")
    if ".." in normalized.split("/"):
        raise ValueError("Source paths cannot leave the attached directory.")
    root = Path(root)
    _no_link_components(root)
    path = root / normalized
    _no_link_components(path)
    resolved_root = root.resolve(strict=True)
    resolved = path.resolve(strict=False)
    if not resolved.is_relative_to(resolved_root):
        raise ValueError("Source path is outside the attached directory.")
    return path


def read_source(root, relative, max_bytes):
    path = safe_path(root, relative)
    if not path.is_file():
        raise OSError("Source is not a regular file.")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode):
            raise OSError("Source is not a regular file.")
        if metadata.st_size > max_bytes:
            raise ValueError(f"File exceeds {max_bytes:,} byte limit.")
        # Check the current path again before reading from the opened handle.
        safe_path(root, relative)
        raw = stream.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raise ValueError(f"File exceeds {max_bytes:,} byte limit.")
    return raw


class ScanService:
    def __init__(self, store, *, max_files=2000, max_bytes=1_000_000, parse_timeout=5.0, run_timeout=120.0, max_entries=20000):
        self.store = store
        self.max_files, self.max_bytes = max_files, min(max_bytes, 2_000_000)
        self.parse_timeout, self.run_timeout = parse_timeout, run_timeout
        self.max_entries = max_entries
        self.lock = threading.RLock()
        self.jobs = {}
        atexit.register(self.close)
        self.data_dir = getattr(store, "data_dir", None)
        if self.data_dir is None:
            database_path = getattr(store, "path", None) or getattr(store, "db_path", None)
            self.data_dir = Path(database_path).parent if database_path else None
        if self.data_dir is not None:
            self.data_dir = Path(self.data_dir).resolve()
        with self._connect() as db:
            for row in db.execute("SELECT id,project_id,data FROM scan_runs"):
                run = json.loads(row["data"])
                if run["status"] in ("queued", "running"):
                    run.update(status="interrupted", finishedAt=now())
                    run["summary"]["message"] = "Server stopped before this scan finished; previous observations are stale."
                    db.execute("UPDATE scan_runs SET data=? WHERE id=?", (json.dumps(run), row["id"]))
                    for evidence in db.execute("SELECT id,data FROM detected_symbols WHERE project_id=?", (row["project_id"],)).fetchall():
                        symbol = json.loads(evidence["data"])
                        if symbol.get("state") == "current":
                            symbol.update(state="stale", freshnessReason="Server stopped before the latest scan completed.")
                            db.execute("UPDATE detected_symbols SET data=? WHERE id=?", (json.dumps(symbol), evidence["id"]))

    @contextmanager
    def _connect(self):
        db = self.store.connect()
        try:
            with db:
                yield db
        finally:
            db.close()

    def _project(self, db, project_id):
        if db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone() is None:
            raise KeyError("Project not found.")

    def close(self):
        """Stop workers on normal server exit so parser children are not orphaned."""
        with self.lock:
            jobs = list(self.jobs.values())
            for job in jobs:
                job["cancel"].set()
        for job in jobs:
            if job["thread"] is not threading.current_thread():
                job["thread"].join(timeout=2)

    def attachment(self, project_id):
        with self._connect() as db:
            self._project(db, project_id)
            row = db.execute("SELECT root,ignores FROM source_attachments WHERE project_id=?", (project_id,)).fetchone()
            latest = db.execute("SELECT data FROM scan_runs WHERE project_id=? ORDER BY rowid DESC LIMIT 1", (project_id,)).fetchone()
        return {"root": row["root"] if row else "", "ignores": json.loads(row["ignores"]) if row else [], "attached": row is not None, "latestScan": json.loads(latest["data"]) if latest else None}

    def attach(self, project_id, root, ignores=None, confirmed=False):
        if confirmed is not True:
            raise ValueError("Confirm read-only access before attaching a source directory.")
        if not isinstance(root, str) or not root.strip() or len(root) > 4096:
            raise ValueError("Enter an absolute source-directory path.")
        if root.startswith((chr(92) * 2, chr(47) * 2)):
            raise ValueError("Attach a local directory; network paths are not supported.")
        root_path = Path(root).expanduser()
        if not root_path.is_absolute():
            raise ValueError("Enter an absolute source-directory path.")
        _no_link_components(root_path)
        root_path = root_path.resolve(strict=True)
        if not root_path.is_dir():
            raise ValueError("Source directory does not exist or cannot be read.")
        if root_path.parent == root_path or root_path == Path.home().resolve():
            raise ValueError("Attach a specific project directory, not a drive or home directory.")
        if self.data_dir and (root_path == self.data_dir or root_path.is_relative_to(self.data_dir)):
            raise ValueError("The application's data directory cannot be attached as source.")
        ignores = [] if ignores is None else ignores
        if not isinstance(ignores, list) or len(ignores) > 100 or any(not isinstance(item, str) or len(item) > 300 or "\x00" in item for item in ignores):
            raise ValueError("Ignore patterns must be a list of at most 100 short strings.")
        with self.lock:
            if project_id in self.jobs:
                raise RuntimeError("Cancel or finish the current scan before changing the attachment.")
            with self._connect() as db:
                self._project(db, project_id)
                previous = db.execute("SELECT root,generation FROM source_attachments WHERE project_id=?", (project_id,)).fetchone()
                changed = previous is None or previous["root"] != str(root_path)
                generation = str(uuid.uuid4()) if changed else previous["generation"]
                db.execute("INSERT INTO source_attachments VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET root=excluded.root,ignores=excluded.ignores,generation=excluded.generation", (project_id, str(root_path), json.dumps(ignores), generation))
                if changed:
                    db.execute("DELETE FROM source_files WHERE project_id=?", (project_id,))
                    for row in db.execute("SELECT id,data FROM detected_symbols WHERE project_id=?", (project_id,)).fetchall():
                        symbol = json.loads(row["data"])
                        symbol.update(state="stale", freshnessReason="Source attachment changed; confirm links to evidence from the new root.")
                        db.execute("UPDATE detected_symbols SET data=? WHERE id=?", (json.dumps(symbol), row["id"]))
        return self.attachment(project_id)

    def symbols(self, project_id):
        with self._connect() as db:
            self._project(db, project_id)
            return [json.loads(row["data"]) for row in db.execute("SELECT data FROM detected_symbols WHERE project_id=? ORDER BY id", (project_id,))]

    def start(self, project_id):
        with self.lock:
            if project_id in self.jobs:
                raise RuntimeError("A scan is already running for this project.")
            with self._connect() as db:
                self._project(db, project_id)
                row = db.execute("SELECT * FROM source_attachments WHERE project_id=?", (project_id,)).fetchone()
                if row is None:
                    raise RuntimeError("Attach a source directory and confirm read-only access first.")
                attachment = dict(row)
                run_id = str(uuid.uuid4())
                run = {"id": run_id, "status": "queued", "startedAt": now(), "files": [], "summary": {"analysed": 0, "skipped": 0, "errors": 0, "additions": 0, "notDetected": 0, "complete": False}}
                db.execute("INSERT INTO scan_runs VALUES(?,?,?)", (run_id, project_id, json.dumps(run)))
            cancelled = threading.Event()
            thread = threading.Thread(target=self._run, args=(project_id, attachment, run, cancelled), daemon=True, name="flowdesk-scan-" + run_id[:8])
            self.jobs[project_id] = {"id": run_id, "cancel": cancelled, "thread": thread}
            thread.start()
            return {"id": run_id, "status": "queued"}

    def status(self, project_id, scan_id):
        with self._connect() as db:
            self._project(db, project_id)
            row = db.execute("SELECT data FROM scan_runs WHERE id=? AND project_id=?", (scan_id, project_id)).fetchone()
            if row is None:
                raise KeyError("Scan not found.")
            return json.loads(row["data"])

    def cancel(self, project_id, scan_id):
        with self.lock:
            self.status(project_id, scan_id)
            job = self.jobs.get(project_id)
            if job and job["id"] == scan_id:
                job["cancel"].set()
        return self.status(project_id, scan_id)

    def _save_run(self, project_id, run):
        with self._connect() as db:
            db.execute("UPDATE scan_runs SET data=? WHERE id=? AND project_id=?", (json.dumps(run), run["id"], project_id))

    def _ignored(self, root, relative, ignores):
        components = relative.replace("\\", "/").split("/")
        if any(part.lower() in DEFAULT_IGNORES for part in components):
            return True
        if self.data_dir:
            candidate = (root / relative).resolve(strict=False)
            if candidate == self.data_dir or candidate.is_relative_to(self.data_dir):
                return True
        return any(fnmatch.fnmatch(relative, pattern) or fnmatch.fnmatch(components[-1], pattern) or fnmatch.fnmatch(relative + "/", pattern) for pattern in ignores)

    def _parse(self, raw, relative, cancelled, deadline):
        kwargs = {"stdin": subprocess.PIPE, "stdout": subprocess.PIPE, "stderr": subprocess.PIPE}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        process = subprocess.Popen([sys.executable, "-I", str(Path(__file__).with_name("scanner.py")), "--worker", relative], **kwargs)
        first = True
        parse_deadline = min(deadline, time.monotonic() + self.parse_timeout)
        try:
            while True:
                if cancelled.is_set():
                    raise InterruptedError("Scan cancelled.")
                if time.monotonic() >= parse_deadline:
                    raise TimeoutError("Parsing exceeded the time limit.")
                try:
                    output, error = process.communicate(input=raw if first else None, timeout=min(0.1, max(0.01, parse_deadline - time.monotonic())))
                    break
                except subprocess.TimeoutExpired:
                    first = False
            if process.returncode:
                raise ValueError("Parser process could not analyse this file.")
            result = json.loads(output)
            if not result.get("ok"):
                raise ValueError(result.get("error", "Parsing failed."))
            if len(result["symbols"]) > 10000:
                raise ValueError("File exceeds 10,000 detected binding limit.")
            return result["symbols"]
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate()

    def _mark_stale(self, project_id, reason):
        with self._connect() as db:
            for row in db.execute("SELECT path,data FROM source_files WHERE project_id=?", (project_id,)).fetchall():
                file = json.loads(row["data"])
                if file.get("state") != "not_detected":
                    file.update(state="stale", freshnessReason=reason)
                    db.execute("UPDATE source_files SET data=? WHERE project_id=? AND path=?", (json.dumps(file), project_id, row["path"]))
            for row in db.execute("SELECT id,data FROM detected_symbols WHERE project_id=?", (project_id,)).fetchall():
                symbol = json.loads(row["data"])
                # Previously proved absence remains absence until checked again.
                if symbol.get("state") != "not_detected":
                    symbol.update(state="stale", freshnessReason=reason)
                    db.execute("UPDATE detected_symbols SET data=? WHERE id=?", (json.dumps(symbol), row["id"]))

    def _file_success(self, project_id, attachment, relative, parsed, digest, scan_time):
        additions = removed = 0
        generation = attachment["generation"]
        with self._connect() as db:
            old = [json.loads(row["data"]) for row in db.execute("SELECT data FROM detected_symbols WHERE project_id=?", (project_id,))]
            old = [s for s in old if s.get("file") == relative and s.get("attachmentGeneration") == generation]
            by_identity = {}
            for symbol in old:
                if not symbol.get("ambiguousIdentity"):
                    by_identity.setdefault(symbol.get("identity"), []).append(symbol)
            seen = set()
            present_identities = {symbol["identity"] for symbol in parsed}
            for parsed_symbol in parsed:
                symbol = dict(parsed_symbol)
                candidates = by_identity.get(symbol["identity"], [])
                prior = candidates[0] if len(candidates) == 1 and not symbol.get("ambiguousIdentity") else None
                symbol_id = prior["id"] if prior else str(uuid.uuid4())
                additions += int(prior is None)
                seen.add(symbol_id)
                symbol.update(id=symbol_id, state="current", scanTime=scan_time, hash=digest, attachmentGeneration=generation)
                db.execute("INSERT INTO detected_symbols VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", (symbol_id, project_id, json.dumps(symbol)))
            for symbol in old:
                if symbol["id"] not in seen:
                    if symbol.get("ambiguousIdentity") and symbol.get("identity") in present_identities:
                        symbol.update(state="stale", freshnessReason="Ambiguous scope identity requires explicit relinking after this scan.")
                    else:
                        removed += int(symbol.get("state") != "not_detected")
                        symbol.update(state="not_detected", freshnessReason="Binding absent from a successfully analysed file.", checkedAt=scan_time)
                    db.execute("UPDATE detected_symbols SET data=? WHERE id=?", (json.dumps(symbol), symbol["id"]))
            data = {"path": relative, "hash": digest, "scanTime": scan_time, "state": "current", "attachmentGeneration": generation}
            db.execute("INSERT INTO source_files VALUES(?,?,?) ON CONFLICT(project_id,path) DO UPDATE SET data=excluded.data", (project_id, relative, json.dumps(data)))
        return additions, removed

    def _missing_files(self, project_id, attachment, seen, complete):
        if not complete:
            return 0
        removed = 0
        root = Path(attachment["root"])
        with self._connect() as db:
            for row in db.execute("SELECT id,data FROM detected_symbols WHERE project_id=?", (project_id,)).fetchall():
                symbol = json.loads(row["data"])
                if symbol.get("attachmentGeneration") != attachment["generation"] or symbol.get("file") in seen:
                    continue
                relative = symbol.get("file", "")
                if self._ignored(root, relative, json.loads(attachment["ignores"])):
                    continue
                try:
                    path = safe_path(root, relative)
                    # A definite FileNotFoundError is different from exists(),
                    # which can conceal access errors on some platforms.
                    path.stat()
                except FileNotFoundError:
                    removed += int(symbol.get("state") != "not_detected")
                    symbol.update(state="not_detected", freshnessReason="Source file verified absent in a complete scan.", checkedAt=now())
                    db.execute("UPDATE detected_symbols SET data=? WHERE id=?", (json.dumps(symbol), row["id"]))
                except (OSError, ValueError):
                    pass
        return removed

    def _entries(self, root, ignores, cancelled, deadline, run, traversal):
        # scandir is consumed incrementally: a huge non-Python directory cannot
        # evade limits or force an unbounded sorted/os.walk allocation.
        stack = [root]
        count = 0
        while stack:
            current = stack.pop()
            try:
                _no_link_components(current)
                with os.scandir(current) as entries:
                    for item in entries:
                        if cancelled.is_set() or time.monotonic() >= deadline or count >= self.max_entries:
                            traversal["complete"] = False
                            return
                        count += 1
                        path = Path(item.path)
                        relative = path.relative_to(root).as_posix()
                        try:
                            linked = _linked(path)
                            directory = item.is_dir(follow_symlinks=False)
                            if linked or self._ignored(root, relative, ignores):
                                if directory or linked or relative.lower().endswith(".py"):
                                    run["summary"]["skipped"] += 1
                                    run["files"].append({"file": relative + ("/" if directory else ""), "status": "skipped", "message": "Ignored path, symlink, or junction."})
                                continue
                            if directory:
                                stack.append(path)
                            elif relative.lower().endswith(".py"):
                                if item.is_file(follow_symlinks=False):
                                    yield path, relative
                                else:
                                    run["summary"]["skipped"] += 1
                                    run["files"].append({"file": relative, "status": "skipped", "message": "Only regular source files are analysed."})
                        except (OSError, ValueError):
                            traversal["complete"] = False
                            run["summary"]["errors"] += 1
                            run["files"].append({"file": relative, "status": "error", "message": "Path could not be checked; earlier observations remain stale."})
            except (OSError, ValueError):
                traversal["complete"] = False
                run["summary"]["errors"] += 1
                run["files"].append({"file": current.relative_to(root).as_posix(), "status": "error", "message": "Directory could not be checked; earlier observations remain stale."})
        run["summary"]["entriesChecked"] = count

    def _run(self, project_id, attachment, run, cancelled):
        deadline = time.monotonic() + self.run_timeout
        root = Path(attachment["root"])
        ignores = json.loads(attachment["ignores"])
        seen, traversal = set(), {"complete": True}
        examined = 0
        try:
            self._mark_stale(project_id, "Scan in progress or file not successfully checked in the latest scan.")
            run["status"] = "running"
            self._save_run(project_id, run)
            _no_link_components(root)
            if not root.is_dir():
                raise ValueError("Attached source directory is unavailable.")
            for path, relative in self._entries(root, ignores, cancelled, deadline, run, traversal):
                if cancelled.is_set() or time.monotonic() >= deadline or examined >= self.max_files:
                    traversal["complete"] = False
                    break
                examined += 1
                seen.add(relative)
                entry = {"file": relative}
                try:
                    raw = read_source(root, relative, self.max_bytes)
                    digest = hashlib.sha256(raw).hexdigest()
                    parsed = self._parse(raw, relative, cancelled, deadline)
                    latest = read_source(root, relative, self.max_bytes)
                    if hashlib.sha256(latest).hexdigest() != digest:
                        raise ValueError("Source changed during analysis; rescan when editing is complete.")
                    added, removed = self._file_success(project_id, attachment, relative, parsed, digest, now())
                    run["summary"]["analysed"] += 1
                    run["summary"]["additions"] += added
                    run["summary"]["notDetected"] += removed
                    entry.update(status="analysed", symbols=len(parsed))
                except InterruptedError:
                    entry.update(status="skipped", message="Scan cancelled; prior observations are stale.")
                    run["summary"]["skipped"] += 1
                    traversal["complete"] = False
                except (OSError, ValueError, TimeoutError) as exc:
                    message = str(exc)[:2000]
                    skipped = "limit" in message.lower() or "symlink" in message.lower() or "junction" in message.lower()
                    entry.update(status="skipped" if skipped else "error", message=message)
                    run["summary"]["skipped" if skipped else "errors"] += 1
                run["files"].append(entry)
                self._save_run(project_id, run)
            complete = traversal["complete"] and not cancelled.is_set() and time.monotonic() < deadline
            run["summary"]["notDetected"] += self._missing_files(project_id, attachment, seen, complete)
            run["summary"]["complete"] = complete
            run["status"] = "cancelled" if cancelled.is_set() else "completed" if complete else "partial"
            if not complete:
                run["summary"]["message"] = "Scan cancelled or limited; unchecked files retain stale observations."
        except Exception as exc:
            run["status"] = "failed"
            run["summary"]["message"] = str(exc)[:2000]
            run["summary"]["errors"] += 1
        finally:
            run["finishedAt"] = now()
            with self.lock:
                try:
                    self._save_run(project_id, run)
                finally:
                    self.jobs.pop(project_id, None)

    def preview(self, project_id, symbol_id):
        symbols = self.symbols(project_id)
        symbol = next((item for item in symbols if item["id"] == symbol_id), None)
        if symbol is None:
            raise KeyError("Detected symbol not found.")
        with self._connect() as db:
            attachment = db.execute("SELECT * FROM source_attachments WHERE project_id=?", (project_id,)).fetchone()
        if attachment is None or symbol.get("attachmentGeneration") != attachment["generation"]:
            raise ValueError("This evidence is historical or belongs to another attachment; attach and rescan before previewing.")
        raw = read_source(Path(attachment["root"]), symbol["file"], self.max_bytes)
        changed = hashlib.sha256(raw).hexdigest() != symbol.get("hash")
        line = symbol.get("locations", [{}])[0].get("line", 1) if symbol.get("locations") else 1
        lines = decode_source(raw).splitlines()
        start = max(0, min(line - 4, max(0, len(lines) - 1)))
        text = "\n".join(lines[start:start + 9])[:10000]
        return {"text": text, "stale": changed or symbol.get("state") != "current", "file": symbol["file"], "line": line, "startLine": start + 1}
