import {
  copy,
  uid,
  type Checkpoint,
  type Content,
  type Envelope,
  type Viewport,
} from "./types";
export type Session = {
  id: string;
  content: Content;
  history: Checkpoint[];
  cursor: string;
  views: Record<string, Viewport>;
  generation: number;
  savedGeneration: number;
  revision: number;
  savedAt: string;
  pending?: { label: string; diagramId?: string };
};
export type Action =
  | { type: "load"; envelope: Envelope }
  | {
      type: "edit";
      content: Content;
      label: string;
      diagramId?: string;
      group?: boolean;
    }
  | { type: "commit" }
  | { type: "recover"; ackIds: string[] }
  | { type: "undo" | "redo" }
  | { type: "view"; diagramId: string; view: Viewport }
  | {
      type: "ack";
      generation: number;
      revision: number;
      savedAt: string;
      historyIds: string[];
    };
export function fromEnvelope(e: Envelope): Session {
  return { ...e, content: copy(e.content), generation: 0, savedGeneration: 0 };
}
function commit(s: Session): Session {
  if (!s.pending) return s;
  const index = s.history.findIndex((h) => h.id === s.cursor);
  const checkpoint = { id: uid(), ...s.pending, content: copy(s.content) };
  return {
    ...s,
    history: [...s.history.slice(0, index + 1), checkpoint],
    cursor: checkpoint.id,
    pending: undefined,
  };
}
export function reducer(state: Session, action: Action): Session {
  switch (action.type) {
    case "load":
      return fromEnvelope(action.envelope);
    case "edit": {
      let next = state;
      if (
        state.pending &&
        (!action.group ||
          state.pending.label !== action.label ||
          state.pending.diagramId !== action.diagramId)
      )
        next = commit(state);
      if (JSON.stringify(action.content) === JSON.stringify(next.content))
        return next;
      next = {
        ...next,
        content: action.content,
        generation: next.generation + 1,
        pending: { label: action.label, diagramId: action.diagramId },
      };
      return action.group ? next : commit(next);
    }
    case "commit":
      return commit(state);
    case "recover": {
      const shared = state.history.filter((h) => action.ackIds.includes(h.id));
      if (!shared.length) return state;
      const checkpoint = {
        id: uid(),
        label: "Recover unsaved changes",
        content: copy(state.content),
      };
      return {
        ...state,
        history: [...shared, checkpoint],
        cursor: checkpoint.id,
        pending: undefined,
        generation: state.generation + 1,
      };
    }
    case "undo":
    case "redo": {
      const s = commit(state);
      const index =
        s.history.findIndex((h) => h.id === s.cursor) +
        (action.type === "undo" ? -1 : 1);
      if (
        index < Math.max(0, s.history.length - 101) ||
        index >= s.history.length
      )
        return s;
      return {
        ...s,
        cursor: s.history[index].id,
        content: copy(s.history[index].content),
        generation: s.generation + 1,
      };
    }
    case "view":
      if (
        JSON.stringify(state.views[action.diagramId]) ===
        JSON.stringify(action.view)
      )
        return state;
      return {
        ...state,
        views: { ...state.views, [action.diagramId]: action.view },
        generation: state.generation + 1,
      };
    case "ack": {
      const retained = new Set(action.historyIds);
      const first = state.history.findIndex((h) => retained.has(h.id));
      const history =
        first > 0 &&
        state.history.findIndex((h) => h.id === state.cursor) >= first
          ? state.history.slice(first)
          : state.history;
      return {
        ...state,
        history,
        revision: action.revision,
        savedAt: action.savedAt,
        savedGeneration: action.generation,
      };
    }
  }
}
export type SaveBody = {
  baseRevision: number;
  mutationId: string;
  anchorId: string;
  append: Checkpoint[];
  cursor: string;
  views: Record<string, Viewport>;
};
export type SaveAck = {
  revision: number;
  savedAt: string;
  historyIds: string[];
};
export function makeBatch(
  s: Session,
  ackIds: string[],
  revision: number,
): SaveBody {
  let common = -1;
  for (let i = 0; i < s.history.length; i++) {
    const acknowledged = ackIds.indexOf(s.history[i].id);
    if (acknowledged !== -1) common = i;
    else break;
  }
  if (common === -1)
    throw Object.assign(
      new Error("The saved history changed. Keep this draft as a new project."),
      { status: 409 },
    );
  const append = copy(s.history.slice(common + 1).slice(-101));
  const retained = [...s.history.slice(0, common + 1), ...append].slice(-101);
  const diagramIds = new Set(
    retained.flatMap((h) => h.content.diagrams.map((d) => d.id)),
  );
  const views = Object.fromEntries(
    Object.entries(s.views).filter(([id]) => diagramIds.has(id)),
  );
  return {
    baseRevision: revision,
    mutationId: uid(),
    anchorId: s.history[common].id,
    append,
    cursor: s.cursor,
    views: copy(views),
  };
}
/** Single immutable request in flight. Failed requests remain intact for safe retries. */
export class SaveQueue {
  private running: Promise<boolean> | null = null;
  private external: Promise<Envelope> | null = null;
  private batch: { body: SaveBody; generation: number } | null = null;
  public conflict = false;
  private rejected = false;
  constructor(
    private get: () => Session,
    private dispatch: (a: Action) => void,
    private request: (id: string, b: SaveBody) => Promise<SaveAck>,
    private report: (
      status: "saving" | "saved" | "failed" | "conflict",
      message?: string,
    ) => void,
    private ackIds: string[],
    private revision: number,
  ) {}
  /** Serialize a server-authored checkpoint with autosave; never replace a newer draft. */
  synchronize(
    request: (snapshot: Session) => Promise<Envelope>,
  ): Promise<Envelope> {
    if (this.external)
      return Promise.reject(
        new Error("A plan change is already being reviewed."),
      );
    const ready = this.flush();
    let startedGeneration: number | undefined;
    const operation = (async () => {
      if (!(await ready))
        throw new Error(
          "Save or recover your draft before applying a proposal.",
        );
      const snapshot = copy(this.get());
      startedGeneration = snapshot.generation;
      const envelope = await request(snapshot);
      if (envelope.id !== snapshot.id)
        throw new Error("The proposal returned a different project.");
      if (this.get().generation !== snapshot.generation) {
        this.conflict = true;
        const message =
          "The proposal was saved, but you also made new edits. Your local draft is preserved. Keep the draft as a new project or discard it to load the accepted plan.";
        this.report("conflict", message);
        throw new Error(message);
      }
      this.ackIds = envelope.history.map((item) => item.id);
      this.revision = envelope.revision;
      this.batch = null;
      this.rejected = false;
      this.dispatch({ type: "load", envelope });
      this.report("saved");
      return envelope;
    })();
    this.external = operation.finally(() => {
      this.external = null;
      if (
        startedGeneration !== undefined &&
        !this.conflict &&
        this.get().generation !== startedGeneration &&
        this.get().generation !== this.get().savedGeneration
      )
        void this.flush();
    });
    return this.external;
  }
  flush(): Promise<boolean> {
    if (this.external)
      return this.external.then(
        () => true,
        () => false,
      );
    if (this.conflict) return Promise.resolve(false);
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async run(): Promise<boolean> {
    this.dispatch({ type: "commit" });
    if (this.rejected) {
      this.dispatch({ type: "recover", ackIds: this.ackIds });
      this.rejected = false;
    }
    while (this.batch || this.get().generation !== this.get().savedGeneration) {
      const s = this.get();
      try {
        if (!this.batch)
          this.batch = {
            body: makeBatch(s, this.ackIds, this.revision),
            generation: s.generation,
          };
        const batch = this.batch;
        this.report("saving");
        const ack = await this.request(s.id, batch.body);
        this.revision = ack.revision;
        this.ackIds = ack.historyIds;
        this.dispatch({ type: "ack", ...ack, generation: batch.generation });
        this.batch = null;
        this.dispatch({ type: "commit" });
      } catch (error) {
        const status = (error as { status?: number }).status;
        this.conflict = status === 409;
        const definite = status === 400 || status === 413 || status === 422;
        if (definite) {
          this.batch = null;
          this.rejected = true;
        }
        this.report(
          this.conflict ? "conflict" : "failed",
          (error instanceof Error
            ? error.message
            : "Save failed. Please retry.") +
            (definite
              ? " Correct the field and retry. Rejected unsaved history will be combined into one recovery step."
              : ""),
        );
        return false;
      }
    }
    this.report("saved");
    return true;
  }
}
