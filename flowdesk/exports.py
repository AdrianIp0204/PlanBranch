"""Portable JSON and Markdown, never machine-specific filesystem permissions."""
from __future__ import annotations

import copy
import json
from uuid import uuid4

from .validation import ValidationError, validate_content, validate_views, relative_file

EXPORT_VERSION = 3
MAX_PORTABLE_BYTES = 10 * 1024 * 1024
MAX_PORTABLE_SYMBOLS = 20_000
SYMBOL_FIELDS = {"id", "name", "kind", "file", "scope", "scopeKind", "annotation", "locations", "declarations", "state", "scanTime", "hash", "heuristic", "identity", "ambiguousIdentity", "identityNote", "importedFrom"}


def check_portable_size(payload):
    """Use this on the raw HTTP/file bytes as well as the serialized download."""
    try:
        size = len(payload.encode("utf-8")) if isinstance(payload, str) else len(payload)
    except (TypeError, UnicodeError) as exc:
        raise ValidationError("Portable project JSON must be valid UTF-8 text.") from exc
    if size > MAX_PORTABLE_BYTES:
        raise ValidationError(
            "Project JSON exceeds the 10 MiB portable-file limit. "
            "Use a database backup for larger projects; no observations were removed."
        )


def serialize_portable(document):
    """The exact UTF-8 JSON representation used for portable downloads."""
    try:
        text = json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False)
    except (TypeError, ValueError, RecursionError) as exc:
        raise ValidationError("Portable projects must contain finite JSON-compatible values.") from exc
    check_portable_size(text)
    return text


def _check_symbol_count(symbols):
    if not isinstance(symbols, list):
        raise ValidationError("Portable symbols must be a list.")
    if len(symbols) > MAX_PORTABLE_SYMBOLS:
        raise ValidationError(
            "Portable projects support at most 20,000 detected symbols. "
            "Use a database backup for larger projects; no observations were removed."
        )


def portable_symbols(symbols):
    _check_symbol_count(symbols)
    result = []
    for symbol in symbols:
        item = {key: copy.deepcopy(value) for key, value in symbol.items() if key in SYMBOL_FIELDS}
        item["state"] = "historical"
        # identity may encode a root generation; the next scan reconciles conservatively.
        item.pop("identity", None)
        relative_file(item.get("file", ""), "Symbol file")
        result.append(item)
    return result


def portable_project(envelope, symbols):
    document = {"format": "flowdesk", "version": EXPORT_VERSION,
            "content": copy.deepcopy(envelope["content"]),
            "views": {k: copy.deepcopy(v) for k, v in envelope.get("views", {}).items() if k in {d["id"] for d in envelope["content"]["diagrams"]}},
            "symbols": portable_symbols(symbols)}
    # Reject before the API offers a download that its importer cannot reopen.
    validate_symbols(document["symbols"])
    serialize_portable(document)
    return document


def validate_symbols(symbols):
    _check_symbol_count(symbols)
    found = set()
    for item in symbols:
        if not isinstance(item, dict) or set(item) - SYMBOL_FIELDS:
            raise ValidationError("Unexpected fields in imported symbol evidence.")
        required = {"id", "name", "kind", "file", "scope", "scopeKind", "annotation", "locations", "declarations", "state", "scanTime", "hash"}
        if not required.issubset(item):
            raise ValidationError("Imported symbol is missing required evidence fields.")
        if not isinstance(item["state"], str) or item["state"] not in {"current", "stale", "not_detected", "historical"}:
            raise ValidationError("Invalid imported evidence state.")
        for field in ("id", "name", "kind", "file", "scope", "scopeKind", "annotation", "scanTime", "hash", "identityNote", "importedFrom"):
            value = item.get(field, "")
            if not isinstance(value, str) or len(value) > 32768:
                raise ValidationError(f"Invalid symbol {field}.")
        if not item.get("id") or item["id"] in found:
            raise ValidationError("Imported symbols require unique IDs.")
        found.add(item["id"])
        relative_file(item.get("file", ""), "Symbol file")
        locations = item.get("locations", [])
        if not isinstance(locations, list) or len(locations) > 10000:
            raise ValidationError("Invalid symbol locations.")
        for location in locations:
            if not isinstance(location, dict) or set(location) - {"line", "column", "endLine", "endColumn", "kind", "scope"}:
                raise ValidationError("Invalid symbol location.")
            if type(location.get("line")) is not int or location["line"] < 1:
                raise ValidationError("Symbol lines must be positive integers.")
            if type(location.get("column", 0)) is not int or location.get("column", 0) < 0:
                raise ValidationError("Invalid symbol column.")
        declarations = item.get("declarations", [])
        if not isinstance(declarations, list) or len(declarations) > 10000:
            raise ValidationError("Invalid symbol declarations.")
        for declaration in declarations:
            if not isinstance(declaration, dict) or set(declaration) - {"kind", "scope", "line"}:
                raise ValidationError("Invalid symbol declaration.")
            if not isinstance(declaration.get("kind"), str) or declaration["kind"] not in {"global", "nonlocal"} or not isinstance(declaration.get("scope"), str):
                raise ValidationError("Invalid symbol declaration kind or scope.")
            if type(declaration.get("line")) is not int or declaration["line"] < 1:
                raise ValidationError("Invalid declaration line.")
        for flag in ("heuristic", "ambiguousIdentity"):
            if flag in item and type(item[flag]) is not bool:
                raise ValidationError("Invalid symbol flag.")
        if len(json.dumps(item, allow_nan=False)) > 200000:
            raise ValidationError("Imported symbol is too large.")
    return found


def remap_project(raw, symbols, views):
    evidence_ids = validate_symbols(symbols)
    content = validate_content(raw, detected_ids=evidence_ids)
    human_ids = {d["id"] for d in content["diagrams"]}
    for d in content["diagrams"]:
        human_ids.update(n["id"] for n in d["nodes"])
        human_ids.update(e["id"] for e in d["edges"])
        human_ids.update(i["id"] for n in d["nodes"] for i in n["checklist"])
    human_ids.update(i["id"] for i in content["variables"] + content["nodeLinks"] + content["matches"])
    for task in content["buildTasks"]:
        human_ids.add(task["id"])
        human_ids.update(check["id"] for check in task["acceptanceChecks"])
        human_ids.update(link[key] for link in task["nodeLinks"] for key in ("nodeId", "diagramId"))
    if human_ids.intersection(evidence_ids):
        raise ValidationError("Detected evidence IDs must be distinct from manual record IDs.")
    views = validate_views(views, {d["id"] for d in content["diagrams"]})
    mapping = {}

    def assign(old):
        if old not in mapping:
            mapping[old] = str(uuid4())
        return mapping[old]

    for diagram in content["diagrams"]:
        assign(diagram["id"])
        for node in diagram["nodes"]:
            assign(node["id"])
            for item in node["checklist"]:
                assign(item["id"])
        for edge in diagram["edges"]:
            assign(edge["id"])
    for item in content["variables"] + content["nodeLinks"] + content["matches"] + symbols:
        assign(item["id"])
    for task in content["buildTasks"]:
        assign(task["id"])
        for check in task["acceptanceChecks"]:
            assign(check["id"])
        for link in task["nodeLinks"]:
            assign(link["nodeId"])
            assign(link["diagramId"])
    for diagram in content["diagrams"]:
        diagram["id"] = mapping[diagram["id"]]
        for node in diagram["nodes"]:
            node["id"] = mapping[node["id"]]
            for item in node["checklist"]:
                item["id"] = mapping[item["id"]]
        for edge in diagram["edges"]:
            edge["id"] = mapping[edge["id"]]
            edge["source"] = mapping[edge["source"]]
            edge["target"] = mapping[edge["target"]]
    for variable in content["variables"]:
        variable["id"] = mapping[variable["id"]]
    for link in content["nodeLinks"]:
        link["id"] = mapping[link["id"]]
        link["nodeId"] = mapping[link["nodeId"]]
        link["variableId"] = mapping[link["variableId"]]
    for match in content["matches"]:
        match["id"] = mapping[match["id"]]
        match["plannedId"] = mapping[match["plannedId"]]
        match["symbolId"] = mapping[match["symbolId"]]
    for task in content["buildTasks"]:
        task["id"] = mapping[task["id"]]
        task["prerequisiteIds"] = [mapping[key] for key in task["prerequisiteIds"]]
        for check in task["acceptanceChecks"]:
            check["id"] = mapping[check["id"]]
        for link in task["nodeLinks"]:
            link["nodeId"] = mapping[link["nodeId"]]
            link["diagramId"] = mapping[link["diagramId"]]
    evidence = portable_symbols(symbols)
    for symbol in evidence:
        symbol["id"] = mapping[symbol["id"]]
    return content, evidence, {mapping[k]: v for k, v in views.items() if k in mapping}


def import_project(store, value):
    if not isinstance(value, dict):
        raise ValidationError("Portable project JSON must contain an object.")
    if set(value) - {"format", "version", "content", "views", "symbols"}:
        raise ValidationError("Unexpected fields in import. Machine settings are not portable.")
    if value.get("format") != "flowdesk" or type(value.get("version")) is not int or value["version"] not in {1, 2, EXPORT_VERSION}:
        raise ValidationError("Unsupported file. Choose a PlanBranch version 1, 2, or 3 JSON export.")
    _check_symbol_count(value.get("symbols", []))
    serialize_portable(value)
    content, symbols, views = remap_project(value.get("content"), value.get("symbols", []), value.get("views", {}))
    # Normalization adds optional manual fields. Check the normalized project as
    # well so every accepted import can immediately be exported again.
    serialize_portable({"format": "flowdesk", "version": EXPORT_VERSION,
                        "content": content, "views": views, "symbols": symbols})
    # All input is checked before storage creates anything; content and evidence commit atomically.
    return store.create_project(content=content, evidence=symbols, views=views)


def markdown_brief(content):
    def escape(text):
        # Text is inert even in Markdown readers that permit arbitrary HTML.
        value = str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        for char in ("\\", "`", "*", "_", "[", "]", "#", "|"):
            value = value.replace(char, "\\" + char)
        return value

    lines = [f"# {escape(content['name'])}", "", "Implementation plan — statuses are user-recorded, not proof of correctness.", ""]
    brief = content.get("brief", {})
    if any(brief.values()):
        lines += ["## Project brief", ""]
        for field, label in (("goal", "Goal"), ("audience", "Intended user"), ("requirements", "Requirements"),
                             ("constraints", "Constraints"), ("outOfScope", "Out of scope"),
                             ("decisions", "Agreed decisions"), ("assumptions", "Assumptions")):
            if brief.get(field):
                lines += [f"### {label}", "", escape(brief[field]), ""]
    if content.get("notes"):
        lines += ["## Project notes", "", escape(content["notes"]), ""]
    for diagram in content["diagrams"]:
        lines += [f"## {escape(diagram['name'])}", ""]
        for node in diagram["nodes"]:
            if node["type"] == "note":
                lines += [f"### Note: {escape(node['title'])}"]
            else:
                lines += [f"### {escape(node['title'])}", "", f"Type: {node['type']} · Status: {node['status'].replace('_', ' ')}"]
            for key, label in (("description", "Description"), ("notes", "Notes"), ("pseudocode", "Pseudocode"), ("targetFile", "Target file"), ("targetScope", "Target scope"), ("why", "Why this choice?"), ("alternatives", "Alternatives considered"), ("blocker", "Blocker")):
                if node.get(key):
                    lines += ["", f"**{label}**", "", escape(node[key])]
            if node["checklist"]:
                lines.append("")
                lines.extend(f"- [{'x' if item['checked'] else ' '}] {escape(item['text'])}" for item in node["checklist"])
            lines.append("")
        titles = {n["id"]: n["title"] for n in diagram["nodes"]}
        if diagram["edges"]:
            lines += ["### Connections", ""]
            lines.extend(f"- {escape(titles[e['source']])} → {escape(titles[e['target']])}" + (f" — {escape(e['label'])}" if e.get("label") else "") for e in diagram["edges"])
            lines.append("")
    if content.get("buildTasks"):
        lines += ["## Build tasks", "", "Build completion is recorded separately from diagram-node completion.", ""]
        task_titles = {task["id"]: task["title"] or "Untitled task" for task in content["buildTasks"]}
        for index, task in enumerate(content["buildTasks"], 1):
            lines += [f"### {index}. {escape(task_titles[task['id']])}", "",
                      "Status: " + task["status"].replace("_", " "), "", escape(task["deliverable"]), ""]
            if task["prerequisiteIds"]:
                lines += ["Prerequisites: " + ", ".join(escape(task_titles[key]) for key in task["prerequisiteIds"]), ""]
            if task["expectedFiles"]:
                lines += ["Expected files or areas: " + ", ".join(escape(path) for path in task["expectedFiles"]), ""]
            if task["nodeLinks"]:
                lines += ["Linked flow steps:"]
                lines.extend("- " + escape(link["title"] or "Untitled node") + (" (removed from diagram)" if link["missing"] else "")
                             for link in task["nodeLinks"])
                lines.append("")
            if task["acceptanceChecks"]:
                lines += ["Acceptance checks:"]
                lines.extend("- " + escape(check["text"]) for check in task["acceptanceChecks"])
                lines.append("")
    lines += ["## Planned variables", "", "| Name | Purpose | Intended type | Intended file | Scope | Status |", "| --- | --- | --- | --- | --- | --- |"]
    for v in content["variables"]:
        lines.append("| " + " | ".join(escape(v.get(k, "")).replace("\n", " / ") for k in ("name", "description", "intendedType", "intendedFile", "scope", "status")) + " |")
    for v in content["variables"]:
        if v.get("notes") or v.get("initialExpression"):
            lines += ["", f"### {escape(v['name'])}"]
            if v.get("initialExpression"):
                lines += ["", "Initial/default expression (unevaluated): " + escape(v["initialExpression"])]
            if v.get("notes"):
                lines += ["", escape(v["notes"])]
    lines.append("")
    return "\n".join(lines)
