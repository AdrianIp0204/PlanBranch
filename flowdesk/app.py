"""Same-origin local API and built asset serving."""
import hmac
import json
from pathlib import Path
import secrets
import sqlite3
from contextlib import closing

from flask import Flask, jsonify, request, send_from_directory, Response
from werkzeug.exceptions import HTTPException

from .storage import Store, ConflictError, NotFoundError
from .validation import ValidationError, validate_content
from .scans import ScanService
from .reconciliation import reconcile
from .planning import PlanningService
from .proposal_drafts import DraftConflictError
from .execution import ExecutionService, ExecutionReceiptError
from .operation_notifications import operation_snapshot
from .writing_drafts import WritingDrafts, WritingConflict, MAX_BYTES as WRITING_MAX_BYTES


def create_app(data_dir=None, *, testing=False, planner=None, executor=None, execution_git=None):
    from .__main__ import default_data_dir
    data_dir = Path(data_dir or default_data_dir()).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    app = Flask(__name__, static_folder=None)
    app.config.update(TESTING=testing, DEBUG=False, MAX_CONTENT_LENGTH=32 * 1024 * 1024,
                      TRUSTED_HOSTS=["127.0.0.1", "localhost", "[::1]"])
    token = secrets.token_urlsafe(32)
    store = Store(data_dir / "flowdesk.sqlite3")
    scans = ScanService(store)
    planning = PlanningService(store, planner)
    execution = ExecutionService(store, planning, executor, execution_git)
    writing = WritingDrafts(store)
    app.extensions.update(flowdesk_store=store, flowdesk_scans=scans, flowdesk_planning=planning, flowdesk_execution=execution)

    @app.before_request
    def protect_local_api():
        # Access host here to force Flask's TRUSTED_HOSTS check before any filesystem work.
        host = request.host
        origin = request.headers.get("Origin")
        if origin and origin != f"{request.scheme}://{host}":
            return jsonify(error="This request must come from the PlanBranch window."), 403
        if request.headers.get("Sec-Fetch-Site") == "cross-site":
            return jsonify(error="Cross-site requests are not allowed."), 403
        if request.path.startswith("/api/") and request.path != "/api/bootstrap":
            supplied = request.headers.get("X-FlowDesk-Token", "")
            if not hmac.compare_digest(supplied.encode("utf-8"), token.encode("ascii")):
                return jsonify(error="Reload PlanBranch to reconnect to the local server."), 403

    @app.after_request
    def response_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        )
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.errorhandler(ConflictError)
    def conflict(exc):
        return jsonify(error=str(exc), conflict=True,
                       revision=getattr(exc, "current_revision", None)), 409

    @app.errorhandler(WritingConflict)
    def writing_conflict(exc):
        return jsonify(exc.response), 409

    @app.errorhandler(DraftConflictError)
    def draft_conflict(exc):
        return jsonify(exc.response), 409

    @app.errorhandler(NotFoundError)
    @app.errorhandler(KeyError)
    def missing(exc):
        return jsonify(error="That project or record no longer exists. Reload the project list."), 404

    @app.errorhandler(ValidationError)
    @app.errorhandler(ValueError)
    def invalid(exc):
        return jsonify(error=str(exc)), 400

    @app.errorhandler(RuntimeError)
    def busy(exc):
        return jsonify(error=str(exc)), 409

    @app.errorhandler(ExecutionReceiptError)
    def execution_refusal(exc):
        return jsonify(error=str(exc), executionReceipt=exc.receipt), 409

    @app.errorhandler(OSError)
    @app.errorhandler(sqlite3.Error)
    def storage_error(exc):
        app.logger.error("Local operation failed: %s", exc)
        return jsonify(error="The local operation failed. Check folder permissions and free disk space, then retry."), 503

    @app.errorhandler(HTTPException)
    def http_error(exc):
        return jsonify(error=exc.description), exc.code

    def body():
        value = request.get_json()
        if not isinstance(value, dict):
            raise ValidationError("Expected a JSON object.")
        return value

    @app.get("/api/bootstrap")
    def bootstrap():
        from . import __version__
        return jsonify(token=token, version=__version__)

    @app.get("/api/settings/info")
    def settings_info():
        from . import __version__
        from .migrations import DATABASE_VERSION
        return jsonify(version=__version__, dataDirectory=str(data_dir), schemaVersion=DATABASE_VERSION)

    @app.get("/api/connection")
    def connection():
        # Local capability/sign-in checks only; no prompt or agent run is sent.
        check = getattr(planning.planner, "connection_status", None)
        agent = check(refresh=request.args.get("refresh") == "1") if callable(check) else planning.planner.status()
        return jsonify(agent=agent)

    @app.get("/api/projects")
    def projects():
        return jsonify(projects=store.list_projects())

    @app.post("/api/projects")
    def create_project():
        data = body()
        if data.get("sample") is True:
            from .sample import sample_content
            return jsonify(store.create_project(content=sample_content())), 201
        if "content" in data:
            # Copies carry evidence only as historical facts, never source permission.
            from .exports import remap_project, portable_symbols
            content_to_copy = validate_content(data["content"])
            evidence = []
            for link in content_to_copy["nodeLinks"]:
                if link.get("origin") == "detected":
                    evidence.append(link["variableId"])
            evidence += [m["symbolId"] for m in content_to_copy["matches"]]
            with closing(store.connect()) as db:
                records = [json.loads(row[0]) for sid in set(evidence)
                           if (row := db.execute("SELECT data FROM detected_symbols WHERE id=?", (sid,)).fetchone())]
            content, symbols, _ = remap_project(content_to_copy, portable_symbols(records), {})
            return jsonify(store.create_project(content=content, evidence=symbols)), 201
        return jsonify(store.create_project(name=data.get("name", "Untitled project"))), 201

    @app.get("/api/projects/<project_id>")
    def get_project(project_id):
        return jsonify(store.get_project(project_id))

    @app.put("/api/projects/<project_id>")
    def save_project(project_id):
        return jsonify(store.save_project(project_id, body()))

    @app.delete("/api/projects/<project_id>")
    def delete_project(project_id):
        data = body()
        if data.get("confirmed") is not True:
            raise ValidationError("Confirm deletion before deleting a planning project.")
        store.delete_project(project_id, data.get("revision"))
        return jsonify(deleted=True)

    @app.post("/api/backup")
    def backup():
        filename = Path(store.backup()).name
        return jsonify(filename=filename)

    def planning_body(*, diagram_field=None):
        fields = (diagram_field,) if isinstance(diagram_field, str) else diagram_field
        raw = request.get_data(cache=True)
        if diagram_field is not None and len(raw) > 2_000_000 + 65536:
            raise ValidationError("Proposal requests must be smaller than 2 MB plus message metadata.")
        if diagram_field is None and len(raw) > 65536:
            raise ValidationError("Planning requests must be smaller than 64 KB.")
        data = body()
        if fields is not None and not any(field in data for field in fields) and len(raw) > 65536:
            raise ValidationError("Planning requests must be smaller than 64 KB.")
        return data

    @app.get("/api/planning/capabilities")
    def planning_capabilities():
        return jsonify(planning.capabilities())

    @app.post("/api/planning/capabilities/refresh")
    def refresh_planning_capabilities():
        return jsonify(planning.capabilities(refresh=True))

    @app.get("/api/projects/<project_id>/operations")
    def get_operations(project_id):
        return jsonify(operation_snapshot(store, project_id))

    @app.get("/api/projects/<project_id>/planning")
    def get_planning(project_id):
        return jsonify(planning.state(project_id))

    @app.get("/api/projects/<project_id>/planning/writing")
    def get_writing(project_id):
        return jsonify(writing.get(project_id))

    @app.put("/api/projects/<project_id>/planning/writing")
    def save_writing(project_id):
        if len(request.get_data(cache=True)) > WRITING_MAX_BYTES + 65536:
            raise ValidationError("Unsent writing requests must be smaller than 6 MB.")
        return jsonify(writing.save(project_id, body()))

    @app.delete("/api/projects/<project_id>/planning/writing/copies/<draft_id>")
    def discard_writing_copy(project_id, draft_id):
        return jsonify(writing.discard_copy(project_id, draft_id, planning_body()))

    @app.post("/api/projects/<project_id>/planning/messages")
    def planning_message(project_id):
        return jsonify(planning.send_message(project_id, planning_body(diagram_field=("proposalDiagram", "proposalBrief", "proposalBuildTasks")))), 202

    @app.post("/api/projects/<project_id>/planning/questions/<set_id>/answers")
    def planning_answers(project_id, set_id):
        return jsonify(planning.answer_questions(project_id, set_id, planning_body())), 202

    @app.post("/api/projects/<project_id>/planning/comments")
    def planning_comment(project_id):
        return jsonify(planning.add_comment(project_id, planning_body())), 201

    @app.patch("/api/projects/<project_id>/planning/comments/<comment_id>")
    def planning_comment_resolution(project_id, comment_id):
        return jsonify(planning.resolve_comment(project_id, comment_id, planning_body()))

    @app.get("/api/projects/<project_id>/planning/proposals/<proposal_id>")
    def planning_proposal_detail(project_id, proposal_id):
        return jsonify(planning.proposal_detail(project_id, proposal_id))

    @app.get("/api/projects/<project_id>/planning/proposals/<proposal_id>/drafts")
    def list_proposal_drafts(project_id, proposal_id):
        return jsonify(planning.drafts.list(project_id, proposal_id))

    @app.get("/api/projects/<project_id>/planning/proposals/<proposal_id>/drafts/<draft_id>")
    def get_proposal_draft(project_id, proposal_id, draft_id):
        return jsonify(planning.drafts.get(project_id, proposal_id, draft_id))

    @app.put("/api/projects/<project_id>/planning/proposals/<proposal_id>/drafts/<draft_id>")
    def save_proposal_draft(project_id, proposal_id, draft_id):
        return jsonify(planning.drafts.save(project_id, proposal_id, draft_id, planning_body(diagram_field=("diagram", "brief", "buildTasks"))))

    @app.post("/api/projects/<project_id>/planning/proposals/<proposal_id>/drafts/<draft_id>/prepare-apply")
    def prepare_proposal_apply(project_id, proposal_id, draft_id):
        return jsonify(planning.drafts.prepare(project_id, proposal_id, draft_id, planning_body()))

    @app.post("/api/projects/<project_id>/planning/proposals/<proposal_id>/drafts/<draft_id>/cancel-apply")
    def cancel_proposal_apply(project_id, proposal_id, draft_id):
        return jsonify(planning.drafts.finish(project_id, proposal_id, draft_id, planning_body()))

    @app.post("/api/projects/<project_id>/planning/proposals/<proposal_id>/drafts/<draft_id>/discard")
    def discard_proposal_draft(project_id, proposal_id, draft_id):
        return jsonify(planning.drafts.finish(project_id, proposal_id, draft_id, planning_body(), discard=True))

    @app.post("/api/projects/<project_id>/planning/proposals/<proposal_id>/accept")
    def accept_planning_proposal(project_id, proposal_id):
        return jsonify(planning.accept(project_id, proposal_id, planning_body(diagram_field="diagram")))

    @app.post("/api/projects/<project_id>/planning/proposals/<proposal_id>/reject")
    def reject_planning_proposal(project_id, proposal_id):
        return jsonify(planning.reject(project_id, proposal_id, planning_body()))

    @app.post("/api/projects/<project_id>/planning/approve")
    def approve_plan(project_id):
        return jsonify(planning.approve(project_id, planning_body()))

    @app.post("/api/projects/<project_id>/planning/reopen")
    def reopen_plan(project_id):
        return jsonify(planning.reopen(project_id, planning_body()))

    @app.get("/api/projects/<project_id>/execution")
    def get_execution(project_id):
        return jsonify(execution.state(project_id))

    @app.post("/api/projects/<project_id>/execution/repository")
    def select_execution_repository(project_id):
        return jsonify(execution.repository(project_id, planning_body()))

    @app.post("/api/projects/<project_id>/execution/preview")
    def preview_execution(project_id):
        return jsonify(execution.preview(project_id, planning_body()))

    @app.post("/api/projects/<project_id>/execution/runs")
    def run_execution(project_id):
        return jsonify(execution.start(project_id, planning_body())), 202

    @app.get("/api/projects/<project_id>/execution/runs/<run_id>")
    def execution_detail(project_id, run_id):
        return jsonify(execution.detail(project_id, run_id))

    @app.post("/api/projects/<project_id>/execution/runs/<run_id>/<action>")
    def execution_action(project_id, run_id, action):
        actions = {"cancel": execution.cancel, "refresh": execution.refresh, "accept": execution.accept,
                   "complete": execution.complete, "apply": execution.apply}
        if action not in actions:
            raise NotFoundError("Unknown execution action.")
        return jsonify(actions[action](project_id, run_id, planning_body()))

    @app.get("/api/projects/<project_id>/source")
    def source(project_id):
        store.get_project(project_id)
        return jsonify(scans.attachment(project_id))

    @app.post("/api/projects/<project_id>/source")
    def attach(project_id):
        store.get_project(project_id)
        data = body()
        return jsonify(scans.attach(project_id, data.get("root", ""), data.get("ignores", []), data.get("confirmed")))

    @app.post("/api/projects/<project_id>/scans")
    def scan(project_id):
        store.get_project(project_id)
        return jsonify(scans.start(project_id)), 202

    @app.get("/api/projects/<project_id>/scans/<scan_id>")
    def scan_status(project_id, scan_id):
        return jsonify(scans.status(project_id, scan_id))

    @app.post("/api/projects/<project_id>/scans/<scan_id>/cancel")
    def cancel_scan(project_id, scan_id):
        result = scans.cancel(project_id, scan_id)
        return jsonify(result or {"cancelled": True})

    @app.get("/api/projects/<project_id>/symbols")
    def symbols(project_id):
        store.get_project(project_id)
        return jsonify(symbols=scans.symbols(project_id))

    @app.get("/api/projects/<project_id>/symbols/<symbol_id>/preview")
    def preview(project_id, symbol_id):
        return jsonify(scans.preview(project_id, symbol_id))

    @app.get("/api/projects/<project_id>/reconciliation")
    def reconciliation(project_id):
        return jsonify(reconcile(store.get_project(project_id)["content"], scans.symbols(project_id)))

    @app.get("/api/projects/<project_id>/export/<format>")
    def export_project(project_id, format):
        from .exports import portable_project, markdown_brief, serialize_portable
        envelope = store.get_project(project_id)
        if format == "json":
            portable = portable_project(envelope, scans.symbols(project_id))
            text, mime, ext = serialize_portable(portable), "application/json", "json"
        elif format == "markdown":
            text, mime, ext = markdown_brief(envelope["content"]), "text/markdown", "md"
        else:
            raise ValidationError("Choose JSON or Markdown export.")
        return Response(text, mimetype=mime, headers={"Content-Disposition": f'attachment; filename="flowdesk-project.{ext}"'})

    @app.post("/api/import")
    def import_project():
        from .exports import import_project as import_document, check_portable_size
        check_portable_size(request.get_data(cache=True))
        return jsonify(import_document(store, body())), 201

    @app.get("/")
    @app.get("/<path:asset>")
    def frontend(asset="index.html"):
        if asset.startswith("api/"):
            return jsonify(error="Unknown API route."), 404
        packaged = Path(__file__).parent / "static"
        checkout_build = Path(__file__).parent.parent / "frontend" / "dist"
        built = checkout_build if (checkout_build / "index.html").exists() else packaged
        if not (built / "index.html").exists():
            return Response("PlanBranch assets have not been built. Run npm ci and npm run build in frontend, then reload.", status=503, mimetype="text/plain")
        return send_from_directory(built, asset)

    return app
