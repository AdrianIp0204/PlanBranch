"""Versioned approval scopes. Progress and canvas placement are not authority.

The scope is an explicit allowlist, not a blanket removal of fields named status.
New meaning-bearing content fields must be added here and bump SCOPE_VERSION.
Proposal receipts continue using their exact, existing manual identity.
"""
from copy import deepcopy
import hashlib
import json

SCOPE_VERSION = 1
NODE_FIELDS = ("id", "type", "title", "description", "notes", "pseudocode",
               "targetFile", "targetScope", "why", "alternatives", "blocker")
TASK_FIELDS = ("id", "title", "deliverable", "expectedFiles")
VARIABLE_FIELDS = ("id", "name", "description", "intendedType", "intendedFile",
                   "scopeKind", "scope", "initialExpression", "notes")


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()


def _ordered(values):
    return sorted(values, key=lambda value: value.get("id", ""))


def task_intent(task):
    return {**{key: deepcopy(task.get(key)) for key in TASK_FIELDS},
            "prerequisiteIds": sorted(task.get("prerequisiteIds", [])),
            "nodeLinks": sorted(({key: link.get(key) for key in ("nodeId", "diagramId", "missing")}
                                 for link in task.get("nodeLinks", [])), key=lambda link: link["nodeId"]),
            "acceptanceChecks": _ordered(deepcopy(task.get("acceptanceChecks", [])))}


def semantic_scope(content, task_id=None):
    tasks = {task["id"]: task for task in content.get("buildTasks", [])}
    selected = set(tasks) if task_id is None else {task_id}
    pending = list(selected)
    while pending:
        key = pending.pop()
        for dependency in tasks.get(key, {}).get("prerequisiteIds", []):
            if dependency not in selected:
                selected.add(dependency); pending.append(dependency)
    nodes = None if task_id is None else {link["nodeId"] for key in selected
             for link in tasks.get(key, {}).get("nodeLinks", [])}
    # Relationships reachable from the task's linked nodes affect its design.
    # Unrelated disconnected diagrams and unrelated tasks have independent scopes.
    if nodes is not None:
        changed = True
        while changed:
            previous = len(nodes)
            for diagram in content.get("diagrams", []):
                for edge in diagram["edges"]:
                    if edge["source"] in nodes or edge["target"] in nodes:
                        nodes.update((edge["source"], edge["target"]))
            changed = previous != len(nodes)
    diagrams = []
    for diagram in content.get("diagrams", []):
        included = [node for node in diagram["nodes"] if nodes is None or node["id"] in nodes]
        if task_id is not None and not included: continue
        diagrams.append({"id": diagram["id"], "name": diagram["name"],
            "nodes": _ordered([{**{key: node.get(key) for key in NODE_FIELDS},
                "checklist": _ordered([{key: item[key] for key in ("id", "text")}
                                       for item in node.get("checklist", [])])} for node in included]),
            "edges": _ordered([{key: edge.get(key) for key in ("id", "source", "target", "sourceHandle", "targetHandle", "label")}
                for edge in diagram["edges"] if nodes is None or edge["source"] in nodes or edge["target"] in nodes])})
    links = [link for link in content.get("nodeLinks", []) if nodes is None or link["nodeId"] in nodes]
    variables = None if task_id is None else {link["variableId"] for link in links if link["origin"] == "planned"}
    return {"scopeVersion": SCOPE_VERSION, "name": content.get("name"), "notes": content.get("notes", ""),
        "brief": deepcopy(content.get("brief", {})), "diagrams": _ordered(diagrams),
        "tasks": _ordered([task_intent(tasks[key]) for key in selected if key in tasks]),
        "missingTasks": sorted(selected - set(tasks)), "nodeLinks": _ordered(deepcopy(links)),
        "variables": _ordered([{key: variable.get(key) for key in VARIABLE_FIELDS}
            for variable in content.get("variables", []) if variables is None or variable["id"] in variables]),
        "matches": _ordered([deepcopy(match) for match in content.get("matches", [])
            if variables is None or match["plannedId"] in variables])}


def semantic_fingerprint(content):
    return digest(semantic_scope(content))


def task_fingerprint(content, task_id):
    return digest(semantic_scope(content, task_id))


def semantic_sections(content):
    """Present the exact approval policy, without maintaining a second allowlist.

    Scope version 1 already includes project names and node blocker text. This
    presentation repair does not alter that policy or revive older approvals.
    Historical inspection receipts are deliberately outside semantic meaning.
    """
    scope = semantic_scope(content)
    return {
        "Project name and notes": {key: scope[key] for key in ("name", "notes")},
        "Requirements, constraints and decisions": scope["brief"],
        "Diagram elements and relationships": scope["diagrams"],
        "Tasks, dependencies and acceptance criteria": {
            "tasks": scope["tasks"], "missingTasks": scope["missingTasks"]},
        "Variables and source references": {
            key: scope[key] for key in ("variables", "nodeLinks", "matches")},
    }


_FIELD_LABELS = {
    "name": "Name", "notes": "Notes", "goal": "Goal", "users": "Users",
    "requirements": "Requirements", "constraints": "Constraints", "decisions": "Decisions",
    "nonGoals": "Out of scope", "nodes": "Nodes", "edges": "Connections", "title": "Title",
    "description": "Description", "pseudocode": "Pseudocode", "targetFile": "Target file",
    "targetScope": "Target scope", "why": "Reason", "alternatives": "Alternatives",
    "blocker": "Blocker", "checklist": "Checklist", "text": "Text", "type": "Type",
    "source": "Source node", "target": "Target node", "sourceHandle": "Source branch",
    "targetHandle": "Target port", "label": "Label", "tasks": "Tasks",
    "deliverable": "Deliverable", "expectedFiles": "Expected files",
    "prerequisiteIds": "Prerequisite tasks", "acceptanceChecks": "Acceptance checks",
    "nodeLinks": "Node links", "nodeId": "Node", "diagramId": "Diagram", "missing": "Missing link",
    "variables": "Variables", "intendedType": "Intended type", "intendedFile": "Intended file",
    "scopeKind": "Scope kind", "scope": "Scope", "initialExpression": "Initial expression",
    "matches": "Source matches", "missingTasks": "Missing tasks", "origin": "Origin",
    "variableId": "Variable", "relationship": "Relationship", "plannedId": "Planned variable",
    "detectedId": "Detected variable", "scanId": "Scan", "status": "Status",
}
_MISSING = object()


def field_changes(before, after, path=(), labels=()):
    """Stable identity paths plus readable changed fields, never whole-plan blobs."""
    if before == after:
        return []
    if isinstance(before, dict) or isinstance(after, dict):
        left = before if isinstance(before, dict) else {}
        right = after if isinstance(after, dict) else {}
        result = []
        for key in sorted(set(left) | set(right)):
            # Collection identity appears in its path, rather than a UUID-only row.
            if key == "id": continue
            result.extend(field_changes(left.get(key, _MISSING), right.get(key, _MISSING),
                (*path, key), (*labels, _FIELD_LABELS.get(key, key))))
        return result
    values = [value for value in (before, after) if value is not _MISSING]
    if values and all(isinstance(value, list) and all(isinstance(item, dict) and "id" in item for item in value) for value in values):
        left = {item["id"]: item for item in before} if isinstance(before, list) else {}
        right = {item["id"]: item for item in after} if isinstance(after, list) else {}
        result = []
        for key in sorted(set(left) | set(right)):
            item = right.get(key) or left[key]
            title = next((item.get(field) for field in ("title", "name", "text", "label") if item.get(field)), key)
            result.extend(field_changes(left.get(key, _MISSING), right.get(key, _MISSING),
                (*path, key), (*labels, str(title))))
        return result
    return [{"path": "/" + "/".join(str(part).replace("~", "~0").replace("/", "~1") for part in path),
             "label": " → ".join(labels) or "Value",
             "kind": "added" if before is _MISSING else "removed" if after is _MISSING else "changed",
             "before": None if before is _MISSING else before,
             "after": None if after is _MISSING else after}]


def task_approved(approval, task_id):
    if not approval: return False
    if approval.get("scopeVersion") == SCOPE_VERSION:
        return bool(approval.get("taskScopes", {}).get(task_id, {}).get("current"))
    return bool(approval.get("current"))
