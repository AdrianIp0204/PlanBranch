"""Fixed, independent acceptance checks for the portfolio fixtures.

Run only against the bundled trusted fixtures. This is a test runner, not a
sandbox for arbitrary submissions. It deliberately lives outside candidate
repositories so a candidate cannot edit its own acceptance checks.
"""
import importlib.util
import json
from pathlib import Path
import sys


def load(root, name):
    spec = importlib.util.spec_from_file_location("candidate", root / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def importer(root):
    module = load(root, "importer.py")

    def valid():
        saved = []
        module.process_records([{"id": "A"}], saved.append)
        assert saved == [{"id": "A"}], "A valid record must be saved exactly once."

    def invalid():
        saved = []
        module.process_records([{}, {"id": ""}, {"id": "  "}], saved.append)
        assert saved == [], "Missing, empty and whitespace identifiers must not reach storage."

    def mixed():
        saved = []
        module.process_records([{}, {"id": "A"}, {"id": ""}, {"id": "B"}], saved.append)
        assert saved == [{"id": "A"}, {"id": "B"}], "Invalid rows must not stop later valid rows."

    return [("R1", valid), ("R2", invalid), ("R3", mixed)]


def pagination(root):
    module = load(root, "pagination.py")

    def ordinary():
        assert module.page([1, 2, 3, 4], 1, 2) == [3, 4], "Pages must be zero based."

    def invalid():
        for index, size in [(-1, 2), (0, 0), (0, -1), (True, 2), (0, 1.5)]:
            try:
                module.page([1, 2], index, size)
            except ValueError:
                continue
            raise AssertionError("Invalid pagination arguments must raise ValueError.")

    def empty():
        assert module.page([], 0, 2) == [] and module.page([1], 9, 2) == [], "Empty and out-of-range pages must be empty."

    return [("R1", ordinary), ("R2", invalid), ("R3", empty)]


def recovery(root):
    module = load(root, "exporter.py")

    def stable():
        assert module.encode({"b": 2, "a": 1}) == '{"a":1,"b":2}', "Keys must be sorted with compact separators."

    def unicode():
        assert module.encode({"name": "香港"}) == '{"name":"香港"}', "Unicode must remain readable."

    def finite():
        for value in (float("nan"), float("inf")):
            try:
                module.encode({"value": value})
            except ValueError:
                continue
            raise AssertionError("Non-finite numbers must be rejected.")

    return [("R1", stable), ("R2", unicode), ("R3", finite)]


def main():
    task_id, location = sys.argv[1:]
    checks = {"importer": importer, "pagination": pagination, "recovery": recovery}
    results = []
    try:
        cases = checks[task_id](Path(location))
        for criterion, check in cases:
            try:
                check()
                results.append({"criterionId": criterion, "passed": True})
            except Exception as error:
                results.append({"criterionId": criterion, "passed": False,
                                "failure": f"{type(error).__name__}: {error}"})
    except Exception as error:
        results = [{"criterionId": "load", "passed": False,
                    "failure": f"{type(error).__name__}: {error}"}]
    print(json.dumps({"checks": results}, ensure_ascii=False))
    return 0 if results and all(item["passed"] for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
