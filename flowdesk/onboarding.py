"""Offline demonstration and capability diagnostics; neither grants execution."""
from contextlib import closing
import os
import shutil

from flask import jsonify, request

from .sample import sample_content
from .validation import ValidationError


def example():
    return {
        "schemaVersion": 1,
        "origin": "demonstration",
        "label": "Illustrative example — no commands were run and no repository is attached.",
        "request": "Import valid records, skip malformed rows, and report the number saved.",
        "content": sample_content(guided=True),
        "proposal": {
            "title": "Validate before saving",
            "before": ["Read record", "Save record"],
            "after": ["Read record", "Validate required identifier", "Save valid / skip invalid"],
            "decision": "Reject malformed records before any storage write. Continue with the next row.",
            "alternative": "Stop the entire batch at the first malformed record.",
        },
        "change": {
            "file": "importer.py",
            "diff": "--- a/importer.py\n+++ b/importer.py\n@@ -1,3 +1,5 @@\n def process_records(rows, save):\n     for row in rows:\n+        if not row.get('id'):\n+            continue\n         save(row)\n",
        },
        "evidence": {
            "origin": "demonstration", "state": "Illustrative pass (not observed)",
            "command": "python -m pytest tests/test_importer.py",
            "output": "Illustrative output: 2 passed. No process was started.",
            "candidate": "demo-candidate-v1 (illustrative identity, not a Git revision)",
            "uncertainty": "The sample checks cover valid and missing identifiers only. Retry safety and storage failures still need review.",
        },
    }


def setup_snapshot(store, registry, project_id=None, provider="codex", refresh=False):
    if provider not in {"codex", "ollama", "openai", "anthropic", "gemini"}:
        raise ValidationError("Choose a supported planning provider.")
    # status() uses local discovery or key presence; it never makes paid requests.
    agent = registry.status(provider, refresh=refresh)
    repository = None
    if project_id:
        with closing(store.connect()) as db:
            store._row(db, project_id)
            repository = db.execute("SELECT repository FROM execution_repositories WHERE project_id=?", (project_id,)).fetchone()
    git = bool(shutil.which("git"))
    configured = bool(agent.get("available"))
    cloud = provider in {"openai", "anthropic", "gemini"}
    return {
        "schemaVersion": 1,
        "capabilities": [
            {"id": "visual", "label": "Visual planning", "state": "available", "detail": "Diagrams, briefs, checkpoints and the guided example work offline."},
            {"id": "planning", "label": "AI planning", "state": "unverified" if cloud and configured else "available" if configured else "requires_setup",
             "detail": agent.get("reason") or ("Local provider discovery succeeded; model generation has not been tested." if configured else "Connect a provider in Settings → Agent."),
             "provider": provider},
            {"id": "editing", "label": "Code editing", "state": "configured" if repository and git else "requires_setup",
             "detail": "An execution repository is selected. Each Run still checks source, approval and provider readiness." if repository and git else
             "Select a Git repository in Build → Run step. Git must be installed. Scanner access is a separate read-only permission."},
            {"id": "checks", "label": "Running checks", "state": "not_checked",
             "detail": "Native providers require local Docker and an existing PLANBRANCH_EXECUTION_IMAGE. Check the runtime explicitly below. Codex uses its separately checked executor."},
        ],
        "gitInstalled": git,
        "runtimeConfigured": bool(shutil.which("docker") and os.environ.get("PLANBRANCH_EXECUTION_IMAGE", "").strip()),
        "bundled": "Portable builds bundle Python and the interface. Git, models, Codex, Docker, images and credentials are separate.",
    }


def register_onboarding(app, store, registry):
    @app.get("/api/onboarding/example")
    def offline_example():
        return jsonify(example())

    @app.get("/api/setup")
    def setup():
        return jsonify(setup_snapshot(store, registry, request.args.get("projectId"), request.args.get("provider", "codex"), request.args.get("refresh") == "1"))

    @app.post("/api/setup/runtime")
    def setup_runtime():
        body = request.get_json()
        if not isinstance(body, dict) or body != {"confirmed": True}:
            raise ValidationError("Confirm the isolated runtime probe. It uses only an existing image and never installs software.")
        from .command_runner import DockerCommandRunner
        policy = DockerCommandRunner(store.db_path.parent).configure()
        # No daemon path or host-specific executable needs to leave this endpoint.
        return jsonify(available=policy["available"], reason=policy.get("reason", "The configured isolated runtime probe passed. Each run checks it again."),
                       image=policy.get("imageLabel"), policyVersion=policy["version"])
