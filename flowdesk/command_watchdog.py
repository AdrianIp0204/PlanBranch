"""Private container lifetime owner: closes only its identified container on EOF.

Started with Python -I outside the command supervisor's job/process group. Its
only authority is the supplied container ID plus an unguessable ownership label.
"""
import json
import os
import queue
import re
import subprocess
import sys
import threading


def main():
    try:
        config = json.loads(sys.stdin.buffer.readline(16384))
        executable, endpoint, container, token = (config[k] for k in ("executable", "endpoint", "container", "token"))
        if not os.path.isabs(executable) or not re.fullmatch(r"[0-9a-f]{64}", container) or not re.fullmatch(r"[0-9a-f]{32}", token):
            return 2
        if not endpoint.startswith(("unix:///", "npipe:////./pipe/")):
            return 2
        timeout = min(max(int(config["timeout"]), 1), 300)
    except (ValueError, KeyError, TypeError):
        return 2
    command = [executable, "--config", config["config"], "--host", endpoint]
    options = {"capture_output": True, "timeout": 10, "creationflags": subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0}
    signal = queue.Queue()
    def watch_owner():
        try:
            sys.stdin.buffer.read(1)
        finally:
            signal.put(True)
    threading.Thread(target=watch_owner, daemon=True).start()
    print("ready", flush=True)
    try:
        signal.get(timeout=timeout)
    except queue.Empty:
        pass
    try:
        inspected = subprocess.run(command + ["inspect", "--format", '{{index .Config.Labels "planbranch.owner"}}', container], **options)
        if inspected.returncode == 0 and inspected.stdout.decode().strip() == token:
            removed = subprocess.run(command + ["rm", "--force", container], **options)
            return 0 if removed.returncode == 0 else 3
        return 3
    except (OSError, subprocess.TimeoutExpired):
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
