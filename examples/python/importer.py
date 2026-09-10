"""Removable Batch importer example. Static scanning never executes this file."""
import csv


def process_records(records: list[dict[str, str]]) -> int:
    count: int = 0
    record: dict[str, str]
    for record in records:
        if not record.get("name"):
            continue
        count += 1
    return count


def read_records(filename: str) -> list[dict[str, str]]:
    with open(filename, newline="", encoding="utf-8") as source:
        return list(csv.DictReader(source))
