import {
  nodeKinds,
  statuses,
  type Content,
  type NodeKind,
  type Status,
} from "./types";

export type PlanningMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  nodeId?: string | null;
  nodeTitle?: string | null;
  diagramId?: string | null;
  proposalId?: string | null;
};
export type NodeComment = {
  id: string;
  nodeId: string;
  nodeTitle: string;
  diagramId: string;
  text: string;
  createdAt: string;
  resolved: boolean;
};
export type ProposedChange = {
  kind: string;
  nodeId?: string;
  edgeId?: string;
  field?: string;
  label: string;
  before: unknown;
  after: unknown;
};
export type PlanProposal = {
  id: string;
  title: string;
  summary: string;
  diagramId: string;
  baseRevision: number;
  baseCursor: string;
  baseHash: string;
  state: "pending" | "accepted" | "rejected" | "stale";
  createdAt: string;
  changes: ProposedChange[];
};
export type PlanningState = {
  agent: { available: boolean; label: string; reason?: string };
  messages: PlanningMessage[];
  comments: NodeComment[];
  proposals: PlanProposal[];
  approval: null | {
    id: string;
    revision: number;
    cursor: string;
    contentHash: string;
    createdAt: string;
    current: boolean;
    snapshot: Content;
  };
  request: null | {
    id: string;
    status: "running" | "failed" | "succeeded";
    error?: string;
    text?: string;
    diagramId?: string;
    nodeId?: string | null;
  };
};
export type PlanningPrompt = {
  mutationId: string;
  text: string;
  diagramId: string;
  nodeId: string | null;
};

export const reviewFieldLabel = (field: string) =>
  (
    ({
      title: "Title",
      type: "Node type",
      status: "Status",
      position: "Position",
      description: "Description",
      notes: "Notes",
      pseudocode: "Pseudocode",
      checklist: "Checklist",
      targetFile: "Target file",
      targetScope: "Target scope",
      why: "Decision rationale",
      alternatives: "Alternatives",
      blocker: "Blocker",
      source: "From",
      target: "To",
      sourceHandle: "Source connection",
      targetHandle: "Target connection",
      label: "Label",
    }) as Record<string, string>
  )[field] ??
  field
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (letter) => letter.toUpperCase());
type ReviewNames = {
  nodes: Record<string, string>;
  edges: Record<string, string>;
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function reviewNames(
  content: Content,
  proposal: PlanProposal,
  side: "before" | "after",
): ReviewNames {
  const nodes: Record<string, string> = Object.fromEntries(
    content.diagrams.flatMap((diagram) =>
      diagram.nodes.map((node) => [node.id, node.title || "Untitled node"]),
    ),
  );
  for (const change of proposal.changes) {
    if (change.kind === "add_node" || change.kind === "remove_node") {
      const value = change[side] ?? change.before ?? change.after;
      if (record(value) && typeof value.id === "string")
        nodes[value.id] = String(value.title || "Untitled node");
    }
  }
  for (const change of proposal.changes) {
    if (
      change.kind === "update_node" &&
      change.field === "title" &&
      change.nodeId
    )
      nodes[change.nodeId] = String(change[side] || "Untitled node");
  }
  const edgeTitle = (edge: Record<string, unknown>) =>
    `${nodes[String(edge.source)] || "Unavailable node"} → ${nodes[String(edge.target)] || "Unavailable node"}${edge.label ? ` · ${edge.label}` : ""}`;
  const edges: Record<string, string> = Object.fromEntries(
    content.diagrams.flatMap((diagram) =>
      diagram.edges.map((edge) => [edge.id, edgeTitle(edge)]),
    ),
  );
  for (const change of proposal.changes) {
    if (change.kind === "add_edge" || change.kind === "remove_edge") {
      const value = change[side] ?? change.before ?? change.after;
      if (record(value) && typeof value.id === "string")
        edges[value.id] = edgeTitle(value);
    }
  }
  return { nodes, edges };
}
export function reviewValueText(
  change: ProposedChange,
  value: unknown,
  names: ReviewNames,
): string {
  function fieldValue(field: string, input: unknown): string {
    if (field === "source" || field === "target")
      return names.nodes[String(input)] || "Unavailable node";
    if (field === "sourceHandle" || field === "targetHandle")
      return (
        (
          {
            out: "Output",
            in: "Input",
            yes: "Yes branch",
            no: "No branch",
          } as Record<string, string>
        )[String(input)] ??
        (input == null ? "Default connection" : String(input))
      );
    if (field === "status" && typeof input === "string")
      return statuses[input as Status] ?? input;
    if (field === "type" && typeof input === "string")
      return nodeKinds[input as NodeKind] ?? input;
    if (field === "position" && record(input))
      return `x: ${input.x}, y: ${input.y}`;
    if (field === "checklist" && Array.isArray(input))
      return input.length
        ? input
            .map((item) =>
              record(item)
                ? `${item.checked ? "[x]" : "[ ]"} ${String(item.text || "Empty checklist item")}`
                : String(item),
            )
            .join("\n")
        : "No checklist items";
    if (input === null || input === undefined) return "None";
    if (input === "") return "Empty";
    return typeof input === "string" ? input : JSON.stringify(input, null, 2);
  }
  if (change.field) return fieldValue(change.field, value);
  if (value === null || value === undefined) return "None";
  if (change.kind === "reorder_nodes" && Array.isArray(value))
    return (
      value
        .map(
          (id, index) =>
            `${index + 1}. ${names.nodes[String(id)] || "Unavailable node"}`,
        )
        .join("\n") || "No nodes"
    );
  if (change.kind === "reorder_edges" && Array.isArray(value))
    return (
      value
        .map(
          (id, index) =>
            `${index + 1}. ${names.edges[String(id)] || "Unavailable connection"}`,
        )
        .join("\n") || "No connections"
    );
  if (
    ["add_node", "remove_node", "add_edge", "remove_edge"].includes(
      change.kind,
    ) &&
    record(value)
  ) {
    const order = change.kind.endsWith("node")
      ? [
          "title",
          "type",
          "status",
          "position",
          "description",
          "checklist",
          "notes",
          "pseudocode",
          "targetFile",
          "targetScope",
          "why",
          "alternatives",
          "blocker",
        ]
      : ["source", "target", "label", "sourceHandle", "targetHandle"];
    const keys = [
      ...order,
      ...Object.keys(value).filter(
        (key) => !order.includes(key) && key !== "id",
      ),
    ];
    return (
      keys
        .filter(
          (key) =>
            value[key] !== undefined &&
            value[key] !== null &&
            value[key] !== "" &&
            !(Array.isArray(value[key]) && value[key].length === 0),
        )
        .map(
          (key) => `${reviewFieldLabel(key)}: ${fieldValue(key, value[key])}`,
        )
        .join("\n") || "No details"
    );
  }
  return fieldValue("", value);
}

export const PLANNING_DRAFT_PREFIX = "flowdesk.planningDrafts.v1.";
export type PlanningDrafts = {
  message: string;
  comments: Record<string, string>;
  failedPrompt: PlanningPrompt | null;
};
export function readPlanningDrafts(projectId: string): PlanningDrafts {
  const empty: PlanningDrafts = {
    message: "",
    comments: {},
    failedPrompt: null,
  };
  try {
    const parsed = JSON.parse(
      sessionStorage.getItem(PLANNING_DRAFT_PREFIX + projectId) || "null",
    );
    if (!parsed || typeof parsed !== "object") return empty;
    const message =
      typeof parsed.message === "string" ? parsed.message.slice(0, 12000) : "";
    const comments =
      parsed.comments && typeof parsed.comments === "object"
        ? Object.fromEntries(
            Object.entries(parsed.comments)
              .filter(
                ([key, value]) =>
                  key.length <= 100 &&
                  typeof value === "string" &&
                  value.length > 0,
              )
              .slice(-20)
              .map(([key, value]) => [key, (value as string).slice(0, 12000)]),
          )
        : {};
    const request = parsed.failedPrompt;
    const failedPrompt =
      request &&
      typeof request.mutationId === "string" &&
      request.mutationId.length <= 100 &&
      typeof request.text === "string" &&
      request.text.length <= 12000 &&
      typeof request.diagramId === "string" &&
      request.diagramId.length <= 100 &&
      (request.nodeId === null || typeof request.nodeId === "string")
        ? {
            mutationId: request.mutationId,
            text: request.text,
            diagramId: request.diagramId,
            nodeId: request.nodeId,
          }
        : null;
    return { message, comments, failedPrompt };
  } catch {
    return empty;
  }
}
export function writePlanningDrafts(projectId: string, drafts: PlanningDrafts) {
  try {
    const comments = Object.fromEntries(
      Object.entries(drafts.comments)
        .filter(([, value]) => value.length > 0)
        .slice(-20)
        .map(([key, value]) => [key, value.slice(0, 12000)]),
    );
    const key = PLANNING_DRAFT_PREFIX + projectId;
    if (
      !drafts.message &&
      !Object.keys(comments).length &&
      !drafts.failedPrompt
    )
      sessionStorage.removeItem(key);
    else
      sessionStorage.setItem(
        key,
        JSON.stringify({
          message: drafts.message.slice(0, 12000),
          comments,
          failedPrompt: drafts.failedPrompt,
        }),
      );
  } catch {
    /* Draft recovery is best effort; editing still works when storage is unavailable. */
  }
}

/** Compare manual content without treating object key order as an edit. */
export function samePlan(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right)
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => samePlan(value, right[index]))
    );
  if (typeof left !== "object") return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(
      (key) => Object.hasOwn(b, key) && samePlan(a[key], b[key]),
    )
  );
}
