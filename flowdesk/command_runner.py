"""Local command isolation: readonly input, bounded tmpfs, non-root model commands."""
from __future__ import annotations
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
from uuid import uuid4
from .execution_git import WorkspaceError, _atomic_json, _checked, _relative, MAX_FILES, MAX_FILE_BYTES, MAX_TREE_BYTES
from .executor_process import run_supervised
from .workspace_tools import snapshot, atomic_write, digest

POLICY_VERSION = "docker-tmpfs-v1"
ARCHIVE_LIMIT = MAX_TREE_BYTES + 12_000_000
CONTAINER_PATH = "/usr/local/bin:/usr/bin:/bin"


def environment():
    return {k: v for k, v in os.environ.items() if k.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"}}


def archive_files(data, *, include_modes=False):
    """Validate every member; never ask tarfile to extract onto the host."""
    result, modes, seen, total = {}, {}, set(), 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
            for index, member in enumerate(archive):
                if index >= MAX_FILES * 2: raise WorkspaceError("Too many returned filesystem entries.")
                name = member.name.removeprefix("./").rstrip("/")
                if not name or name == ".":
                    if member.isdir(): continue
                    raise WorkspaceError("Invalid command archive entry.")
                _relative(name)
                if name.casefold() in seen: raise WorkspaceError("Duplicate or case-conflicting command output paths.")
                seen.add(name.casefold())
                if member.isdir(): continue
                if not member.isfile() or member.size > MAX_FILE_BYTES or member.mode & 0o7000:
                    raise WorkspaceError("Command output contains a link, special file, unsafe mode or oversized file.")
                total += member.size
                if len(result) >= MAX_FILES or total > MAX_TREE_BYTES: raise WorkspaceError("Command output exceeds review limits.")
                modes[name] = member.mode & 0o777
                result[name] = archive.extractfile(member).read(MAX_FILE_BYTES + 1)
                if len(result[name]) != member.size: raise WorkspaceError("Command output archive is incomplete.")
    except (tarfile.TarError, OSError) as exc:
        raise WorkspaceError("Command output could not be validated.") from exc
    if any(parent.as_posix() in result for name in result for parent in Path(name).parents if str(parent) != "."):
        raise WorkspaceError("Command output has conflicting file paths.")
    return (result, modes) if include_modes else result


def output_mode(previous, current, returned):
    """Import authored execute changes; preserve the host's existing rw bits."""
    initial_execute = 0o111 if previous is not None and previous & 0o111 else 0
    execute = previous & 0o111 if previous is not None and returned & 0o111 == initial_execute else returned & 0o111
    return (current & 0o666) | execute


class DockerCommandRunner:
    def __init__(self, data_dir):
        self.directory = Path(data_dir).resolve() / "command-sandboxes"
        self.config = self.directory / "docker-config"

    def _args(self, executable, endpoint, args):
        self.config.mkdir(parents=True, exist_ok=True)
        return [executable, "--config", str(self.config), "--host", endpoint, *args]

    def _call(self, executable, endpoint, args):
        result = subprocess.run(self._args(executable, endpoint, args), capture_output=True, timeout=15,
            env=environment(), creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        if result.returncode or len(result.stdout) > 1_000_000:
            raise WorkspaceError("The local Docker runtime or selected image is unavailable or lacks required utilities.")
        return result.stdout.decode("utf-8")

    @staticmethod
    def restrictions():
        return ["--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--cap-add=KILL",
            "--security-opt=no-new-privileges=true", "--user=0:0", "--pids-limit=64", "--memory=512m",
            "--memory-swap=512m", "--cpus=1", "--ulimit", "nofile=256:256", "--init", "--no-healthcheck",
            "--log-driver=none", "--stop-timeout=2", "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m,mode=1777",
            "--tmpfs", "/workspace:rw,nosuid,size=160m,mode=0777", "--workdir=/workspace"]

    def configure(self):
        unavailable = {"version": POLICY_VERSION, "available": False, "reason": "Isolated commands are unavailable. Set PLANBRANCH_EXECUTION_IMAGE to an existing local Docker image; file editing remains available."}
        executable, image = shutil.which("docker"), os.environ.get("PLANBRANCH_EXECUTION_IMAGE", "").strip()
        endpoint = os.environ.get("PLANBRANCH_DOCKER_HOST") or ("npipe:////./pipe/dockerDesktopLinuxEngine" if os.name == "nt" else "unix:///var/run/docker.sock")
        if not executable or not image: return unavailable
        try:
            if not endpoint.startswith(("unix:///", "npipe:////./pipe/")): raise WorkspaceError("Execution requires a local Docker daemon.")
            info = json.loads(self._call(executable, endpoint, ["info", "--format", "{{json .}}"] ))
            if info.get("OSType") != "linux" or not any("seccomp" in str(x) for x in info.get("SecurityOptions", [])):
                raise WorkspaceError("Docker must provide Linux containers with default seccomp protection.")
            details = json.loads(self._call(executable, endpoint, ["image", "inspect", image]))[0]
            image_id = details["Id"]
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id) or details.get("Os") != "linux" or details.get("Config", {}).get("Volumes"):
                raise WorkspaceError("Select an existing Linux image without declared writable volumes.")
            probe = "planbranch-probe-" + uuid4().hex
            try:
                self._call(executable, endpoint, ["run", "--rm", "--name", probe, *self.restrictions(), "--entrypoint=/usr/bin/env", image_id,
                    "-i", "PATH=" + CONTAINER_PATH, "/bin/sh", "-c", "command -v cp >/dev/null && command -v chmod >/dev/null && command -v tar >/dev/null && command -v sleep >/dev/null && command -v sed >/dev/null"])
            finally:
                # Identifies only our unique preflight container, never user work.
                try: self._call(executable, endpoint, ["rm", "--force", probe])
                except WorkspaceError: pass
            return {"version": POLICY_VERSION, "available": True, "imageId": image_id, "imageLabel": image,
                "endpoint": endpoint, "daemonId": info["ID"], "executable": str(Path(executable).resolve()), "network": "none",
                "maxSeconds": 120, "memoryBytes": 512 * 1024 * 1024, "workspaceBytes": 160 * 1024 * 1024,
                "pids": 64, "user": "65534:65534", "collectorCapability": "KILL"}
        except (OSError, ValueError, KeyError, IndexError, subprocess.TimeoutExpired) as exc:
            return {**unavailable, "reason": str(exc) if isinstance(exc, WorkspaceError) else unavailable["reason"]}

    def _archive(self, executable, endpoint, container):
        command = self._args(executable, endpoint, ["exec", "--user=0:0", container, "/usr/bin/env", "-i", "PATH=" + CONTAINER_PATH,
            "/bin/sh", "-c", "kill -STOP -1 || exit 91; exec tar -C /workspace -cf - ."])
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=environment(),
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        chunks, failure = [], []
        def read():
            size = 0
            try:
                while chunk := process.stdout.read(65536):
                    size += len(chunk)
                    if size > ARCHIVE_LIMIT: raise WorkspaceError("The command archive exceeded its byte limit.")
                    chunks.append(chunk)
            except Exception as exc: failure.append(exc)
        reader = threading.Thread(target=read, daemon=True)
        reader.start(); reader.join(20)
        try:
            if reader.is_alive() or failure: raise WorkspaceError("The isolated command archive was incomplete or too large.")
            if process.wait(timeout=2) != 0: raise WorkspaceError("The isolated filesystem could not be captured.")
            return archive_files(b"".join(chunks), include_modes=True)
        finally:
            if process.poll() is None: process.kill()
            process.wait(timeout=5); process.stdout.close()

    def run(self, policy, root, arguments, call_id, cancel, on_event):
        command, seconds = arguments.get("command"), arguments.get("timeoutSeconds", 60)
        if not isinstance(command, str) or not 1 <= len(command) <= 8000 or "\0" in command: raise WorkspaceError("Commands require 1 to 8000 characters without NUL bytes.")
        if type(seconds) is not int or not 1 <= seconds <= 120: raise WorkspaceError("Command timeout must be between 1 and 120 seconds.")
        if policy.get("version") != POLICY_VERSION or not policy.get("available"):
            return {"executed": False, "reason": policy.get("reason", "Isolated commands are unavailable."), "testsRun": False}
        executable, endpoint = policy["executable"], policy["endpoint"]
        info = json.loads(self._call(executable, endpoint, ["info", "--format", "{{json .}}"] ))
        if info.get("ID") != policy["daemonId"] or info.get("OSType") != "linux" or not any("seccomp" in str(x) for x in info.get("SecurityOptions", [])): raise WorkspaceError("The reviewed Docker runtime changed. Preview a new Run step.")
        before = snapshot(root)
        before_modes = {name: (Path(root) / name).stat().st_mode & 0o777 for name in before}
        self.directory.mkdir(parents=True, exist_ok=True)
        directory = Path(tempfile.mkdtemp(prefix="command-", dir=self.directory))
        copied = directory / "input"; copied.mkdir()
        for name, data in before.items():
            target = _checked(copied, name); target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
            target.chmod(0o755 if (Path(root) / name).stat().st_mode & 0o111 else 0o644)
        if "," in str(copied): raise WorkspaceError("The execution data directory cannot contain a comma for Docker mounts.")
        token = uuid4().hex
        container = self._call(executable, endpoint, ["create", *self.restrictions(), "--mount", f"type=bind,source={copied},target=/input,readonly",
            "--label", "planbranch.owner=" + token, "--entrypoint=/usr/bin/env", policy["imageId"], "-i", "PATH=" + CONTAINER_PATH,
            "/bin/sh", "-c", "exec sleep infinity"]).strip()
        if not re.fullmatch(r"[0-9a-f]{64}", container): raise WorkspaceError("Docker returned an invalid container identity.")
        _atomic_json(directory / "container.json", {"container": container, "token": token, "endpoint": endpoint})
        watchdog, after = None, None
        record = {"id": call_id, "command": command, "status": "in_progress", "exitCode": None, "output": ""}
        try:
            watchdog = subprocess.Popen([sys.executable, "-I", str(Path(__file__).with_name("command_watchdog.py"))], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=environment(), creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0, start_new_session=os.name != "nt")
            watchdog.stdin.write((json.dumps({"executable": executable, "endpoint": endpoint, "container": container, "config": str(self.config),
                "token": token, "timeout": seconds + 90}) + "\n").encode()); watchdog.stdin.flush()
            if watchdog.stdout.readline(100).strip() != b"ready": raise WorkspaceError("Container lifetime protection did not start.")
            self._call(executable, endpoint, ["start", container])
            prefix = ["exec", "--user=65534:65534", "--workdir=/workspace", container, "/usr/bin/env", "-i", "PATH=" + CONTAINER_PATH, "HOME=/tmp", "TMPDIR=/tmp"]
            self._call(executable, endpoint, [*prefix, "/bin/sh", "-c", "test \"$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status)\" = 0000000000000000 || exit 92; cp -R /input/. /workspace/ || exit 93; chmod -R u+rwX /workspace; test -w /workspace"])
            on_event({"type": "command", "command": dict(record)})
            def packet(value):
                if value.get("type") in {"stdout", "stderr"}:
                    record["output"] = (record["output"] + value.get("text", ""))[-65536:]
                    on_event({"type": "command", "command": dict(record)})
            outcome = run_supervised(self._args(executable, endpoint, [*prefix, "/bin/sh", "-c", command]), cwd=directory,
                env=environment(), prompt=b"", cancel=cancel, on_packet=packet, timeout=seconds, max_bytes=512000, max_line=65536)
            if outcome["reason"] == "exited": record.update(exitCode=outcome["returncode"], status="completed" if outcome["returncode"] == 0 else "failed")
            else: record["status"] = "cancelled" if cancel.is_set() else "interrupted"
            after, modes = self._archive(executable, endpoint, container)
        finally:
            if watchdog:
                try: watchdog.stdin.close()
                except BrokenPipeError: pass
                watchdog.wait(timeout=25); watchdog.stdout.close()
                if watchdog.returncode != 0: raise WorkspaceError("Container cleanup is uncertain; no copy-back was attempted.")
            else: self._call(executable, endpoint, ["rm", "--force", container])
            on_event({"type": "command", "command": dict(record)})
        if snapshot(root) != before or any((Path(root) / name).stat().st_mode & 0o777 != mode for name, mode in before_modes.items()):
            raise WorkspaceError("The worktree changed during the command; sandbox changes were not copied back.")
        for name in set(before) | set(after): _checked(Path(root), name)
        for name in sorted(set(before) | set(after)):
            if before.get(name) != after.get(name): atomic_write(root, name, after.get(name), digest(before[name]) if name in before else None)
            if name in after and os.name != "nt":
                path = _checked(Path(root), name)
                path.chmod(output_mode(before_modes.get(name), path.stat().st_mode, modes[name]))
        return {"executed": True, "command": record, "sandbox": POLICY_VERSION}
