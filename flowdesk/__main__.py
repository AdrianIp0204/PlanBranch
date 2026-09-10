"""Local launcher. No debug server, externally accessible binding, or telemetry."""
import argparse
import os
from pathlib import Path
import sys


def default_data_dir():
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "FlowDesk"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "flowdesk"


def main():
    parser = argparse.ArgumentParser(description="FlowDesk local programming planner")
    parser.add_argument("command", nargs="?", choices=["serve", "backup"], default="serve")
    parser.add_argument("--data-dir", type=Path, default=default_data_dir())
    parser.add_argument("--port", type=int, default=4310)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    from .storage import Store
    args.data_dir.mkdir(parents=True, exist_ok=True)
    if args.command == "backup":
        print(Store(args.data_dir / "flowdesk.sqlite3").backup())
        return
    from .app import create_app
    from waitress import serve
    app = create_app(args.data_dir)
    print(f"FlowDesk: http://127.0.0.1:{args.port}", flush=True)
    print(f"Data: {args.data_dir.resolve()}", flush=True)
    try:
        serve(app, host="127.0.0.1", port=args.port, max_request_body_size=32 * 1024 * 1024)
    except OSError as exc:
        print(f"Unable to start FlowDesk: {exc}. Try another --port.", file=sys.stderr)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
