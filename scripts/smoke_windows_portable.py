"""Verify a Windows portable zip/directory without host Python packages or Node.

The Python running this controller may come from a development environment.
Every application, scanner, and execution worker under test uses the copied
portable runtime. All data and source fixtures are newly created; no Codex
request, Git checkout, external service, or user database is used.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from uuid import uuid4
import zipfile


MAX_BYTES = 2 * 1024 * 1024 * 1024
MAX_FILES = 30000


def portable_parts(parts):
    reserved = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", *[f"{prefix}{n}" for prefix in ("COM", "LPT") for n in range(1, 10)]}
    return all(part and part not in {".", ".."} and part == part.rstrip(" .")
               and not any(ord(char) < 32 or char in '<>:"\\|?*' for char in part)
               and part.split(".")[0].upper() not in reserved for part in parts)


def extract_bundle(source: Path, destination: Path) -> Path:
    """Stage only ordinary bounded files inside a freshly created directory."""
    source = source.resolve(strict=True)
    destination = destination.resolve()
    if destination.exists():
        raise ValueError("The portable staging directory must be new.")
    if source.is_dir():
        if destination.is_relative_to(source):
            raise ValueError("Portable staging must be outside the input bundle.")
        total = count = 0
        for directory, dirs, files in os.walk(source, followlinks=False):
            for name in (*dirs, *files):
                path = Path(directory) / name
                if not portable_parts(path.relative_to(source).parts) or path.is_symlink() or path.is_junction() or path.resolve() != path:
                    raise ValueError("Portable bundles cannot contain redirected paths.")
                count += 1
                if path.is_file():
                    total += path.stat().st_size
                elif not path.is_dir():
                    raise ValueError("Portable bundles contain only files and directories.")
        if total > MAX_BYTES or count > MAX_FILES:
            raise ValueError("Portable bundle exceeds the bounded smoke-test size.")
        shutil.copytree(source, destination)
    else:
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_FILES or sum(item.file_size for item in entries) > MAX_BYTES:
                raise ValueError("Portable archive exceeds the bounded smoke-test size.")
            names = set()
            for item in entries:
                # ZipInfo normalizes OS separators on Windows; validate the
                # original central-directory name before that normalization.
                name = item.orig_filename
                path = PurePosixPath(name)
                mode = item.external_attr >> 16
                key = path.as_posix().casefold()
                if (not name or path.is_absolute() or not portable_parts(path.parts) or "\\" in name
                        or path.as_posix() != name.rstrip("/") or item.flag_bits & 1
                        or stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR} or key in names):
                    raise ValueError("Portable archive has an unsafe or duplicate path.")
                names.add(key)
                if not (destination / Path(*path.parts)).resolve().is_relative_to(destination):
                    raise ValueError("Portable archive escapes the staging directory.")
            destination.mkdir(parents=True)
            archive.extractall(destination)
    candidates = [destination, *[path for path in destination.iterdir() if path.is_dir()]]
    roots = [path for path in candidates if (path / "runtime" / "python.exe").is_file()]
    if len(roots) != 1:
        raise ValueError("Expected exactly one portable application directory.")
    root = roots[0]
    for relative in ("planbranch.cmd", "flowdesk.cmd", "app/flowdesk/__init__.py"):
        if not (root / relative).is_file():
            raise ValueError(f"Portable bundle is missing {relative}.")
    return root


def poisoned_environment(directory: Path, base=None):
    directory.mkdir(parents=True, exist_ok=True)
    marker = directory / "host-startup-was-imported"
    trap = "from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('unexpected host import')\nraise RuntimeError('Host module must not load')\n"
    (directory / "sitecustomize.py").write_text(trap, encoding="utf-8")
    (directory / "usercustomize.py").write_text(trap, encoding="utf-8")
    fake = directory / "flowdesk"
    fake.mkdir()
    (fake / "__init__.py").write_text(trap, encoding="utf-8")
    for name in ("python.cmd", "python3.cmd", "node.cmd", "codex.cmd"):
        (directory / name).write_text("@exit /b 91\r\n", encoding="ascii")
    original = dict(os.environ if base is None else base)
    env = {key: value for key, value in original.items()
           if not key.upper().startswith("PYTHON") and key.upper() not in {"PATH", "__PYVENV_LAUNCHER__"}}
    system = Path(original.get("SystemRoot", original.get("SYSTEMROOT", "C:/Windows"))) / "System32"
    env.update(PYTHONHOME=str(directory), PYTHONPATH=str(directory), PYTHONUSERBASE=str(directory),
               PATH=str(directory) + os.pathsep + str(system))
    return env, marker


def verify_backup(path: Path):
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise AssertionError("Portable backup failed SQLite integrity validation.")
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise AssertionError("Portable backup has broken references.")
        if db.execute("SELECT COUNT(*) FROM projects").fetchone()[0] != 1:
            raise AssertionError("Portable backup did not preserve its fixture project.")


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class LocalAPI:
    def __init__(self, port):
        self.root = f"http://127.0.0.1:{port}"
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.token = None

    def request(self, path, method="GET", body=None, *, raw=False):
        headers = {"Origin": self.root}
        if self.token:
            headers["X-FlowDesk-Token"] = self.token
        data = None if body is None else json.dumps(body).encode("utf-8")
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.root + path, data=data, headers=headers, method=method)
        with self.opener.open(request, timeout=15) as response:
            result = response.read()
        return result.decode("utf-8") if raw else json.loads(result)


class OwnedJob:
    """Kill the fixture's owned process tree when this controller closes it."""
    def __init__(self):
        import ctypes
        from ctypes import wintypes
        class Basic(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]
        class Io(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]
        class Extended(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", Io), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.SetInformationJobObject.restype = wintypes.BOOL
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError("Could not create the disposable server job")
        limits = Extended()
        limits.BasicLimitInformation.LimitFlags = 0x2000
        if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close()
            raise OSError("Could not protect the disposable server lifetime")

    def assign(self, process):
        if not self.kernel.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise OSError("Could not assign the blocked fixture launcher to its job")

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def alias_command(alias: Path, arguments: list[str], env, *, gate=False):
    # These paths are generated by this smoke test and deliberately contain
    # spaces/Unicode. No user text becomes a command or batch expression.
    paths = [str(alias), *arguments]
    if any(any(character in value for character in ('"', '\r', '\n', '%')) for value in paths):
        raise ValueError("Smoke-test paths must not contain quotes, newlines, or percent signs.")
    comspec = str(Path(env.get("SystemRoot", env.get("SYSTEMROOT", "C:/Windows"))) / "System32" / "cmd.exe")
    command = " ".join('"' + value + '"' for value in paths)
    if gate:
        command = "set /p PLANBRANCH_SMOKE_START= >nul && " + command
    return '"' + comspec + '" /d /s /c "' + command + '"'


def start_server(bundle, alias, cwd, data, env, log, timeout):
    port = free_port()
    stream = log.open("wb")
    job = OwnedJob()
    process = None
    try:
        process = subprocess.Popen(alias_command(bundle / alias, ["--data-dir", str(data), "--port", str(port)], env, gate=True),
            cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=stream, stderr=subprocess.STDOUT,
            shell=False, creationflags=subprocess.CREATE_NO_WINDOW)
        # cmd is blocked on input. It cannot launch the app before assignment.
        job.assign(process)
        process._planbranch_smoke_port = port
        process._planbranch_smoke_job = job
        process.stdin.write(b"continue\n")
        process.stdin.flush()
    except BaseException:
        job.close()
        if process is not None:
            if process.poll() is None:
                process.kill()  # Owned live handle; launcher is still blocked.
            process.wait(timeout=10)
        stream.close()
        raise
    api = LocalAPI(port)
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"{alias} exited early. Inspect {log}.")
            try:
                api.token = api.request("/api/bootstrap")["token"]
                return process, stream, api
            except (OSError, urllib.error.URLError):
                time.sleep(.1)
        raise TimeoutError(f"{alias} did not serve its local API. Inspect {log}.")
    except BaseException:
        stop_server(process, stream, env)
        raise


def stop_server(process, stream, env):
    try:
        process._planbranch_smoke_job.close()
        if process.poll() is None:
            process.wait(timeout=10)
        # The wrapper PID alone exiting is insufficient: verify its local
        # server socket also closed after the owned tree was terminated.
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            with socket.socket() as probe:
                probe.settimeout(.2)
                if probe.connect_ex(("127.0.0.1", process._planbranch_smoke_port)) != 0:
                    break
            time.sleep(.05)
        else:
            raise RuntimeError("The portable fixture server remained reachable after its owned process tree stopped.")
    finally:
        process.stdin.close()
        stream.close()


def save(api, project, *, content=None, cursor=None):
    checkpoint = {"id": str(uuid4()), "label": "Portable smoke edit", "content": content} if content else None
    api.request(f"/api/projects/{project['id']}", "PUT", {
        "baseRevision": project["revision"], "mutationId": str(uuid4()), "anchorId": project["history"][-1]["id"],
        "append": [checkpoint] if checkpoint else [], "cursor": checkpoint["id"] if checkpoint else cursor,
        "views": project["views"],
    })
    return api.request(f"/api/projects/{project['id']}")


ISOLATION_PROBE = r'''
import importlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
modules = {}
for name in ('flowdesk', 'flask', 'waitress', 'sqlite3', 'ssl', '_ctypes', 'json'):
    module = importlib.import_module(name)
    filename = pathlib.Path(module.__file__).resolve()
    assert filename.is_relative_to(root), (name, str(filename))
    modules[name] = str(filename)
assert sys.flags.isolated and sys.flags.ignore_environment and sys.flags.no_user_site
assert all(path and pathlib.Path(path).resolve().is_relative_to(root) for path in sys.path), sys.path
assert 'sitecustomize' not in sys.modules and 'usercustomize' not in sys.modules
print(json.dumps({'python': sys.version, 'applicationVersion': importlib.import_module('flowdesk').__version__,
                  'executable': sys.executable, 'modules': modules, 'path': sys.path}))
'''


SUPERVISOR_PROBE = r'''
import json, os, pathlib, sys, threading, time
from flowdesk.executor_process import run_supervised
work = pathlib.Path(sys.argv[1]).resolve()
packets = []
code = "import pathlib,sys;sys.stdin.read();pathlib.Path('observed-result.txt').write_text('isolated command passed');print('fixture-command-completed',flush=True)"
result = run_supervised([sys.executable,'-I','-c',code], cwd=work, env=dict(os.environ), prompt=b'fixture-only',
    cancel=threading.Event(), on_packet=packets.append, timeout=15)
assert result == {'reason':'exited','returncode':0}, result
assert (work/'observed-result.txt').read_text() == 'isolated command passed'
assert any(p.get('type') == 'stdout' and 'fixture-command-completed' in p.get('text','') for p in packets), packets
cancel = threading.Event()
code = "import pathlib,sys,time;sys.stdin.read();print('fixture-ready',flush=True);time.sleep(2);pathlib.Path('unexpected-after-cancel').write_text('bad')"
def observe(packet):
    if packet.get('type') == 'stdout' and 'fixture-ready' in packet.get('text',''):
        cancel.set()
cancelled = run_supervised([sys.executable,'-I','-c',code], cwd=work, env=dict(os.environ), prompt=b'',
    cancel=cancel, on_packet=observe, timeout=15)
assert cancelled['reason'] == 'cancelled', cancelled
time.sleep(2.2)
assert not (work/'unexpected-after-cancel').exists()
print(json.dumps({'command':result,'cancellation':cancelled,'codexInvoked':False}))
'''


def bundled_probe(bundle, code, args, cwd, env, timeout):
    completed = subprocess.run([str(bundle / "runtime" / "python.exe"), "-I", "-X", "utf8", "-c", code, *map(str, args)],
        cwd=cwd, env=env, text=True, encoding="utf-8", capture_output=True, timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW, check=True)
    return json.loads(completed.stdout)


def run_smoke(source, output_dir, timeout):
    if os.name != "nt":
        raise RuntimeError("The portable smoke test runs on Windows. Use Linux source/wheel checks on Linux.")
    output_dir.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="portable smoke \u8a08\u5283 ", dir=output_dir)).resolve()
    report = {"workspace": str(workspace), "input": str(source.resolve()), "checks": [], "passed": False}
    report_path = workspace / "result.json"
    def passed(check):
        report["checks"].append(check)
        print(check, flush=True)
    try:
        bundle = extract_bundle(source, workspace / "Copied application \u7a0b\u5f0f")
        cwd = workspace / "Unrelated working directory \u6e2c\u8a66"
        env, marker = poisoned_environment(cwd)
        data = workspace / "Disposable data \u8cc7\u6599"
        report["bundle"] = str(bundle)
        report["isolation"] = bundled_probe(bundle, ISOLATION_PROBE, [bundle], cwd, env, timeout)
        assert not marker.exists(), "A host startup hook was imported"
        passed("Bundled imports ignore host Python, startup hooks, PATH and working-directory modules")
        process, stream, api = start_server(bundle, "planbranch.cmd", cwd, data, env, workspace / "planbranch.log", timeout)
        try:
            html = api.request("/", raw=True)
            assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', html)
            assert assets, "The launcher did not serve its packaged frontend"
            for asset in assets:
                assert api.request(asset, raw=True)
            project = api.request("/api/projects", "POST", {"sample": True})
            baseline = deepcopy(project)
            content = deepcopy(project["content"])
            content["notes"] += "\nPortable saved edit \u6e2c\u8a66"
            diagram_id = content["diagrams"][0]["id"]
            project["views"][diagram_id] = {"x": -222, "y": 117, "zoom": .65}
            edited = save(api, project, content=content)
            undone = save(api, edited, cursor=baseline["cursor"])
            assert undone["content"] == baseline["content"]
            assert len(undone["history"]) == len(baseline["history"]) + 1
            passed("planbranch.cmd serves packaged frontend and durably saves edit plus Undo")
        finally:
            stop_server(process, stream, env)
        process, stream, api = start_server(bundle, "flowdesk.cmd", cwd, data, env, workspace / "flowdesk.log", timeout)
        try:
            restored = api.request(f"/api/projects/{baseline['id']}")
            assert restored["content"] == undone["content"] and restored["cursor"] == undone["cursor"]
            assert restored["history"] == undone["history"] and restored["views"] == undone["views"]
            redone = save(api, restored, cursor=edited["cursor"])
            assert redone["content"] == edited["content"]
            passed("flowdesk.cmd restores exact IDs, viewport and redo history after restart")
            source_dir = workspace / "Disposable Python source \u539f\u78bc"
            source_dir.mkdir()
            source_file = source_dir / "sample.py"
            must_not_run = source_dir / "source-was-executed"
            source_file.write_text("from pathlib import Path\nPath(" + repr(str(must_not_run)) + ").write_text('bad')\nportable_total: int = 3\n", encoding="utf-8")
            original = hashlib.sha256(source_file.read_bytes()).hexdigest()
            route = f"/api/projects/{baseline['id']}"
            api.request(route + "/source", "POST", {"root": str(source_dir), "ignores": [], "confirmed": True})
            scan = api.request(route + "/scans", "POST", {})
            deadline = time.monotonic() + timeout
            while scan["status"] in ("queued", "running") and time.monotonic() < deadline:
                time.sleep(.1)
                scan = api.request(route + "/scans/" + scan["id"])
            assert scan["status"] == "completed", scan
            symbols = api.request(route + "/symbols")["symbols"]
            assert any(item["name"] == "portable_total" and item["annotation"] == "int" and item["state"] == "current" for item in symbols)
            assert not must_not_run.exists() and hashlib.sha256(source_file.read_bytes()).hexdigest() == original
            passed("Bundled scanner worker detects annotations without executing or changing source")
            filename = api.request("/api/backup", "POST", {})["filename"]
            backup = (data / "backups" / filename).resolve()
            assert backup.is_relative_to(data.resolve() / "backups")
            verify_backup(backup)
            passed("HTTP database backup opens with valid integrity and references")
        finally:
            stop_server(process, stream, env)
        completed = subprocess.run(alias_command(bundle / "flowdesk.cmd", ["backup", "--data-dir", str(data)], env),
            cwd=cwd, env=env, text=True, encoding="utf-8", capture_output=True, timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW, check=True)
        backup = Path(completed.stdout.strip()).resolve()
        assert backup.is_relative_to(data.resolve() / "backups")
        verify_backup(backup)
        passed("Compatible flowdesk.cmd backup command uses the bundled runtime")
        execution = workspace / "Disposable supervisor fixture \u57f7\u884c"
        execution.mkdir()
        report["supervisor"] = bundled_probe(bundle, SUPERVISOR_PROBE, [execution], cwd, env, timeout)
        assert not marker.exists(), "A host startup hook was imported"
        passed("Bundled execution worker reports observed command exit and cancels its owned child")
        report["passed"] = True
        return report_path
    except BaseException as exc:
        report["error"] = str(exc)
        raise
    finally:
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Portable smoke evidence: {report_path}", flush=True)


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path, help="Built portable zip or application directory")
    parser.add_argument("--output-dir", type=Path, default=Path("output/portable-smoke"))
    parser.add_argument("--timeout", type=float, default=120, help="Per-stage timeout in seconds")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    try:
        run_smoke(args.bundle, args.output_dir.resolve(), args.timeout)
    except (OSError, ValueError, AssertionError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"Portable smoke failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
