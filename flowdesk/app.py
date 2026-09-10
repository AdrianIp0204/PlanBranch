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


def create_app(data_dir=None, *, testing=False):
    from .__main__ import default_data_dir
    data_dir = Path(data_dir or default_data_dir()).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    app = Flask(__name__, static_folder=None)
    app.config.update(TESTING=testing, DEBUG=False, MAX_CONTENT_LENGTH=32 * 1024 * 1024,
                      TRUSTED_HOSTS=["127.0.0.1", "localhost", "[::1]"])
    token = secrets.token_urlsafe(32)
    store = Store(data_dir / "flowdesk.sqlite3")
    scans = ScanService(store)
    app.extensions.update(flowdesk_store=store, flowdesk_scans=scans)

    @app.before_request
    def protect_local_api():
        # Access host here to force Flask's TRUSTED_HOSTS check before any filesystem work.
        host = request.host
        origin = request.headers.get("Origin")
        if origin and origin != f"{request.scheme}://{host}":
            return jsonify(error="This request must come from the FlowDesk window."), 403
        if request.headers.get("Sec-Fetch-Site") == "cross-site":
            return jsonify(error="Cross-site requests are not allowed."), 403
        if request.path.startswith("/api/") and request.path != "/api/bootstrap":
            supplied = request.headers.get("X-FlowDesk-Token", "")
            if not hmac.compare_digest(supplied.encode("utf-8"), token.encode("ascii")):
                return jsonify(error="Reload FlowDesk to reconnect to the local server."), 403

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
        return jsonify(token=token, version="0.1.0")

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
            return Response("FlowDesk assets have not been built. Run npm ci and npm run build in frontend, then reload.", status=503, mimetype="text/plain")
        return send_from_directory(built, asset)

    return app
