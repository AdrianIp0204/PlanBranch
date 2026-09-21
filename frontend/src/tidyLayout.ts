import type { Diagram, Position, TaskNode } from "./types";

export type TidyOptions = {
  direction: "horizontal" | "vertical";
  scope: "all" | "selected";
  selectedIds?: readonly string[];
};

type Box = { main: number; cross: number; mainSize: number; crossSize: number };

const WIDTH = 220;
const HEIGHT = 142;
const RANK_GAP = 120;
const LANE_GAP = 80;
const COMPONENT_GAP = 120;
const CLEARANCE = 40;

/** Iterative Kosaraju avoids exhausting the JS stack on a long diagram. */
function components(outgoing: number[][], incoming: number[][]) {
  const seen = new Set<number>();
  const finish: number[] = [];
  for (let start = 0; start < outgoing.length; start++) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack = [{ node: start, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.next < outgoing[frame.node].length) {
        const next = outgoing[frame.node][frame.next++];
        if (!seen.has(next)) {
          seen.add(next);
          stack.push({ node: next, next: 0 });
        }
      } else {
        finish.push(frame.node);
        stack.pop();
      }
    }
  }
  const membership = Array<number>(outgoing.length).fill(-1);
  const groups: number[][] = [];
  for (const start of finish.reverse()) {
    if (membership[start] !== -1) continue;
    const index = groups.length;
    const group: number[] = [];
    const stack = [start];
    membership[start] = index;
    while (stack.length) {
      const node = stack.pop()!;
      group.push(node);
      for (const next of incoming[node]) {
        if (membership[next] !== -1) continue;
        membership[next] = index;
        stack.push(next);
      }
    }
    groups.push(group.sort((a, b) => a - b));
  }
  return { groups, membership };
}

/** Reserve several ranks for a cycle instead of stacking its nodes on one rank. */
function ranks(outgoing: number[][], incoming: number[][]) {
  const { groups, membership } = components(outgoing, incoming);
  const nextGroups = groups.map(() => new Set<number>());
  const indegree = groups.map(() => 0);
  outgoing.forEach((targets, source) => {
    for (const target of targets) {
      const from = membership[source];
      const to = membership[target];
      if (from !== to && !nextGroups[from].has(to)) {
        nextGroups[from].add(to);
        indegree[to]++;
      }
    }
  });
  const queue = groups.map((_, i) => i).filter((i) => !indegree[i]);
  const groupRank = groups.map(() => 0);
  for (let head = 0; head < queue.length; head++) {
    const group = queue[head];
    for (const next of nextGroups[group]) {
      groupRank[next] = Math.max(
        groupRank[next],
        groupRank[group] + groups[group].length,
      );
      if (--indegree[next] === 0) queue.push(next);
    }
  }
  const rank = Array<number>(outgoing.length).fill(0);
  groups.forEach((members, group) => {
    const starts = members.filter((n) =>
      incoming[n].some((p) => membership[p] !== group),
    );
    const seen = new Set<number>();
    let offset = 0;
    // Prefer cycle entry points, then stable node order for a closed cycle.
    for (const start of [...starts, ...members]) {
      if (seen.has(start)) continue;
      const stack = [start];
      while (stack.length) {
        const node = stack.pop()!;
        if (seen.has(node)) continue;
        seen.add(node);
        rank[node] = groupRank[group] + offset++;
        for (let i = outgoing[node].length - 1; i >= 0; i--) {
          const next = outgoing[node][i];
          if (membership[next] === group && !seen.has(next)) stack.push(next);
        }
      }
    }
  });
  return rank;
}

function weakComponents(outgoing: number[][], incoming: number[][]) {
  const seen = new Set<number>();
  const groups: number[][] = [];
  for (let start = 0; start < outgoing.length; start++) {
    if (seen.has(start)) continue;
    const group = [start];
    seen.add(start);
    for (let head = 0; head < group.length; head++) {
      const node = group[head];
      for (const next of [...outgoing[node], ...incoming[node]]) {
        if (!seen.has(next)) {
          seen.add(next);
          group.push(next);
        }
      }
    }
    groups.push(group.sort((a, b) => a - b));
  }
  return groups;
}

function idealPositions(diagram: Diagram, direction: TidyOptions["direction"]) {
  const index = new Map(diagram.nodes.map((n, i) => [n.id, i]));
  const outgoing: number[][] = diagram.nodes.map(() => []);
  const incoming: number[][] = diagram.nodes.map(() => []);
  const unique = new Set<string>();
  for (const edge of diagram.edges) {
    const source = index.get(edge.source);
    const target = index.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const key = `${source}:${target}`;
    if (unique.has(key)) continue;
    unique.add(key);
    outgoing[source].push(target);
    incoming[target].push(source);
  }
  const rank = ranks(outgoing, incoming);
  const result: Box[] = [];
  let componentCross = 0;
  const horizontal = direction === "horizontal";
  for (const group of weakComponents(outgoing, incoming)) {
    const layers = new Map<number, number[]>();
    for (const node of group) {
      const layer = layers.get(rank[node]) ?? [];
      layer.push(node);
      layers.set(rank[node], layer);
    }
    const orderedRanks = [...layers.keys()].sort((a, b) => a - b);
    const order = new Map<number, number>();
    const updateOrder = (layer: number[]) =>
      layer.forEach((n, i) => order.set(n, (i + 0.5) / layer.length));
    for (const layer of layers.values()) updateOrder(layer);
    // A fixed number of forward/backward sweeps reduces obvious crossings.
    // Back edges in cycles are deliberately excluded from forward ordering.
    for (let pass = 0; pass < 4; pass++) {
      const forward = pass % 2 === 0;
      for (const level of forward
        ? orderedRanks
        : [...orderedRanks].reverse()) {
        const layer = layers.get(level)!;
        const scores = new Map<number, number>();
        for (const node of layer) {
          const adjacent = (forward ? incoming[node] : outgoing[node]).filter(
            (other) => (forward ? rank[other] < level : rank[other] > level),
          );
          scores.set(
            node,
            adjacent.length
              ? adjacent.reduce((sum, n) => sum + order.get(n)!, 0) /
                  adjacent.length
              : order.get(node)!,
          );
        }
        layer.sort(
          (a, b) =>
            scores.get(a)! - scores.get(b)! ||
            order.get(a)! - order.get(b)! ||
            a - b,
        );
        updateOrder(layer);
      }
    }
    const rows = Math.max(...[...layers.values()].map((layer) => layer.length));
    const mainStep = (horizontal ? WIDTH : HEIGHT) + RANK_GAP;
    const crossStep = (horizontal ? HEIGHT : WIDTH) + LANE_GAP;
    for (const [level, layer] of layers) {
      layer.forEach((node, row) => {
        const height = diagram.nodes[node].type === "decision" ? HEIGHT : 112;
        result[node] = {
          main: level * mainStep,
          cross: componentCross + (row + (rows - layer.length) / 2) * crossStep,
          mainSize: horizontal ? WIDTH : height,
          crossSize: horizontal ? height : WIDTH,
        };
      });
    }
    componentCross += rows * crossStep + COMPONENT_GAP;
  }
  return result;
}

function asBox(node: TaskNode, horizontal: boolean): Box {
  const height = node.type === "decision" ? HEIGHT : 112;
  return {
    main: horizontal ? node.position.x : node.position.y,
    cross: horizontal ? node.position.y : node.position.x,
    mainSize: horizontal ? WIDTH : height,
    crossSize: horizontal ? height : WIDTH,
  };
}

/**
 * Produce an explicit layout candidate; never mutate graph content or handles.
 * Fixed nodes are obstacles, so existing overlap between fixed nodes is retained.
 * New positions move monotonically along a lane until clear. One sorted pass
 * suffices: after passing an obstacle, later moves cannot collide with it again.
 */
export function tidyDiagram(diagram: Diagram, options: TidyOptions): Diagram {
  const selected = new Set(options.selectedIds ?? []);
  const movable = diagram.nodes.map(
    (node) =>
      !node.pinned && (options.scope === "all" || selected.has(node.id)),
  );
  if (!movable.some(Boolean)) return diagram;
  const horizontal = options.direction === "horizontal";
  const ideal = idealPositions(diagram, options.direction);
  const originals = diagram.nodes.map((node) => asBox(node, horizontal));
  const moving = ideal.filter((_, i) => movable[i]);
  const originalMoving = originals.filter((_, i) => movable[i]);
  // Keep ordinary diagrams near their existing location while leaving ample
  // finite coordinate headroom for the maximum supported 5,000-node graph.
  const anchor = (values: number[]) =>
    Math.max(-1_000_000, Math.min(1_000_000, Math.min(...values)));
  const mainOffset =
    anchor(originalMoving.map((b) => b.main)) -
    Math.min(...moving.map((b) => b.main));
  const crossOffset =
    anchor(originalMoving.map((b) => b.cross)) -
    Math.min(...moving.map((b) => b.cross));
  const obstacles = originals
    .filter((_, i) => !movable[i])
    .sort((a, b) => a.cross - b.cross);
  const positions = new Map<number, Position>();
  const order = diagram.nodes
    .map((_, i) => i)
    .filter((i) => movable[i])
    .sort(
      (a, b) =>
        ideal[a].main - ideal[b].main ||
        ideal[a].cross - ideal[b].cross ||
        a - b,
    );
  for (const index of order) {
    const box = {
      ...ideal[index],
      main: ideal[index].main + mainOffset,
      cross: ideal[index].cross + crossOffset,
    };
    for (const obstacle of obstacles) {
      if (
        box.main + box.mainSize + CLEARANCE > obstacle.main &&
        box.main < obstacle.main + obstacle.mainSize + CLEARANCE &&
        box.cross + box.crossSize + CLEARANCE > obstacle.cross &&
        box.cross < obstacle.cross + obstacle.crossSize + CLEARANCE
      )
        box.cross = obstacle.cross + obstacle.crossSize + CLEARANCE;
    }
    positions.set(
      index,
      horizontal
        ? { x: box.main, y: box.cross }
        : { x: box.cross, y: box.main },
    );
    let low = 0;
    let high = obstacles.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (obstacles[middle].cross <= box.cross) low = middle + 1;
      else high = middle;
    }
    obstacles.splice(low, 0, box);
  }
  return {
    ...diagram,
    nodes: diagram.nodes.map((node, i) => {
      const position = positions.get(i);
      return position &&
        (position.x !== node.position.x || position.y !== node.position.y)
        ? { ...node, position }
        : node;
    }),
  };
}
