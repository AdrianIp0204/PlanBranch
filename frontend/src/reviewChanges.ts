import { samePlan } from "./planning";
import type { Diagram, TaskEdge, TaskNode } from "./types";

export type ReviewTarget = {
  id: string;
  side: "before" | "after";
  nodeIds: string[];
};
export type ReviewChange = ReviewTarget & {
  key: string;
  entity: "node" | "edge";
  kind: "added" | "changed" | "removed";
  title: string;
};
export type ReviewHint = ReviewTarget & {
  key: string;
  kind: "criteria" | "branch" | "separate";
  label: string;
};

function edgeTitle(edge: TaskEdge, nodes: Map<string, TaskNode>) {
  return `${nodes.get(edge.source)?.title || "Untitled node"} → ${nodes.get(edge.target)?.title || "Untitled node"}${edge.label.trim() ? ` · ${edge.label}` : ""}`;
}

/** Compare stable identities; ordering changes alone are not diagram changes. */
export function reviewChanges(before: Diagram | undefined, after: Diagram) {
  const changes: ReviewChange[] = [];
  const beforeNodes = new Map(before?.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map(before?.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  for (const node of after.nodes) {
    const old = beforeNodes.get(node.id);
    if (!old || !samePlan(old, node))
      changes.push({
        key: `node:${node.id}`,
        entity: "node",
        id: node.id,
        kind: old ? "changed" : "added",
        side: "after",
        title: node.title || "Untitled node",
        nodeIds: [node.id],
      });
  }
  for (const node of before?.nodes ?? []) {
    if (!afterNodes.has(node.id))
      changes.push({
        key: `node:${node.id}`,
        entity: "node",
        id: node.id,
        kind: "removed",
        side: "before",
        title: node.title || "Untitled node",
        nodeIds: [node.id],
      });
  }
  for (const edge of after.edges) {
    const old = beforeEdges.get(edge.id);
    if (!old || !samePlan(old, edge))
      changes.push({
        key: `edge:${edge.id}`,
        entity: "edge",
        id: edge.id,
        kind: old ? "changed" : "added",
        side: "after",
        title: edgeTitle(edge, afterNodes),
        nodeIds: [...new Set([edge.source, edge.target])],
      });
  }
  for (const edge of before?.edges ?? []) {
    if (!afterEdges.has(edge.id))
      changes.push({
        key: `edge:${edge.id}`,
        entity: "edge",
        id: edge.id,
        kind: "removed",
        side: "before",
        title: edgeTitle(edge, beforeNodes),
        nodeIds: [...new Set([edge.source, edge.target])],
      });
  }
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const item of changes) counts[item.kind] += 1;
  return { changes, counts };
}

export type ReviewCursor = { key: string | null; index: number };
export function retainReviewCursor(
  changes: ReviewChange[],
  cursor: ReviewCursor,
): ReviewCursor {
  if (!changes.length || cursor.key === null) return { key: null, index: -1 };
  const found = changes.findIndex((item) => item.key === cursor.key);
  const index =
    found >= 0
      ? found
      : Math.max(0, Math.min(cursor.index, changes.length - 1));
  return { key: changes[index].key, index };
}

/** Advisory only: these checks describe omissions, never correctness/completion. */
export function reviewHints(diagram: Diagram): ReviewHint[] {
  const hints: ReviewHint[] = [];
  const nodes = new Map(diagram.nodes.map((node) => [node.id, node]));
  for (const node of diagram.nodes) {
    if (
      ["process", "decision", "io"].includes(node.type) &&
      !node.checklist.some((item) => item.text.trim())
    ) {
      hints.push({
        key: `criteria:${node.id}`,
        kind: "criteria",
        id: node.id,
        side: "after",
        nodeIds: [node.id],
        label: `Add acceptance criteria: ${node.title || "Untitled node"}`,
      });
    }
  }
  for (const edge of diagram.edges) {
    if (nodes.get(edge.source)?.type === "decision" && !edge.label.trim()) {
      hints.push({
        key: `branch:${edge.id}`,
        kind: "branch",
        id: edge.id,
        side: "after",
        nodeIds: [...new Set([edge.source, edge.target])],
        label: `Label decision branch: ${edgeTitle(edge, nodes)}`,
      });
    }
  }

  // Weak connectivity permits directed loops, merges and multiple starts. Notes
  // do not join otherwise separate flows or create warnings on their own.
  const neighbours = new Map(
    diagram.nodes
      .filter((node) => node.type !== "note")
      .map((node) => [node.id, new Set<string>()]),
  );
  for (const edge of diagram.edges) {
    if (!neighbours.has(edge.source) || !neighbours.has(edge.target)) continue;
    neighbours.get(edge.source)!.add(edge.target);
    neighbours.get(edge.target)!.add(edge.source);
  }
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of neighbours.keys()) {
    if (visited.has(id)) continue;
    const component: string[] = [];
    const pending = [id];
    visited.add(id);
    while (pending.length) {
      const next = pending.pop()!;
      component.push(next);
      for (const neighbour of neighbours.get(next)!) {
        if (!visited.has(neighbour)) {
          visited.add(neighbour);
          pending.push(neighbour);
        }
      }
    }
    components.push(component);
  }
  components.sort((a, b) => b.length - a.length);
  for (const component of components.slice(1)) {
    hints.push({
      key: `separate:${JSON.stringify([...component].sort())}`,
      kind: "separate",
      id: component[0],
      side: "after",
      nodeIds: component,
      label: `Check separate flow: ${nodes.get(component[0])?.title || "Untitled node"}`,
    });
  }
  return hints;
}
