"""Browser-test-only deterministic provider; never shipped in the application."""
import argparse
from copy import deepcopy
import time
from uuid import uuid4
from flowdesk.app import create_app
from waitress import serve


class FixturePlanner:
    def __init__(self):
        self.failed = set()

    def status(self):
        return {"available": True, "label": "Codex CLI"}

    def generate(self, context):
        prompt = context["messages"][-1]["text"]
        time.sleep(1.5 if "slow" in prompt else 0.15)
        if "fail once" in prompt and prompt not in self.failed:
            self.failed.add(prompt)
            raise RuntimeError("Fixture connection interrupted. Retry this message.")
        if prompt.startswith("Discuss"):
            return {"message": "The plan is ready for your review. No steps were executed.", "proposal": None}
        diagram = deepcopy(next(d for d in context["content"]["diagrams"] if d["id"] == context["activeDiagramId"]))
        node = {"id": str(uuid4()), "type": "process", "title": "Review expected result", "position": {"x": 420, "y": 300},
                "description": "Check the expected result before continuing.", "status": "not_started",
                "checklist": [{"id": str(uuid4()), "text": "Expected result is documented", "checked": False}],
                **{key: "" for key in ("notes", "pseudocode", "targetFile", "targetScope", "why", "alternatives", "blocker")}}
        if diagram["nodes"]:
            diagram["edges"].append({"id": str(uuid4()), "source": diagram["nodes"][0]["id"], "target": node["id"], "label": "Review", "sourceHandle": None, "targetHandle": None})
        diagram["nodes"].append(node)
        return {"message": "I propose a review step. <script>window.fixtureInjected=true</script>",
                "proposal": {"title": "Add a review step", "summary": "Make the expected result explicit before proceeding.", "diagramId": diagram["id"], "nodes": diagram["nodes"], "edges": diagram["edges"]}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data-dir", required=True)
    args = parser.parse_args()
    serve(create_app(args.data_dir, planner=FixturePlanner()), host="127.0.0.1", port=args.port)
