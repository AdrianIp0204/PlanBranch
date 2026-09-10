import { describe, expect, it } from "vitest";
import { evidenceState, planState, symbolDescription } from "./catalogue";
import type { DetectedSymbol, PlannedVariable } from "./types";

const plan = { id: "plan" } as PlannedVariable;
const symbol = (
  id: string,
  state: string,
  ambiguousIdentity = false,
): DetectedSymbol => ({
  id,
  state,
  ambiguousIdentity,
  name: "count",
  kind: "variable",
  file: "worker.py",
  scope: "work",
  scopeKind: "function",
  annotation: "int",
  locations: [{ line: 7, column: 4 }],
  declarations: [],
  hash: "hash",
  scanTime: "",
});
const matches = (ids: string[]) =>
  ids.map((symbolId) => ({
    plannedId: "plan",
    symbolId,
    decision: "confirmed",
  }));

describe("catalogue evidence wording and backend-compatible precedence", () => {
  it("distinguishes no match, missing, stale, current, and ambiguous observations", () => {
    expect(planState(plan, [], [])).toBe("Planned only");
    expect(planState(plan, matches(["missing"]), [])).toBe(
      "Linked, not detected",
    );
    expect(planState(plan, matches(["s"]), [symbol("s", "current")])).toBe(
      "Linked and detected",
    );
    for (const state of ["stale", "historical", "unverified"])
      expect(planState(plan, matches(["s"]), [symbol("s", state)])).toBe(
        "Stale scan",
      );
    expect(
      planState(plan, matches(["s"]), [symbol("s", "current", true)]),
    ).toBe("Stale scan");
    expect(
      planState(plan, matches(["stale", "absent"]), [
        symbol("stale", "stale"),
        symbol("absent", "not_detected"),
      ]),
    ).toBe("Linked, not detected");
  });
  it("describes exact repeated bindings with their source line and trust state", () => {
    expect(symbolDescription(symbol("a", "current", true))).toContain(
      "worker.py · work · line 7 · Current · identity needs review",
    );
    expect(evidenceState(symbol("i", "historical"))).toBe(
      "Historical / unverified",
    );
    expect(evidenceState(symbol("gone", "not_detected"))).toBe("Not detected");
  });
});
