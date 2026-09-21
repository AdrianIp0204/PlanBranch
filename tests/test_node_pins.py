"""Layout pins are authored metadata, compatible with old planning snapshots."""
from copy import deepcopy
import json

import pytest

from flowdesk.exports import portable_project, remap_project
from flowdesk.planning import fingerprint
from flowdesk.sample import sample_content
from flowdesk.storage import Store
from flowdesk.validation import ValidationError, validate_content
from test_planning import propose, save, workspace
from test_storage import edit, payload, store


def test_old_snapshots_keep_exact_content_identity():
    original = sample_content()
    normalized = validate_content(original)
    assert normalized == original
    assert fingerprint(normalized) == fingerprint(original)
    assert all("pinned" not in node for diagram in normalized["diagrams"] for node in diagram["nodes"])


@pytest.mark.parametrize("value", [None, 0, 1, "true", [], {}])
def test_pin_requires_boolean(value):
    content = sample_content()
    content["diagrams"][0]["nodes"][0]["pinned"] = value
    with pytest.raises(ValidationError, match="pinned must be true or false"):
        validate_content(content)


def test_pins_positions_and_history_survive_restart_and_portable_roundtrip(store):
    initial = store.create_project(content=sample_content())
    content = deepcopy(initial["content"])
    node = content["diagrams"][0]["nodes"][0]
    node["pinned"] = True
    pinned = edit(store, initial, content)
    arranged = deepcopy(content)
    for movable in arranged["diagrams"][0]["nodes"][1:]:
        movable["position"]["x"] += 350
    after = edit(store, pinned, arranged)
    restarted = Store(store.db_path)
    assert restarted.get_project(initial["id"])["content"] == arranged
    restarted.save_project(initial["id"], payload(after, cursor=pinned["cursor"]))
    undone = restarted.get_project(initial["id"])
    assert undone["content"] == content
    restarted.save_project(initial["id"], payload(undone, cursor=after["cursor"]))
    redone = restarted.get_project(initial["id"])
    assert redone["content"] == arranged
    with restarted.connect() as db:
        metadata = json.loads(db.execute("SELECT data FROM nodes WHERE id=?", (node["id"],)).fetchone()[0])
        assert metadata["pinned"] is True
    portable = portable_project(redone, [])
    imported, _, _ = remap_project(portable["content"], [], portable["views"])
    assert imported["diagrams"][0]["nodes"][0]["pinned"] is True
    assert imported["diagrams"][0]["nodes"][0]["position"] == node["position"]
    assert imported["diagrams"][0]["nodes"][0]["id"] != node["id"]


def test_legacy_agent_output_keeps_human_pins(workspace):
    store, project, service, planner = workspace
    content = deepcopy(project["content"])
    diagram = content["diagrams"][0]
    diagram["nodes"][0]["pinned"] = True
    diagram["nodes"][1]["pinned"] = False
    project = save(store, project, content)
    legacy_nodes = deepcopy(diagram["nodes"])
    for node in legacy_nodes:
        node.pop("pinned", None)
    legacy_nodes[0]["title"] = "Clarify the pinned step"
    planner.response = {"message": "Review this refinement.", "proposal": {
        "title": "Refine the plan", "summary": "Preserve layout preferences.",
        "diagramId": diagram["id"], "nodes": legacy_nodes, "edges": deepcopy(diagram["edges"]),
    }}
    proposal = propose(service, project)
    candidate = service.proposal_detail(project["id"], proposal["id"])["content"]
    assert candidate["diagrams"][0]["nodes"][0]["pinned"] is True
    assert candidate["diagrams"][0]["nodes"][1]["pinned"] is False
    assert store.get_project(project["id"])["content"] == content
