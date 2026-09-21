import { describe, expect, it } from "vitest";
import {
  reviewChanges,
  retainReviewCursor,
  reviewHints,
  type ReviewCursor,
} from "./reviewChanges";
import { copy, createNode, type Diagram, type NodeKind } from "./types";

function node(id: string, type: NodeKind = "process") {
  return {
    ...createNode(type, { x: 0, y: 0 }),
    id,
    title: id,
    checklist: [
      { id: `check-${id}`, text: "A useful outcome", checked: false },
    ],
  };
}
function graph(): Diagram {
  return {
    id: "main",
    name: "Main",
    nodes: [
      node("start", "start"),
      node("choice", "decision"),
      node("task"),
      node("end", "end"),
    ],
    edges: [
      { id: "a", source: "start", target: "choice", label: "" },
      { id: "b", source: "choice", target: "task", label: "Yes" },
      { id: "c", source: "choice", target: "end", label: "No" },
      { id: "d", source: "task", target: "end", label: "" },
    ],
  };
}

describe("review changes", () => {
  it("counts every added, changed and removed identity and uses the correct side for connections", () => {
    const before = graph(),
      after = copy(before);
    after.nodes[2].description = "New explanation";
    after.nodes = after.nodes.filter((n) => n.id !== "end");
    after.nodes.push(node("new", "io"));
    after.edges[1].label = "Continue";
    after.edges = after.edges.filter((e) => e.id !== "c" && e.id !== "d");
    after.edges.push({
      id: "new-edge",
      source: "task",
      target: "new",
      label: "",
    });
    const { changes, counts } = reviewChanges(before, after);
    expect(counts).toEqual({ added: 2, changed: 2, removed: 3 });
    expect(changes.find((c) => c.key === "edge:c")).toMatchObject({
      kind: "removed",
      side: "before",
      nodeIds: ["choice", "end"],
      title: "choice → end · No",
    });
    expect(changes.find((c) => c.key === "edge:new-edge")).toMatchObject({
      kind: "added",
      side: "after",
      nodeIds: ["task", "new"],
    });
    expect(changes.find((c) => c.key === "node:task")).toMatchObject({
      kind: "changed",
      side: "after",
    });
    expect(before.nodes[2].description).toBe("");
  });
  it("ignores reordered arrays and retains legal dictionary-like IDs", () => {
    const before = graph();
    before.nodes.push(node("constructor"), node("__proto__"));
    const after = copy(before);
    after.nodes.reverse();
    after.edges.reverse();
    expect(reviewChanges(before, after).changes).toEqual([]);
    after.nodes.find((n) => n.id === "__proto__")!.pinned = true;
    expect(reviewChanges(before, after).changes.map((c) => c.key)).toEqual([
      "node:__proto__",
    ]);
  });
  it("preserves current identity through title edits and changed positions, then selects a nearby surviving entry", () => {
    const before = graph(),
      after = copy(before);
    after.nodes[0].title = "New start";
    after.nodes[2].notes = "Note";
    let changes = reviewChanges(before, after).changes;
    let cursor: ReviewCursor = { key: "node:task", index: 1 };
    after.nodes[2].title = "Renamed while selected";
    after.nodes.reverse();
    changes = reviewChanges(before, after).changes;
    cursor = retainReviewCursor(changes, cursor);
    expect(cursor).toEqual({ key: "node:task", index: 0 });
    after.nodes[after.nodes.findIndex((n) => n.id === "task")] = copy(
      before.nodes[2],
    );
    changes = reviewChanges(before, after).changes;
    expect(retainReviewCursor(changes, cursor)).toEqual({
      key: "node:start",
      index: 0,
    });
    expect(retainReviewCursor([], cursor)).toEqual({ key: null, index: -1 });
    expect(retainReviewCursor(changes, { key: null, index: -1 })).toEqual({
      key: null,
      index: -1,
    });
  });
  it("represents an initially empty diagram and a proposal that removes everything", () => {
    const before = graph();
    expect(reviewChanges(undefined, before).counts).toEqual({
      added: 8,
      changed: 0,
      removed: 0,
    });
    const result = reviewChanges(before, { ...before, nodes: [], edges: [] });
    expect(result.counts).toEqual({ added: 0, changed: 0, removed: 8 });
    expect(result.changes.every((c) => c.side === "before")).toBe(true);
  });
});

describe("advisory review hints", () => {
  it("checks substantive checklist items, not descriptions or checked state, only for task types", () => {
    const diagram = graph();
    diagram.nodes = ["start", "end", "process", "decision", "io", "note"].map(
      (type) => ({
        ...node(type, type as NodeKind),
        description: "Complete description",
        checklist: [{ id: type, text: "  \n ", checked: true }],
      }),
    );
    diagram.edges = [];
    expect(
      reviewHints(diagram)
        .filter((h) => h.kind === "criteria")
        .map((h) => h.id),
    ).toEqual(["process", "decision", "io"]);
    diagram.nodes.find((n) => n.id === "process")!.checklist[0].text =
      "An observable outcome";
    expect(
      reviewHints(diagram)
        .filter((h) => h.kind === "criteria")
        .map((h) => h.id),
    ).toEqual(["decision", "io"]);
  });
  it("labels only empty decision branches, including decision loops, with endpoint targets", () => {
    const diagram = graph();
    diagram.edges[1].label = " \n ";
    diagram.edges.push({
      id: "loop",
      source: "choice",
      target: "choice",
      label: "",
    });
    const hints = reviewHints(diagram);
    expect(hints.filter((h) => h.kind === "branch").map((h) => h.id)).toEqual([
      "b",
      "loop",
    ]);
    expect(hints.find((h) => h.id === "loop")?.nodeIds).toEqual(["choice"]);
    expect(hints.some((h) => h.kind === "separate")).toBe(false);
  });
  it("accepts connected cycles, merges and note isolates, while identifying a genuinely separate flow", () => {
    const diagram = graph();
    diagram.edges.push({
      id: "loop",
      source: "task",
      target: "choice",
      label: "Retry",
    });
    diagram.nodes.push(node("note", "note"));
    expect(reviewHints(diagram)).toEqual([]);
    diagram.nodes.push(node("separate"));
    const hints = reviewHints(diagram);
    expect(hints).toEqual([
      {
        key: 'separate:["separate"]',
        kind: "separate",
        id: "separate",
        side: "after",
        nodeIds: ["separate"],
        label: "Check separate flow: separate",
      },
    ]);
    diagram.edges.push(
      { id: "n1", source: "task", target: "note", label: "" },
      { id: "n2", source: "note", target: "separate", label: "" },
    );
    expect(reviewHints(diagram)).toEqual(hints);
  });
  it("handles empty, note-only and large cyclic diagrams iteratively without mutation", () => {
    const diagram: Diagram = { id: "main", name: "Main", nodes: [], edges: [] };
    expect(reviewHints(diagram)).toEqual([]);
    diagram.nodes.push(node("note", "note"));
    expect(reviewHints(diagram)).toEqual([]);
    diagram.nodes = Array.from({ length: 5000 }, (_, i) => node(String(i)));
    diagram.edges = diagram.nodes.map((n, i) => ({
      id: String(i),
      source: n.id,
      target: String((i + 1) % 5000),
      label: "",
    }));
    const original = copy(diagram);
    expect(reviewHints(diagram)).toEqual([]);
    expect(diagram).toEqual(original);
  });
});
