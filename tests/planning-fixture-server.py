"""Browser-test-only deterministic provider; never shipped in the application."""
import argparse
from copy import deepcopy
import hashlib
import time
from uuid import uuid4
from flowdesk.app import create_app
from waitress import serve


class FixturePlanner:
    def __init__(self):
        self.failed = set()

    def status(self):
        return {"available": True, "label": "Codex CLI"}

    def capabilities(self, refresh=False):
        return {"status": "ready", "source": "cli_catalogue", "cliVersion": "fixture-1",
                "fetchedAt": "2026-09-20T00:00:00Z", "models": [
                    {"id": model, "label": label, "description": "Browser fixture",
                     "defaultReasoningEffort": efforts[0], "isDefault": index == 0,
                     "reasoningEfforts": [{"id": effort, "description": effort} for effort in efforts]}
                    for index, (model, label, efforts) in enumerate([
                        ("fixture-fast", "Quick planner", ["low", "medium"]),
                        ("fixture-deep", "Careful planner", ["medium", "high"])])]}

    def configure(self, selection):
        if selection != {"mode": "default"}:
            model = next((m for m in self.capabilities()["models"] if m["id"] == selection.get("model")), None)
            if model is None or selection.get("reasoningEffort") not in [e["id"] for e in model["reasoningEfforts"]]:
                from flowdesk.validation import ValidationError
                raise ValidationError("Choose a supported fixture model and reasoning level.")
        instructions = "Synthetic planning fixture instructions."
        return {"selection": deepcopy(selection), "cliVersion": "fixture-1", "instructionVersion": "fixture-v3",
                "instructionHash": hashlib.sha256(instructions.encode()).hexdigest(), "instructions": instructions,
                "protocolVersion": 3}

    @staticmethod
    def envelope(kind, message, *, questions=None, proposal=None):
        if proposal is not None:
            proposal = {"brief": None, **proposal}
        return {"protocolVersion": 3, "kind": kind, "message": message,
                "questions": questions or [], "proposal": proposal}

    def generate(self, context):
        prompt = context["messages"][-1]["text"]
        if prompt.startswith("Plan a Python task CLI"):
            diagram_id = context["activeDiagramId"]
            specs = [("start", "Read command", 340, 0),
                     ("decision", "Add or list?", 340, 160),
                     ("process", "Save task to SQLite", 100, 360),
                     ("io", "List saved tasks", 580, 360),
                     ("end", "Show result", 340, 550)]
            nodes = [{"id": str(uuid4()), "type": kind, "title": title,
                      "position": {"x": x, "y": y}, "status": "not_started",
                      "description": title + ".", "checklist": [],
                      **{key: "" for key in ("notes", "pseudocode", "targetFile", "targetScope", "why", "alternatives", "blocker")}}
                     for kind, title, x, y in specs]
            edges = [{"id": str(uuid4()), "source": nodes[source]["id"], "target": nodes[target]["id"],
                      "sourceHandle": handle, "targetHandle": "in", "label": label}
                     for source, target, handle, label in [(0, 1, "out", ""), (1, 2, "yes", "add"),
                                                          (1, 3, "no", "list"), (2, 4, "out", ""), (3, 4, "out", "")]]
            return self.envelope("proposal", "Here is a small first version: two commands, one local database. Review the branches on the canvas, or tell me what to change.", proposal={
                "title": "A small task CLI", "summary": "Add tasks to SQLite and list them from the terminal.",
                "diagramId": diagram_id, "nodes": nodes, "edges": edges})
        time.sleep(1.5 if "slow" in prompt else 0.15)
        if "fail once" in prompt and prompt not in self.failed:
            self.failed.add(prompt)
            raise RuntimeError("Fixture connection interrupted. Retry this message.")
        if prompt.startswith("Answers to planning questions:"):
            answered = next(item for item in reversed(context["questionSets"]) if item["state"] == "answered")
            failure_key = "continuation:" + answered["id"]
            if (any("fail continuation once" in message["text"] for message in context["messages"])
                    and failure_key not in self.failed):
                self.failed.add(failure_key)
                raise RuntimeError("Fixture continuation interrupted. Retry this message.")
            return self.envelope("reply", "Your answers are recorded. " + prompt)
        if prompt.startswith("Clarify text requirement"):
            return self.envelope("questions", "One requirement needs a short answer.", questions=[
                {"id": "success", "kind": "text", "prompt": "What would make the first version useful?",
                 "options": [], "recommendedOptionId": None}])
        if prompt.startswith(("Clarify requirements", "Please revisit the unanswered questions")):
            return self.envelope("questions", "Choose the requirements for this plan.", questions=[
                {"id": "storage", "kind": "choice", "prompt": "How should the app store its data?",
                 "options": [
                     {"id": "json", "label": "JSON file", "description": "A simple local file."},
                     {"id": "sqlite", "label": "SQLite", "description": "A local structured database."}],
                 "recommendedOptionId": "sqlite"},
                {"id": "audience", "kind": "choice", "prompt": "Who will use the first version?",
                 "options": [
                     {"id": "personal", "label": "Personal use", "description": "One person on one computer."},
                     {"id": "team", "label": "Team use", "description": "A shared workflow for a team."}],
                 "recommendedOptionId": "personal"}])
        if prompt.startswith("Discuss brief context"):
            brief = context["content"]["brief"]
            return self.envelope("reply", "Current goal: " + brief["goal"] + " Agreed decisions: " + brief["decisions"])
        if prompt.startswith("Propose project brief"):
            brief = deepcopy(context["content"]["brief"])
            brief["goal"] = "Plan a small local task tool with clear user-reviewed outcomes."
            brief["assumptions"] = "Task ordering may be manual; this is an assumption to review."
            return self.envelope("proposal", "Review the proposed goal and assumptions in the project brief.", proposal={
                "title": "A focused project brief", "summary": "Clarify the goal while keeping assumptions visibly unconfirmed.",
                "diagramId": context["activeDiagramId"], "nodes": None, "edges": None, "brief": brief})
        if prompt.startswith("Revise the visible brief"):
            brief = deepcopy(context["reviewProposal"]["brief"])
            brief["assumptions"] += " Confirm whether task ordering should be manual."
            return self.envelope("proposal", "The revised brief keeps your manual edits and confirmed decisions.", proposal={
                "title": "Refined project brief", "summary": "Retain manual review and make the remaining assumption explicit.",
                "diagramId": context["activeDiagramId"], "nodes": None, "edges": None, "brief": brief})
        if prompt.startswith("Discuss"):
            selection = context.get("generation", {}).get("selection", {"mode": "default"})
            detail = (f" Requested model: {selection['model']} / {selection['reasoningEffort']}."
                      if "model settings" in prompt.lower() and selection["mode"] == "explicit" else "")
            return self.envelope("reply", "The plan is ready for your review. No steps were executed." + detail)
        if prompt.startswith("Review navigation fixture"):
            diagram = deepcopy(next(d for d in context["content"]["diagrams"] if d["id"] == context["activeDiagramId"]))
            existing = next(n for n in diagram["nodes"] if n["title"] == "Store task")
            decision = next(n for n in diagram["nodes"] if n["title"] == "Choose action")
            removed = next(n for n in diagram["nodes"] if n["title"] == "Deprecated export")
            existing["description"] = "Write the task and confirm the saved identifier before continuing."
            diagram["nodes"] = [n for n in diagram["nodes"] if n["id"] != removed["id"]]
            diagram["edges"] = [e for e in diagram["edges"] if removed["id"] not in (e["source"], e["target"])]
            next(e for e in diagram["edges"] if e["source"] == decision["id"] and e["target"] == existing["id"])["label"] = ""
            added = {"id": str(uuid4()), "type": "io", "title": "Display confirmation", "position": {"x": 3500, "y": 1800},
                     "description": "Show the result of saving a task.", "status": "not_started", "checklist": [],
                     **{key: "" for key in ("notes", "pseudocode", "targetFile", "targetScope", "why", "alternatives", "blocker")}}
            diagram["nodes"].append(added)
            diagram["edges"].extend([
                {"id": str(uuid4()), "source": existing["id"], "target": added["id"], "sourceHandle": "out", "targetHandle": "in", "label": "Saved"},
                {"id": str(uuid4()), "source": existing["id"], "target": decision["id"], "sourceHandle": "out", "targetHandle": "in", "label": "Choose another action"},
            ])
            return self.envelope("proposal", "Review each diagram change and the optional planning checks.", proposal={
                "title": "Review the task workflow", "summary": "Clarify storage, add confirmation and retire the old export branch.",
                "diagramId": diagram["id"], "nodes": diagram["nodes"], "edges": diagram["edges"]})
        if prompt.startswith("Revise the visible proposal"):
            candidate = deepcopy(context["reviewProposal"]["diagram"])
            candidate["nodes"][0]["description"] = "Revised from the visible candidate: " + candidate["nodes"][0]["title"]
            return self.envelope("proposal", "I revised the visible candidate.", proposal={
                "title": "Revised review step", "summary": "Preserve the manually edited candidate.",
                "diagramId": candidate["id"], "nodes": candidate["nodes"], "edges": candidate["edges"]})
        diagram = deepcopy(next(d for d in context["content"]["diagrams"] if d["id"] == context["activeDiagramId"]))
        node = {"id": str(uuid4()), "type": "process", "title": "Review expected result", "position": {"x": 420, "y": 300},
                "description": "Check the expected result before continuing.", "status": "not_started",
                "checklist": [{"id": str(uuid4()), "text": "Expected result is documented", "checked": False}],
                **{key: "" for key in ("notes", "pseudocode", "targetFile", "targetScope", "why", "alternatives", "blocker")}}
        if diagram["nodes"]:
            diagram["edges"].append({"id": str(uuid4()), "source": diagram["nodes"][0]["id"], "target": node["id"], "label": "Review", "sourceHandle": None, "targetHandle": None})
        diagram["nodes"].append(node)
        return self.envelope("proposal", "I propose a review step. <script>window.fixtureInjected=true</script>",
                proposal={"title": "Add a review step", "summary": "Make the expected result explicit before proceeding.", "diagramId": diagram["id"], "nodes": diagram["nodes"], "edges": diagram["edges"]})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data-dir", required=True)
    args = parser.parse_args()
    serve(create_app(args.data_dir, planner=FixturePlanner()), host="127.0.0.1", port=args.port)
