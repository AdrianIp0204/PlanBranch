import { describe, expect, it, vi } from "vitest";
import {
  WritingQueue,
  emptyWriting,
  retireWriting,
  stampWriting,
  sameWriting,
  type WritingPayload,
  type WritingSave,
  type WritingState,
} from "./writingDrafts";
const state = (payload = emptyWriting(), revision = 0): WritingState => ({
  draft: { id: "current", revision, updatedAt: null, payload },
  copies: [],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
describe("durable unsent writing queue", () => {
  it("late acknowledgements never overwrite newer writing and drain the next immutable batch", async () => {
    const first = deferred<WritingState>(),
      requests: WritingSave[] = [];
    const queue = new WritingQueue(
      emptyWriting(),
      async (body) => {
        requests.push(structuredClone(body));
        return requests.length === 1 ? first.promise : state(body.payload, 2);
      },
      () => {},
    );
    queue.initialize(state());
    queue.update((value) => ({ ...value, message: "First" }));
    const pending = queue.flush();
    queue.update((value) => ({ ...value, message: "Newer" }));
    first.resolve(state(requests[0].payload, 1));
    expect(await pending).toBe(true);
    expect(requests.map((r) => r.payload.message)).toEqual(["First", "Newer"]);
    expect(requests[1].baseRevision).toBe(1);
    expect(queue.value.message).toBe("Newer");
    expect(queue.pending()).toBe(false);
  });
  it("an uncertain committed save retries the same request before saving newer writing", async () => {
    const calls: WritingSave[] = [];
    const queue = new WritingQueue(
      emptyWriting(),
      async (body) => {
        calls.push(structuredClone(body));
        if (calls.length === 1) throw new Error("Lost acknowledgement");
        return state(body.payload, calls.length === 2 ? 1 : 2);
      },
      () => {},
    );
    queue.initialize(state());
    queue.update((v) => ({ ...v, message: "Before" }));
    expect(await queue.flush()).toBe(false);
    queue.update((v) => ({ ...v, message: "After" }));
    expect(await queue.flush(true)).toBe(true);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[2].mutationId).not.toBe(calls[0].mutationId);
    expect(queue.value.message).toBe("After");
  });
  it("a concurrent conflict preserves local edits and explicitly preserves the other tab on resolution", async () => {
    const first = deferred<WritingState>(),
      calls: WritingSave[] = [];
    const queue = new WritingQueue(
      emptyWriting(),
      async (body) => {
        calls.push(structuredClone(body));
        return calls.length === 1 ? first.promise : state(body.payload, 3);
      },
      () => {},
    );
    queue.initialize(state());
    queue.update((v) => ({ ...v, message: "Mine" }));
    const pending = queue.flush();
    queue.update((v) => ({ ...v, message: "Newer mine" }));
    first.reject({
      status: 409,
      data: {
        ...state({ ...emptyWriting(), message: "Other" }, 2),
        copies: [
          {
            id: "copy",
            revision: 1,
            updatedAt: null,
            payload: calls[0].payload,
          },
        ],
      },
    });
    expect(await pending).toBe(false);
    expect(queue.value.message).toBe("Newer mine");
    expect(queue.status).toBe("conflict");
    expect(await queue.flush(true)).toBe(false);
    queue.continueMine();
    expect(await queue.flush()).toBe(true);
    expect(calls[1]).toMatchObject({
      baseRevision: 2,
      preserveCurrent: true,
      payload: { message: "Newer mine" },
    });
  });
  it("does not treat object key order as changed writing", () => {
    expect(sameWriting({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
  it("retirement is by version, even when newer typing returns to exactly the submitted text", () => {
    let value = stampWriting(emptyWriting(), {
      ...emptyWriting(),
      message: "Same",
    });
    value.failedPrompt = {
      mutationId: "sent",
      text: "Same",
      diagramId: "d",
      nodeId: null,
    };
    value.submitted.message = value.versions.message;
    value = stampWriting(value, { ...value, message: "Different" });
    value = stampWriting(value, { ...value, message: "Same" });
    expect(retireWriting(value, "message", "sent").message).toBe("Same");
    value.submitted.message = value.versions.message;
    expect(retireWriting(value, "message", "sent").message).toBe("");
  });
  it("legacy writing without an explicit submitted version remains available after receipt recovery", () => {
    const value = emptyWriting();
    value.comments = { n: "Unsent newer comment" };
    value.failedComment = {
      mutationId: "old",
      nodeId: "n",
      diagramId: "d",
      text: "Old",
    };
    expect(retireWriting(value, "comment", "old").comments.n).toBe(
      "Unsent newer comment",
    );
    value.questionDrafts = {
      q: { answer: { custom: true, text: "Unsent", choice: null } },
    };
    value.failedAnswer = {
      setId: "q",
      mutationId: "answer",
      baseRevision: 1,
      answers: [],
      selection: { mode: "default" },
    };
    expect(
      retireWriting(value, "answer", "answer").questionDrafts.q.answer.text,
    ).toBe("Unsent");
  });
});
