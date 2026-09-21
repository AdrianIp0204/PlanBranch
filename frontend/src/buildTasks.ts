import {
  uid,
  statuses,
  type BuildTask,
  type Content,
  type Diagram,
} from "./types";

export function createBuildTask(): BuildTask {
  return {
    id: uid(),
    title: "New task",
    deliverable: "",
    nodeLinks: [],
    prerequisiteIds: [],
    expectedFiles: [],
    acceptanceChecks: [],
    status: "not_started",
  };
}
export function nodeChoices(diagrams: readonly Diagram[]) {
  return diagrams.flatMap((diagram) =>
    diagram.nodes.map((node) => ({
      nodeId: node.id,
      diagramId: diagram.id,
      title: node.title,
      label: `${diagram.name} · ${node.title || "Untitled node"}`,
      missing: false,
    })),
  );
}
export function normalizeBuildLinks(content: Content): void {
  if (!content.buildTasks) return;
  const live = new Map(
    nodeChoices(content.diagrams).map((node) => [node.nodeId, node]),
  );
  for (const task of content.buildTasks)
    task.nodeLinks = task.nodeLinks.map((link) => {
      const node = live.get(link.nodeId);
      return node
        ? {
            nodeId: node.nodeId,
            diagramId: node.diagramId,
            title: node.title,
            missing: false,
          }
        : { ...link, missing: true };
    });
}
export function deletionNotice(
  content: Content,
  nodeIds: readonly string[],
): string {
  const removed = new Set(nodeIds);
  const affected = (content.buildTasks ?? []).filter((task) =>
    task.nodeLinks.some((link) => removed.has(link.nodeId)),
  );
  if (!affected.length) return "";
  const labels = affected
    .slice(0, 5)
    .map((task) => `“${task.title || "Untitled task"}”`)
    .join(", ");
  return `\n\nLinked build tasks: ${labels}${affected.length > 5 ? ` and ${affected.length - 5} more` : ""}. Their links will be kept as missing.`;
}
export function wouldCreateTaskCycle(
  tasks: readonly BuildTask[],
  taskId: string,
  prerequisiteId: string,
): boolean {
  if (taskId === prerequisiteId) return true;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const pending = [prerequisiteId],
    visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === taskId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(byId.get(id)?.prerequisiteIds ?? []));
  }
  return false;
}
const taskValue = (task: BuildTask) =>
  JSON.stringify([
    task.title,
    task.deliverable,
    task.nodeLinks.map((link) => [
      link.nodeId,
      link.diagramId,
      link.title,
      link.missing,
    ]),
    task.prerequisiteIds,
    task.expectedFiles,
    task.acceptanceChecks.map((check) => [check.id, check.text]),
    task.status,
  ]);
export function buildTaskChanges(
  before: readonly BuildTask[],
  after: readonly BuildTask[],
) {
  const previous = new Map(
    before.map((task, index) => [task.id, { task, index }]),
  );
  const current = new Set(after.map((task) => task.id));
  const changes: {
    key: string;
    id: string;
    kind: "added" | "changed" | "removed";
    title: string;
    side: "before" | "after";
  }[] = [];
  for (const [index, task] of after.entries()) {
    const old = previous.get(task.id);
    if (!old || taskValue(old.task) !== taskValue(task) || old.index !== index)
      changes.push({
        key: `task:${task.id}`,
        id: task.id,
        kind: old ? "changed" : "added",
        title: task.title || "Untitled task",
        side: "after",
      });
  }
  for (const task of before)
    if (!current.has(task.id))
      changes.push({
        key: `task:${task.id}`,
        id: task.id,
        kind: "removed",
        title: task.title || "Untitled task",
        side: "before",
      });
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const change of changes) counts[change.kind]++;
  return { changes, counts };
}

/** Validate cached request bodies before retry; server also checks cross-content IDs. */
export function validBuildTasks(value: unknown): value is BuildTask[] {
  if (!Array.isArray(value) || value.length > 1000) return false;
  const text = (v: unknown, max: number): v is string =>
    typeof v === "string" && v.length <= max;
  const id = (v: unknown): v is string => text(v, 128) && !!v.trim();
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const keys = (v: Record<string, unknown>, expected: string[]) =>
    Object.keys(v).length === expected.length &&
    expected.every((key) => Object.hasOwn(v, key));
  const ids = new Set<string>();
  for (const task of value) {
    if (
      !record(task) ||
      !keys(task, [
        "id",
        "title",
        "deliverable",
        "nodeLinks",
        "prerequisiteIds",
        "expectedFiles",
        "acceptanceChecks",
        "status",
      ]) ||
      !id(task.id) ||
      ids.has(task.id)
    )
      return false;
    ids.add(task.id);
  }
  const taskIds = new Set(ids);
  for (const task of value as BuildTask[]) {
    if (
      !text(task.title, 500) ||
      !text(task.deliverable, 32768) ||
      (typeof task.status !== "string" || !Object.hasOwn(statuses, task.status))
    )
      return false;
    if (!Array.isArray(task.nodeLinks) || task.nodeLinks.length > 500)
      return false;
    const links = new Set<string>();
    for (const link of task.nodeLinks) {
      if (
        !record(link) ||
        !keys(link, ["nodeId", "diagramId", "title", "missing"]) ||
        !id(link.nodeId) ||
        !id(link.diagramId) ||
        !text(link.title, 500) ||
        typeof link.missing !== "boolean" ||
        links.has(link.nodeId)
      )
        return false;
      links.add(link.nodeId);
    }
    if (
      !Array.isArray(task.prerequisiteIds) ||
      task.prerequisiteIds.length > 1000 ||
      task.prerequisiteIds.some(
        (dep) => !id(dep) || !taskIds.has(dep) || dep === task.id,
      ) ||
      new Set(task.prerequisiteIds).size !== task.prerequisiteIds.length
    )
      return false;
    if (
      !Array.isArray(task.expectedFiles) ||
      task.expectedFiles.length > 200 ||
      !task.expectedFiles.every((file) => text(file, 2048))
    )
      return false;
    if (
      !Array.isArray(task.acceptanceChecks) ||
      task.acceptanceChecks.length > 500
    )
      return false;
    for (const check of task.acceptanceChecks) {
      if (
        !record(check) ||
        !keys(check, ["id", "text"]) ||
        !id(check.id) ||
        ids.has(check.id) ||
        !text(check.text, 4000)
      )
        return false;
      ids.add(check.id);
    }
  }
  const incoming = new Map(
    (value as BuildTask[]).map((task) => [
      task.id,
      task.prerequisiteIds.length,
    ]),
  );
  const dependants = new Map<string, string[]>();
  for (const task of value as BuildTask[])
    for (const prerequisite of task.prerequisiteIds) {
      const list = dependants.get(prerequisite) ?? [];
      list.push(task.id);
      dependants.set(prerequisite, list);
    }
  const pending = [...incoming]
    .filter(([, count]) => count === 0)
    .map(([taskId]) => taskId);
  let visited = 0;
  while (pending.length) {
    const taskId = pending.pop()!;
    visited++;
    for (const dependant of dependants.get(taskId) ?? []) {
      const count = incoming.get(dependant)! - 1;
      incoming.set(dependant, count);
      if (!count) pending.push(dependant);
    }
  }
  return visited === value.length;
}
