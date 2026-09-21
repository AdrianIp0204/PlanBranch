import { describe, expect, it } from "vitest";
import {
  buildTaskChanges,
  createBuildTask,
  deletionNotice,
  normalizeBuildLinks,
  validBuildTasks,
  wouldCreateTaskCycle,
} from "./buildTasks";
import { copy, createNode, type BuildTask, type Content } from "./types";
const task = (id: string, prerequisiteIds: string[] = []): BuildTask => ({
  ...createBuildTask(),
  id,
  title: id,
  prerequisiteIds,
});
function content(): Content {
  return {
    schemaVersion: 3,
    name: "Plan",
    notes: "",
    diagrams: [
      {
        id: "diagram",
        name: "Main",
        nodes: [
          {
            ...createNode("process", { x: 0, y: 0 }),
            id: "node",
            title: "Current node",
          },
        ],
        edges: [],
      },
    ],
    variables: [],
    nodeLinks: [],
    matches: [],
    buildTasks: [
      {
        ...task("work"),
        nodeLinks: [
          {
            nodeId: "node",
            diagramId: "old",
            title: "Old name",
            missing: true,
          },
          {
            nodeId: "gone",
            diagramId: "removed",
            title: "Keep this context",
            missing: false,
          },
        ],
      },
    ],
  };
}
describe("build task relationships", () => {
  it("normalizes live links and preserves missing context without changing task status", () => {
    const value = content();
    value.buildTasks![0].status = "done";
    normalizeBuildLinks(value);
    expect(value.buildTasks![0].nodeLinks).toEqual([
      {
        nodeId: "node",
        diagramId: "diagram",
        title: "Current node",
        missing: false,
      },
      {
        nodeId: "gone",
        diagramId: "removed",
        title: "Keep this context",
        missing: true,
      },
    ]);
    expect(value.buildTasks![0].status).toBe("done");
    value.diagrams[0].nodes = [];
    normalizeBuildLinks(value);
    expect(value.buildTasks![0].nodeLinks[0]).toEqual({
      nodeId: "node",
      diagramId: "diagram",
      title: "Current node",
      missing: true,
    });
  });
  it("leaves legacy content unchanged and describes affected task links before deletion", () => {
    const value = content();
    expect(deletionNotice(value, ["node"])).toContain("work");
    expect(deletionNotice(value, ["node"])).toContain("kept as missing");
    expect(deletionNotice(value, ["different"])).toBe("");
    delete value.buildTasks;
    value.schemaVersion = 1;
    const old = copy(value);
    normalizeBuildLinks(value);
    expect(value).toEqual(old);
  });
  it("detects indirect cycles while accepting disconnected tasks, forks and merges", () => {
    const tasks = [
      task("a"),
      task("b", ["a"]),
      task("c", ["a"]),
      task("d", ["b", "c"]),
      task("unrelated"),
    ];
    expect(wouldCreateTaskCycle(tasks, "a", "d")).toBe(true);
    expect(wouldCreateTaskCycle(tasks, "b", "d")).toBe(true);
    expect(wouldCreateTaskCycle(tasks, "d", "unrelated")).toBe(false);
    expect(wouldCreateTaskCycle(tasks, "a", "a")).toBe(true);
    expect(validBuildTasks(tasks)).toBe(true);
  });
  it("reviews stable task IDs and order independently of object property ordering", () => {
    const before = [task("a"), task("b"), task("removed")],
      after = [copy(before[1]), copy(before[0]), task("new")];
    const result = buildTaskChanges(before, after);
    expect(result.counts).toEqual({ added: 1, changed: 2, removed: 1 });
    expect(result.changes.find((item) => item.id === "removed")?.side).toBe(
      "before",
    );
    expect(result.changes.find((item) => item.id === "new")?.side).toBe(
      "after",
    );
    expect(
      buildTaskChanges(
        [task("same")],
        [
          Object.fromEntries(
            Object.entries(task("same")).reverse(),
          ) as BuildTask,
        ],
      ).changes,
    ).toEqual([]);
  });
});
describe("cached build task validation", () => {
  it("allows incomplete authored fields but enforces stable IDs, structure, status, links and DAG", () => {
    const incomplete = task("constructor");
    incomplete.title = "";
    incomplete.expectedFiles = [""];
    incomplete.acceptanceChecks = [{ id: "__proto__", text: "" }];
    expect(validBuildTasks([incomplete])).toBe(true);
    expect(
      validBuildTasks([{ ...incomplete, status: "automatically_done" }]),
    ).toBe(false);
    expect(
      validBuildTasks([{ ...incomplete, status: { toString: "bad" } }]),
    ).toBe(false);
    expect(
      validBuildTasks([
        { ...incomplete, acceptanceChecks: [{ id: "constructor", text: "" }] },
      ]),
    ).toBe(false);
    expect(validBuildTasks([task("a", ["missing"])])).toBe(false);
    expect(validBuildTasks([task("a", ["b"]), task("b", ["a"])])).toBe(false);
    expect(validBuildTasks([{ ...incomplete, extra: "unexpected" }])).toBe(
      false,
    );
    expect(
      validBuildTasks([
        {
          ...incomplete,
          nodeLinks: [
            { nodeId: "n", diagramId: "d", title: "Node", missing: "true" },
          ],
        },
      ]),
    ).toBe(false);
  });
  it("matches authored text and collection bounds", () => {
    const value = task("bounded");
    value.title = "a".repeat(500);
    value.deliverable = "d".repeat(32768);
    value.expectedFiles = Array(200).fill("f".repeat(2048));
    value.acceptanceChecks = Array.from({ length: 500 }, (_, index) => ({
      id: `c-${index}`,
      text: "c".repeat(4000),
    }));
    expect(validBuildTasks([value])).toBe(true);
    expect(validBuildTasks([{ ...value, title: value.title + "x" }])).toBe(
      false,
    );
    expect(
      validBuildTasks([
        { ...value, expectedFiles: [...value.expectedFiles, ""] },
      ]),
    ).toBe(false);
    const tasks = Array.from({ length: 1000 }, (_, i) =>
      task(String(i), i ? [String(i - 1)] : []),
    );
    expect(validBuildTasks(tasks)).toBe(true);
    expect(validBuildTasks([...tasks, task("too-many")])).toBe(false);
  });
});
