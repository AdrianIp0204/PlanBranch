"""Owned execution lifetime; this is process supervision, not the Codex sandbox."""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import time


class ExecutionProcessError(RuntimeError):
    pass


class WindowsJob:
    """A non-inherited kernel handle whose owner's death kills every member."""
    def __init__(self):
        import ctypes
        from ctypes import wintypes
        class Basic(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]
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
            raise ExecutionProcessError("Windows could not create an execution supervisor. No coding process was started.")
        limits = Extended()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close()
            raise ExecutionProcessError("Windows could not protect the execution lifetime. No coding process was started.")

    def assign(self, process):
        if not self.kernel.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise ExecutionProcessError("Windows could not isolate the coding process lifetime. No coding process was started.")

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def run_supervised(args, *, cwd, env, prompt, cancel, on_packet, timeout=1800,
                   max_bytes=8_000_000, max_line=512_000):
    """Stream private worker packets; never adopt or kill PIDs from saved state."""
    job, worker = None, None
    inbox = queue.Queue(maxsize=128)
    abandoned = threading.Event()
    helper = Path(__file__).with_name("executor_worker.py").resolve()
    if not helper.is_file():
        raise ExecutionProcessError("PlanBranch's execution supervisor is missing. Reinstall the application.")
    payload = json.dumps({"args": args, "cwd": str(cwd), "env": env,
        "prompt": base64.b64encode(prompt).decode("ascii"), "timeout": timeout,
        "maxBytes": max_bytes, "maxLine": max_line}).encode("utf-8") + b"\n"
    if len(payload) > 2_000_000:
        raise ExecutionProcessError("The execution request is too large. Reduce the selected task context.")
    try:
        if os.name == "nt":
            job = WindowsJob()
        worker = subprocess.Popen([sys.executable, "-I", str(helper)], cwd=helper.parent, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, shell=False,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            start_new_session=os.name != "nt")
        if job:
            # Worker has no task input and cannot spawn Codex before assignment.
            job.assign(worker)

        def enqueue(value):
            while not abandoned.is_set():
                try:
                    inbox.put(value, timeout=.1)
                    return
                except queue.Full:
                    pass

        def read():
            try:
                while line := worker.stdout.readline(max_line * 6 + 4096):
                    if not line.endswith(b"\n"):
                        enqueue({"type": "worker_error", "reason": "output_limit"})
                        break
                    try:
                        packet = json.loads(line)
                        if not isinstance(packet, dict):
                            raise ValueError
                    except (ValueError, RecursionError):
                        enqueue({"type": "worker_error", "reason": "protocol"})
                        break
                    enqueue(packet)
            finally:
                enqueue(None)

        def start():
            try:
                worker.stdin.write(payload)
                worker.stdin.flush()
            except (OSError, ValueError):
                enqueue({"type": "worker_error", "reason": "start_failed"})

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        threading.Thread(target=start, daemon=True).start()
        deadline = time.monotonic() + timeout + 5
        while True:
            if cancel.is_set():
                return {"reason": "cancelled", "returncode": None}
            if time.monotonic() >= deadline:
                return {"reason": "timeout", "returncode": None}
            try:
                packet = inbox.get(timeout=.05)
            except queue.Empty:
                continue
            if packet is None:
                return {"reason": "interrupted", "returncode": None}
            if packet.get("type") == "worker_error":
                return {"reason": packet.get("reason", "interrupted"), "returncode": None}
            if packet.get("type") == "exit":
                return {"reason": "exited", "returncode": packet.get("returncode")}
            on_packet(packet)
    except OSError:
        raise ExecutionProcessError("The execution supervisor could not start. No coding process was started.") from None
    finally:
        abandoned.set()
        if job:
            job.close()  # kills descendants, including background processes
        elif worker is not None and worker.poll() is None and os.name != "nt":
            try:
                os.killpg(worker.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if worker is not None:
            if worker.poll() is None:
                worker.kill()
            worker.wait(timeout=5)
            for pipe in (worker.stdin, worker.stdout):
                try:
                    pipe.close()
                except OSError:
                    pass
