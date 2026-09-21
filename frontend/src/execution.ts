import {
  validModelSelection,
  type GenerationDetails,
  type ModelSelection,
} from "./planning";
import type { BuildTask, Envelope, ProjectBrief, TaskNode } from "./types";
export type ExecutionRepository = {
  id: string;
  path: string;
  head?: string;
  dirty?: boolean;
};
export type ExecutionRunState =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export type ExecutionRunSummary = {
  id: string;
  previewId: string;
  taskId: string;
  taskTitle: string;
  state: ExecutionRunState;
  createdAt: string;
  updatedAt: string;
  sourceCommit: string | null;
  summary: string;
  error: string | null;
  progress: string;
  acceptedDigest: string | null;
  completedCursor: string | null;
  applied: boolean;
};
export type ExecutionArtifact = {
  digest: string;
  sourceCommit: string;
  files: {
    path: string;
    kind: string;
    binary: boolean;
    oldSize: number | null;
    newSize: number | null;
    oldMode?: string | null;
    newMode?: string | null;
    patch: string | null;
  }[];
};
export type ExecutionContext = {
  task: BuildTask;
  brief: ProjectBrief;
  linkedNodes: TaskNode[];
  sourceCommit: string | null;
  generation: GenerationDetails | null;
};
export type ExecutionRun = ExecutionRunSummary & {
  repository: ExecutionRepository;
  context: ExecutionContext;
  worktreePath: string | null;
  commands: {
    id: string;
    command: string;
    status: string;
    exitCode: number | null;
    output: string;
  }[];
  events: { type: string; message?: string; text?: string }[];
  artifact: ExecutionArtifact | null;
  planStale: boolean;
  sourceStale: boolean;
  applyPlanStale: boolean;
  applyRequest: { mutationId: string; digest: string; confirmed: true } | null;
  applyState: {
    state: "prepared" | "applying" | "applied";
    digest: string;
    updatedAt: string;
    completed: string[];
    fileCount: number;
  } | null;
};
export type ExecutionState = {
  repository: ExecutionRepository | null;
  runs: ExecutionRunSummary[];
  agent: { available: boolean; label: string; reason?: string };
  ownership: { available: boolean; reason?: string };
};
export type ExecutionPreview = ExecutionContext & {
  id: string;
  createdAt: string;
  baseRevision: number;
  repositoryId: string | null;
  approvalId: string | null;
  repository: { path: string; head: string; dirty: boolean } | null;
};
export type ExecutionPreviewResult = {
  preview: ExecutionPreview;
  ready: boolean;
  issues: string[];
};
export type ExecutionAction =
  "cancel" | "refresh" | "accept" | "complete" | "apply";
export type ExecutionActionBody = {
  mutationId: string;
  digest?: string;
  baseRevision?: number;
  confirmed?: true;
};
export type ExecutionReply = { run: ExecutionRun; project?: Envelope };
export type RunStart = {
  mutationId: string;
  previewId: string;
  confirmed: true;
};
export type ExecutionReceipt =
  | { kind: "start"; body: RunStart }
  | { kind: ExecutionAction; runId: string; body: ExecutionActionBody };
export const executionActive = (
  run?: Pick<ExecutionRunSummary, "state"> | null,
) => !!run && ["queued", "running", "cancelling"].includes(run.state);
export function executionSelectionLabel(selection?: ModelSelection) {
  return !selection || selection.mode === "default"
    ? "CLI default"
    : `${selection.model}${selection.reasoningEffort ? ` · ${selection.reasoningEffort}` : ""}`;
}
export const executionReceiptKey = (projectId: string) =>
  `flowdesk.execution-receipt.v1.${projectId}`;
export function readExecutionReceipt(
  projectId: string,
): ExecutionReceipt | null {
  try {
    const item = JSON.parse(
      sessionStorage.getItem(executionReceiptKey(projectId)) ?? "null",
    );
    if (
      !item ||
      typeof item !== "object" ||
      !item.body ||
      typeof item.body.mutationId !== "string" ||
      !item.body.mutationId
    )
      return null;
    if (item.kind === "start")
      return typeof item.body.previewId === "string" &&
        item.body.confirmed === true
        ? {
            kind: "start",
            body: {
              mutationId: item.body.mutationId,
              previewId: item.body.previewId,
              confirmed: true,
            },
          }
        : null;
    if (
      !["cancel", "refresh", "accept", "complete", "apply"].includes(
        item.kind,
      ) ||
      typeof item.runId !== "string"
    )
      return null;
    if (
      ["accept", "complete", "apply"].includes(item.kind) &&
      (typeof item.body.digest !== "string" || item.body.confirmed !== true)
    )
      return null;
    if (
      item.kind === "complete" &&
      (!Number.isInteger(item.body.baseRevision) || item.body.baseRevision < 0)
    )
      return null;
    return {
      kind: item.kind,
      runId: item.runId,
      body: {
        mutationId: item.body.mutationId,
        ...(item.body.digest !== undefined ? { digest: item.body.digest } : {}),
        ...(item.body.baseRevision !== undefined
          ? { baseRevision: item.body.baseRevision }
          : {}),
        ...(item.body.confirmed === true ? { confirmed: true } : {}),
      },
    };
  } catch {
    return null;
  }
}
export function writeExecutionReceipt(
  projectId: string,
  receipt: ExecutionReceipt | null,
) {
  try {
    if (receipt)
      sessionStorage.setItem(
        executionReceiptKey(projectId),
        JSON.stringify(receipt),
      );
    else sessionStorage.removeItem(executionReceiptKey(projectId));
  } catch {
    /* Server run history remains authoritative. */
  }
}
export function sameExecutionSelection(left: ModelSelection, right: unknown) {
  return (
    validModelSelection(right) &&
    (left.mode === "default"
      ? right.mode === "default"
      : right.mode === "explicit" &&
        left.model === right.model &&
        left.reasoningEffort === right.reasoningEffort)
  );
}
