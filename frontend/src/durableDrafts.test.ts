import { describe, expect, it, vi } from "vitest";
import {
  DraftSaveQueue,
  draftCandidateValues,
  type DraftSection,
  type DraftDetail,
  type DraftSummary,
} from "./durableDrafts";
import { fromEnvelope, reducer } from "./history";
import { copy, createNode, emptyBrief, type Content } from "./types";

const content = (): Content => ({
  schemaVersion: 1,
  name: "Project",
  notes: "",
  diagrams: [
    {
      id: "diagram",
      name: "Plan",
      nodes: [
        {
          ...createNode("process", { x: 0, y: 0 }),
          id: "node",
          title: "Original",
        },
      ],
      edges: [],
    },
  ],
  variables: [],
  nodeLinks: [],
  matches: [],
});
const summary = (revision = 0, id = "draft"): DraftSummary => ({
  id,
  proposalId: "proposal",
  diagramId: "diagram",
  draftRevision: revision,
  state: "active",
  createdAt: "2026-09-21",
  updatedAt: `time-${revision}`,
  baseRevision: 1,
  baseHash: "base",
  proposalHash: "hash",
  conflictOf: null,
  stale: false,
  appliedCursor: null,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function setup(revision = 0, sections: DraftSection[] = ["diagram"]) {
  const initial = content();
  let session = fromEnvelope({
    id: "project",
    revision: 0,
    savedAt: "",
    content: initial,
    history: [
      { id: "baseline", label: "Agent proposal", content: copy(initial) },
    ],
    cursor: "baseline",
    views: {},
  });
  const request = vi.fn(async (_id: string, _body: unknown) => ({
    draft: summary(1),
  }));
  const report = vi.fn();
  const queue = new DraftSaveQueue(
    () => session,
    summary(revision),
    request,
    (draft, generation) => {
      session = {
        ...session,
        revision: draft.draftRevision,
        savedGeneration: generation,
        savedAt: draft.updatedAt,
      };
    },
    report,
    sections,
  );
  const edit = (title: string) => {
    const next = copy(session.content);
    next.diagrams[0].nodes[0].title = title;
    session = reducer(session, {
      type: "edit",
      content: next,
      label: "Edit title",
    });
  };
  const editBrief = (goal: string) => {
    const next = copy(session.content);
    next.schemaVersion = 2;
    next.brief = { ...emptyBrief(), goal };
    session = reducer(session, {
      type: "edit",
      content: next,
      label: "Edit brief",
    });
  };
  return { queue, request, report, edit, editBrief, get: () => session };
}

describe("durable proposal draft queue", () => {
  it("persists an untouched proposal when explicitly flushed", async () => {
    const { queue, request } = setup();
    expect(queue.pending()).toBe(false);
    expect(queue.reference()).toBeNull();
    expect(await queue.flush()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toMatchObject({
      baseDraftRevision: 0,
      contentHash: "hash",
    });
    expect(queue.reference()).toEqual({ draftId: "draft", draftRevision: 1 });
  });
  it("serializes immutable batches and never replaces newer edits on a delayed acknowledgement", async () => {
    const { queue, request, edit, get } = setup(1);
    const first = deferred<{ draft: DraftSummary }>(),
      second = deferred<{ draft: DraftSummary }>();
    request
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    edit("First edit");
    const saving = queue.flush();
    const captured = copy(request.mock.calls[0][1]);
    edit("Second edit");
    expect(queue.flush()).toBe(saving);
    expect(request).toHaveBeenCalledTimes(1);
    first.resolve({ draft: summary(2) });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(get().content.diagrams[0].nodes[0].title).toBe("Second edit");
    expect(request.mock.calls[0][1]).toEqual(captured);
    expect(request.mock.calls[1][1]).toMatchObject({
      baseDraftRevision: 2,
      diagram: { nodes: [{ title: "Second edit" }] },
    });
    second.resolve({ draft: summary(3) });
    expect(await saving).toBe(true);
    expect(get().savedGeneration).toBe(get().generation);
    expect(get().history).toHaveLength(3);
  });
  it("keeps a failed batch identity for retry, then saves later edits separately", async () => {
    const { queue, request, edit } = setup(1);
    request
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce({ draft: summary(2) })
      .mockResolvedValueOnce({ draft: summary(3) });
    edit("Possibly saved");
    expect(await queue.flush()).toBe(false);
    const failed = copy(request.mock.calls[0]);
    edit("Newer local draft");
    expect(await queue.flush()).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(await queue.flush(true)).toBe(true);
    expect(request.mock.calls[1]).toEqual(failed);
    expect(request.mock.calls[2][1]).not.toEqual(failed[1]);
    expect(queue.reference()?.draftRevision).toBe(3);
  });
  it("adopts a persisted conflict copy without discarding edits newer than the conflicted batch", async () => {
    const { queue, request, edit, get } = setup(1);
    const pending = deferred<{ draft: DraftSummary }>();
    request.mockImplementationOnce(() => pending.promise);
    edit("Captured draft");
    const sending = queue.flush();
    edit("Still newer edit");
    const recovery = {
      ...summary(1, "recovery"),
      candidate: content(),
      applyRequest: null,
    } satisfies DraftDetail;
    pending.resolve({ draft: summary(2) });
    // Exercise conflict after a different tab changes the next CAS base.
    request.mockRejectedValueOnce(
      Object.assign(new Error("Draft conflict"), {
        status: 409,
        data: {
          latestDraft: summary(3),
          recoveryDraft: summary(1, "recovery"),
        },
      }),
    );
    expect(await sending).toBe(false);
    edit("Edited while choosing a copy");
    expect(queue.adoptRecovery(recovery)).toBe(true);
    expect(get().content.diagrams[0].nodes[0].title).toBe(
      "Edited while choosing a copy",
    );
    request.mockResolvedValueOnce({ draft: summary(2, "recovery") });
    expect(await queue.flush()).toBe(true);
    expect(request.mock.calls.at(-1)).toEqual([
      "recovery",
      expect.objectContaining({
        baseDraftRevision: 1,
        diagram: expect.objectContaining({
          nodes: [
            expect.objectContaining({ title: "Edited while choosing a copy" }),
          ],
        }),
      }),
    ]);
  });
});

it("keeps brief-only in-flight and retry payloads frozen while saving later brief edits separately", async () => {
  const { queue, request, editBrief, get } = setup(1, ["brief"]);
  const pending = deferred<{ draft: DraftSummary }>();
  request
    .mockImplementationOnce(() => pending.promise)
    .mockRejectedValueOnce(new Error("Brief response lost"));
  editBrief("Captured goal");
  const sending = queue.flush();
  const captured = copy(request.mock.calls[0][1]);
  expect(captured).toMatchObject({ brief: { goal: "Captured goal" } });
  expect(captured).not.toHaveProperty("diagram");
  editBrief("Newer goal");
  pending.resolve({ draft: summary(2) });
  expect(await sending).toBe(false);
  expect(get().content.brief?.goal).toBe("Newer goal");
  expect(request.mock.calls[0][1]).toEqual(captured);
  const failed = copy(request.mock.calls[1]);
  editBrief("Still newer goal");
  request
    .mockResolvedValueOnce({ draft: summary(3) })
    .mockResolvedValueOnce({ draft: summary(4) });
  expect(await queue.flush(true)).toBe(true);
  expect(request.mock.calls[2]).toEqual(failed);
  expect(request.mock.calls[3][1]).toMatchObject({
    brief: { goal: "Still newer goal" },
  });
  expect(get().content.brief?.goal).toBe("Still newer goal");
  expect(get().savedGeneration).toBe(get().generation);
});

it("serializes only authorized sections and known brief fields", () => {
  const candidate = content();
  candidate.brief = {
    ...emptyBrief(),
    goal: "Human intent",
    hidden: "No extra fields",
  } as typeof candidate.brief;
  expect(draftCandidateValues(candidate, "diagram", ["brief"])).toEqual({
    brief: { ...emptyBrief(), goal: "Human intent" },
  });
  expect(draftCandidateValues(candidate, "diagram", ["diagram"])).toEqual({
    diagram: candidate.diagrams[0],
  });
  expect(
    draftCandidateValues(candidate, "diagram", ["diagram", "brief"]),
  ).toEqual({
    diagram: candidate.diagrams[0],
    brief: { ...emptyBrief(), goal: "Human intent" },
  });
});
