"""Mixed evidence must use the same precedence as the visible catalogue."""
import pytest
from flowdesk.reconciliation import reconcile


@pytest.mark.parametrize("symbols,expected", [
    ([], "linked_not_detected"),
    ([{"id":"a","state":"current"}], "linked_detected"),
    ([{"id":"a","state":"current","ambiguousIdentity":True}], "stale_scan"),
    ([{"id":"a","state":"historical"}], "stale_scan"),
    ([{"id":"a","state":"stale"},{"id":"b","state":"not_detected"}], "linked_not_detected"),
])
def test_catalogue_state_precedence(symbols, expected):
    content={"variables":[{"id":"plan","name":"count"}],"matches":[{"plannedId":"plan","symbolId":item["id"],"decision":"confirmed"} for item in symbols] or [{"plannedId":"plan","symbolId":"a","decision":"confirmed"}]}
    for item in symbols:
        item.update(name="count", file="source.py", scope="work", annotation="int")
    assert reconcile(content,symbols)["reviews"][0]["state"] == expected


def test_rejected_match_stays_rejected_but_exact_other_scope_remains_available():
    content={"variables":[{"id":"plan","name":"count","intendedFile":"source.py","scope":"work"}],"matches":[{"plannedId":"plan","symbolId":"a","decision":"rejected"}]}
    symbols=[{"id":sid,"name":"count","file":"source.py","scope":scope,"annotation":"int","state":"current"} for sid,scope in [("a","other"),("b","work")]]
    result=reconcile(content,symbols)
    assert [suggestion["symbolId"] for suggestion in result["suggestions"]] == ["b"]
    assert result["reviews"][0]["state"] == "planned_only"
