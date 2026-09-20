import { describe, it, expect, vi } from "vitest";
import {
  fromEnvelope,
  reducer,
  makeBatch,
  SaveQueue,
  type Action,
  type SaveBody,
  type SaveAck,
} from "./history";
import { copy, createNode, type Envelope, type Content } from "./types";
export function fixture(): Envelope {
  const content: Content = {
    schemaVersion: 1,
    name: "Example",
    notes: "",
    diagrams: [
      {
        id: "diagram-a",
        name: "Main",
        nodes: [createNode("process", { x: 20, y: 40 })],
        edges: [],
      },
    ],
    variables: [],
    nodeLinks: [],
    matches: [],
  };
  return {
    id: "project-a",
    revision: 1,
    savedAt: "2026-09-10T00:00:00Z",
    content,
    history: [
      { id: "baseline", label: "Create project", content: copy(content) },
    ],
    cursor: "baseline",
    views: { "diagram-a": { x: 10, y: 20, zoom: 1 } },
  };
}
function harness() {
  let state = fromEnvelope(fixture());
  const dispatch = (a: Action) => {
    state = reducer(state, a);
  };
  const edit = (notes: string, group = false) => {
    const content = copy(state.content);
    content.notes = notes;
    dispatch({ type: "edit", content, label: "Edit notes", group });
  };
  return { get: () => state, dispatch, edit };
}
function server() {
  let revision = 1;
  let ids = ["baseline"];
  return (body: SaveBody): SaveAck => {
    ids = [
      ...ids.slice(0, ids.indexOf(body.anchorId) + 1),
      ...body.append.map((h) => h.id),
    ].slice(-101);
    return {
      revision: ++revision,
      savedAt: "2026-09-10T01:00:00Z",
      historyIds: ids,
    };
  };
}
const defer = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
describe("project history", () => {
  it("groups a text burst and restores metadata with stable IDs", () => {
    const h = harness();
    h.edit("one", true);
    h.edit("two", true);
    h.edit("three", true);
    expect(h.get().history).toHaveLength(1);
    h.dispatch({ type: "commit" });
    expect(h.get().history).toHaveLength(2);
    const nodeId = h.get().content.diagrams[0].nodes[0].id;
    h.dispatch({ type: "undo" });
    expect(h.get().content.notes).toBe("");
    h.dispatch({ type: "redo" });
    expect(h.get().content.notes).toBe("three");
    expect(h.get().content.diagrams[0].nodes[0].id).toBe(nodeId);
  });
  it("keeps linked metadata through undo, redo and restart", () => {
    const h = harness();
    const content = copy(h.get().content);
    content.variables.push({
      id: "v1",
      name: "count",
      description: "Items",
      intendedType: "int",
      intendedFile: "future.py",
      scopeKind: "function",
      scope: "main",
      initialExpression: "0",
      notes: "manual",
      status: "blocked",
    });
    content.nodeLinks.push({
      id: "l1",
      nodeId: content.diagrams[0].nodes[0].id,
      variableId: "v1",
      origin: "planned",
      relationship: "reads",
    });
    h.dispatch({ type: "edit", content, label: "Add variable" });
    const final = copy(h.get().content);
    h.dispatch({ type: "undo" });
    const reopened = fromEnvelope({ ...h.get(), savedAt: "now", revision: 2 });
    const restored = reducer(reopened, { type: "redo" });
    expect(restored.content).toEqual(final);
  });
  it("drops the redo branch only on a new content edit", () => {
    const h = harness();
    h.edit("one");
    h.edit("two");
    h.dispatch({ type: "undo" });
    h.dispatch({
      type: "view",
      diagramId: "diagram-a",
      view: { x: 100, y: 200, zoom: 0.5 },
    });
    expect(h.get().history).toHaveLength(3);
    h.edit("different");
    expect(h.get().history.at(-1)?.content.notes).toBe("different");
    expect(h.get().history.some((c) => c.content.notes === "two")).toBe(false);
  });
  it("makes a cursor-only save preserving redo", () => {
    const h = harness();
    h.edit("one");
    h.edit("two");
    const ids = h.get().history.map((c) => c.id);
    h.dispatch({ type: "undo" });
    const batch = makeBatch(h.get(), ids, 5);
    expect(batch.append).toEqual([]);
    expect(batch.anchorId).toBe(ids.at(-1));
    expect(batch.cursor).toBe(ids[1]);
  });
  it("keeps deleted but undoable diagram views, drops abandoned diagram views", () => {
    const h = harness();
    let c = copy(h.get().content);
    c.diagrams.push({ id: "b", name: "B", nodes: [], edges: [] });
    h.dispatch({ type: "edit", content: c, label: "Add B" });
    h.dispatch({
      type: "view",
      diagramId: "b",
      view: { x: 500, y: 500, zoom: 2 },
    });
    c = copy(h.get().content);
    c.diagrams = c.diagrams.filter((d) => d.id !== "b");
    h.dispatch({ type: "edit", content: c, label: "Delete B" });
    expect(makeBatch(h.get(), ["baseline"], 1).views.b).toBeDefined();
    h.dispatch({ type: "undo" });
    h.dispatch({ type: "undo" });
    h.edit("branch from A");
    expect(makeBatch(h.get(), ["baseline"], 1).views.b).toBeUndefined();
  });
  it("bounds a long offline batch and undo range to 100 actions plus baseline", () => {
    const h = harness();
    for (let i = 0; i < 140; i++) h.edit(String(i));
    const batch = makeBatch(h.get(), ["baseline"], 1);
    expect(batch.append).toHaveLength(101);
    for (let i = 0; i < 140; i++) h.dispatch({ type: "undo" });
    expect(h.get().content.notes).toBe("39");
  });
});
describe("serialized autosave", () => {
  it("never replaces newer edits when an older response arrives", async () => {
    const h = harness();
    const pending = defer<SaveAck>();
    const bodies: SaveBody[] = [];
    const respond = server();
    const request = vi.fn(async (_id: string, body: SaveBody) => {
      bodies.push(copy(body));
      return bodies.length === 1 ? pending.promise : respond(body);
    });
    const queue = new SaveQueue(
      h.get,
      h.dispatch,
      request,
      vi.fn(),
      ["baseline"],
      1,
    );
    h.edit("old");
    const saving = queue.flush();
    h.edit("new while saving");
    expect(queue.flush()).toBe(saving);
    pending.resolve(respond(bodies[0]));
    expect(await saving).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(h.get().content.notes).toBe("new while saving");
    expect(h.get().savedGeneration).toBe(h.get().generation);
  });
  it("retries uncertain failures with the same immutable mutation", async () => {
    const h = harness();
    const respond = server();
    const bodies: SaveBody[] = [];
    const request = vi.fn(async (_id: string, b: SaveBody) => {
      bodies.push(copy(b));
      if (bodies.length === 1) throw new Error("Network disappeared");
      return respond(b);
    });
    const queue = new SaveQueue(
      h.get,
      h.dispatch,
      request,
      vi.fn(),
      ["baseline"],
      1,
    );
    h.edit("first");
    expect(await queue.flush()).toBe(false);
    h.edit("second");
    expect(await queue.flush()).toBe(true);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2].mutationId).not.toBe(bodies[0].mutationId);
    expect(h.get().content.notes).toBe("second");
  });
  it("recovers corrected drafts after a definite validation rejection", async () => {
    const h = harness();
    const respond = server();
    const bodies: SaveBody[] = [];
    const request = vi.fn(async (_id: string, b: SaveBody) => {
      bodies.push(copy(b));
      if (bodies.length === 1)
        throw Object.assign(new Error("Invalid project name"), { status: 400 });
      expect(b.append.every((h) => h.content.name.trim().length > 0)).toBe(
        true,
      );
      return respond(b);
    });
    const queue = new SaveQueue(
      h.get,
      h.dispatch,
      request,
      vi.fn(),
      ["baseline"],
      1,
    );
    let c = copy(h.get().content);
    c.name = "";
    h.dispatch({ type: "edit", content: c, label: "Rename" });
    expect(await queue.flush()).toBe(false);
    c = copy(h.get().content);
    c.name = "Corrected";
    h.dispatch({ type: "edit", content: c, label: "Rename" });
    expect(await queue.flush()).toBe(true);
    expect(bodies[1].mutationId).not.toBe(bodies[0].mutationId);
    expect(h.get().content.name).toBe("Corrected");
    expect(h.get().history).toHaveLength(2);
  });
  it("stops at a stale revision and preserves the draft for recovery", async () => {
    const h = harness();
    const request = vi.fn(async () => {
      throw Object.assign(new Error("Changed in another tab"), { status: 409 });
    });
    const queue = new SaveQueue(
      h.get,
      h.dispatch,
      request,
      vi.fn(),
      ["baseline"],
      1,
    );
    h.edit("my work");
    expect(await queue.flush()).toBe(false);
    expect(await queue.flush()).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(h.get().content.notes).toBe("my work");
    expect(queue.conflict).toBe(true);
  });
  it("retains newer local checkpoints when acknowledged history is pruned", () => {
    const h = harness();
    for (let i = 0; i < 104; i++) h.edit(String(i));
    const saved = h.get().generation;
    const ids = h
      .get()
      .history.slice(-101)
      .map((h) => h.id);
    h.edit("unsaved latest");
    h.dispatch({
      type: "ack",
      generation: saved,
      revision: 2,
      savedAt: "now",
      historyIds: ids,
    });
    expect(h.get().history).toHaveLength(102);
    expect(h.get().history.at(-1)?.content.notes).toBe("unsaved latest");
    expect(h.get().savedGeneration).not.toBe(h.get().generation);
  });
  it("reports an unavailable history anchor without throwing or losing content", async () => {
    const h = harness();
    const report = vi.fn();
    const queue = new SaveQueue(
      h.get,
      h.dispatch,
      vi.fn(),
      report,
      ["missing-anchor"],
      1,
    );
    h.edit("keep me");
    expect(await queue.flush()).toBe(false);
    expect(report).toHaveBeenCalledWith(
      "conflict",
      expect.stringContaining("Keep this draft"),
    );
    expect(h.get().content.notes).toBe("keep me");
  });
});

describe("reviewed server checkpoints", () => {
  function proposed(state: ReturnType<typeof fromEnvelope>): Envelope {
    const content = copy(state.content);
    content.notes = "Accepted agent proposal";
    const checkpoint = {
      id: "proposal-checkpoint",
      label: "Accept proposal",
      content,
    };
    return {
      id: state.id,
      revision: state.revision + 1,
      savedAt: "2026-09-20T00:00:00Z",
      content,
      history: [...state.history, checkpoint],
      cursor: checkpoint.id,
      views: state.views,
    };
  }
  it("flushes earlier edits and continues normal undo and autosave from the accepted revision", async () => {
    const h = harness();
    const report = vi.fn();
    const saved = server();
    const request = vi.fn(async (_id: string, body: SaveBody) => saved(body));
    const queue = new SaveQueue(
      h.get,
      h.dispatch,
      request,
      report,
      ["baseline"],
      1,
    );
    h.edit("My saved instructions");
    const apply = vi.fn(async (snapshot) => proposed(snapshot));
    await queue.synchronize(apply);
    expect(apply.mock.calls[0][0].content.notes).toBe("My saved instructions");
    expect(apply.mock.calls[0][0].revision).toBe(2);
    expect(h.get().content.notes).toBe("Accepted agent proposal");
    h.dispatch({ type: "undo" });
    expect(h.get().content.notes).toBe("My saved instructions");
    await queue.flush();
    const body = request.mock.calls.at(-1)![1];
    expect(body.baseRevision).toBe(3);
    expect(body.anchorId).toBe("proposal-checkpoint");
    expect(body.append).toEqual([]);
  });
  it("preserves newer local edits when an acceptance response arrives late", async () => {
    const h = harness();
    const report = vi.fn();
    const response = defer<Envelope>();
    const request = vi.fn();
    const queue = new SaveQueue(
      h.get,
      h.dispatch,
      request,
      report,
      ["baseline"],
      1,
    );
    const started = defer<void>();
    const applied = queue.synchronize(async () => {
      started.resolve();
      return response.promise;
    });
    await started.promise;
    const accepted = proposed(h.get());
    h.edit("Newer local correction");
    const autosave = queue.flush();
    response.resolve(accepted);
    await expect(applied).rejects.toThrow("local draft is preserved");
    expect(await autosave).toBe(false);
    expect(h.get().content.notes).toBe("Newer local correction");
    expect(queue.conflict).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      "conflict",
      expect.stringContaining("Keep the draft"),
    );
  });
  it("recovers a lost acceptance reply by retrying its receipt without another checkpoint", async () => {
    const h = harness();
    const request = vi.fn(
      async (_id: string, body: SaveBody): Promise<SaveAck> => ({
        revision: body.baseRevision + 1,
        savedAt: "2026-09-20T00:01:00Z",
        historyIds: [...h.get().history.map((item) => item.id)],
      }),
    );
    const queue = new SaveQueue(
      h.get,
      h.dispatch,
      request,
      vi.fn(),
      ["baseline"],
      1,
    );
    let stored: Envelope | undefined;
    let receipt: { mutationId: string; baseRevision: number } | undefined;
    let checkpointWrites = 0;
    const apply = vi.fn(async (snapshot: ReturnType<typeof fromEnvelope>) => {
      const body = {
        mutationId: "accept-once",
        baseRevision: snapshot.revision,
      };
      if (!receipt) {
        receipt = body;
        stored = proposed(snapshot);
        checkpointWrites++;
        throw new Error("Connection closed after acceptance committed");
      }
      expect(body).toEqual(receipt);
      return copy(stored!);
    });

    await expect(queue.synchronize(apply)).rejects.toThrow("Connection closed");
    expect(h.get().content.notes).toBe("");
    expect(h.get().revision).toBe(1);
    expect(h.get().history).toHaveLength(1);
    expect(request).not.toHaveBeenCalled();

    await queue.synchronize(apply);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(checkpointWrites).toBe(1);
    expect(h.get().content.notes).toBe("Accepted agent proposal");
    expect(h.get().revision).toBe(2);
    expect(h.get().history).toHaveLength(2);
    expect(
      h.get().history.filter((item) => item.id === "proposal-checkpoint"),
    ).toHaveLength(1);

    h.edit("A correction after recovering the reply");
    expect(await queue.flush()).toBe(true);
    expect(request.mock.calls[0][1].baseRevision).toBe(2);
    expect(request.mock.calls[0][1].anchorId).toBe("proposal-checkpoint");
  });
  it("does not apply or silently retry after the prerequisite save fails", async () => {
    const h = harness();
    h.edit("Unsaved instructions");
    const request = vi.fn().mockRejectedValue(new Error("Disk full"));
    const queue = new SaveQueue(
      h.get,
      h.dispatch,
      request,
      vi.fn(),
      ["baseline"],
      1,
    );
    const apply = vi.fn();
    await expect(queue.synchronize(apply)).rejects.toThrow("Save or recover");
    expect(apply).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(h.get().content.notes).toBe("Unsaved instructions");
  });
});
