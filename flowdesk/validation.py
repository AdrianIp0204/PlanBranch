"""Validation for portable, human-authored project content.

Scanner observations and machine permissions deliberately have no place in this
schema. Validation returns a copy with optional fields populated for the UI.
"""
from __future__ import annotations

import copy
import json
import math
import re

from .content_versions import BRIEF_FIELDS, CONTENT_VERSION, empty_brief, upgrade_content


class ValidationError(ValueError):
    pass


STATUSES = {"not_started", "in_progress", "blocked", "done"}
NODE_TYPES = {"start", "end", "process", "decision", "io", "note"}
RELATIONSHIPS = {"unspecified", "reads", "writes", "creates"}
MAX_HISTORY = 101
MAX_CONTENT_BYTES = 2_000_000


def fail(message: str):
    raise ValidationError(message)


def obj(value, fields, context):
    if not isinstance(value, dict):
        fail(f"{context} must be an object.")
    extra = set(value) - set(fields)
    if extra:
        fail(f"Unexpected fields in {context}: {', '.join(sorted(extra))}.")
    return value


def string(value, context, limit=32768, required=False):
    if not isinstance(value, str) or len(value) > limit:
        fail(f"{context} must be text of at most {limit} characters.")
    if required and not value.strip():
        fail(f"{context} cannot be empty.")
    if "\x00" in value:
        fail(f"{context} cannot contain a null character.")
    return value


def identifier(value, context="ID"):
    return string(value, context, 128, required=True)


def choice(value, allowed, context):
    if not isinstance(value, str) or value not in allowed:
        fail(f"Unsupported {context}.")
    return value


def integer(value, context, minimum=0):
    if type(value) is not int or value < minimum:
        fail(f"{context} must be an integer of at least {minimum}.")
    return value


def number(value, context, bound=10_000_000):
    if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > bound:
        fail(f"{context} must be a finite number within +/-{bound}.")
    return value


def array(value, context, limit):
    if not isinstance(value, list) or len(value) > limit:
        fail(f"{context} must be a list with at most {limit} entries.")
    return value


def relative_file(value, context):
    string(value, context, 2048)
    normalized = value.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        fail(f"{context} must be project-relative, not an absolute machine path.")
    if ".." in normalized.split("/"):
        fail(f"{context} must not escape the source root.")
    return value


def validate_brief(raw):
    obj(raw, set(BRIEF_FIELDS), "project brief")
    result = copy.deepcopy(raw)
    for field in BRIEF_FIELDS:
        string(result.setdefault(field, ""), f"Brief {field}")
    return result


def validate_build_tasks(tasks, content, claim):
    """Build prerequisites form a DAG; program-flow edges may still loop."""
    array(tasks, "Build tasks", 1000)
    nodes = {node["id"]: (diagram["id"], node["title"])
             for diagram in content["diagrams"] for node in diagram["nodes"]}
    task_ids = set()
    for task in tasks:
        fields = {"id", "title", "deliverable", "nodeLinks", "prerequisiteIds", "expectedFiles", "acceptanceChecks", "status"}
        obj(task, fields, "build task")
        if set(task) != fields:
            fail("A build task must include every task field, using empty text or lists for unfinished details.")
        claim(task.get("id"), "Build task ID")
        task_ids.add(task["id"])
        string(task["title"], "Build task title", 500)
        string(task["deliverable"], "Build deliverable")
        choice(task["status"], STATUSES, "build task status")
        seen_nodes = set()
        for link in array(task["nodeLinks"], "Build node links", 500):
            obj(link, {"nodeId", "diagramId", "title", "missing"}, "build node link")
            identifier(link.get("nodeId"), "Build linked node ID")
            identifier(link.get("diagramId"), "Build linked diagram ID")
            string(link.get("title"), "Build linked node title", 500)
            if type(link.get("missing")) is not bool:
                fail("Build link missing must be true or false.")
            if link["nodeId"] in seen_nodes:
                fail("A build task may link to a node only once.")
            seen_nodes.add(link["nodeId"])
            live = nodes.get(link["nodeId"])
            if live is not None:
                link.update(diagramId=live[0], title=live[1], missing=False)
            else:
                # Preserve the last-known title and diagram when a flow node is
                # deleted. Restoring its ID automatically restores the live link.
                link["missing"] = True
        for expected in array(task["expectedFiles"], "Expected files or areas", 200):
            string(expected, "Expected file or area", 2048)
        for check in array(task["acceptanceChecks"], "Build acceptance checks", 500):
            obj(check, {"id", "text"}, "build acceptance check")
            claim(check.get("id"), "Build acceptance check ID")
            string(check.get("text"), "Build acceptance check text", 4000)
        array(task["prerequisiteIds"], "Build prerequisites", 1000)
    dependants = {key: [] for key in task_ids}
    counts = {}
    for task in tasks:
        seen = set()
        for prerequisite in task["prerequisiteIds"]:
            identifier(prerequisite, "Prerequisite task ID")
            if prerequisite not in task_ids:
                fail("A build prerequisite references an unknown task.")
            if prerequisite == task["id"]:
                fail("A build task cannot depend on itself.")
            if prerequisite in seen:
                fail("Build prerequisites must be unique within a task.")
            seen.add(prerequisite)
            dependants[prerequisite].append(task["id"])
        counts[task["id"]] = len(seen)
    ready = [key for key, count in counts.items() if count == 0]
    visited = 0
    while ready:
        key = ready.pop()
        visited += 1
        for dependant in dependants[key]:
            counts[dependant] -= 1
            if counts[dependant] == 0:
                ready.append(dependant)
    if visited != len(tasks):
        fail("Build task prerequisites must not contain a cycle. Program diagrams may contain loops.")
    return tasks


def validate_content(raw, detected_ids=None):
    """Normalize a manual snapshot; optionally verify scanner-owned references."""
    try:
        if len(json.dumps(raw, allow_nan=False).encode("utf-8")) > MAX_CONTENT_BYTES:
            fail("Project content exceeds the 2 MB limit.")
    except (TypeError, ValueError, RecursionError) as exc:
        if isinstance(exc, ValidationError):
            raise
        fail("Project content must contain finite, JSON-compatible values.")
    try:
        content = upgrade_content(raw)
    except ValueError as exc:
        fail(str(exc))
    obj(content, {"schemaVersion", "name", "notes", "brief", "buildTasks", "diagrams", "variables", "nodeLinks", "matches"}, "project")
    content["brief"] = validate_brief(content.get("brief", empty_brief()))
    string(content.get("name"), "Project name", 200, True)
    string(content.setdefault("notes", ""), "Project notes", 100000)
    diagrams = array(content.get("diagrams"), "Diagrams", 100)
    if not diagrams:
        fail("A project must contain at least one diagram.")
    all_ids = set()
    node_ids = set()
    planned_ids = set()

    def claim(value, context):
        identifier(value, context)
        if value in all_ids:
            fail(f"Duplicate ID: {value}.")
        all_ids.add(value)

    total_nodes = total_edges = 0
    for diagram in diagrams:
        obj(diagram, {"id", "name", "nodes", "edges"}, "diagram")
        claim(diagram.get("id"), "Diagram ID")
        string(diagram.get("name"), "Diagram name", 200, True)
        nodes = array(diagram.get("nodes"), "Diagram nodes", 5000)
        edges = array(diagram.get("edges"), "Diagram edges", 10000)
        total_nodes += len(nodes)
        total_edges += len(edges)
        local_nodes = set()
        for node in nodes:
            obj(node, {"id", "type", "title", "position", "description", "notes", "pseudocode", "status", "checklist", "targetFile", "targetScope", "why", "alternatives", "blocker", "pinned"}, "node")
            claim(node.get("id"), "Node ID")
            local_nodes.add(node["id"])
            node_ids.add(node["id"])
            choice(node.get("type"), NODE_TYPES, "node type")
            string(node.get("title"), "Node title", 500)
            position = obj(node.get("position"), {"x", "y"}, "Node position")
            number(position.get("x"), "Node x")
            number(position.get("y"), "Node y")
            # Keep this optional: populating old snapshots would change their
            # content identity and invalidate frozen planning requests/approvals.
            if "pinned" in node and type(node["pinned"]) is not bool:
                fail("Node pinned must be true or false.")
            for key in ("description", "notes", "pseudocode", "targetScope", "why", "alternatives", "blocker"):
                string(node.setdefault(key, ""), f"Node {key}")
            relative_file(node.setdefault("targetFile", ""), "Node target file")
            choice(node.setdefault("status", "not_started"), STATUSES, "node status")
            for item in array(node.setdefault("checklist", []), "Checklist", 500):
                obj(item, {"id", "text", "checked"}, "checklist item")
                claim(item.get("id"), "Checklist ID")
                string(item.get("text"), "Checklist text", 4000)
                if type(item.get("checked")) is not bool:
                    fail("Checklist checked must be true or false.")
        for edge in edges:
            obj(edge, {"id", "source", "target", "sourceHandle", "targetHandle", "label"}, "edge")
            claim(edge.get("id"), "Edge ID")
            identifier(edge.get("source"), "Edge source")
            identifier(edge.get("target"), "Edge target")
            if edge.get("source") not in local_nodes or edge.get("target") not in local_nodes:
                fail("An edge must reference two nodes in its own diagram.")
            string(edge.setdefault("label", ""), "Edge label", 2000)
            for key in ("sourceHandle", "targetHandle"):
                if edge.get(key) is not None:
                    string(edge[key], f"Edge {key}", 128)
    if total_nodes > 5000 or total_edges > 10000:
        fail("A project supports at most 5000 nodes and 10000 edges.")
    for variable in array(content.setdefault("variables", []), "Planned variables", 5000):
        obj(variable, {"id", "name", "description", "intendedType", "intendedFile", "scopeKind", "scope", "initialExpression", "notes", "status"}, "planned variable")
        claim(variable.get("id"), "Variable ID")
        planned_ids.add(variable["id"])
        for key in ("name", "description", "intendedType", "scopeKind", "scope", "initialExpression", "notes"):
            string(variable.setdefault(key, ""), f"Variable {key}")
        relative_file(variable.setdefault("intendedFile", ""), "Intended file")
        choice(variable.setdefault("status", "not_started"), STATUSES, "variable status")
    link_keys = set()
    for link in array(content.setdefault("nodeLinks", []), "Node-variable links", 20000):
        obj(link, {"id", "nodeId", "variableId", "origin", "relationship"}, "node-variable link")
        claim(link.get("id"), "Node-variable link ID")
        identifier(link.get("nodeId"), "Linked node ID")
        if link.get("nodeId") not in node_ids:
            fail("A variable link references an unknown node.")
        choice(link.get("origin"), {"planned", "detected"}, "variable link origin")
        identifier(link.get("variableId"), "Linked variable ID")
        if link["origin"] == "planned" and link["variableId"] not in planned_ids:
            fail("A link references an unknown planned variable.")
        if link["origin"] == "detected" and detected_ids is not None and link["variableId"] not in detected_ids:
            fail("A link references an unknown detected symbol in this project.")
        choice(link.setdefault("relationship", "unspecified"), RELATIONSHIPS, "node-variable relationship")
        key = (link["nodeId"], link["origin"], link["variableId"])
        if key in link_keys:
            fail("A node may link to a variable only once.")
        link_keys.add(key)
    match_keys = set()
    for match in array(content.setdefault("matches", []), "Plan-code matches", 10000):
        obj(match, {"id", "plannedId", "symbolId", "decision"}, "plan-code match")
        claim(match.get("id"), "Match ID")
        identifier(match.get("plannedId"), "Matched plan ID")
        if match.get("plannedId") not in planned_ids:
            fail("A match references an unknown planned variable.")
        identifier(match.get("symbolId"), "Matched symbol ID")
        if detected_ids is not None and match["symbolId"] not in detected_ids:
            fail("A match references an unknown detected symbol in this project.")
        choice(match.get("decision"), {"confirmed", "rejected"}, "match decision")
        key = (match["plannedId"], match["symbolId"])
        if key in match_keys:
            fail("A plan-symbol pair may have only one match decision.")
        match_keys.add(key)
    content["buildTasks"] = validate_build_tasks(content.get("buildTasks", []), content, claim)
    return content


def validate_checkpoint(raw, detected_ids=None):
    obj(raw, {"id", "label", "diagramId", "content"}, "history checkpoint")
    identifier(raw.get("id"), "Checkpoint ID")
    string(raw.get("label"), "History action", 200, True)
    content = validate_content(raw.get("content"), detected_ids)
    result = {"id": raw["id"], "label": raw["label"], "content": content}
    if raw.get("diagramId") is not None:
        identifier(raw["diagramId"], "History diagram ID")
        # A deletion checkpoint can name the diagram it removed.
        result["diagramId"] = raw["diagramId"]
    return result


def validate_views(raw, diagram_ids=None):
    if not isinstance(raw, dict) or len(raw) > 100:
        fail("Views must be an object with at most 100 diagrams.")
    result = {}
    for key, view in raw.items():
        identifier(key, "View diagram ID")
        obj(view, {"x", "y", "zoom"}, "diagram viewport")
        number(view.get("x"), "Viewport x")
        number(view.get("y"), "Viewport y")
        number(view.get("zoom"), "Viewport zoom", 10)
        if view["zoom"] < 0.05:
            fail("Viewport zoom must be between 0.05 and 10.")
        if diagram_ids is not None and key not in diagram_ids:
            fail("A viewport references an unknown diagram.")
        result[key] = dict(view)
    return result
