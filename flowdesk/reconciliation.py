"""Review suggestions are derived; human plans and match choices are untouched."""
from __future__ import annotations


def _file(value):
    return (value or "").replace("\\", "/").removeprefix("./")


def _scope(value):
    value = (value or "").strip()
    return "<module>" if value in ("module", "global", "<module>") else value


def reconcile(content, symbols):
    suggestions, reviews = [], []
    decisions = {(item["plannedId"], item["symbolId"]): item["decision"] for item in content.get("matches", [])}
    by_id = {symbol["id"]: symbol for symbol in symbols}
    for plan in content.get("variables", []):
        linked = [by_id.get(symbol_id) for (planned_id, symbol_id), decision in decisions.items() if planned_id == plan["id"] and decision == "confirmed"]
        differences = []
        if not linked:
            state = "planned_only"
        elif any(symbol is None or symbol.get("state") == "not_detected" for symbol in linked):
            state = "linked_not_detected"
        elif any(symbol.get("state") in ("stale", "historical") or symbol.get("ambiguousIdentity") for symbol in linked if symbol):
            state = "stale_scan"
        else:
            state = "linked_detected"
        for symbol in filter(None, linked):
            for planned_key, actual_key, label, normalize in [
                ("name", "name", "Name", lambda value: value or ""),
                ("intendedFile", "file", "File", _file),
                ("scope", "scope", "Scope", _scope),
                ("scopeKind", "scopeKind", "Scope kind", lambda value: value or ""),
                ("intendedType", "annotation", "Written annotation", lambda value: (value or "").strip()),
            ]:
                intended = normalize(plan.get(planned_key))
                actual = normalize(symbol.get(actual_key))
                if intended and intended != "unknown" and intended != actual:
                    differences.append(f"{label}: planned {intended}; detected {actual or 'unknown'} ({symbol['file']}).")
        reviews.append({"plannedId": plan["id"], "state": state, "differences": differences})
        for symbol in symbols:
            if symbol.get("state") != "current" or (plan["id"], symbol["id"]) in decisions:
                continue
            same_name = bool(plan.get("name")) and plan["name"] == symbol.get("name")
            same_file = bool(plan.get("intendedFile")) and _file(plan["intendedFile"]) == _file(symbol.get("file"))
            same_scope = bool(plan.get("scope")) and _scope(plan["scope"]) == _scope(symbol.get("scope"))
            same_type = bool(plan.get("intendedType")) and plan["intendedType"].strip() == symbol.get("annotation") and symbol.get("annotation") != "unknown"
            # Name alone never creates a suggestion. A possible rename needs
            # file + scope + annotation corroboration, avoiding every local in
            # a function becoming a rename suggestion.
            if same_name and (same_file or same_scope) or not same_name and same_file and same_scope and same_type:
                reasons = []
                if same_name:
                    reasons.append("Same name")
                else:
                    reasons.append("Possible rename; review before linking")
                if same_file:
                    reasons.append("Same intended file")
                if same_scope:
                    reasons.append("Same intended scope")
                if same_type:
                    reasons.append("Written annotation matches intended type")
                if plan.get("intendedFile") and not same_file:
                    reasons.append("Different file; possible move to review")
                if symbol.get("ambiguousIdentity"):
                    reasons.append("Scope identity is ambiguous; inspect the source location")
                suggestions.append({"plannedId": plan["id"], "symbolId": symbol["id"], "reasons": reasons})
    return {"suggestions": suggestions, "reviews": reviews}
