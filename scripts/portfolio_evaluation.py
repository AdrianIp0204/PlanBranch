"""Reproduce offline engineering observations, never an AI comparison trial.

Only fresh TemporaryDirectory repositories are accepted. The injected executor
writes fixed bundled text; it cannot request tools, contact providers, or choose
a host command. The trusted oracle runs separately from production execution.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time
from uuid import NAMESPACE_URL, uuid4, uuid5

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from flowdesk.check_evidence import snapshot_identity
from flowdesk.execution import ACTIVE, ExecutionService
from flowdesk.execution_git import GitWorkspace
from flowdesk.exports import portable_project, serialize_portable
from flowdesk.planning import PlanningService
from flowdesk.storage import Store, empty_content
from flowdesk.validation import validate_content

FIXTURES = ROOT / "examples" / "evaluation"


def fixed_id(value):
    return str(uuid5(NAMESPACE_URL, "https://planbranch.invalid/evaluation/" + value))


def mutation(**values):
    return {"mutationId": str(uuid4()), **values}


def load_tasks():
    return json.loads((FIXTURES / "tasks.json").read_text(encoding="utf-8"))["tasks"]


def plan_for(spec):
    """Create ordinary portable content with no machine permission or evidence."""
    content = empty_content(spec["title"] + " · deterministic fixture")
    content["notes"] = "Bundled fixture plan. No model has run; no approval or execution permission is included."
    content["brief"].update(goal=spec["title"], requirements=spec["requirement"],
        decisions=spec["decision"], constraints="Use a disposable repository. No provider calls.",
        outOfScope="Real AI performance, human review timing and production deployment.")
    diagram = content["diagrams"][0]
    diagram["id"] = fixed_id(spec["id"] + "/diagram")
    diagram["name"] = "Intent, implementation and review"
    diagram["nodes"] = [
        {"id": fixed_id(spec["id"] + "/" + key), "type": kind, "title": title,
         "position": {"x": index * 290, "y": 80}, "status": "not_started"}
        for index, (key, kind, title) in enumerate([
            ("requirement", "start", spec["title"]),
            ("implementation", "process", spec["decision"]),
            ("review", "end", "Inspect tests and diff before acceptance")])]
    diagram["edges"] = [
        {"id": fixed_id(spec["id"] + "/edge/" + str(index)), "source": diagram["nodes"][index]["id"],
         "target": diagram["nodes"][index + 1]["id"], "sourceHandle": "out", "targetHandle": "in", "label": ""}
        for index in range(2)]
    primary = {"id": fixed_id(spec["id"] + "/task"), "title": spec["title"],
        "deliverable": spec["requirement"], "expectedFiles": spec["allowedFiles"],
        "prerequisiteIds": [], "status": "not_started",
        "nodeLinks": [{"nodeId": diagram["nodes"][1]["id"], "diagramId": diagram["id"],
                       "title": diagram["nodes"][1]["title"], "missing": False}],
        "acceptanceChecks": [{"id": fixed_id(spec["id"] + "/" + criterion.split(":")[0]), "text": criterion}
                             for criterion in spec["criteria"]]}
    content["buildTasks"] = [primary]
    if spec["id"] == "importer":
        content["buildTasks"].append({"id": fixed_id("importer/count"), "title": "Count successful imports",
            "deliverable": "Return a count incremented only after a successful storage callback.",
            "expectedFiles": ["importer.py"], "prerequisiteIds": [primary["id"]], "nodeLinks": [],
            "acceptanceChecks": [{"id": fixed_id("importer/count/check"), "text": "Invalid and unsaved rows do not increment the count."}],
            "status": "not_started"})
    return validate_content(content)


def write_fixture(root, files):
    for relative, content in files.items():
        path = root / relative
        if path.is_absolute() and (not path.resolve().is_relative_to(root.resolve()) or ".git" in Path(relative).parts):
            raise ValueError("Fixture path escapes its disposable repository.")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")


def git(root, *args):
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
        GIT_AUTHOR_DATE="2026-01-01T00:00:00Z", GIT_COMMITTER_DATE="2026-01-01T00:00:00Z",
        GIT_TERMINAL_PROMPT="0")
    result = subprocess.run(["git", "-c", "core.hooksPath=" + os.devnull, "-c", "core.autocrlf=false",
                             "-c", "commit.gpgsign=false", "-c", "safe.directory=" + root.as_posix(), *args],
                            cwd=root, env=environment, text=True, capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError("Fixture Git operation failed: " + result.stderr.strip())
    return result.stdout.strip()


class OfflinePlanner:
    def status(self):
        return {"available": False, "label": "No model used"}


class FixtureExecutor:
    """An explicit test double. It neither parses requests nor invokes tools."""
    def __init__(self, spec):
        self.spec, self.calls = spec, 0

    def status(self):
        return {"available": True, "label": "Deterministic fixture; no AI model"}

    def configure(self, selection):
        return {"provider": "fixture", "selection": deepcopy(selection), "instructionVersion": "portfolio-fixture-v1",
                "instructions": "Write the fixed bundled fixture only.", "resolvedModel": "none"}

    def run(self, context, worktree, cancel, on_event):
        self.calls += 1
        write_fixture(Path(worktree), self.spec["candidate"])
        return {"status": self.spec["outcome"], "summary": "Scripted candidate text; no model ran.", "commands": [],
                "error": "Injected interruption after partial edits." if self.spec["outcome"] == "interrupted" else None}


def finish(service, project_id, run_id):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        run = service.detail(project_id, run_id)["run"]
        if run["state"] not in ACTIVE:
            return run
        time.sleep(.02)
    raise RuntimeError("Deterministic execution exceeded its 30-second deadline.")


def oracle(task_id, candidate):
    before = snapshot_identity(candidate)["sha256"]
    result = subprocess.run([sys.executable, "-I", "-B", str(FIXTURES / "oracle.py"), task_id, str(candidate)],
                            cwd=FIXTURES, capture_output=True, text=True, encoding="utf-8", timeout=15)
    if result.returncode not in {0, 1}:
        raise RuntimeError("Independent oracle failed to run.")
    observations = json.loads(result.stdout)
    observations.update(exitCode=result.returncode, candidateHash=before,
        sourceUnchanged=snapshot_identity(candidate)["sha256"] == before,
        provenance="external_trusted_fixture_oracle; not PlanBranch immutable verification")
    return observations


def run_case(spec, root):
    source = root / "repo"
    source.mkdir(parents=True)
    write_fixture(source, spec["baseline"])
    git(source, "init", "--initial-branch=fixture")
    git(source, "config", "user.name", "PlanBranch deterministic fixture")
    git(source, "config", "user.email", "fixture@example.invalid")
    git(source, "add", ".")
    git(source, "commit", "-m", "Fixed evaluation baseline")
    source_commit = git(source, "rev-parse", "HEAD")
    original_index = (source / ".git" / "index").read_bytes()
    before = oracle(spec["id"], source)
    store = Store(root / "app-data" / "flowdesk.sqlite3")
    project = store.create_project(content=plan_for(spec))
    pid = project["id"]
    task = project["content"]["buildTasks"][0]
    planning = PlanningService(store, OfflinePlanner())
    executor = FixtureExecutor(spec)
    service = ExecutionService(store, planning, executor, GitWorkspace(store.db_path.parent))
    observations = {}
    try:
        with closing(store.connect()) as db:
            observations["new_plan_has_no_authority"] = all(db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] == 0
                for table in ("planning_approvals", "execution_repositories", "execution_runs", "source_attachments"))
        observations["unapproved_run_blocked"] = not service.preview(pid, {"taskId": task["id"]})["ready"]
        planning.approve(pid, mutation(baseRevision=project["revision"]))
        observations["approval_alone_cannot_run"] = not service.preview(pid, {"taskId": task["id"]})["ready"]
        service.repository(pid, mutation(path=str(source), confirmed=True))
        preview = service.preview(pid, {"taskId": task["id"]})
        if not preview["ready"]:
            raise RuntimeError("Disposable execution was blocked: " + "; ".join(preview["issues"]))
        if len(project["content"]["buildTasks"]) > 1:
            dependent_id = project["content"]["buildTasks"][1]["id"]
            dependent = service.preview(pid, {"taskId": dependent_id})
            observations["incomplete_prerequisite_blocks_dependent"] = not dependent["ready"] and bool(dependent["prerequisiteIssues"])
        request = mutation(previewId=preview["preview"]["id"], confirmed=True)
        run = finish(service, pid, service.start(pid, request)["run"]["id"])
        if not run["artifact"]:
            raise RuntimeError("The fixture produced no inspectable change artifact.")
        candidate = Path(run["worktreePath"])
        after = oracle(spec["id"], candidate)
        changed = sorted(item["path"] for item in run["artifact"]["files"])
        unexpected = sorted(set(changed) - set(spec["allowedFiles"]))
        observations.update(
            source_checkout_unchanged_before_review=snapshot_identity(source)["sha256"] == before["candidateHash"],
            run_does_not_accept_complete_or_apply=not run["acceptedDigest"] and not run["completedCursor"] and not run["applied"],
            oracle_bound_to_captured_candidate=after["candidateHash"] == run["capturedCandidate"]["sha256"] and after["sourceUnchanged"],
            external_tests_not_promoted_to_internal_verification=run["commands"] == [],
            duplicate_start_does_not_rerun=service.start(pid, request)["run"]["id"] == run["id"] and executor.calls == 1)
        if spec["id"] == "importer":
            digest = run["artifact"]["digest"]
            accepted = service.accept(pid, run["id"], mutation(digest=digest, confirmed=True))["run"]
            observations["acceptance_does_not_complete_or_apply"] = not accepted["completedCursor"] and not accepted["applied"]
            completed = service.complete(pid, run["id"], mutation(digest=digest, confirmed=True, baseRevision=project["revision"]))
            observations["completion_does_not_apply"] = not completed["run"]["applied"]
            applied = service.apply(pid, run["id"], mutation(digest=digest, confirmed=True))["run"]
            observations["explicit_apply_changes_only_disposable_checkout"] = applied["applied"] and snapshot_identity(source)["sha256"] == after["candidateHash"]
            observations["apply_does_not_stage_or_commit"] = (source / ".git" / "index").read_bytes() == original_index and git(source, "rev-parse", "HEAD") == source_commit
            dependent = service.preview(pid, {"taskId": dependent_id})
            observations["dependent_still_needs_user_commit"] = not dependent["ready"] and any("Commit" in issue for issue in dependent["issues"])
        if spec["id"] == "recovery":
            service.close()
            service = ExecutionService(Store(store.db_path), planning, executor, GitWorkspace(store.db_path.parent))
            recovered = service.detail(pid, run["id"])["run"]
            observations["interrupted_candidate_survives_reopen_without_rerun"] = (recovered["state"] == "interrupted"
                and recovered["candidate"]["sha256"] == after["candidateHash"] and executor.calls == 1)
            observations["interrupted_candidate_remains_unaccepted"] = not recovered["acceptedDigest"] and not recovered["applied"]
        return {"taskId": spec["id"], "fixtureState": run["state"], "baselineCommit": source_commit,
            "baselineChecks": before, "candidateChecks": after, "changedFiles": changed,
            "unrequestedFiles": unexpected, "unrequestedFileCount": len(unexpected),
            "passedCriteria": sum(check["passed"] for check in after["checks"]), "totalCriteria": len(spec["criteria"]),
            "traceLinks": [{"criterionId": criterion.split(":")[0], "task": spec["id"],
                            "candidateHash": after["candidateHash"], "file": spec["allowedFiles"][0],
                            "check": criterion.split(":")[0], "origin": "predeclared fixture mapping"}
                           for criterion in spec["criteria"]],
            "scriptedReviewDecision": spec["scriptedReview"], "humanReviewObserved": False,
            "humanReviewSeconds": None, "observations": observations}
    finally:
        service.close()


def source_fingerprint():
    paths = sorted({*ROOT.glob("flowdesk/**/*.py"), *ROOT.glob("flowdesk/migrations/*.sql"),
                    *ROOT.glob("flowdesk/prompts/*.md"), *ROOT.glob("frontend/src/**/*"),
                    Path(__file__).resolve(), FIXTURES / "oracle.py", FIXTURES / "tasks.json"})
    files = {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
             for path in paths if path.is_file() and "__pycache__" not in path.parts}
    return {"algorithm": "sha256 of sorted compact JSON mapping relative file names to SHA-256 bytes",
            "fileCount": len(files), "sha256": hashlib.sha256(json.dumps(files, sort_keys=True, separators=(",", ":")).encode()).hexdigest()}


def evaluate():
    start_source = source_fingerprint()
    start_head = git(ROOT, "rev-parse", "HEAD")
    cases = []
    with tempfile.TemporaryDirectory(prefix="planbranch-evaluation-") as location:
        for spec in load_tasks():
            cases.append(run_case(spec, Path(location) / spec["id"]))
    end_source = source_fingerprint()
    end_head = git(ROOT, "rev-parse", "HEAD")
    source_unchanged = start_source == end_source and start_head == end_head
    return {"schemaVersion": 1, "generatedAt": datetime.now(timezone.utc).isoformat(),
        "evidenceClass": "deterministic_fixture_observations", "empiricalComparison": "not_yet_conducted",
        "modelCalls": 0, "humanParticipants": 0, "python": platform.python_version(), "platform": platform.system(),
        "sourceHead": start_head, "sourceHeadAfter": end_head,
        "sourceFingerprint": start_source, "sourceFingerprintAfter": end_source,
        "sourceUnchangedDuringEvaluation": source_unchanged,
        "oracleHash": hashlib.sha256((FIXTURES / "oracle.py").read_bytes()).hexdigest(),
        "fixtureHash": hashlib.sha256((FIXTURES / "tasks.json").read_bytes()).hexdigest(),
        "cases": cases, "allBoundaryObservationsPassed": all(all(case["observations"].values()) for case in cases),
        "receiptValid": source_unchanged,
        "limitations": ["Scripted candidates and scripted review decisions; no AI or human comparison.",
            "External trusted fixture checks do not certify production sandbox enforcement or internal immutable verification.",
            "Interruption is injected by the test double; this is not a measured OS crash recovery trial.",
            "File allowlists find whole-file scope deviations, not unrelated edits within an allowed file."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Write sanitized JSON observations.")
    parser.add_argument("--export-plan", type=Path, help="Write the ordinary importer plan; includes no execution authority.")
    args = parser.parse_args()
    if args.export_plan:
        document = portable_project({"content": plan_for(load_tasks()[0]), "views": {}}, [])
        args.export_plan.parent.mkdir(parents=True, exist_ok=True)
        args.export_plan.write_text(serialize_portable(document) + "\n", encoding="utf-8")
    report = evaluate()
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for case in report["cases"]:
        print(f"{case['taskId']}: {case['passedCriteria']}/{case['totalCriteria']} criteria; "
              f"{case['unrequestedFileCount']} unrequested files; state={case['fixtureState']}; "
              f"{sum(case['observations'].values())}/{len(case['observations'])} boundary observations")
    print("Deterministic fixtures only. Empirical AI comparison: NOT YET CONDUCTED.")
    if not report["receiptValid"]:
        print("Source changed during evaluation: receipt invalid; repeat on a stable checkout.")
    return 0 if report["allBoundaryObservationsPassed"] and report["receiptValid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
