import {
  validModelSelection,
  selectionProvider,
  selectionLabel,
  type PlanningQuestion,
  type QuestionAnswer,
  type ProviderId,
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
  question?: {
    id: string;
    questions: PlanningQuestion[];
    createdAt: string;
    answerRequest?: ExecutionAnswerBody;
  } | null;
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
  events: {
    type: string;
    message?: string;
    text?: string;
    provider?: ProviderId;
    turn?: number;
    usage?: Record<string, number>;
    at?: string;
  }[];
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
export type ExecutionAnswerBody = {
  mutationId: string;
  questionId: string;
  answers: QuestionAnswer[];
  digest: string;
  confirmed: true;
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
  | { kind: "answer"; runId: string; body: ExecutionAnswerBody }
  | { kind: ExecutionAction; runId: string; body: ExecutionActionBody };
export const executionActive = (
  run?: Pick<ExecutionRunSummary, "state"> | null,
) => !!run && ["queued", "running", "cancelling"].includes(run.state);
export function executionSelectionLabel(selection?: ModelSelection) {
  return !selection || selection.mode === "default"
    ? "CLI default"
    : selectionLabel(selection);
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
    if (item.kind === "answer") {
      if (
        typeof item.runId !== "string" ||
        typeof item.body.questionId !== "string" ||
        typeof item.body.digest !== "string" ||
        item.body.confirmed !== true ||
        !Array.isArray(item.body.answers) ||
        item.body.answers.length < 1 ||
        item.body.answers.length > 3 ||
        !item.body.answers.every((answer: unknown) => {
          if (!answer || typeof answer !== "object") return false;
          const a = answer as Record<string, unknown>;
          return (
            typeof a.questionId === "string" &&
            (a.optionId === null || typeof a.optionId === "string") &&
            (a.text === null ||
              (typeof a.text === "string" && a.text.length <= 2000))
          );
        })
      )
        return null;
      return {
        kind: "answer",
        runId: item.runId,
        body: {
          mutationId: item.body.mutationId,
          questionId: item.body.questionId,
          answers: item.body.answers,
          digest: item.body.digest,
          confirmed: true,
        },
      };
    }
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
    selectionProvider(left) === selectionProvider(right) &&
    (left.mode === "default"
      ? right.mode === "default"
      : right.mode === "explicit" &&
        left.model === right.model &&
        left.reasoningEffort === right.reasoningEffort)
  );
}
