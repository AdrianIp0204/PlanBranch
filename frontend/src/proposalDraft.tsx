import {
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
import {
  copy,
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

/** Canvas and Inspector share their normal editing behavior, with no save queue or API access. */
export function ProposalDraftProvider({
  projectId,
  content,
  diagramId,
  storageKey,
  children,
}: {
  projectId: string;
  content: Content;
  diagramId: string;
  storageKey: string;
  children: ReactNode;
}) {
  const original = content.diagrams.find((d) => d.id === diagramId)!;
  const [session, replace] = useReducer(
    (_previous: Session, next: Session) => next,
    undefined,
    () =>
      proposalSession(
        projectId,
        content,
        diagramId,
        readProposalDraft(storageKey, original),
      ),
  );
  const ref = useRef(session);
  const [saveError, setSaveError] = useState("");
  const send = (action: Action) => {
    const next = reducer(ref.current, action);
    // Keep local editing bounded, with the same 100-action undo limit as the project.
    const index = next.history.findIndex((h) => h.id === next.cursor);
    const first = Math.max(0, index - 100);
    if (first) next.history = next.history.slice(first);
    ref.current = next;
    replace(next);
  };
  useEffect(() => {
    const diagram = session.content.diagrams.find((d) => d.id === diagramId)!;
    try {
      if (samePlan(diagram, original)) sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, JSON.stringify(diagram));
      setSaveError("");
    } catch {
      setSaveError(
        "Manual edits could not be kept in this browser. Keep this window open until you apply them.",
      );
    }
  }, [session.content, storageKey]);
  useEffect(() => {
    if (!session.pending) return;
    const timer = window.setTimeout(() => send({ type: "commit" }), 600);
    return () => window.clearTimeout(timer);
  }, [session.generation]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (
        saveError &&
        !samePlan(
          ref.current.content.diagrams.find((d) => d.id === diagramId),
          original,
        )
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [saveError]);
  const value: Store = useMemo(
    () => ({
      session,
      change(edit, label, _diagramId, group = false) {
        const edited = copy(ref.current.content);
        edit(edited);
        const candidate = edited.diagrams.find((d) => d.id === diagramId);
        if (!candidate) return;
        // This workspace can edit only the proposed diagram's nodes and connections.
        const restricted = copy(ref.current.content);
        const diagram = restricted.diagrams.find((d) => d.id === diagramId)!;
        diagram.nodes = candidate.nodes;
        diagram.edges = candidate.edges;
        send({ type: "edit", content: restricted, label, diagramId, group });
      },
      commit: () => send({ type: "commit" }),
      undo: () => send({ type: "undo" }),
      redo: () => send({ type: "redo" }),
      setView: (id, view) => send({ type: "view", diagramId: id, view }),
      getSnapshot: () => ref.current,
      flush: async () => {
        send({ type: "commit" });
        return true;
      },
      synchronize: async () => {
        throw new Error("Apply changes to save this proposal.");
      },
      saveStatus: "draft",
      saveError,
    }),
    [session, saveError],
  );
  return (
    <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
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
