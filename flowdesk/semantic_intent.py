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


def task_approved(approval, task_id):
    if not approval: return False
    if approval.get("scopeVersion") == SCOPE_VERSION:
        return bool(approval.get("taskScopes", {}).get(task_id, {}).get("current"))
    return bool(approval.get("current"))
