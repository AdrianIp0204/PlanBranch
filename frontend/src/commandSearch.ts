import type { Content, DetectedSymbol, ProjectSummary } from "./types";
import { nodeKinds } from "./types";

export type CommandResult =
  | { type: "project"; id: string }
  | { type: "diagram"; diagramId: string }
  | { type: "node"; diagramId: string; id: string }
  | { type: "task"; id: string }
  | { type: "variable"; id: string; detected: boolean }
  | { type: "action"; id: string };
export type CommandAction = { id: string; title: string; detail?: string };
export const commandGroups = [
  "Actions",
  "Projects",
  "Diagrams",
  "Nodes",
  "Build tasks",
  "Planned variables",
  "Detected symbols",
] as const;
export type CommandGroup = (typeof commandGroups)[number];
export type CommandEntry = {
  key: string;
  title: string;
  detail: string;
  group: CommandGroup;
  result: CommandResult;
  search: string;
  searchTitle: string;
};
const normalize = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
const context = (...parts: (string | undefined)[]) =>
  parts.filter(Boolean).join(" · ");

/** An in-memory index of navigation metadata only: no source text or user prose. */
export function buildCommandIndex({
  projects,
  content,
  symbols = [],
  actions = [],
}: {
  projects: ProjectSummary[];
  content: Content | null;
  symbols?: DetectedSymbol[];
  actions?: CommandAction[];
}): CommandEntry[] {
  const entries: CommandEntry[] = [];
  const add = (
    key: string,
    group: CommandGroup,
    title: string,
    detail: string,
    result: CommandResult,
  ) => {
    entries.push({
      key,
      group,
      title,
      detail,
      result,
      searchTitle: normalize(title),
      search: normalize(context(title, detail)),
    });
  };
  for (const action of actions)
    add(
      `action:${action.id}`,
      "Actions",
      action.title,
      action.detail ?? "Workspace action",
      { type: "action", id: action.id },
    );
  for (const project of projects)
    add(
      `project:${project.id}`,
      "Projects",
      project.name || "Untitled project",
      "Open project",
      { type: "project", id: project.id },
    );
  if (content) {
    for (const diagram of content.diagrams) {
      add(
        `diagram:${diagram.id}`,
        "Diagrams",
        diagram.name || "Untitled diagram",
        content.name,
        { type: "diagram", diagramId: diagram.id },
      );
      for (const node of diagram.nodes)
        add(
          `node:${diagram.id}:${node.id}`,
          "Nodes",
          node.title || "Untitled node",
          context(
            diagram.name,
            nodeKinds[node.type],
            node.targetFile,
            node.targetScope,
          ),
          { type: "node", diagramId: diagram.id, id: node.id },
        );
    }
    for (const task of content.buildTasks ?? [])
      add(
        `task:${task.id}`,
        "Build tasks",
        task.title || "Untitled task",
        context("Build", task.expectedFiles.join(", ")),
        { type: "task", id: task.id },
      );
    for (const variable of content.variables)
      add(
        `planned:${variable.id}`,
        "Planned variables",
        variable.name || "Unnamed variable",
        context(
          variable.intendedFile || "File unspecified",
          variable.scope || "Scope unspecified",
        ),
        { type: "variable", id: variable.id, detected: false },
      );
    for (const symbol of symbols) {
      const line = symbol.locations[0]?.line;
      add(
        `detected:${symbol.id}`,
        "Detected symbols",
        symbol.name || "Unnamed symbol",
        context(
          `${symbol.file}${line ? `:${line}` : ""}`,
          symbol.scope || "Module scope",
          symbol.kind,
          symbol.state.replaceAll("_", " "),
        ),
        { type: "variable", id: symbol.id, detected: true },
      );
    }
  }
  // Equal labels in equal contexts still need visible identities, not hover-only hints.
  const duplicates = new Map<string, number>();
  const identity = (item: CommandEntry) =>
    `${item.group}\0${item.title}\0${item.detail}`;
  for (const item of entries)
    duplicates.set(identity(item), (duplicates.get(identity(item)) ?? 0) + 1);
  for (const item of entries) {
    if ((duplicates.get(identity(item)) ?? 0) > 1) {
      const result = item.result;
      const id = result.type === "diagram" ? result.diagramId : result.id;
      item.detail = context(item.detail, `ID ${id}`);
      item.search = normalize(context(item.title, item.detail));
    }
  }
  return entries;
}

export type CommandMatches = {
  groups: { name: CommandGroup; entries: CommandEntry[]; total: number }[];
  entries: CommandEntry[];
  total: number;
};
/** Limit each group independently so large evidence catalogues cannot hide actions. */
export function searchCommands(
  index: CommandEntry[],
  query: string,
  perGroup = 8,
): CommandMatches {
  const limit = Math.max(1, Math.min(20, Math.trunc(perGroup) || 8));
  const phrase = normalize(query.trim().slice(0, 240));
  const terms = phrase.split(/\s+/).filter(Boolean);
  const buckets = new Map<
    CommandGroup,
    { entry: CommandEntry; score: number }[]
  >();
  const totals = new Map<CommandGroup, number>();
  for (const entry of index) {
    if (!terms.every((term) => entry.search.includes(term))) continue;
    totals.set(entry.group, (totals.get(entry.group) ?? 0) + 1);
    const score = !phrase
      ? 0
      : entry.searchTitle === phrase
        ? 0
        : entry.searchTitle.startsWith(phrase)
          ? 1
          : terms.every((term) => entry.searchTitle.includes(term))
            ? 2
            : 3;
    const bucket = buckets.get(entry.group) ?? [];
    const before = bucket.findIndex((item) => score < item.score);
    if (before >= 0) bucket.splice(before, 0, { entry, score });
    else if (bucket.length < limit) bucket.push({ entry, score });
    if (bucket.length > limit) bucket.pop();
    buckets.set(entry.group, bucket);
  }
  const groups = commandGroups.flatMap((name) => {
    const items = buckets.get(name);
    return items?.length
      ? [
          {
            name,
            entries: items.map((item) => item.entry),
            total: totals.get(name) ?? 0,
          },
        ]
      : [];
  });
  return {
    groups,
    entries: groups.flatMap((group) => group.entries),
    total: [...totals.values()].reduce((sum, count) => sum + count, 0),
  };
}
