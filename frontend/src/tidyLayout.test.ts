import { describe, expect, it } from "vitest";
import { tidyDiagram } from "./tidyLayout";
import { createNode, type Diagram, type TaskNode } from "./types";

const node = (
  id: string,
  x = 0,
  y = 0,
  type: TaskNode["type"] = "process",
): TaskNode => ({
  ...createNode(type, { x, y }),
  id,
  title: id,
  notes: "Keep these notes",
  targetFile: "src/tasks.py",
  checklist: [{ id: `${id}-check`, text: "Expected result", checked: true }],
});
const diagram = (nodes: TaskNode[], pairs: string[][] = []): Diagram => ({
  id: "main",
  name: "Main flow",
  nodes,
  edges: pairs.map(([source, target], i) => ({
    id: `edge-${i}`,
    source,
    target,
    sourceHandle:
      nodes.find((n) => n.id === source)?.type === "decision" ? "yes" : "out",
    targetHandle: "in",
    label: `Branch ${i}`,
  })),
});
const overlaps = (a: TaskNode, b: TaskNode) =>
  a.position.x < b.position.x + 220 &&
  a.position.x + 220 > b.position.x &&
  a.position.y < b.position.y + (b.type === "decision" ? 142 : 112) &&
  a.position.y + (a.type === "decision" ? 142 : 112) > b.position.y;
function expectClear(nodes: TaskNode[], fixed = new Set<string>()) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (fixed.has(nodes[i].id) && fixed.has(nodes[j].id)) continue;
      expect(
        overlaps(nodes[i], nodes[j]),
        `${nodes[i].id} overlaps ${nodes[j].id}`,
      ).toBe(false);
    }
  }
}
const positions = (d: Diagram) =>
  Object.fromEntries(d.nodes.map((n) => [n.id, n.position]));

describe("explicit diagram arrangement", () => {
  it("lays out branches, merges, a return loop and a disconnected note without changing content", () => {
    const original = diagram(
      [
        node("start", 50, 80, "start"),
        node("choose", 50, 80, "decision"),
        node("left", 50, 80),
        node("right", 50, 80),
        node("merge", 50, 80),
        node("end", 50, 80, "end"),
        node("note", 50, 80, "note"),
      ],
      [
        ["start", "choose"],
        ["choose", "left"],
        ["choose", "right"],
        ["left", "merge"],
        ["right", "merge"],
        ["merge", "choose"],
        ["merge", "end"],
      ],
    );
    const snapshot = structuredClone(original);
    const proposed = tidyDiagram(original, {
      direction: "horizontal",
      scope: "all",
    });
    expectClear(proposed.nodes);
    expect(original).toEqual(snapshot);
    expect(proposed.edges).toBe(original.edges);
    proposed.nodes.forEach((n, i) => {
      expect({ ...n, position: snapshot.nodes[i].position }).toEqual(
        snapshot.nodes[i],
      );
      expect(n.checklist).toBe(original.nodes[i].checklist);
    });
    const p = positions(proposed);
    expect(p.start.x).toBeLessThan(p.choose.x);
    expect(p.end.x).toBeGreaterThan(p.merge.x);
    expect(
      tidyDiagram(original, { direction: "horizontal", scope: "all" }),
    ).toEqual(proposed);
  });

  it("changes the primary arrangement direction without changing handle meanings", () => {
    const input = diagram(
      [node("a"), node("b", 0, 0, "decision"), node("c")],
      [
        ["a", "b"],
        ["b", "c"],
      ],
    );
    const horizontal = tidyDiagram(input, {
      direction: "horizontal",
      scope: "all",
    });
    const vertical = tidyDiagram(input, {
      direction: "vertical",
      scope: "all",
    });
    expect(horizontal.nodes.map((n) => n.position.x)).toEqual([0, 340, 680]);
    expect(vertical.nodes.map((n) => n.position.y)).toEqual([0, 262, 524]);
    expect(horizontal.edges).toEqual(input.edges);
    expect(vertical.edges).toEqual(input.edges);
    expectClear(horizontal.nodes);
    expectClear(vertical.nodes);
  });

  it("keeps pinned nodes and every unselected node fixed, including fixed overlaps", () => {
    const pin = { ...node("pin", 0, 0, "decision"), pinned: true };
    const input = diagram(
      [pin, node("fixed", 0, 0), node("a", 0, 0), node("b", 0, 0)],
      [
        ["pin", "a"],
        ["a", "b"],
        ["b", "pin"],
      ],
    );
    for (const direction of ["horizontal", "vertical"] as const) {
      const result = tidyDiagram(input, {
        direction,
        scope: "selected",
        selectedIds: ["pin", "a", "b", "unknown"],
      });
      expect(result.nodes[0]).toBe(pin);
      expect(result.nodes[1]).toBe(input.nodes[1]);
      expectClear(result.nodes, new Set(["pin", "fixed"]));
    }
  });

  it("preserves pins when arranging the whole diagram", () => {
    const input = diagram(
      [{ ...node("pin", 0, 0), pinned: true }, node("a"), node("b")],
      [
        ["a", "b"],
        ["b", "pin"],
      ],
    );
    const result = tidyDiagram(input, {
      direction: "horizontal",
      scope: "all",
    });
    expect(result.nodes[0]).toBe(input.nodes[0]);
    expectClear(result.nodes);
  });

  it("does nothing for empty diagrams, empty selections or selections containing only pins", () => {
    for (const input of [
      diagram([]),
      diagram([{ ...node("pin"), pinned: true }]),
    ]) {
      expect(
        tidyDiagram(input, { direction: "horizontal", scope: "all" }),
      ).toBe(input);
    }
    const input = diagram([node("a"), { ...node("pin"), pinned: true }]);
    expect(
      tidyDiagram(input, { direction: "vertical", scope: "selected" }),
    ).toBe(input);
    expect(
      tidyDiagram(input, {
        direction: "vertical",
        scope: "selected",
        selectedIds: ["pin"],
      }),
    ).toBe(input);
  });

  it("orders a crossed pair of branches by their neighbors", () => {
    const input = diagram(
      [
        node("start"),
        node("a"),
        node("b"),
        node("c"),
        node("d"),
        node("merge"),
      ],
      [
        ["start", "a"],
        ["start", "b"],
        ["a", "d"],
        ["b", "c"],
        ["d", "merge"],
        ["c", "merge"],
      ],
    );
    const result = tidyDiagram(input, {
      direction: "horizontal",
      scope: "all",
    });
    const p = positions(result);
    expect((p.a.y - p.b.y) * (p.d.y - p.c.y)).toBeGreaterThan(0);
    expectClear(result.nodes);
  });

  it("clears dense arbitrary obstacles without moving pinned or unselected content", () => {
    let seed = 493;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const nodes = Array.from({ length: 140 }, (_, i) => ({
      ...node(
        `n${i}`,
        Math.floor(random() * 1600) - 800,
        Math.floor(random() * 900) - 450,
        i % 3 ? "process" : "decision",
      ),
      pinned: i % 4 === 0,
    }));
    const pairs = nodes
      .slice(1)
      .map((n, i) => [nodes[Math.floor(random() * (i + 1))].id, n.id]);
    pairs.push(["n50", "n5"], ["n10", "n10"]);
    const input = diagram(nodes, pairs);
    const selected = nodes.filter((_, i) => i % 2 === 0).map((n) => n.id);
    const fixed = new Set(
      nodes
        .filter((n) => n.pinned || !selected.includes(n.id))
        .map((n) => n.id),
    );
    for (const direction of ["horizontal", "vertical"] as const) {
      const result = tidyDiagram(input, {
        direction,
        scope: "selected",
        selectedIds: selected,
      });
      result.nodes.forEach((n, i) => {
        if (fixed.has(n.id)) expect(n).toBe(nodes[i]);
      });
      expectClear(result.nodes, fixed);
    }
  });

  it("handles the supported 5,000-node cycle iteratively and keeps coordinates valid", () => {
    const nodes = Array.from({ length: 5000 }, (_, i) =>
      node(`n${i}`, 9_999_900, -9_999_900),
    );
    const input = diagram(
      nodes,
      nodes.map((n, i) => [n.id, nodes[(i + 1) % nodes.length].id]),
    );
    const result = tidyDiagram(input, {
      direction: "horizontal",
      scope: "all",
    });
    expect(result.nodes).toHaveLength(5000);
    result.nodes.forEach((n, i) => {
      expect(Math.abs(n.position.x)).toBeLessThanOrEqual(10_000_000);
      expect(Math.abs(n.position.y)).toBeLessThanOrEqual(10_000_000);
      if (i)
        expect(
          n.position.x - result.nodes[i - 1].position.x,
        ).toBeGreaterThanOrEqual(340);
    });
  });
});
