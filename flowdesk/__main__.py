"""Local launcher. No debug server, externally accessible binding, or telemetry."""
import argparse
import os
from pathlib import Path
import sys
from datetime import datetime, timezone


def default_data_dir():
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "FlowDesk"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "flowdesk"


def _run(args):
    from .storage import Store
    args.data_dir.mkdir(parents=True, exist_ok=True)
    if args.command == "backup":
        print(Store(args.data_dir / "flowdesk.sqlite3").backup())
        return
    from .app import create_app
    from waitress import serve
    app = create_app(args.data_dir)
    print(f"PlanBranch: http://127.0.0.1:{args.port}", flush=True)
    print(f"Data: {args.data_dir.resolve()}", flush=True)
    serve(app, host="127.0.0.1", port=args.port, max_request_body_size=32 * 1024 * 1024)


def startup_failure(args, exc):
    message = f"Unable to start PlanBranch ({type(exc).__name__}): {str(exc)[:2000]}"
    hint = "Check the data folder permissions, installed package, and --port. See docs/User_Guide.md for troubleshooting."
    print(message + "\n" + hint, file=sys.stderr, flush=True)
    # Best effort: startup must still explain failure when the data directory is
    # itself unavailable. This log contains no environment or provider credentials.
    try:
        args.data_dir.mkdir(parents=True, exist_ok=True)
        log = args.data_dir / "startup.log"
        if log.exists() and log.stat().st_size > 128_000:
            log.replace(args.data_dir / "startup.previous.log")
        with log.open("a", encoding="utf-8") as stream:
            stream.write(datetime.now(timezone.utc).isoformat() + " " + message + "\n")
        print(f"Startup log: {log.resolve()}", file=sys.stderr, flush=True)
    except OSError:
        print("The startup log could not be written. Run the launcher in a terminal to retain this message.", file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser(description="PlanBranch visual AI coding planner")
    parser.add_argument("command", nargs="?", choices=["serve", "backup"], default="serve")
    parser.add_argument("--data-dir", type=Path, default=default_data_dir())
    parser.add_argument("--port", type=int, default=4310)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    try:
        _run(args)
    except Exception as exc:
        startup_failure(args, exc)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
