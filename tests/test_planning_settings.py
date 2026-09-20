"""Settings are request metadata, never mutable graph content or retry policy."""
from contextlib import closing
from copy import deepcopy
from uuid import uuid4

import pytest

from flowdesk.planning import PlanningService
from flowdesk.storage import Store
from flowdesk.validation import ValidationError
from test_planning import FakePlanner, payload, wait_for


class ConfiguredPlanner(FakePlanner):
    def __init__(self):
        super().__init__(RuntimeError("Temporary failure"))
        self.configurations = []
        self.version = "first"

    def configure(self, selection):
        self.configurations.append(deepcopy(selection))
        if selection["mode"] == "explicit" and (selection["model"], selection["reasoningEffort"]) != ("test-model", "high"):
            raise ValidationError("Unsupported selection")
        return {"selection": deepcopy(selection), "cliVersion": "fixture", "instructionVersion": self.version,
                "instructionHash": self.version, "instructions": "Trusted " + self.version, "protocolVersion": 1}


def test_retry_preserves_configuration_and_hides_instruction_text(tmp_path):
    store = Store(tmp_path / "flowdesk.sqlite3")
    project = store.create_project()
    planner = ConfiguredPlanner()
    service = PlanningService(store, planner)
    request = payload(project, selection={"mode": "explicit", "model": "test-model", "reasoningEffort": "high"})
    service.send_message(project["id"], request)
    first = wait_for(service, project["id"])
    assert first["request"]["status"] == "failed"
    assert first["request"]["generation"]["instructionVersion"] == "first"
    assert "instructions" not in first["request"]["generation"]
    assert first["request"]["payload"] == {**request, "nodeId": None}
    planner.version = "second"
    planner.response = {"message": "Ready for review", "proposal": None}
    # A retry after process restart uses its old contract without rediscovery.
    service = PlanningService(store, planner)
    service.send_message(project["id"], request)
    second = wait_for(service, project["id"])
    assert second["request"]["status"] == "succeeded"
    assert planner.contexts[0] == planner.contexts[1]
    assert len(planner.configurations) == 1
    assert len([m for m in second["messages"] if m["role"] == "user"]) == 1
    assert store.get_project(project["id"]) == project
    with pytest.raises(ValidationError, match="mutation ID"):
        service.send_message(project["id"], {**request, "selection": {"mode": "default"}})
    service.send_message(project["id"], {**request, "mutationId": str(uuid4()), "selection": {"mode": "default"}})
    assert wait_for(service, project["id"])["request"]["generation"]["instructionVersion"] == "second"


@pytest.mark.parametrize("selection", [None, {}, {"mode": "default", "model": "extra"},
    {"mode": "explicit", "model": "test-model"}, {"mode": "explicit", "model": "test-model", "reasoningEffort": "unsupported"},
    {"mode": "explicit", "model": "test-model", "reasoningEffort": "high", "arguments": ["--dangerously-bypass-approvals-and-sandbox"]}])
def test_invalid_settings_create_no_message_or_request(tmp_path, selection):
    store = Store(tmp_path / "flowdesk.sqlite3")
    project = store.create_project()
    service = PlanningService(store, ConfiguredPlanner())
    with pytest.raises(ValidationError):
        service.send_message(project["id"], payload(project, selection=selection))
    state = service.state(project["id"])
    assert state["messages"] == [] and state["request"] is None


def test_configuration_discovery_does_not_hold_database_write_lock(tmp_path):
    store = Store(tmp_path / "flowdesk.sqlite3")
    project = store.create_project()
    planner = ConfiguredPlanner()
    configure = planner.configure
    def check_lock(selection):
        with closing(store.connect()) as db:
            db.execute("PRAGMA busy_timeout=10")
            db.execute("BEGIN IMMEDIATE")
            db.rollback()
        return configure(selection)
    planner.configure = check_lock
    service = PlanningService(store, planner)
    service.send_message(project["id"], payload(project))
    assert wait_for(service, project["id"])["request"]["status"] == "failed"
