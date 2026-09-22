import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import useWritingDrafts from "./useWritingDrafts";
import { loadWriting, saveWriting, discardWritingCopy } from "./writingApi";
import {
  emptyWriting,
  type WritingSave,
  type WritingState,
} from "./writingDrafts";
import { PLANNING_DRAFT_PREFIX } from "./planning";
vi.mock("./writingApi", () => ({
  loadWriting: vi.fn(),
  saveWriting: vi.fn(),
  discardWritingCopy: vi.fn(),
}));
let server: WritingState;
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  server = {
    draft: {
      id: "current",
      revision: 0,
      updatedAt: null,
      payload: emptyWriting(),
    },
    copies: [],
  };
  vi.mocked(loadWriting).mockImplementation(async () =>
    structuredClone(server),
  );
  vi.mocked(saveWriting).mockImplementation(async (_id, body) => {
    if (body.copyOnly)
      server.copies.push({
        id: "copy" + server.copies.length,
        revision: 1,
        updatedAt: null,
        payload: structuredClone(body.payload),
      });
    else
      server.draft = {
        id: "current",
        revision: server.draft.revision + 1,
        updatedAt: null,
        payload: structuredClone(body.payload),
      };
    return structuredClone(server);
  });
});
afterEach(cleanup);
it("loads durable writing into a fresh browser without any submission", async () => {
  server.draft = {
    ...server.draft,
    revision: 4,
    payload: {
      ...emptyWriting(),
      message: "Server prompt",
      comments: { node: "Comment" },
      questionDrafts: {
        set: { answer: { choice: null, custom: true, text: "Answer" } },
      },
    },
  };
  const { result } = renderHook(() => useWritingDrafts("p"));
  await waitFor(() => expect(result.current.status).toBe("saved"));
  expect(result.current.value).toEqual(server.draft.payload);
  expect(saveWriting).not.toHaveBeenCalled();
});
it("migrates a legacy session copy separately when canonical writing exists", async () => {
  server.draft = {
    ...server.draft,
    revision: 3,
    payload: { ...emptyWriting(), message: "Canonical" },
  };
  sessionStorage.setItem(
    PLANNING_DRAFT_PREFIX + "p",
    JSON.stringify({ message: "Legacy", comments: {} }),
  );
  const { result } = renderHook(() => useWritingDrafts("p"));
  await waitFor(() => expect(result.current.status).toBe("saved"));
  expect(result.current.value.message).toBe("Canonical");
  expect(result.current.copies[0].payload.message).toBe("Legacy");
  expect(vi.mocked(saveWriting).mock.calls[0][1].copyOnly).toBe(true);
  expect(sessionStorage.getItem(PLANNING_DRAFT_PREFIX + "p")).toBeNull();
});
it("preserves a failed immutable batch across unmount and retries it after reload", async () => {
  const save = vi.mocked(saveWriting).getMockImplementation()!;
  vi.mocked(saveWriting).mockRejectedValueOnce(new Error("Offline"));
  const first = renderHook(() => useWritingDrafts("p"));
  await waitFor(() => expect(first.result.current.status).toBe("saved"));
  act(() => first.result.current.set("message", "Unsent"));
  await act(async () => {
    expect(await first.result.current.flush()).toBe(false);
  });
  const body = structuredClone(vi.mocked(saveWriting).mock.calls[0][1]);
  first.unmount();
  vi.mocked(saveWriting).mockImplementation(save);
  const second = renderHook(() => useWritingDrafts("p"));
  await waitFor(() => expect(second.result.current.status).toBe("saved"));
  expect(vi.mocked(saveWriting).mock.calls[1][1]).toEqual(body);
  expect(second.result.current.value.message).toBe("Unsent");
});
it("registers a truthful navigation guard and unregisters on close", async () => {
  const guard = vi.fn();
  const { result, unmount } = renderHook(() => useWritingDrafts("p", guard));
  await waitFor(() => expect(result.current.status).toBe("saved"));
  const registered = guard.mock.calls[0][0];
  act(() => result.current.set("message", "Pending"));
  expect(registered.pending()).toBe(true);
  vi.mocked(saveWriting).mockRejectedValueOnce(new Error("Offline"));
  await act(async () => {
    expect(await registered.flush()).toBe(false);
  });
  expect(registered.pending()).toBe(true);
  unmount();
  expect(guard).toHaveBeenLastCalledWith(null);
});
it("blocks navigation while a saved copy is loading and keeps current writing if loading fails", async () => {
  const saved = {
    id: "copy",
    revision: 1,
    updatedAt: null,
    payload: { ...emptyWriting(), message: "Recovered" },
  };
  server.draft = {
    ...server.draft,
    revision: 2,
    payload: { ...emptyWriting(), message: "Current" },
  };
  server.copies = [saved];
  const guard = vi.fn();
  const { result } = renderHook(() => useWritingDrafts("p", guard));
  await waitFor(() => expect(result.current.status).toBe("saved"));
  let reject!: (reason: unknown) => void;
  vi.mocked(loadWriting).mockImplementationOnce(
    () =>
      new Promise((_resolve, failed) => {
        reject = failed;
      }),
  );
  let selecting!: Promise<boolean>;
  await act(async () => {
    selecting = result.current.select(saved);
  });
  expect(result.current.ready).toBe(false);
  expect(guard.mock.calls[0][0].pending()).toBe(true);
  expect(await guard.mock.calls[0][0].flush()).toBe(false);
  await act(async () => {
    reject(new Error("Offline"));
    expect(await selecting).toBe(false);
  });
  expect(result.current.value.message).toBe("Current");
  expect(result.current.error).toBe("Offline");
});
it("stages exact request durably before delivery, and retires only the submitted version", async () => {
  const { result } = renderHook(() => useWritingDrafts("p"));
  await waitFor(() => expect(result.current.status).toBe("saved"));
  act(() => result.current.set("message", "Original"));
  const request = {
    mutationId: "message",
    text: "Original",
    diagramId: "d",
    nodeId: null,
  };
  await act(async () => result.current.stage("message", request));
  expect(server.draft.payload.failedPrompt).toEqual(request);
  act(() => result.current.set("message", "New writing"));
  act(() => result.current.retire("message", "message"));
  expect(result.current.value.message).toBe("New writing");
  expect(result.current.value.failedPrompt).toBeNull();
});
it("retrying an uncertain submission retains its original writing version", async () => {
  const { result } = renderHook(() => useWritingDrafts("p"));
  await waitFor(() => expect(result.current.status).toBe("saved"));
  const request = {
    mutationId: "message",
    text: "Same",
    diagramId: "d",
    nodeId: null,
  };
  act(() => result.current.set("message", "Same"));
  await act(async () => result.current.stage("message", request));
  const original = result.current.value.submitted.message;
  act(() => result.current.set("message", "Different"));
  act(() => result.current.set("message", "Same"));
  await act(async () => result.current.stage("message", request));
  expect(result.current.value.submitted.message).toBe(original);
  act(() => result.current.retire("message", "message"));
  expect(result.current.value.message).toBe("Same");
});
it("a generated Ask again request does not consume unrelated composer writing", async () => {
  const { result } = renderHook(() => useWritingDrafts("p"));
  await waitFor(() => expect(result.current.status).toBe("saved"));
  act(() => result.current.set("message", "My unsent note"));
  await act(async () =>
    result.current.stage(
      "message",
      { mutationId: "ask", text: "Ask again", diagramId: "d", nodeId: null },
      false,
    ),
  );
  act(() => result.current.retire("message", "ask"));
  expect(result.current.value.message).toBe("My unsent note");
});
