"""Service-level provider attribution, recovery and cancellation regressions."""
from contextlib import closing
from copy import deepcopy
import hashlib
import threading
import time
from uuid import uuid4

import pytest

from flowdesk.app import create_app
from flowdesk.planning import PlanningService
from flowdesk.providers import ProviderRegistry, normalize_selection
from flowdesk.storage import Store
from flowdesk.validation import ValidationError
from flowdesk.writing_drafts import WritingDrafts, empty_writing


SELECTION = {"provider": "ollama", "mode": "explicit", "model": "fixture:small", "reasoningEffort": None}


class FixtureRegistry(ProviderRegistry):
    def __init__(self, directory):
        super().__init__(directory)
        self.configured = []
        self.contexts = []
        self.fail_once = False
        self.started = threading.Event()
        self.release = threading.Event()
        self.block_first = False
        self.cancel_event = None

    def status(self, provider="codex"):
        return {"available": provider != "codex", "label": provider}

    def configure(self, selection, purpose="planning"):
        self.configured.append(deepcopy(selection))
        instructions = "Disposable provider fixture instructions."
        return {"provider": selection.get("provider", "codex"), "selection": normalize_selection(selection),
                "cliVersion": None, "instructionVersion": "fixture-provider-v1", "protocolVersion": 4,
                "instructions": instructions, "instructionHash": hashlib.sha256(instructions.encode()).hexdigest()}

    def generate(self, context, cancel=None):
        self.contexts.append(deepcopy(context))
        index = len(self.contexts)
        self.started.set()
        if self.block_first and index == 1:
            self.cancel_event = cancel
            assert self.release.wait(10)
        if self.fail_once:
            self.fail_once = False
            raise RuntimeError("Synthetic interrupted connection")
        return {"protocolVersion": 4, "kind": "reply", "message": "late" if self.block_first and index == 1 else "Reply",
                "questions": [], "proposal": None}


def request(project):
    return {"mutationId": str(uuid4()), "text": "Plan a disposable example", "diagramId": project["content"]["diagrams"][0]["id"], "selection": deepcopy(SELECTION)}


def settled(service, project_id):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        state = service.state(project_id)
        if state["request"] and state["request"]["status"] != "running":
            return state
        time.sleep(.02)
    raise AssertionError("Planning did not finish")


def test_provider_retry_attribution_restart_and_unchanged_manual_history(tmp_path):
    store = Store(tmp_path / "data.sqlite3")
    project = store.create_project()
    registry = FixtureRegistry(tmp_path)
    registry.fail_once = True
    service = PlanningService(store, registry)
    payload = request(project)
    service.send_message(project["id"], payload)
    assert settled(service, project["id"])["request"]["status"] == "failed"
    service.send_message(project["id"], payload)
    state = settled(service, project["id"])
    assert state["request"]["status"] == "succeeded"
    assert registry.contexts[0] == registry.contexts[1]
    assert registry.configured == [SELECTION]
    reply = next(message for message in state["messages"] if message["role"] == "assistant")
    assert (reply["provider"], reply["model"]) == ("ollama", "fixture:small")
    with pytest.raises(ValidationError, match="mutation ID"):
        service.send_message(project["id"], {**payload, "selection": {"mode": "default"}})
    restored = PlanningService(Store(store.db_path), FixtureRegistry(tmp_path)).state(project["id"])
    assert restored["messages"] == state["messages"]
    assert store.get_project(project["id"]) == project


def test_cancel_and_retry_ignore_old_completion(tmp_path):
    store = Store(tmp_path / "data.sqlite3")
    project = store.create_project()
    registry = FixtureRegistry(tmp_path)
    registry.block_first = True
    service = PlanningService(store, registry)
    payload = request(project)
    service.send_message(project["id"], payload)
    assert registry.started.wait(5)
    cancel = {"mutationId": str(uuid4())}
    state = service.cancel(project["id"], payload["mutationId"], cancel)
    assert state["request"]["status"] == "failed"
    assert registry.cancel_event.is_set()
    service.send_message(project["id"], payload)
    assert settled(service, project["id"])["request"]["status"] == "succeeded"
    registry.release.set()
    deadline = time.monotonic() + 5
    while service._cancels and time.monotonic() < deadline:
        time.sleep(.01)
    service.cancel(project["id"], payload["mutationId"], cancel)
    replies = [m["text"] for m in service.state(project["id"])["messages"] if m["role"] == "assistant"]
    assert replies == ["Reply"]
    assert len(registry.configured) == 1


def test_writing_keeps_original_provider_payload_on_restart(tmp_path):
    store = Store(tmp_path / "data.sqlite3")
    project = store.create_project()
    writing = empty_writing()
    payload = request(project)
    writing.update(message=payload["text"], failedPrompt=payload)
    writing["versions"]["message"] = "writing-v1"
    result = WritingDrafts(store).save(project["id"], {"baseRevision": 0, "mutationId": str(uuid4()), "payload": writing})
    assert WritingDrafts(Store(store.db_path)).get(project["id"]) == result
    assert result["draft"]["payload"]["failedPrompt"] == payload


def test_additive_provider_migration_preserves_project(tmp_path):
    store = Store(tmp_path / "data.sqlite3")
    project = store.create_project()
    with closing(store.connect()) as db, db:
        db.execute("DROP TABLE planning_message_sources")
        db.execute("DELETE FROM schema_migrations WHERE version=10")
    upgraded = Store(store.db_path)
    assert upgraded.get_project(project["id"]) == project
    with closing(upgraded.connect()) as db:
        assert db.execute("SELECT count(*) FROM planning_message_sources").fetchone()[0] == 0


def test_provider_routes_keep_same_origin_and_token_protection(tmp_path):
    registry = FixtureRegistry(tmp_path)
    app = create_app(tmp_path, testing=True, planner=registry)
    client = app.test_client()
    assert client.get("/api/agent/connections").status_code == 403
    token = client.get("/api/bootstrap").json["token"]
    headers = {"X-FlowDesk-Token": token}
    assert client.get("/api/agent/status?provider=ollama", headers=headers).json["agent"]["available"] is True
    assert client.get("/api/agent/status?provider=codex", headers=headers).json["agent"]["available"] is False
    assert client.get("/api/agent/status?provider=ollama", headers={**headers, "Origin": "https://example.invalid"}).status_code == 403
    app.extensions["flowdesk_execution"].close()
