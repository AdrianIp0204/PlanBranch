"""Repository context endpoints share the application's local API protection."""
from flask import jsonify


def register_repository_context(app, planning, planning_body):
    service = planning.repository_context

    @app.get("/api/projects/<project_id>/planning/context/files")
    def planning_context_files(project_id):
        return jsonify(service.catalogue(project_id))

    @app.post("/api/projects/<project_id>/planning/context/preview")
    def planning_context_preview(project_id):
        return jsonify(service.preview(project_id, planning_body(diagram_field="prompt")))

    @app.post("/api/projects/<project_id>/planning/context/<preview_id>/cancel")
    def planning_context_cancel(project_id, preview_id):
        return jsonify(service.cancel(project_id, preview_id))

    @app.get("/api/projects/<project_id>/planning/context/references/<request_id>")
    def planning_context_references(project_id, request_id):
        return jsonify(service.references(project_id, request_id))
