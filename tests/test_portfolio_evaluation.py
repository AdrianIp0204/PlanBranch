"""Validate the evaluation instrument, including its intentional negative cases."""
from contextlib import closing
from copy import deepcopy
import json

import pytest

from scripts.portfolio_evaluation import evaluate, load_tasks, oracle, plan_for, write_fixture
from flowdesk.exports import portable_project, import_project
from flowdesk.storage import Store


def test_oracle_rejects_incorrect_candidate_without_editing_source(tmp_path):
    spec = load_tasks()[0]
    write_fixture(tmp_path, spec["baseline"])
    baseline = oracle(spec["id"], tmp_path)
    assert baseline["exitCode"] == 1
    assert [check["passed"] for check in baseline["checks"]] == [True, False, False]
    assert baseline["sourceUnchanged"]
    write_fixture(tmp_path, spec["candidate"])
    candidate = oracle(spec["id"], tmp_path)
    assert candidate["exitCode"] == 0 and len(candidate["checks"]) == 3
    assert candidate["sourceUnchanged"] and candidate["candidateHash"] != baseline["candidateHash"]


def test_fixture_writer_refuses_path_outside_disposable_root(tmp_path):
    with pytest.raises(ValueError, match="escapes"):
        write_fixture(tmp_path, {"../escaped.py": "pass"})
    assert not (tmp_path.parent / "escaped.py").exists()


def test_portable_example_contains_plan_only_and_roundtrips(tmp_path):
    content = plan_for(load_tasks()[0])
    document = portable_project({"content": content, "views": {}}, [])
    assert set(document) == {"format", "version", "content", "views", "symbols"}
    store = Store(tmp_path / "data.sqlite3")
    imported = import_project(store, deepcopy(document))
    assert len(imported["content"]["buildTasks"]) == 2
    assert imported["content"]["buildTasks"][1]["prerequisiteIds"] == [imported["content"]["buildTasks"][0]["id"]]
    assert all(task["status"] == "not_started" for task in imported["content"]["buildTasks"])
    with closing(store.connect()) as db:
        for table in ("planning_approvals", "execution_repositories", "execution_runs", "source_attachments"):
            assert db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] == 0


def test_real_services_keep_fixture_claims_and_authority_separate():
    report = evaluate()
    assert report["allBoundaryObservationsPassed"]
    assert report["receiptValid"] and report["sourceUnchangedDuringEvaluation"]
    assert report["empiricalComparison"] == "not_yet_conducted"
    assert report["modelCalls"] == report["humanParticipants"] == 0
    cases = {case["taskId"]: case for case in report["cases"]}
    assert {key: case["passedCriteria"] for key, case in cases.items()} == {"importer": 3, "pagination": 3, "recovery": 2}
    assert cases["pagination"]["unrequestedFiles"] == ["settings.json"]
    assert cases["recovery"]["fixtureState"] == "interrupted"
    assert all(case["humanReviewSeconds"] is None and not case["humanReviewObserved"] for case in cases.values())
    assert all(case["candidateChecks"]["sourceUnchanged"] for case in cases.values())
    # The public receipt has hashes and relative filenames, never disposable paths.
    assert "AppData" not in json.dumps(report) and "planbranch-evaluation-" not in json.dumps(report)


def test_receipt_cannot_certify_source_changed_during_evaluation(monkeypatch):
    import scripts.portfolio_evaluation as harness
    fingerprints = iter([{"sha256": "before"}, {"sha256": "after"}])
    monkeypatch.setattr(harness, "source_fingerprint", lambda: next(fingerprints))
    monkeypatch.setattr(harness, "load_tasks", lambda: [])
    report = harness.evaluate()
    assert not report["sourceUnchangedDuringEvaluation"] and not report["receiptValid"]
