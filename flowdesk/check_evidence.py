"""Host-created byte identities and bounded test-artifact observations.

These hashes identify bytes; they are neither correctness proofs nor signatures.
Git internals are excluded by the existing workspace reader. Only Python caches,
pytest caches and the explicit .planbranch-results output directory are excluded
from source identity. Ignored and uncommitted source files otherwise count.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import xml.etree.ElementTree as ET

EVIDENCE_VERSION = 1


def source_identity(files, modes=None):
    entries = []
    for name, data in sorted(files.items()):
        parts = PurePosixPath(name).parts
        if ("__pycache__" in parts or ".pytest_cache" in parts or
                (parts and parts[0] == ".planbranch-results")):
            continue
        entries.append({"path": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
                        "executable": bool((modes or {}).get(name, 0) & 0o111)})
    digest = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"schemaVersion": EVIDENCE_VERSION, "sha256": digest, "fileCount": len(entries),
            "exclusions": [".git", "__pycache__", ".pytest_cache", ".planbranch-results"], "files": entries}


def snapshot_identity(root):
    from .workspace_tools import snapshot
    files = snapshot(root)
    return source_identity(files, {name: (Path(root) / name).stat().st_mode for name in files})


def junit_observation(files):
    """Parse only the documented explicit result path; never resolve external XML."""
    name = ".planbranch-results/junit.xml"
    data = files.get(name)
    if data is None: return None
    artifact = {"path": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    if len(data) > 512_000 or b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        return {"artifact": artifact, "state": "unreadable", "reason": "Unsupported or oversized JUnit XML."}
    try:
        root = ET.fromstring(data)
        if root.tag not in {"testsuite", "testsuites"}: raise ValueError("Unsupported root")
        cases = list(root.iter("testcase"))
        if len(cases) > 5000: raise ValueError("Too many tests")
        counts = {"total": len(cases), "failed": 0, "errors": 0, "skipped": 0, "passed": 0}
        for case in cases:
            key = "failed" if case.find("failure") is not None else "errors" if case.find("error") is not None else "skipped" if case.find("skipped") is not None else "passed"
            counts[key] += 1
        # Count actual testcase elements, not an unverified tests='...' claim.
        state = "no_tests" if not cases else "failed" if counts["failed"] or counts["errors"] else "skipped" if not counts["passed"] else "passed"
        return {"artifact": artifact, "state": state, "counts": counts, "provenance": "command-produced-junit"}
    except (ET.ParseError, ValueError, RecursionError):
        return {"artifact": artifact, "state": "unreadable", "reason": "JUnit XML could not be parsed safely."}


def observation_state(command, candidate_hash=None):
    evidence = command.get("evidence")
    if not evidence or evidence.get("schemaVersion") != EVIDENCE_VERSION or evidence.get("provenance") != "host_observed":
        return "external_result_reported"
    if (evidence.get("sourceChanged") or not candidate_hash or
            evidence.get("candidateBefore") != candidate_hash or evidence.get("candidateAfter") != candidate_hash):
        return "stale_evidence"
    if command.get("status") in {"interrupted", "cancelled", "in_progress"} or command.get("exitCode") is None:
        return "not_verified"
    test = evidence.get("testResult") or {}
    if command["exitCode"] != 0 or test.get("state") == "failed": return "observed_check_failed"
    if test.get("state") in {"no_tests", "skipped", "unreadable", "unchanged_report"}: return "human_review_required"
    return "observed_check_passed"
