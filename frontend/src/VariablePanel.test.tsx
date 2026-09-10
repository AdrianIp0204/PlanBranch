import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import VariablePanel from "./VariablePanel";
import { ProjectProvider, useProject } from "./store";
import {
  copy,
  type Content,
  type DetectedSymbol,
  type Envelope,
} from "./types";

vi.mock("./api", () => ({ api: vi.fn() }));
const observation: DetectedSymbol = {
  id: "observed",
  name: "count",
  file: "long/path/source.py",
  scope: "pipeline.stage",
  scopeKind: "function",
  kind: "variable",
  annotation: "int",
  locations: [{ line: 42, column: 4 }],
  declarations: [],
  state: "current",
  hash: "hash",
  scanTime: "2026-09-10T00:00:00Z",
  ambiguousIdentity: true,
};
function initial(): Envelope {
  const content: Content = {
    schemaVersion: 1,
    name: "Catalogue",
    notes: "",
    diagrams: [{ id: "main", name: "Main", nodes: [], edges: [] }],
    variables: ["alpha", "count"].map((name) => ({
      id: name,
      name,
      description: "",
      intendedType: "",
      intendedFile: "",
      scopeKind: "unknown",
      scope: "",
      initialExpression: "",
      notes: "",
      status: "not_started",
    })),
    nodeLinks: [],
    matches: [],
  };
  return {
    id: "project",
    revision: 1,
    savedAt: "2026-09-10T00:00:00Z",
    content,
    history: [{ id: "baseline", label: "Created", content: copy(content) }],
    cursor: "baseline",
    views: {},
  };
}
function Harness() {
  const [focus, setFocus] = useState<string | null>(null);
  const { session } = useProject();
  return (
    <>
      <VariablePanel
        symbols={[observation]}
        focus={focus}
        setFocus={setFocus}
        onReveal={() => {}}
        onClose={() => {}}
        reconciliation={{ suggestions: [], reviews: [] }}
      />
      <output data-testid="matches">
        {JSON.stringify(session.content.matches)}
      </output>
      <output data-testid="history">{session.history.length}</output>
    </>
  );
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});
function mount() {
  render(
    <ProjectProvider envelope={initial()}>
      <Harness />
    </ProjectProvider>,
  );
}

describe("catalogue navigation and decisions", () => {
  it("clears filters and moves keyboard selection without adding project history", () => {
    mount();
    fireEvent.change(screen.getByLabelText("Search variables"), {
      target: { value: "absent" },
    });
    expect(screen.getByText("0 of 3 results · Filters active")).toBeTruthy();
    expect(screen.getByText("No variables match these filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByLabelText("Search variables")).toBe(
      document.activeElement,
    );
    const alpha = screen.getByRole("button", { name: "alpha" });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowDown" });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "count",
    );
    expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(
      screen.getByText(/More than one binding shares this scope/),
    ).toBeTruthy();
    expect(screen.getByText("Line 42:4")).toBeTruthy();
    expect(screen.getByTestId("history").textContent).toBe("1");
  });

  it("shows the exact binding context and waits for explicit match confirmation", () => {
    mount();
    fireEvent.click(screen.getAllByRole("button", { name: "count" })[0]);
    fireEvent.change(screen.getByLabelText("Link a detected symbol"), {
      target: { value: observation.id },
    });
    expect(screen.getByTestId("matches").textContent).toBe("[]");
    expect(
      document.querySelector(".selected-binding-context")?.textContent,
    ).toContain("line 42");
    fireEvent.click(screen.getByRole("button", { name: "Confirm match" }));
    expect(JSON.parse(screen.getByTestId("matches").textContent!)).toEqual([
      expect.objectContaining({
        plannedId: "count",
        symbolId: "observed",
        decision: "confirmed",
      }),
    ]);
    expect(document.querySelector(".review-state")?.textContent).toBe(
      "Stale scan",
    );
  });
});
