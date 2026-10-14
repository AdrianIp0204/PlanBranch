"""An offline example cannot become execution evidence or an authorization."""
from contextlib import closing

from flowdesk.app import create_app
from flowdesk.onboarding import example, setup_snapshot
from flowdesk.storage import Store


class OfflineRegistry:
    def status(self, provider, refresh=False):
        return {"available": False, "reason": "No model is connected."}


def test_demo_is_labelled_and_has_real_brief_task_links_without_observations():
    demo = example()
    assert demo["origin"] == demo["evidence"]["origin"] == "demonstration"
    assert "No process" in demo["evidence"]["output"]
    content = demo["content"]
    assert content["brief"]["requirements"]
    first, second = content["buildTasks"]
    assert second["prerequisiteIds"] == [first["id"]]
    assert all(c["id"] and c["text"] for c in first["acceptanceChecks"])
    assert first["nodeLinks"][0]["nodeId"] in {n["id"] for d in content["diagrams"] for n in d["nodes"]}


def test_setup_requires_actual_capabilities_and_key_presence_is_unverified(tmp_path, monkeypatch):
    store = Store(tmp_path / "store.sqlite3")
    monkeypatch.setattr("flowdesk.onboarding.shutil.which", lambda _: None)
    result = setup_snapshot(store, OfflineRegistry())
    states = {x["id"]: x["state"] for x in result["capabilities"]}
    assert states == {"visual": "available", "planning": "requires_setup", "editing": "requires_setup", "checks": "not_checked"}
    class KeyOnly:
        def status(self, *a, **kw): return {"available": True, "verified": False}
    assert setup_snapshot(store, KeyOnly(), provider="openai")["capabilities"][1]["state"] == "unverified"


def test_reading_resettable_example_creates_no_state_and_probes_require_confirmation(tmp_path, monkeypatch):
    app = create_app(tmp_path, testing=True)
    client = app.test_client()
    assert client.get("/api/onboarding/example").status_code == 403
    client.environ_base["HTTP_X_FLOWDESK_TOKEN"] = client.get("/api/bootstrap").json["token"]
    for _ in range(2):
        assert client.get("/api/onboarding/example").json["origin"] == "demonstration"
    assert client.get("/api/projects").json["projects"] == []
    calls = []
    monkeypatch.setattr("flowdesk.command_runner.DockerCommandRunner.configure", lambda _: calls.append(1) or {"version": "test", "available": False, "reason": "Install a runtime explicitly."})
    assert client.post("/api/setup/runtime", json={}).status_code == 400
    assert not calls
    assert client.post("/api/setup/runtime", json={"confirmed": True}).json["available"] is False
    assert calls == [1]
    project = client.post("/api/projects", json={"sample": True, "guided": True}).json
    assert project["content"]["buildTasks"]
    store = app.extensions["flowdesk_store"]
    with closing(store.connect()) as db:
        for table in ("planning_approvals", "execution_runs", "execution_repositories", "source_attachments"):
            assert db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
    app.extensions["flowdesk_execution"].close()
