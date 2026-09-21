import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import BuildTasksEditor from "./BuildTasksEditor";
import { createBuildTask } from "./buildTasks";
import { copy, createNode, type BuildTask, type Diagram } from "./types";
let current: BuildTask[];
const reveal = vi.fn();
const diagrams: Diagram[] = [
  {
    id: "diagram",
    name: "Main",
    nodes: [
      {
        ...createNode("process", { x: 0, y: 0 }),
        id: "node",
        title: "Linked step",
        status: "done",
      },
    ],
    edges: [],
  },
  {
    id: "other",
    name: "Other diagram",
    nodes: [
      {
        ...createNode("decision", { x: 0, y: 0 }),
        id: "other-node",
        title: "Alternate node",
      },
    ],
    edges: [],
  },
];
function task(id: string): BuildTask {
  return { ...createBuildTask(), id, title: id };
}
function mount(initial: BuildTask[] = [], readOnly = false) {
  function Harness() {
    const [tasks, setTasks] = useState(initial),
      [selectedId, onSelect] = useState<string | null>(null);
    current = tasks;
    return (
      <BuildTasksEditor
        tasks={tasks}
        diagrams={diagrams}
        selectedId={selectedId}
        onSelect={onSelect}
        readOnly={readOnly}
        onRevealNode={reveal}
        onChange={(edit) =>
          setTasks((old) => {
            const next = copy(old);
            edit(next);
            return next;
          })
        }
      />
    );
  }
  return render(<Harness />);
}
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function openSection(name: RegExp) {
  fireEvent.click(screen.getByText(name, { selector: "summary" }));
}
describe("shared build task editor", () => {
  it("creates an independently editable task with stable acceptance IDs and separate status", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Add first task" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Task title"));
    fireEvent.change(screen.getByLabelText("Task title"), {
      target: { value: "Implement storage" },
    });
    fireEvent.change(screen.getByLabelText("Deliverable"), {
      target: { value: "A storage adapter" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add acceptance check" }),
    );
    const id = current[0].acceptanceChecks[0].id;
    fireEvent.change(screen.getByLabelText("Acceptance check 1"), {
      target: { value: "Data survives a restart" },
    });
    fireEvent.change(screen.getByLabelText("Task status"), {
      target: { value: "done" },
    });
    expect(current[0]).toMatchObject({
      title: "Implement storage",
      deliverable: "A storage adapter",
      status: "done",
      acceptanceChecks: [{ id, text: "Data survives a restart" }],
    });
    expect(current[0].acceptanceChecks[0]).not.toHaveProperty("checked");
    expect(diagrams[1].nodes[0].status).toBe("not_started");
  });
  it("reorders by stable ID and confirms deletion of prerequisite references", () => {
    const a = task("a"),
      b = task("b");
    b.prerequisiteIds = ["a"];
    mount([a, b]);
    fireEvent.click(screen.getByRole("button", { name: "Move task down" }));
    expect(current.map((item) => item.id)).toEqual(["b", "a"]);
    expect(
      (screen.getByLabelText("Task title") as HTMLInputElement).value,
    ).toBe("a");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    expect(current).toHaveLength(2);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    expect(confirm).toHaveBeenLastCalledWith(
      expect.stringContaining("prerequisite list"),
    );
    expect(current).toEqual([{ ...b, prerequisiteIds: [] }]);
  });
  it("links across diagrams, navigates live nodes, and repairs or removes retained missing links", () => {
    const value = task("work");
    value.nodeLinks = [
      { nodeId: "gone", diagramId: "lost", title: "Old node", missing: true },
    ];
    mount([value]);
    expect(screen.getByText("Missing node")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Relink Old node"), {
      target: { value: "other-node" },
    });
    expect(current[0].nodeLinks).toEqual([
      {
        nodeId: "other-node",
        diagramId: "other",
        title: "Alternate node",
        missing: false,
      },
    ]);
    openSection(/Linked nodes/);
    fireEvent.click(screen.getByRole("button", { name: "Alternate node" }));
    expect(reveal).toHaveBeenCalledWith("other", "other-node");
    fireEvent.change(screen.getByLabelText("Link node"), {
      target: { value: "node" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Link node" }));
    expect(current[0].nodeLinks).toHaveLength(2);
    expect(current[0].status).toBe("not_started");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove link to Alternate node" }),
    );
    expect(current[0].nodeLinks.map((link) => link.nodeId)).toEqual(["node"]);
  });
  it("disables indirect prerequisite cycles and leaves existing choices removable", () => {
    const a = task("a"),
      b = task("b"),
      c = task("c");
    b.prerequisiteIds = ["a"];
    c.prerequisiteIds = ["b"];
    mount([a, b, c]);
    openSection(/Prerequisites/);
    expect(
      (
        screen.getByRole("checkbox", {
          name: /c.*Would create a cycle/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(current[0].prerequisiteIds).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Task: c" }));
    openSection(/Prerequisites/);
    fireEvent.click(screen.getByRole("checkbox", { name: "b" }));
    expect(current[2].prerequisiteIds).toEqual([]);
    fireEvent.click(screen.getByRole("checkbox", { name: "a" }));
    expect(current[2].prerequisiteIds).toEqual(["a"]);
  });
  it("keeps expected file rows and incomplete check entries editable", () => {
    mount([task("work")]);
    openSection(/Expected files/);
    fireEvent.click(screen.getByRole("button", { name: "Add expected file" }));
    fireEvent.change(screen.getByLabelText("Expected file 1"), {
      target: { value: "src/storage.py" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add acceptance check" }),
    );
    expect(current[0].expectedFiles).toEqual(["src/storage.py"]);
    expect(current[0].acceptanceChecks[0].text).toBe("");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove expected file 1" }),
    );
    expect(current[0].expectedFiles).toEqual([]);
  });
  it("renders readonly task comparisons without destructive controls", () => {
    const a = task("a"),
      b = task("b");
    mount([a, b], true);
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete task" })).toBeNull();
    expect(
      (screen.getByLabelText("Task title") as HTMLInputElement).readOnly,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Task: b" }));
    expect(
      (screen.getByLabelText("Task title") as HTMLInputElement).value,
    ).toBe("b");
    expect(current).toEqual([a, b]);
  });
});
