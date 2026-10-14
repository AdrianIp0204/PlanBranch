"""New workflows are available through the authenticated local application API."""
from uuid import uuid4

from flowdesk.app import create_app
from flowdesk.sample import sample_content
from test_build_tasks import task
from test_planning import FakePlanner


def test_checkpoint_and_offline_handoff_routes_are_live_and_local_only(tmp_path):
    app = create_app(tmp_path, testing=True, planner=FakePlanner())
    try:
        store = app.extensions["flowdesk_store"]
        content = sample_content()
        content["buildTasks"] = [task()]
        project = store.create_project(content=content)
        client = app.test_client()
        base = f"/api/projects/{project['id']}"
        assert client.get(base + "/plans").status_code == 403
        token = client.get("/api/bootstrap").json["token"]
        client.environ_base["HTTP_X_FLOWDESK_TOKEN"] = token
        assert client.get(base + "/plans").json["alternatives"] == []
        response = client.post(base + "/plans/checkpoint", json={"mutationId": str(uuid4()), "baseRevision": 0, "name": "Offline baseline"})
        assert response.status_code == 200, response.json
        saved = response.json["snapshotId"]
        assert client.get(base + "/plans/snapshots/" + saved).json["content"] == project["content"]
        assert client.get(base + "/plans/snapshots/" + saved + "/compare").json["changes"] == []
        payload = {"taskId": content["buildTasks"][0]["id"], "baseRevision": 0}
        assert client.post(base + "/handoffs", json=payload).status_code == 400
        assert client.post(base + "/planning/approve", json={"baseRevision": 0, "mutationId": str(uuid4())}).status_code == 200
        package = client.post(base + "/handoffs", json=payload)
        assert package.status_code == 200, package.json
        assert package.json["manifest"]["baseCommit"] is None
        assert package.json["manifest"]["sourceIncluded"] is False
        assert len(client.get(base + "/handoffs", query_string={"taskId": payload["taskId"]}).json["handoffs"]) == 1
        assert client.post(base + "/plans/checkpoint", json={"mutationId": str(uuid4()), "baseRevision": 0, "name": "Forbidden"}, headers={"Origin": "https://external.invalid"}).status_code == 403
    finally:
        app.extensions["flowdesk_execution"].close()
