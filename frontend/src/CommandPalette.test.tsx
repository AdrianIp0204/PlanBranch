import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import CommandPalette from "./CommandPalette";
import { buildCommandIndex, searchCommands } from "./commandSearch";
import {
  createNode,
  type Content,
  type DetectedSymbol,
  type ProjectSummary,
} from "./types";

const projects: ProjectSummary[] = [
  { id: "project", name: "Application", revision: 1, savedAt: "2026-01-01" },
];
const actions = [
  { id: "settings", title: "Settings", detail: "Appearance and preferences" },
  { id: "save", title: "Save project" },
];
function fixture(): Content {
  const a = {
    ...createNode("process", { x: 0, y: 0 }),
    id: "a",
    title: "Load tasks",
    description: "hidden-user-prose",
  };
  const b = {
    ...createNode("decision", { x: 250, y: 0 }),
    id: "b",
    title: "Load tasks",
  };
  return {
    schemaVersion: 3,
    name: "Application",
    notes: "hidden-project-notes",
    diagrams: [
      { id: "first", name: "First diagram", nodes: [a], edges: [] },
      { id: "second", name: "Second diagram", nodes: [b], edges: [] },
    ],
    variables: [
      {
        id: "var",
        name: "tasks",
        intendedFile: "future.py",
        scope: "main",
        scopeKind: "function",
        description: "hidden-variable-prose",
        notes: "",
        intendedType: "list",
        initialExpression: "hidden-expression",
        status: "not_started",
      },
    ],
    buildTasks: [
      {
        id: "task",
        title: "Implement parsing",
        deliverable: "hidden-deliverable",
        expectedFiles: ["cli.py"],
        status: "not_started",
        prerequisiteIds: [],
        acceptanceChecks: [],
        nodeLinks: [],
      },
    ],
    nodeLinks: [],
    matches: [],
  };
}
const symbols: DetectedSymbol[] = [
  {
    id: "sym",
    name: "tasks",
    kind: "parameter",
    file: "cli.py",
    scope: "main",
    scopeKind: "function",
    annotation: "hidden-annotation",
    declarations: ["hidden-source"],
    locations: [{ line: 42, column: 0 }],
    state: "stale",
    scanTime: "",
    hash: "",
  },
];
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {
      this.open = false;
    },
  });
});
afterEach(cleanup);

describe("command search metadata", () => {
  it("finds all navigation kinds with precise context and separates plans from evidence", () => {
    const index = buildCommandIndex({
      projects,
      content: fixture(),
      symbols,
      actions,
    });
    const task = searchCommands(index, "cli.py").entries;
    expect(task.map((entry) => entry.result)).toEqual([
      { type: "task", id: "task" },
      { type: "variable", id: "sym", detected: true },
    ]);
    const nodes = searchCommands(index, "Load tasks").entries;
    expect(nodes.map((entry) => entry.detail)).toEqual([
      "First diagram · Process",
      "Second diagram · Decision",
    ]);
    const variables = searchCommands(index, "tasks").groups;
    expect(variables.map((group) => group.name)).toContain("Planned variables");
    expect(
      variables.find((group) => group.name === "Detected symbols")?.entries[0]
        .detail,
    ).toBe("cli.py:42 · main · parameter · stale");
    expect(searchCommands(index, "hidden").total).toBe(0);
    expect(
      searchCommands(index, "second diagram").entries.map(
        (entry) => entry.result.type,
      ),
    ).toEqual(["diagram", "node"]);
    expect(
      buildCommandIndex({ projects, content: null, symbols, actions }).map(
        (entry) => entry.result.type,
      ),
    ).toEqual(["action", "action", "project"]);
  });
  it("keeps each group bounded and ranks an exact name ahead of thousands of substring matches", () => {
    const content = fixture();
    const node = content.diagrams[0].nodes[0];
    content.diagrams[0].nodes = Array.from({ length: 2000 }, (_, n) => ({
      ...node,
      id: `n${n}`,
      title: n === 1999 ? "Load" : `Load item ${n}`,
    }));
    const result = searchCommands(
      buildCommandIndex({ projects, content, actions }),
      "load",
      8,
    );
    expect(result.total).toBe(2001);
    expect(result.entries).toHaveLength(8);
    expect(result.entries[0].result).toEqual({
      type: "node",
      id: "n1999",
      diagramId: "first",
    });
    expect(
      searchCommands(buildCommandIndex({ projects, content, actions }), "")
        .entries.length,
    ).toBeLessThanOrEqual(56);
  });
  it("adds visible stable identities to otherwise indistinguishable names", () => {
    const content = fixture();
    content.diagrams[0].nodes.push({
      ...content.diagrams[0].nodes[0],
      id: "a-copy",
    });
    const entries = searchCommands(
      buildCommandIndex({ projects, content }),
      "load first",
    ).entries;
    expect(entries.map((entry) => entry.detail)).toEqual([
      "First diagram · Process · ID a",
      "First diagram · Process · ID a-copy",
    ]);
  });
});

describe("command palette interaction", () => {
  it("keeps keyboard focus in the search box while arrows and Home/End choose results", async () => {
    const onChoose = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette
        projects={projects}
        content={fixture()}
        symbols={symbols}
        actions={actions}
        onChoose={onChoose}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("combobox");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Load tasks" } });
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1].id);
    fireEvent.keyDown(input, { key: "Home" });
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "End" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onChoose).toHaveBeenCalledExactlyOnceWith({
      type: "node",
      id: "b",
      diagramId: "second",
    });
  });
  it("does not act during IME composition and exposes clear-search recovery", async () => {
    const onChoose = vi.fn(),
      onClose = vi.fn();
    render(
      <CommandPalette
        projects={projects}
        content={fixture()}
        actions={actions}
        onChoose={onChoose}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("combobox");
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(onChoose).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.change(input, { target: { value: "nothing-matches-this" } });
    expect(screen.getByText("No matching items.")).toBeTruthy();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledExactlyOnceWith();
  });
  it("keeps failed navigation open and prevents duplicate choices while a save is pending", async () => {
    let reject!: (error: Error) => void;
    const onChoose = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    const onClose = vi.fn();
    render(
      <CommandPalette
        projects={projects}
        content={fixture()}
        actions={actions}
        onChoose={onChoose}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Second diagram" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () =>
      reject(new Error("Save failed. Your changes remain here.")),
    );
    expect(screen.getByRole("alert").textContent).toContain("Save failed");
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).value).toBe("Second diagram");
    expect(onClose).not.toHaveBeenCalled();
  });
  it("restores its opener on dismissal and preserves selected identity as live results update", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      const [content, setContent] = useState(fixture);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open quick jump</button>
          <button
            onClick={() =>
              setContent((old) => ({ ...old, diagrams: old.diagrams.slice(1) }))
            }
          >
            Remove first diagram
          </button>
          {open && (
            <CommandPalette
              projects={projects}
              content={content}
              actions={actions}
              onChoose={() => {}}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open quick jump" });
    opener.focus();
    fireEvent.click(opener);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Load tasks" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove first diagram" }),
    );
    expect(
      within(screen.getByRole("listbox")).getAllByRole("option"),
    ).toHaveLength(1);
    expect(screen.getByRole("option").getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
