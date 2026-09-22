import { useEffect, useReducer, useRef } from "react";
import {
  readPlanningDrafts,
  PLANNING_DRAFT_PREFIX,
  type PlanningDrafts,
  type PlanningPrompt,
  type AnswerSubmission,
} from "./planning";
import { uid, copy } from "./types";
import { loadWriting, saveWriting, discardWritingCopy } from "./writingApi";
import {
  WritingQueue,
  emptyWriting,
  hasWriting,
  sameWriting,
  stampWriting,
  retireWriting,
  type WritingPayload,
  type WritingBatch,
  type WritingSave,
  type WritingRecord,
  type WritingContext,
  type CommentSubmission,
  type DraftGuard,
} from "./writingDrafts";
const PREFIX = "flowdesk.unsentWriting.v1.";
type Cache = {
  payload: WritingPayload;
  batch: WritingBatch | null;
  revision: number;
  generation: number;
  savedGeneration: number;
  migration?: WritingSave | null;
};
function cached(projectId: string): Cache | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(PREFIX + projectId) || "null",
    );
    return value &&
      typeof value.payload?.message === "string" &&
      value.payload.versions &&
      typeof value.revision === "number"
      ? value
      : null;
  } catch {
    return null;
  }
}
export default function useWritingDrafts(
  projectId: string,
  onDraftGuard?: (guard: DraftGuard | null) => void,
) {
  const [, render] = useReducer((n: number) => n + 1, 0);
  const mounted = useRef(false),
    initializing = useRef<Promise<void> | null>(null);
  const initial = useRef<{ cache: Cache | null; legacy: PlanningDrafts }>(null);
  initial.current ??= {
    cache: cached(projectId),
    legacy: readPlanningDrafts(projectId),
  };
  const migration = useRef<WritingSave | null>(
    initial.current.cache?.migration ?? null,
  );
  const queueRef = useRef<WritingQueue | null>(null);
  const persist = () => {
    const queue = queueRef.current;
    if (!queue) return;
    try {
      sessionStorage.setItem(
        PREFIX + projectId,
        JSON.stringify({
          payload: queue.value,
          batch: queue.batch,
          revision: queue.revision,
          generation: queue.generation,
          savedGeneration: queue.savedGeneration,
          migration: migration.current,
        }),
      );
    } catch {
      /* SQLite remains authoritative; unsaved state remains visible. */
    }
    if (mounted.current) render();
  };
  queueRef.current ??= new WritingQueue(
    initial.current.cache?.payload ??
      stampWriting(emptyWriting(), emptyWriting(initial.current.legacy)),
    (body) => saveWriting(projectId, body),
    persist,
  );
  const queue = queueRef.current;
  async function preserveCopy(body?: WritingSave) {
    if (body) migration.current = copy(body);
    if (!migration.current) return;
    queue.status = "loading";
    persist();
    await saveWriting(projectId, migration.current);
    // An immutable receipt may mention copies discarded after that save.
    // Always recover current writing and copies from a fresh server read.
    const latest = await loadWriting(projectId);
    migration.current = null;
    queue.batch = null;
    queue.conflict = null;
    queue.generation++;
    queue.savedGeneration = queue.generation;
    queue.initialize(latest);
  }
  async function initialize() {
    if (initializing.current) return initializing.current;
    initializing.current = (async () => {
      queue.status = "loading";
      persist();
      try {
        const state = await loadWriting(projectId);
        if (!state?.draft?.payload)
          throw new Error(
            "Unsent writing could not be loaded. Retry before editing it.",
          );
        const recovered = initial.current!;
        const local = recovered.cache?.payload ?? queue.value;
        if (migration.current) {
          await preserveCopy();
        } else if (recovered.cache?.batch) {
          queue.initialize(state);
          queue.value = copy(local);
          queue.revision = recovered.cache.revision;
          queue.generation = recovered.cache.generation;
          queue.savedGeneration = recovered.cache.savedGeneration;
          queue.batch = copy(recovered.cache.batch);
          queue.status = "dirty";
          await queue.flush(true);
        } else if (
          hasWriting(local) &&
          !sameWriting(local, state.draft.payload)
        ) {
          if (state.draft.revision === 0) {
            queue.initialize(state);
            queue.update(() => copy(local), false);
            await queue.flush();
          } else {
            await preserveCopy({
              baseRevision: state.draft.revision,
              mutationId: uid(),
              payload: copy(local),
              copyOnly: true,
            });
          }
        } else queue.initialize(state);
        initial.current = {
          cache: null,
          legacy: { message: "", comments: {}, failedPrompt: null },
        };
        try {
          sessionStorage.removeItem(PLANNING_DRAFT_PREFIX + projectId);
        } catch {
          /* Preserve server copy. */
        }
        persist();
      } catch (error) {
        queue.fail(error);
      }
    })().finally(() => {
      initializing.current = null;
    });
    return initializing.current;
  }
  useEffect(() => {
    mounted.current = true;
    void initialize();
    return () => {
      mounted.current = false;
      persist();
    };
  }, [projectId]);
  useEffect(() => {
    if (queue.status !== "dirty") return;
    const timer = setTimeout(() => void queue.flush(), 600);
    return () => clearTimeout(timer);
  }, [queue.generation, queue.status]);
  useEffect(() => {
    const guard: DraftGuard = {
      flush: () => queue.flush(true),
      pending: () => queue.pending(),
    };
    onDraftGuard?.(guard);
    return () => onDraftGuard?.(null);
  }, [onDraftGuard, queue]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (queue.pending()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queue]);
  function set<K extends keyof WritingPayload>(
    field: K,
    value:
      WritingPayload[K] | ((current: WritingPayload[K]) => WritingPayload[K]),
  ) {
    queue.update((current) => ({
      ...current,
      [field]:
        typeof value === "function"
          ? (value as (current: WritingPayload[K]) => WritingPayload[K])(
              current[field],
            )
          : value,
    }));
  }
  function captureVersion(
    kind: "message" | "comment" | "answer",
    key?: string,
  ): string {
    let version = "";
    queue.update((value) => {
      if (kind === "message") {
        version = value.versions.message || uid();
        value.versions.message = version;
      } else {
        const group = kind === "comment" ? "comments" : "questions";
        if (!key) throw new Error("Writing context is required.");
        version =
          (Object.hasOwn(value.versions[group], key)
            ? value.versions[group][key]
            : "") || uid();
        value.versions[group] = { ...value.versions[group], [key]: version };
      }
      return value;
    }, false);
    return version;
  }
  async function stage(
    kind: "message" | "comment" | "answer",
    request: PlanningPrompt | CommentSubmission | AnswerSubmission,
    consume = true,
    capturedVersion?: string,
  ) {
    queue.update((value) => {
      if (kind === "message") {
        const existing = value.failedPrompt?.mutationId === request.mutationId;
        value.failedPrompt = request as PlanningPrompt;
        if (!existing) {
          delete value.submitted.message;
          if (consume) {
            value.submitted.message =
              capturedVersion ?? (value.versions.message || uid());
            if (!capturedVersion)
              value.versions.message = value.submitted.message;
          }
        }
      } else if (kind === "comment") {
        const body = request as CommentSubmission;
        const existing = value.failedComment?.mutationId === body.mutationId;
        value.failedComment = body;
        if (!existing) {
          value.submitted.comment =
            capturedVersion ??
            ((Object.hasOwn(value.versions.comments, body.nodeId)
              ? value.versions.comments[body.nodeId]
              : null) ||
              uid());
          if (!capturedVersion)
            value.versions.comments = {
              ...value.versions.comments,
              [body.nodeId]: value.submitted.comment,
            };
        }
      } else {
        const body = request as AnswerSubmission;
        const existing = value.failedAnswer?.mutationId === body.mutationId;
        value.failedAnswer = body;
        if (!existing) {
          value.submitted.answer =
            capturedVersion ??
            ((Object.hasOwn(value.versions.questions, body.setId)
              ? value.versions.questions[body.setId]
              : null) ||
              uid());
          if (!capturedVersion)
            value.versions.questions = {
              ...value.versions.questions,
              [body.setId]: value.submitted.answer,
            };
        }
      }
      return value;
    }, false);
    if (!(await queue.flush(true)))
      throw new Error(
        "Save the unsent writing before sending. Retry its save or choose a saved copy.",
      );
  }
  function retire(kind: "message" | "comment" | "answer", id: string) {
    queue.update((value) => retireWriting(value, kind, id), false);
  }
  async function select(saved: WritingRecord) {
    if (!(await queue.flush(true))) return false;
    queue.status = "loading";
    persist();
    try {
      const latest = await loadWriting(projectId);
      const available = latest.copies.find((item) => item.id === saved.id);
      if (!available)
        throw new Error("This saved copy was discarded in another tab.");
      queue.selectCopy(available, latest);
      return queue.flush();
    } catch (reason) {
      queue.fail(reason);
      return false;
    }
  }
  async function discard(saved: WritingRecord) {
    try {
      const state = await discardWritingCopy(
        projectId,
        saved.id,
        saved.revision,
      );
      queue.copies = state.copies;
      persist();
    } catch (reason) {
      queue.fail(reason);
    }
  }
  return {
    value: queue.value,
    status: queue.status,
    error: queue.error,
    copies: queue.copies,
    conflict: queue.conflict,
    set,
    stage,
    captureVersion,
    retire,
    flush: () => queue.flush(true),
    retry: () =>
      !queue.isReady() || migration.current ? initialize() : queue.flush(true),
    useMine: async () => {
      queue.continueMine();
      return queue.flush(true);
    },
    loadOther: async () => {
      if (!queue.conflict) return;
      try {
        await preserveCopy(
          migration.current ?? {
            baseRevision: queue.revision,
            mutationId: uid(),
            payload: copy(queue.value),
            copyOnly: true,
          },
        );
      } catch (reason) {
        queue.fail(reason);
      }
    },
    select,
    discard,
    setContext: (context: WritingContext | null) => set("context", context),
    ready: queue.isReady() && queue.status !== "loading" && !migration.current,
  };
}
