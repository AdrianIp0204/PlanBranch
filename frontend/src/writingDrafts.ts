import {
  samePlan,
  type PlanningDrafts,
  type PlanningPrompt,
  type AnswerSubmission,
} from "./planning";
import { copy, uid } from "./types";

export type CommentSubmission = {
  mutationId: string;
  diagramId: string;
  nodeId: string;
  text: string;
};
export type WritingContext = {
  diagramId: string;
  nodeId: string | null;
  diagramName: string;
  nodeTitle: string;
};
export type WritingPayload = PlanningDrafts & {
  questionDrafts: NonNullable<PlanningDrafts["questionDrafts"]>;
  failedAnswer: AnswerSubmission | null;
  failedComment: CommentSubmission | null;
  revision: NonNullable<PlanningDrafts["revision"]> | null;
  context: WritingContext | null;
  versions: {
    message: string;
    comments: Record<string, string>;
    questions: Record<string, string>;
  };
  submitted: { message?: string; comment?: string; answer?: string };
};
export type WritingRecord = {
  id: string;
  revision: number;
  updatedAt: string | null;
  payload: WritingPayload;
};
export type WritingState = {
  draft: WritingRecord;
  copies: WritingRecord[];
  recoveryId?: string;
};
export type WritingSave = {
  baseRevision: number;
  mutationId: string;
  payload: WritingPayload;
  preserveCurrent?: boolean;
  copyOnly?: boolean;
};
export type WritingStatus =
  "loading" | "saved" | "dirty" | "saving" | "failed" | "conflict";
export type DraftGuard = {
  flush: () => Promise<boolean>;
  pending: () => boolean;
};
export const emptyWriting = (legacy?: PlanningDrafts): WritingPayload => ({
  message: "",
  comments: {},
  failedPrompt: null,
  questionDrafts: {},
  failedAnswer: null,
  failedComment: null,
  revision: null,
  context: null,
  versions: { message: "", comments: {}, questions: {} },
  submitted: {},
  ...legacy,
});
export const hasWriting = (value: WritingPayload) =>
  Boolean(
    value.message ||
    Object.values(value.comments).some(Boolean) ||
    Object.keys(value.questionDrafts).length ||
    value.failedPrompt ||
    value.failedAnswer ||
    value.failedComment ||
    value.revision,
  );
export const sameWriting = samePlan;
export function pruneWritingVersions(value: WritingPayload): WritingPayload {
  value.comments = Object.fromEntries(
    Object.entries(value.comments).filter(([, text]) => text !== ""),
  );
  value.questionDrafts = Object.fromEntries(
    Object.entries(value.questionDrafts).filter(
      ([, answers]) => Object.keys(answers).length > 0,
    ),
  );
  for (const [field, group, pending] of [
    ["comments", "comments", value.failedComment?.nodeId],
    ["questionDrafts", "questions", value.failedAnswer?.setId],
  ] as const) {
    value.versions[group] = Object.fromEntries(
      Object.entries(value.versions[group]).filter(([key]) => {
        const writing = Object.hasOwn(value[field], key)
          ? value[field][key]
          : null;
        return (
          key === pending ||
          (typeof writing === "string"
            ? !!writing
            : !!writing && Object.keys(writing).length > 0)
        );
      }),
    );
  }
  return value;
}
export function stampWriting(
  previous: WritingPayload,
  next: WritingPayload,
): WritingPayload {
  next.versions = copy(previous.versions);
  if (
    previous.message !== next.message ||
    !sameWriting(previous.revision, next.revision) ||
    !sameWriting(previous.context, next.context)
  )
    next.versions.message = uid();
  for (const [field, group] of [
    ["comments", "comments"],
    ["questionDrafts", "questions"],
  ] as const)
    for (const key of new Set([
      ...Object.keys(previous[field]),
      ...Object.keys(next[field]),
    ]))
      if (
        !sameWriting(
          Object.hasOwn(previous[field], key)
            ? previous[field][key]
            : undefined,
          Object.hasOwn(next[field], key) ? next[field][key] : undefined,
        )
      )
        next.versions[group] = { ...next.versions[group], [key]: uid() };
  return pruneWritingVersions(next);
}
export function retireWriting(
  value: WritingPayload,
  kind: "message" | "comment" | "answer",
  mutationId: string,
): WritingPayload {
  const next = copy(value);
  if (kind === "message") {
    if (next.failedPrompt?.mutationId !== mutationId) return next;
    if (
      next.submitted.message &&
      next.submitted.message === next.versions.message
    ) {
      next.message = "";
      next.revision = null;
      next.context = null;
    }
    next.failedPrompt = null;
    delete next.submitted.message;
  } else if (kind === "comment") {
    const request = next.failedComment;
    if (request?.mutationId !== mutationId) return next;
    if (
      next.submitted.comment &&
      next.submitted.comment === next.versions.comments[request.nodeId]
    )
      delete next.comments[request.nodeId];
    next.failedComment = null;
    delete next.submitted.comment;
  } else {
    const request = next.failedAnswer;
    if (request?.mutationId !== mutationId) return next;
    if (
      next.submitted.answer &&
      next.submitted.answer === next.versions.questions[request.setId]
    )
      delete next.questionDrafts[request.setId];
    next.failedAnswer = null;
    delete next.submitted.answer;
  }
  return pruneWritingVersions(next);
}
export function reconcileWriting(
  current: WritingPayload,
  sent: WritingPayload,
  ack: WritingPayload,
): WritingPayload {
  let next = copy(current);
  for (const [field, kind] of [
    ["failedPrompt", "message"],
    ["failedComment", "comment"],
    ["failedAnswer", "answer"],
  ] as const)
    if (sent[field] && !ack[field])
      next = retireWriting(next, kind, sent[field]!.mutationId);
  return next;
}
export type WritingBatch = { generation: number; body: WritingSave };
export class WritingQueue {
  revision = 0;
  generation = 0;
  savedGeneration = 0;
  batch: WritingBatch | null = null;
  value: WritingPayload;
  status: WritingStatus = "loading";
  error = "";
  copies: WritingRecord[] = [];
  conflict: WritingState | null = null;
  private running: Promise<boolean> | null = null;
  private ready = false;
  constructor(
    value: WritingPayload,
    private request: (body: WritingSave) => Promise<WritingState>,
    private notify: () => void,
  ) {
    this.value = pruneWritingVersions(copy(value));
  }
  initialize(state: WritingState) {
    this.revision = state.draft.revision;
    this.value = pruneWritingVersions(copy(state.draft.payload));
    this.copies = state.copies;
    this.ready = true;
    this.status = "saved";
    this.error = "";
    this.notify();
  }
  update(update: (value: WritingPayload) => WritingPayload, stamp = true) {
    const next = update(copy(this.value));
    if (sameWriting(next, this.value)) return;
    this.value = stamp ? stampWriting(this.value, next) : next;
    this.generation++;
    if (
      this.status !== "conflict" &&
      this.status !== "failed" &&
      this.status !== "loading"
    )
      this.status = "dirty";
    this.notify();
  }
  isReady() {
    return this.ready;
  }
  pending() {
    return (
      this.status === "loading" ||
      !this.ready ||
      this.generation !== this.savedGeneration ||
      !!this.batch ||
      this.status === "conflict"
    );
  }
  fail(reason: unknown) {
    this.error =
      reason instanceof Error ? reason.message : "Writing could not be saved.";
    this.status = "failed";
    this.notify();
  }
  flush(retry = false): Promise<boolean> {
    if (this.running) return this.running;
    if (
      !this.ready ||
      this.status === "loading" ||
      this.conflict ||
      (this.status === "failed" && !retry)
    )
      return Promise.resolve(false);
    this.running = this.save().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async save() {
    while (this.generation !== this.savedGeneration || this.batch) {
      this.batch ??= {
        generation: this.generation,
        body: {
          baseRevision: this.revision,
          mutationId: uid(),
          payload: copy(this.value),
        },
      };
      const batch = this.batch;
      this.status = "saving";
      this.error = "";
      this.notify();
      try {
        const state = await this.request(batch.body);
        this.revision = state.draft.revision;
        this.copies = state.copies;
        this.value = reconcileWriting(
          this.value,
          batch.body.payload,
          state.draft.payload,
        );
        this.savedGeneration = batch.generation;
        this.batch = null;
      } catch (reason) {
        const issue = reason as { status?: number; data?: WritingState };
        if (issue.status === 409 && issue.data?.draft) {
          this.conflict = issue.data;
          this.copies = issue.data.copies;
          this.status = "conflict";
          this.error =
            "Writing changed in another tab. Both versions are saved.";
          this.notify();
        } else this.fail(reason);
        return false;
      }
    }
    this.status = "saved";
    this.notify();
    return true;
  }
  continueMine() {
    if (!this.conflict) return;
    this.revision = this.conflict.draft.revision;
    this.conflict = null;
    this.batch = {
      generation: this.generation,
      body: {
        baseRevision: this.revision,
        mutationId: uid(),
        payload: copy(this.value),
        preserveCurrent: true,
      },
    };
    this.status = "dirty";
    this.error = "";
    this.notify();
  }
  selectCopy(copy: WritingRecord, state: WritingState) {
    this.revision = state.draft.revision;
    this.conflict = null;
    this.value = pruneWritingVersions(structuredClone(copy.payload));
    this.generation++;
    this.batch = {
      generation: this.generation,
      body: {
        baseRevision: this.revision,
        mutationId: uid(),
        payload: structuredClone(copy.payload),
        preserveCurrent: true,
      },
    };
    this.status = "dirty";
    this.error = "";
    this.notify();
  }
}
