import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fromEnvelope, reducer, type Action, type Session } from "./history";
import { samePlan } from "./planning";
import { StoreContext, type Store } from "./store";
import { api } from "./api";
import {
  DraftSaveQueue,
  type DraftConflict,
  type DraftDetail,
  type DraftList,
  type DraftReference,
  type DraftStatus,
  type DraftSummary,
} from "./durableDrafts";
import {
  copy,
  uid,
  nodeKinds,
  statuses,
  type Content,
  type Diagram,
  type TaskNode,
} from "./types";

export const PROPOSAL_DRAFT_PREFIX = "flowdesk.proposalDraft.v1.";
export const proposalDraftKey = (
  projectId: string,
  proposalId: string,
  hash: string,
) => `${PROPOSAL_DRAFT_PREFIX}${projectId}.${proposalId}.${hash}`;

/** Drafts are browser data, never trusted project content. The server validates again on apply. */
export function validDraftDiagram(
  value: unknown,
  original: Diagram,
): value is Diagram {
  if (!value || typeof value !== "object") return false;
  const d = value as Diagram;
  if (
    d.id !== original.id ||
    d.name !== original.name ||
    !Array.isArray(d.nodes) ||
    !Array.isArray(d.edges) ||
    d.nodes.length > 5000 ||
    d.edges.length > 10000
  )
    return false;
  const ids = new Set<string>();
  const validId = (id: unknown) =>
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 128 &&
    !ids.has(id) &&
    !!ids.add(id);
  for (const n of d.nodes) {
    if (
      !n ||
      !validId(n.id) ||
      !Object.hasOwn(nodeKinds, n.type) ||
      !Object.hasOwn(statuses, n.status) ||
      !n.position ||
      !Number.isFinite(n.position.x) ||
      !Number.isFinite(n.position.y)
    )
      return false;
    if (
      ![
        "title",
        "description",
        "notes",
        "pseudocode",
        "targetFile",
        "targetScope",
        "why",
        "alternatives",
        "blocker",
      ].every((key) => typeof n[key as keyof TaskNode] === "string")
    )
      return false;
    if (n.pinned !== undefined && typeof n.pinned !== "boolean") return false;
    if (
      !Array.isArray(n.checklist) ||
      !n.checklist.every(
        (item) =>
          item &&
          validId(item.id) &&
          typeof item.text === "string" &&
          typeof item.checked === "boolean",
      )
    )
      return false;
  }
  const nodeIds = new Set(d.nodes.map((n) => n.id));
  return d.edges.every(
    (e) =>
      e &&
      validId(e.id) &&
      nodeIds.has(e.source) &&
      nodeIds.has(e.target) &&
      typeof e.label === "string" &&
      [e.sourceHandle, e.targetHandle].every(
        (h) => h == null || typeof h === "string",
      ),
  );
}

export function readProposalDraft(
  key: string,
  original: Diagram,
): Diagram | null {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    return validDraftDiagram(parsed, original) ? parsed : null;
  } catch {
    return null;
  }
}
export function clearProposalDraft(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* A stale draft cannot change saved content. */
  }
}

export function proposalSession(
  projectId: string,
  content: Content,
  diagramId: string,
  restored?: Diagram | null,
): Session {
  const baseline = copy(content);
  let session = fromEnvelope({
    id: projectId,
    revision: 0,
    savedAt: "",
    content: baseline,
    history: [
      {
        id: "proposal-baseline",
        label: "Agent proposal",
        diagramId,
        content: copy(baseline),
      },
    ],
    cursor: "proposal-baseline",
    views: {},
  });
  if (restored) {
    const draft = copy(baseline);
    draft.diagrams = draft.diagrams.map((d) =>
      d.id === diagramId ? copy(restored) : d,
    );
    session = reducer(session, {
      type: "edit",
      content: draft,
      label: "Recovered manual edits",
      diagramId,
    });
  }
  return session;
}

export type ProposalDraftContextValue = {
  draft: DraftDetail;
  drafts: DraftSummary[];
  status: DraftStatus;
  switching: boolean;
  error: string;
  conflict: DraftConflict | null;
  flush: () => Promise<boolean>;
  retry: () => Promise<boolean>;
  getReference: () => DraftReference | null;
  hasUnsaved: () => boolean;
  refresh: () => Promise<boolean>;
  loadLatest: () => Promise<boolean>;
  useRecovery: () => Promise<boolean>;
  selectDraft: (id: string) => Promise<boolean>;
  cancelApply: () => Promise<boolean>;
  discardDraft: () => Promise<boolean>;
};
const DraftContext = createContext<ProposalDraftContextValue | null>(null);
export function useProposalDraft() {
  const value = useContext(DraftContext);
  if (!value) throw new Error("No proposal draft is open.");
  return value;
}
type DraftProviderProps = {
  projectId: string;
  proposalId: string;
  contentHash: string;
  content: Content;
  diagramId: string;
  storageKey: string;
  readOnly?: boolean;
  children: ReactNode;
};
const reasonText = (reason: unknown) =>
  reason instanceof Error
    ? reason.message
    : "The draft could not be loaded. Try again.";
const draftBase = (projectId: string, proposalId: string) =>
  `/projects/${projectId}/planning/proposals/${proposalId}/drafts`;

/** Load canonical SQLite content before mounting editable controls. */
export function ProposalDraftProvider(props: DraftProviderProps) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    draft: DraftDetail | null;
    list: DraftSummary[];
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setLoaded(null);
    setError("");
    const base = draftBase(props.projectId, props.proposalId);
    void (async () => {
      const list = await api<DraftList>(base);
      const id = list.defaultDraftId;
      const draft = id
        ? (await api<{ draft: DraftDetail }>(`${base}/${id}`)).draft
        : null;
      if (current) setLoaded({ draft, list: list.drafts });
    })().catch((reason) => {
      if (current) setError(reasonText(reason));
    });
    return () => {
      current = false;
    };
  }, [props.projectId, props.proposalId, props.contentHash, attempt]);
  if (!loaded)
    return (
      <section
        className="proposal-workspace"
        aria-label="Proposal draft loading"
      >
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button onClick={() => setAttempt((value) => value + 1)}>
              Retry loading draft
            </button>
          </>
        ) : (
          <p role="status">Loading proposal draft…</p>
        )}
      </section>
    );
  return (
    <LoadedProposalDraft
      key={`${props.projectId}.${props.proposalId}.${props.contentHash}.${attempt}`}
      {...props}
      initial={loaded.draft}
      initialList={loaded.list}
    />
  );
}

function LoadedProposalDraft({
  projectId,
  proposalId,
  contentHash,
  content,
  diagramId,
  storageKey,
  readOnly = false,
  children,
  initial,
  initialList,
}: DraftProviderProps & {
  initial: DraftDetail | null;
  initialList: DraftSummary[];
}) {
  const original = content.diagrams.find((item) => item.id === diagramId)!;
  const [session, replace] = useReducer(
    (_previous: Session, next: Session) => next,
    undefined,
    () => {
      const restored =
        initial?.candidate.diagrams.find((item) => item.id === diagramId) ??
        (!readOnly && !initialList.length
          ? readProposalDraft(storageKey, original)
          : null);
      const value = proposalSession(
        projectId,
        initial?.candidate ?? content,
        diagramId,
        initial ? null : restored,
      );
      value.savedGeneration = initial ? value.generation : 0;
      value.revision = initial?.draftRevision ?? 0;
      value.savedAt = initial?.updatedAt ?? "";
      return value;
    },
  );
  const ref = useRef(session);
  const mounted = useRef(true);
  const changingDraft = useRef(false);
  const [switching, setSwitching] = useState(false);
  const setChangingDraft = (value: boolean) => {
    changingDraft.current = value;
    if (mounted.current) setSwitching(value);
  };
  const pendingAlter = useRef<{
    operation: "cancel-apply" | "discard";
    id: string;
    body: { baseDraftRevision: number; mutationId: string };
  } | null>(null);
  const [draft, setDraft] = useState<DraftDetail>(
    () =>
      initial ?? {
        id: uid(),
        proposalId,
        diagramId,
        draftRevision: 0,
        state: "active",
        createdAt: "",
        updatedAt: "",
        baseRevision: 0,
        baseHash: "",
        proposalHash: contentHash,
        conflictOf: null,
        stale: false,
        appliedCursor: null,
        candidate: copy(session.content),
        applyRequest: null,
      },
  );
  const draftRef = useRef(draft);
  const [drafts, setDrafts] = useState(initialList);
  const [status, setStatus] = useState<DraftStatus>(
    session.generation === session.savedGeneration ? "saved" : "dirty",
  );
  const statusRef = useRef<DraftStatus>(status);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<DraftConflict | null>(null);
  const base = draftBase(projectId, proposalId);
  const report = (
    next: DraftStatus,
    message = "",
    collision: DraftConflict | null = null,
  ) => {
    statusRef.current = next;
    if (mounted.current) {
      setStatus(next);
      setError(message);
      setConflict(collision);
    }
  };
  const updateDraft = (next: DraftDetail) => {
    draftRef.current = next;
    if (mounted.current) {
      setDraft(next);
      setDrafts((current) => [
        next,
        ...current.filter((item) => item.id !== next.id),
      ]);
    }
  };
  const createQueue = (summary: DraftSummary) =>
    new DraftSaveQueue(
      () => ref.current,
      summary,
      (id, body) =>
        api<{ draft: DraftSummary }>(`${base}/${id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        }),
      (ack, generation, diagram) => {
        const candidate = copy(ref.current.content);
        candidate.diagrams = candidate.diagrams.map((item) =>
          item.id === diagramId ? copy(diagram) : item,
        );
        const previous = draftRef.current;
        updateDraft({
          ...previous,
          ...ack,
          candidate,
          applyRequest: ack.state === "active" ? null : previous.applyRequest,
        });
        const next = {
          ...ref.current,
          savedGeneration: generation,
          revision: ack.draftRevision,
          savedAt: ack.updatedAt,
        };
        ref.current = next;
        if (mounted.current) replace(next);
        clearProposalDraft(storageKey);
      },
      report,
    );
  const queueRef = useRef<DraftSaveQueue | null>(null);
  if (!queueRef.current) queueRef.current = createQueue(draft);
  const send = (action: Action) => {
    if (
      changingDraft.current ||
      ((readOnly || draftRef.current.state !== "active") &&
        action.type !== "view")
    )
      return;
    // Viewport changes belong to this open preview only, never draft saves or undo.
    const next =
      action.type === "view"
        ? {
            ...ref.current,
            views: { ...ref.current.views, [action.diagramId]: action.view },
          }
        : reducer(ref.current, action);
    const index = next.history.findIndex((item) => item.id === next.cursor);
    const first = Math.max(0, index - 100);
    if (first) next.history = next.history.slice(first);
    const edited = next.generation !== ref.current.generation;
    ref.current = next;
    replace(next);
    if (edited && !["failed", "conflict", "saving"].includes(statusRef.current))
      report("dirty");
  };
  const flush = () => {
    if (changingDraft.current) return Promise.resolve(false);
    if (readOnly) return Promise.resolve(true);
    send({ type: "commit" });
    return queueRef.current!.flush();
  };
  useEffect(() => {
    mounted.current = true;
    queueRef.current!.activate();
    return () => {
      mounted.current = false;
      queueRef.current?.dispose();
    };
  }, []);
  useEffect(() => {
    if (
      readOnly ||
      ["failed", "conflict", "loading"].includes(statusRef.current) ||
      !queueRef.current!.pending() ||
      draftRef.current.state !== "active"
    )
      return;
    const timer = setTimeout(() => {
      send({ type: "commit" });
      void queueRef.current!.flush();
    }, 600);
    return () => clearTimeout(timer);
  }, [
    session.generation,
    session.savedGeneration,
    draft.id,
    draft.state,
    readOnly,
  ]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (queueRef.current?.pending()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);
  const fetchDraft = async (id: string) =>
    (await api<{ draft: DraftDetail }>(`${base}/${id}`)).draft;
  const install = (next: DraftDetail) => {
    queueRef.current?.dispose();
    const value = proposalSession(projectId, next.candidate, diagramId);
    value.views = ref.current.views;
    value.revision = next.draftRevision;
    value.savedAt = next.updatedAt;
    ref.current = value;
    replace(value);
    updateDraft(next);
    queueRef.current = createQueue(next);
    report("saved");
  };
  const refresh = async () => {
    try {
      const [next, list] = await Promise.all([
        fetchDraft(draftRef.current.id),
        api<DraftList>(base),
      ]);
      if (!mounted.current) return false;
      // Refresh may observe another tab. It must never silently advance our CAS base.
      const known = queueRef.current!.summary();
      if (
        next.draftRevision !== known.draftRevision &&
        (next.state === "active" ||
          !samePlan(next.candidate, draftRef.current.candidate))
      ) {
        setDrafts(list.drafts);
        queueRef.current!.noticeConflict(
          next,
          "This saved draft changed in another window. Choose which copy to keep working on.",
        );
        return false;
      }
      // An unchanged candidate can acquire a durable apply receipt without replacing local edits.
      updateDraft(next);
      setDrafts(list.drafts);
      queueRef.current!.updateSummary(next);
      if (!queueRef.current!.pending()) report("saved");
      return true;
    } catch (reason) {
      report("failed", reasonText(reason));
      return false;
    }
  };
  const loadLatest = async () => {
    const id =
      queueRef.current!.conflict?.latestDraft?.id ?? draftRef.current.id;
    setChangingDraft(true);
    try {
      const next = await fetchDraft(id);
      if (!mounted.current) return false;
      install(next);
      return true;
    } catch (reason) {
      report("conflict", reasonText(reason), queueRef.current!.conflict);
      return false;
    } finally {
      setChangingDraft(false);
    }
  };
  const useRecovery = async () => {
    setChangingDraft(true);
    try {
      if (!queueRef.current!.conflict?.recoveryDraft)
        await queueRef.current!.preserveConflictCopy();
      const id = queueRef.current!.conflict?.recoveryDraft?.id;
      if (!id) return false;
      const next = await fetchDraft(id);
      if (!mounted.current || !queueRef.current!.adoptRecovery(next))
        return false;
      updateDraft({ ...next, candidate: copy(next.candidate) });
      return await queueRef.current!.flush();
    } catch (reason) {
      report("conflict", reasonText(reason), queueRef.current!.conflict);
      return false;
    } finally {
      setChangingDraft(false);
    }
  };
  const selectDraft = async (id: string) => {
    if (id === draftRef.current.id) return true;
    if (!(await flush())) return false;
    setChangingDraft(true);
    try {
      const next = await fetchDraft(id);
      if (!mounted.current) return false;
      install(next);
      return true;
    } catch (reason) {
      report("failed", reasonText(reason));
      return false;
    } finally {
      setChangingDraft(false);
    }
  };
  const alterDraft = async (operation: "cancel-apply" | "discard") => {
    if (!(await flush())) return false;
    setChangingDraft(true);
    try {
      const captured =
        pendingAlter.current?.operation === operation &&
        pendingAlter.current.id === draftRef.current.id
          ? pendingAlter.current
          : {
              operation,
              id: draftRef.current.id,
              body: {
                baseDraftRevision: draftRef.current.draftRevision,
                mutationId: uid(),
              },
            };
      pendingAlter.current = captured;
      const { draft: summary } = await api<{ draft: DraftSummary }>(
        `${base}/${captured.id}/${operation}`,
        {
          method: "POST",
          body: JSON.stringify(captured.body),
        },
      );
      pendingAlter.current = null;
      queueRef.current!.updateSummary(summary);
      updateDraft({ ...draftRef.current, ...summary, applyRequest: null });
      return await refresh();
    } catch (reason) {
      report("failed", reasonText(reason));
      return false;
    } finally {
      setChangingDraft(false);
    }
  };
  const value: Store = useMemo(
    () => ({
      session,
      change(edit, label, _diagramId, group = false) {
        const edited = copy(ref.current.content);
        edit(edited);
        const candidate = edited.diagrams.find((item) => item.id === diagramId);
        if (!candidate) return;
        const restricted = copy(ref.current.content);
        const diagram = restricted.diagrams.find(
          (item) => item.id === diagramId,
        )!;
        diagram.nodes = candidate.nodes;
        diagram.edges = candidate.edges;
        send({ type: "edit", content: restricted, label, diagramId, group });
      },
      commit: () => send({ type: "commit" }),
      undo: () => send({ type: "undo" }),
      redo: () => send({ type: "redo" }),
      setView: (id, view) => send({ type: "view", diagramId: id, view }),
      getSnapshot: () => ref.current,
      flush,
      synchronize: async () => {
        throw new Error("Apply changes to save this proposal into the plan.");
      },
      saveStatus: status,
      saveError: error,
    }),
    [session, status, error, readOnly],
  );
  const controls: ProposalDraftContextValue = {
    draft,
    drafts,
    status,
    switching,
    error,
    conflict,
    flush,
    retry: () => {
      if (readOnly) return refresh();
      send({ type: "commit" });
      return queueRef.current!.pending()
        ? queueRef.current!.flush(true)
        : refresh();
    },
    getReference: () => queueRef.current!.reference(),
    hasUnsaved: () => queueRef.current!.pending(),
    refresh,
    loadLatest,
    useRecovery,
    selectDraft,
    cancelApply: () => alterDraft("cancel-apply"),
    discardDraft: () => alterDraft("discard"),
  };
  return (
    <DraftContext.Provider value={controls}>
      <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
    </DraftContext.Provider>
  );
}

export type ChangeMark = "Added" | "Changed" | "Removed";
export function diagramMarks(before: Diagram | undefined, after: Diagram) {
  function compare<T extends { id: string }>(old: T[], next: T[]) {
    const beforeMarks: Record<string, ChangeMark> = Object.create(null),
      afterMarks: Record<string, ChangeMark> = Object.create(null);
    for (const item of next) {
      const previous = old.find((p) => p.id === item.id);
      if (!previous) afterMarks[item.id] = "Added";
      else if (!samePlan(previous, item)) {
        beforeMarks[item.id] = "Changed";
        afterMarks[item.id] = "Changed";
      }
    }
    for (const item of old)
      if (!next.some((n) => n.id === item.id)) beforeMarks[item.id] = "Removed";
    return { before: beforeMarks, after: afterMarks };
  }
  return {
    nodes: compare(before?.nodes ?? [], after.nodes),
    edges: compare(before?.edges ?? [], after.edges),
  };
}
