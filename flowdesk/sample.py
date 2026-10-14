"""An explicitly loaded, removable example. It grants no source access."""
from uuid import uuid4

from .storage import empty_content
from .validation import validate_content


def sample_content(*, guided=False):
    content = empty_content("Batch importer · example")
    content["notes"] = (
        "A small plan for importing records safely. Start with a valid row, then test malformed input and retries. "
        "The loop is intentional. Checklist ticks record preparation; task statuses are separate.\n\n"
        "This is removable example data. Attach the bundled examples/python directory explicitly to try a Python scan."
    )
    diagram = content["diagrams"][0]
    diagram["name"] = "Import records"
    ids = {key: str(uuid4()) for key in ("start", "load", "check", "save", "skip", "end", "note", "count", "record")}
    specs = [
        ("start", "start", "Begin import", 320, 25, "done"),
        ("load", "io", "Read next record", 320, 185, "done"),
        ("check", "decision", "Record valid?", 320, 350, "in_progress"),
        ("save", "process", "Save & count", 80, 560, "not_started"),
        ("skip", "process", "Log & skip", 600, 560, "blocked"),
        ("end", "end", "Finish import", 40, 185, "not_started"),
        ("note", "note", "Think about retries", 670, 180, "not_started"),
    ]
    for key, node_type, title, x, y, status in specs:
        node = {"id": ids[key], "type": node_type, "title": title, "position": {"x": x, "y": y}, "status": status}
        if key == "check":
            node.update({"description": "Validate the identifier and required fields before any storage writes.",
                         "why": "Fail early so a malformed row never reaches storage.",
                         "alternatives": "Collect invalid rows for a separate review batch.",
                         "targetFile": "importer.py", "targetScope": "process_records",
                         "checklist": [{"id": str(uuid4()), "text": "List required fields", "checked": True},
                                       {"id": str(uuid4()), "text": "Test empty identifiers", "checked": False}]})
        if key == "skip":
            node.update({"blocker": "Decide where rejected rows should be written.", "notes": "Keep enough context to retry without retaining unnecessary source data."})
        if key == "save":
            node.update({"pseudocode": "save(record)\ncount += 1\ncontinue", "targetFile": "importer.py", "targetScope": "process_records"})
        if key == "note":
            node["notes"] = "What happens if the process stops halfway through? Re-running an import should avoid duplicates."
        diagram["nodes"].append(node)
    for source, target, label in [
        ("start", "load", ""), ("load", "check", "Has a record"), ("load", "end", "End of input"),
        ("check", "save", "Yes"), ("check", "skip", "No"), ("save", "load", "Next record"), ("skip", "load", "Continue"),
    ]:
        handle = ("yes" if label == "Yes" else "no") if source == "check" else "out"
        diagram["edges"].append({"id": str(uuid4()), "source": ids[source], "target": ids[target], "sourceHandle": handle, "targetHandle": "in", "label": label})
    content["variables"] = [
        {"id": ids["count"], "name": "count", "description": "Number of records successfully imported.",
         "intendedType": "int", "intendedFile": "importer.py", "scopeKind": "function", "scope": "process_records",
         "initialExpression": "0", "status": "in_progress", "notes": "Only increment after a successful write."},
        {"id": ids["record"], "name": "record", "description": "The row currently being validated.",
         "intendedType": "dict[str, str]", "intendedFile": "importer.py", "scopeKind": "function", "scope": "process_records",
         "initialExpression": "", "status": "not_started", "notes": ""},
    ]
    content["nodeLinks"] = [
        {"id": str(uuid4()), "nodeId": ids[node], "variableId": ids[variable], "origin": "planned", "relationship": relationship}
        for node, variable, relationship in [("save", "count", "writes"), ("check", "record", "reads"), ("load", "record", "creates")]
    ]
    if not guided:
        return validate_content(content)
    content["brief"].update(
        goal="Import valid records, skip malformed rows, and report how many were saved.",
        audience="People importing a small local data batch.",
        requirements="Validate each identifier before writing. Skip invalid rows and continue. Count only successful saves.",
        constraints="Offline example. No repository, credentials or command runtime is needed to explore this plan.",
        outOfScope="Retry-safe storage and concurrent imports.",
        decisions="Keep validation separate from storage; review rejected-row handling before implementation.",
        assumptions="Each record is a dictionary; storage errors need a separate decision.",
    )
    task_id = str(uuid4())
    content["buildTasks"] = [
        {"id": task_id, "title": "Validate records before saving", "deliverable": "Skip rows without an identifier before storage is called.",
         "nodeLinks": [{"nodeId": ids["check"], "diagramId": diagram["id"], "title": "Record valid?", "missing": False}],
         "prerequisiteIds": [], "expectedFiles": ["importer.py", "tests/test_importer.py"],
         "acceptanceChecks": [{"id": str(uuid4()), "text": "A valid record reaches storage once."},
                              {"id": str(uuid4()), "text": "A row without an identifier never reaches storage."}], "status": "not_started"},
        {"id": str(uuid4()), "title": "Report successful imports", "deliverable": "Return a count incremented only after a successful save.",
         "nodeLinks": [{"nodeId": ids["save"], "diagramId": diagram["id"], "title": "Save & count", "missing": False}],
         "prerequisiteIds": [task_id], "expectedFiles": ["importer.py"],
         "acceptanceChecks": [{"id": str(uuid4()), "text": "The count excludes malformed and unsaved records."}], "status": "not_started"},
    ]
    return validate_content(content)
