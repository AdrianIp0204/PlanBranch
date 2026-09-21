export type Status = "not_started" | "in_progress" | "blocked" | "done";
export type NodeKind = "start" | "end" | "process" | "decision" | "io" | "note";
export type Position = { x: number; y: number };
export type Viewport = Position & { zoom: number };
export type TaskNode = {
  id: string;
  type: NodeKind;
  title: string;
  position: Position;
  pinned?: boolean;
  description: string;
  notes: string;
  pseudocode: string;
  status: Status;
  checklist: { id: string; text: string; checked: boolean }[];
  targetFile: string;
  targetScope: string;
  why: string;
  alternatives: string;
  blocker: string;
};
export type TaskEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label: string;
};
export type Diagram = {
  id: string;
  name: string;
  nodes: TaskNode[];
  edges: TaskEdge[];
};
export type PlannedVariable = {
  id: string;
  name: string;
  description: string;
  intendedType: string;
  intendedFile: string;
  scopeKind: string;
  scope: string;
  initialExpression: string;
  notes: string;
  status: Status;
};
export type NodeLink = {
  id: string;
  nodeId: string;
  variableId: string;
  origin: "planned" | "detected";
  relationship: "unspecified" | "reads" | "writes" | "creates";
};
export type Match = {
  id: string;
  plannedId: string;
  symbolId: string;
  decision: "confirmed" | "rejected";
};
export type ProjectBrief = {
  goal: string;
  audience: string;
  requirements: string;
  constraints: string;
  outOfScope: string;
  decisions: string;
  assumptions: string;
};
export const emptyBrief = (): ProjectBrief => ({
  goal: "",
  audience: "",
  requirements: "",
  constraints: "",
  outOfScope: "",
  decisions: "",
  assumptions: "",
});
export type BuildTask = {
  id: string;
  title: string;
  deliverable: string;
  nodeLinks: {
    nodeId: string;
    diagramId: string;
    title: string;
    missing: boolean;
  }[];
  prerequisiteIds: string[];
  expectedFiles: string[];
  acceptanceChecks: { id: string; text: string }[];
  status: Status;
};
export type Content = {
  schemaVersion: 1 | 2 | 3;
  buildTasks?: BuildTask[];
  brief?: ProjectBrief;
  name: string;
  notes: string;
  diagrams: Diagram[];
  variables: PlannedVariable[];
  nodeLinks: NodeLink[];
  matches: Match[];
};
export type Checkpoint = {
  id: string;
  label: string;
  diagramId?: string;
  content: Content;
};
export type Envelope = {
  id: string;
  revision: number;
  savedAt: string;
  content: Content;
  history: Checkpoint[];
  cursor: string;
  views: Record<string, Viewport>;
};
export type ProjectSummary = {
  id: string;
  name: string;
  savedAt: string;
  revision: number;
};
export type DetectedSymbol = {
  id: string;
  name: string;
  kind: string;
  file: string;
  scope: string;
  scopeKind: string;
  annotation: string | null;
  locations: { line: number; column: number }[];
  declarations: unknown[];
  state: string;
  scanTime: string;
  hash: string;
  heuristic?: boolean;
  ambiguousIdentity?: boolean;
  identityNote?: string;
  freshnessReason?: string;
};
export type Source = {
  root: string | null;
  ignores: string[];
  attached: boolean;
  latestScan?: Scan | null;
};
export type Scan = {
  id: string;
  status: string;
  summary: Record<string, unknown>;
  files: {
    file?: string;
    path?: string;
    status?: string;
    error?: string;
    message?: string;
  }[];
};
export type Reconciliation = {
  suggestions: { plannedId: string; symbolId: string; reasons: string[] }[];
  reviews: { plannedId: string; state: string; differences: string[] }[];
};
export const statuses: Record<Status, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};
export const nodeKinds: Record<NodeKind, string> = {
  start: "Start",
  end: "End",
  process: "Process",
  decision: "Decision",
  io: "Input / output",
  note: "Note",
};
export const uid = () => crypto.randomUUID();
export const copy = <T>(value: T): T => structuredClone(value);
export function createNode(type: NodeKind, position: Position): TaskNode {
  return {
    id: uid(),
    type,
    title: nodeKinds[type],
    position,
    description: "",
    notes: "",
    pseudocode: "",
    status: "not_started",
    checklist: [],
    targetFile: "",
    targetScope: "",
    why: "",
    alternatives: "",
    blocker: "",
  };
}
