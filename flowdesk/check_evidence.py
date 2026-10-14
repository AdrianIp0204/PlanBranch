"""Host-created byte identities and bounded test-artifact observations.

These hashes identify bytes, not correctness. Version 2 includes every candidate
file except Git metadata, including ignored source and existing caches. Writable
verification outputs live outside the candidate. Host seals authenticate the
local ingestion boundary, not external reports or requirement coverage.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import hmac
import os
from copy import deepcopy
import xml.etree.ElementTree as ET

EVIDENCE_VERSION = 2


def source_identity(files, modes=None):
    entries = []
    for name, data in sorted(files.items()):
        parts = PurePosixPath(name).parts
        if parts and parts[0] == '.git':
            continue
        entries.append({"path": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
                        "executable": bool((modes or {}).get(name, 0) & 0o111)})
    digest = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"schemaVersion": EVIDENCE_VERSION, "sha256": digest, "fileCount": len(entries),
            "exclusions": [".git"], "files": entries}


def _host_key(data_dir, *, create=False):
    """Never expose this key to a provider, worktree, archive or container."""
    from .execution_git import _plain, WorkspaceError
    root = Path(data_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = root / 'command-evidence.key'
    if create:
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(os.urandom(32))
    if not _plain(path) or path.stat().st_nlink != 1 or path.stat().st_size != 32:
        raise WorkspaceError('The host command evidence key is unavailable or unsafe.')
    return path.read_bytes()


def _sealed_payload(command):
    result = {key: deepcopy(command.get(key)) for key in ('id', 'command', 'status', 'exitCode', 'output', 'evidence')}
    result['evidence'].pop('hostSeal', None)
    result['evidence'].pop('hostAuthenticated', None)
    return json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def seal_command(data_dir, command):
    result = deepcopy(command)
    result['evidence']['hostSeal'] = hmac.new(_host_key(data_dir, create=True), _sealed_payload(result), hashlib.sha256).hexdigest()
    return result


def authenticated_command(data_dir, command, run_id):
    """Only the host runner can create evidence; JSON provenance is not authority."""
    evidence = command.get('evidence')
    if not isinstance(evidence, dict) or evidence.get('schemaVersion') != EVIDENCE_VERSION or evidence.get('runId') != run_id:
        return False
    try:
        expected = hmac.new(_host_key(data_dir), _sealed_payload(command), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, evidence.get('hostSeal', ''))
    except (OSError, ValueError, TypeError):
        return False


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
    if isinstance(evidence, dict) and evidence.get('schemaVersion') == 1 and evidence.get('provenance') == 'host_observed':
        return 'legacy_writable_observation'
    if not evidence or evidence.get("schemaVersion") != EVIDENCE_VERSION or evidence.get("provenance") != "host_observed":
        return "external_result_reported"
    if not evidence.get('hostAuthenticated'):
        return 'external_result_reported'
    if evidence.get('executionMode') != 'immutable_verification':
        return 'mutable_command_observed'
    if evidence.get('mountReadOnly') is not True or evidence.get('runtime') != 'docker-source-bound-v2':
        return 'not_verified'
    if (evidence.get("sourceChanged") or not candidate_hash or
            evidence.get("candidateBefore") != candidate_hash or evidence.get("candidateAfter") != candidate_hash):
        return "stale_evidence"
    if command.get("status") in {"interrupted", "cancelled", "in_progress"} or command.get("exitCode") is None:
        return "not_verified"
    test = evidence.get("testResult") or {}
    if command["exitCode"] != 0 or test.get("state") == "failed": return "observed_check_failed"
    if test.get("state") in {"no_tests", "skipped", "unreadable", "unchanged_report"}: return "human_review_required"
    if test.get('state') != 'passed':
        return 'command_exit_observed'
    return "observed_check_passed"
