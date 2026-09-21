"""Private stdlib-only worker. Launched by absolute path with Python -I.

The parent assigns this blocked worker to its Windows job before sending input.
On POSIX this worker owns a process group and kills it when the owner pipe closes.
No repository Python modules or startup files are imported.
"""
from __future__ import annotations

import base64
import json
import os
import signal
import subprocess
import sys
import threading
import time

MAX_START_BYTES = 2_000_000


def main():
    line = sys.stdin.buffer.readline(MAX_START_BYTES + 1)
    if not line.endswith(b"\n") or len(line) > MAX_START_BYTES:
        return 2
    try:
        config = json.loads(line)
        args, cwd, env = config["args"], config["cwd"], config["env"]
        prompt = base64.b64decode(config["prompt"], validate=True)
        timeout = min(float(config["timeout"]), 1800)
        max_bytes = min(int(config["maxBytes"]), 8_000_000)
        max_line = min(int(config["maxLine"]), 512_000)
        if not isinstance(args, list) or not args or not all(isinstance(a, str) for a in args):
            return 2
        if not isinstance(cwd, str) or not isinstance(env, dict) or timeout <= 0 or max_bytes <= 0 or max_line <= 0:
            return 2
    except (ValueError, TypeError, KeyError):
        return 2
    stop = threading.Event()
    write_lock = threading.Lock()
    count_lock = threading.Lock()
    state = {"bytes": 0, "reason": None}

    def emit(packet):
        try:
            with write_lock:
                sys.stdout.buffer.write(json.dumps(packet, ensure_ascii=True).encode("ascii") + b"\n")
                sys.stdout.buffer.flush()
        except (BrokenPipeError, OSError):
            stop.set()

    def cancel(reason):
        if state["reason"] is None:
            state["reason"] = reason
        stop.set()

    def watch_owner():
        # The parent retains the only write end. EOF includes hard parent death.
        while sys.stdin.buffer.readline(512):
            cancel("cancelled")
        cancel("owner_closed")

    threading.Thread(target=watch_owner, daemon=True).start()
    if stop.is_set():
        return 0
    try:
        process = subprocess.Popen(args, cwd=cwd, env=env, shell=False,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    except OSError:
        emit({"type": "worker_error", "reason": "start_failed"})
        return 2

    def count(chunk):
        with count_lock:
            state["bytes"] += len(chunk)
            if state["bytes"] > max_bytes:
                cancel("output_limit")
                return False
        return True

    def read_stdout():
        try:
            while chunk := process.stdout.readline(max_line + 1):
                if not count(chunk) or len(chunk) > max_line:
                    cancel("output_limit")
                    return
                emit({"type": "stdout", "text": chunk.decode("utf-8", errors="replace")})
        finally:
            process.stdout.close()

    def read_stderr():
        try:
            while chunk := process.stderr.read1(4096):
                if not count(chunk):
                    return
                emit({"type": "stderr", "text": chunk.decode("utf-8", errors="replace")})
        finally:
            process.stderr.close()

    def write_prompt():
        try:
            process.stdin.write(prompt)
            process.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            process.stdin.close()

    threads = [threading.Thread(target=fn, daemon=True) for fn in (read_stdout, read_stderr, write_prompt)]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + timeout
    try:
        while process.poll() is None and not stop.wait(.03):
            if time.monotonic() >= deadline:
                cancel("timeout")
        if stop.is_set():
            emit({"type": "worker_error", "reason": state["reason"] or "cancelled"})
        else:
            for thread in threads:
                thread.join(timeout=1)
            if any(thread.is_alive() for thread in threads):
                # A descendant may still own a stream, or a consumer may have
                # stopped draining it. Never announce a confirmed finish while
                # command evidence could still be pending in another thread.
                cancel("interrupted")
            if stop.is_set():
                emit({"type": "worker_error", "reason": state["reason"] or "cancelled"})
            else:
                emit({"type": "exit", "returncode": process.returncode})
    finally:
        # Also remove background descendants after a normal agent exit. The
        # parent closes the Windows job; POSIX kills the still-owned group.
        if os.name != "nt":
            os.killpg(os.getpgrp(), signal.SIGKILL)
        elif process.poll() is None:
            process.kill()
            process.wait(timeout=3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
