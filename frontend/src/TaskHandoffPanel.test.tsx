import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import TaskHandoffPanel from "./TaskHandoffPanel";
import { api, ApiError, post, downloadBlob } from "./api";
import { useProject } from "./store";
import { useRunObservation } from "./useRunObservation";
import type { ExecutionRun } from "./execution";

vi.mock("./api", async () => ({
  ...(await vi.importActual<typeof import("./api")>("./api")),
  api: vi.fn(),
  post: vi.fn(),
  downloadBlob: vi.fn(),
}));
vi.mock("./store", () => ({ useProject: vi.fn() }));
const flush = vi.fn();
const exported = {
  manifest: {
    schema: "planbranch.task-handoff.v1",
    handoffId: "handoff",
    taskId: "task",
    contentHash: "hash",
    baseCommit: "base",
    sourceIncluded: false,
    expectedReturn: {
      schema: "planbranch.external-result.v1",
      candidateCommit: "REPLACE",
    },
  },
  markdown: "# Approved implementation brief",
};
const result = {
  id: "returned",
  handoffId: "handoff",
  origin: "external",
  verificationState: "External result reported",
  baseCommit: "base",
  candidateCommit: "candidate",
  contentHash: "resultHash",
  compatibilityIssues: [],
  report: { origin: "host", html: "<script>alert('untrusted')</script>" },
  reportTrust: "Untrusted external claims; no local checks were performed.",
  files: [{ path: "main.py", diff: "+ value = 2", binary: false }],
  reviews: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  flush.mockResolvedValue(true);
  vi.mocked(useProject).mockReturnValue({
    session: { id: "project", revision: 7 },
    commit: vi.fn(),
    flush,
    getSnapshot: () => ({ revision: 7 }),
  } as unknown as ReturnType<typeof useProject>);
  vi.mocked(api).mockResolvedValue({ handoffs: [], results: [] });
  vi.mocked(post).mockResolvedValue(exported);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const verificationPreview = {
  ready: true,
  issues: [],
  preview: {
    id: "verification",
    candidateCommit: "candidate",
    command: "test",
    timeoutSeconds: 60,
  },
};
const observedRun = (state = "running", id = "observed-run") => ({
  id,
  state,
  summary: state === "succeeded" ? "Check finished" : "Check in progress",
  commands: [],
});
async function beginVerification(
  status: (url: string, options?: RequestInit) => unknown,
  options: {
    initialState?: string;
    getResult?: () => typeof result;
    startReply?: () => Promise<unknown>;
  } = {},
) {
  const setup = options;
  vi.mocked(api).mockImplementation(async (url, options) =>
    url.includes("/execution/runs/")
      ? status(url, options)
      : { handoffs: [], results: [(setup.getResult ?? (() => result))()] },
  );
  vi.mocked(post).mockImplementation(async (url) =>
    url.endsWith("/preview")
      ? verificationPreview
      : setup.startReply
        ? setup.startReply()
        : { run: observedRun(setup.initialState) },
  );
  let mounted!: ReturnType<typeof render>;
  await act(async () => {
    mounted = render(<TaskHandoffPanel taskId="task" />);
  });
  fireEvent.click(
    screen.getByText("Verify returned candidate without editing"),
  );
  fireEvent.change(screen.getByLabelText("Local verification command"), {
    target: { value: "test" },
  });
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: "Preview verification without editing",
      }),
    );
  });
  fireEvent.click(screen.getByLabelText(/I authorize this check/));
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Run verification without editing" }),
    );
  });
  return mounted;
}

it.each([
  new TypeError("Connection interrupted"),
  new ApiError("Connection interrupted", 503),
  new ApiError("Connection interrupted", 429),
  new ApiError("Connection interrupted", 408),
])(
  "automatically recovers a transient verification observation failure without starting another run (%s)",
  async (cause) => {
    vi.useFakeTimers();
    const status = vi
      .fn()
      .mockRejectedValueOnce(cause)
      .mockResolvedValue({ run: observedRun("succeeded") });
    await beginVerification(status);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Connection interrupted",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText("Verification process completed")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(post).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(status).toHaveBeenCalledTimes(2);
  },
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function tick(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

it("backs off repeated transient reads to eight seconds and resets after a successful active observation", async () => {
  vi.useFakeTimers();
  const status = vi.fn();
  for (let index = 0; index < 5; ++index)
    status.mockRejectedValueOnce(new ApiError("Server restarting", 503));
  status
    .mockResolvedValueOnce({ run: observedRun() })
    .mockRejectedValueOnce(new TypeError("Network interrupted again"))
    .mockResolvedValue({ run: observedRun("succeeded") });
  await beginVerification(status);
  const delays = [1000, 1000, 2000, 4000, 8000, 8000, 1000, 1000];
  for (const [index, delay] of delays.entries()) {
    await tick(delay - 1);
    expect(status).toHaveBeenCalledTimes(index);
    await tick(1);
    expect(status).toHaveBeenCalledTimes(index + 1);
    if (index === 5) expect(screen.queryByRole("alert")).toBeNull();
  }
  expect(screen.getByText("Verification process completed")).toBeTruthy();
  expect(post).toHaveBeenCalledTimes(2);
});

it("polls queued, running and cancelling observations at the normal cadence", async () => {
  vi.useFakeTimers();
  const status = vi
    .fn()
    .mockResolvedValueOnce({ run: observedRun("running") })
    .mockResolvedValueOnce({ run: observedRun("cancelling") })
    .mockResolvedValue({ run: observedRun("cancelled") });
  await beginVerification(status, { initialState: "queued" });
  for (const state of ["running", "cancelling", "cancelled"]) {
    await tick(1000);
    expect(
      screen.getByText(
        state === "succeeded"
          ? "Verification process completed"
          : `Local verification: ${state}`,
      ),
    ).toBeTruthy();
  }
  await tick(60000);
  expect(status).toHaveBeenCalledTimes(3);
  expect(post).toHaveBeenCalledTimes(2);
});

it.each(["succeeded", "failed", "cancelled", "interrupted"])(
  "stops automatic reads after terminal %s",
  async (state) => {
    vi.useFakeTimers();
    const status = vi.fn().mockResolvedValue({ run: observedRun(state) });
    await beginVerification(status);
    await tick(1000);
    expect(
      screen.getByText(
        state === "succeeded"
          ? "Verification process completed"
          : `Local verification: ${state}`,
      ),
    ).toBeTruthy();
    await tick(60000);
    expect(status).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledTimes(2);
  },
);

it.each([400, 401, 403, 404, 410])(
  "stops after permanent status %s with manual recovery and unknown-current guidance",
  async (statusCode) => {
    vi.useFakeTimers();
    const status = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("Observation unavailable", statusCode),
      )
      .mockResolvedValue({ run: observedRun("succeeded") });
    await beginVerification(status);
    await tick(1000);
    expect(screen.getByRole("alert").textContent).toContain(
      "Automatic updates stopped. Refresh local observation",
    );
    expect(
      screen.getByText("Last observed local verification: running"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Preview verification without editing",
      }),
    ).toHaveProperty("disabled", true);
    await tick(60000);
    expect(status).toHaveBeenCalledOnce();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh local observation" }),
      );
    });
    expect(status).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Verification process completed")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(post).toHaveBeenCalledTimes(2);
  },
);

it("keeps only one effective read and lets the newest manual refresh win against late automatic or manual responses", async () => {
  vi.useFakeTimers();
  const automatic = deferred<unknown>(),
    earlierManual = deferred<unknown>(),
    latest = deferred<unknown>();
  const status = vi
    .fn()
    .mockReturnValueOnce(automatic.promise)
    .mockReturnValueOnce(earlierManual.promise)
    .mockReturnValueOnce(latest.promise);
  await beginVerification(status);
  await tick(1000);
  await tick(60000);
  expect(status).toHaveBeenCalledOnce();
  const firstSignal = status.mock.calls[0][1].signal as AbortSignal;
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh local observation" }),
  );
  expect(firstSignal.aborted).toBe(true);
  const secondSignal = status.mock.calls[1][1].signal as AbortSignal;
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh local observation" }),
  );
  expect(secondSignal.aborted).toBe(true);
  expect(
    status.mock.calls.filter(([, options]) => !options.signal.aborted),
  ).toHaveLength(1);
  await act(async () => {
    latest.resolve({ run: observedRun("succeeded") });
  });
  await act(async () => {
    earlierManual.reject(new ApiError("Stale failure", 404));
    automatic.resolve({ run: observedRun("running") });
  });
  expect(screen.getByText("Verification process completed")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  await tick(60000);
  expect(status).toHaveBeenCalledTimes(3);
  expect(post).toHaveBeenCalledTimes(2);
});

it.each(["automatic", "manual"])(
  "aborts an in-flight %s read on unmount and ignores its late response",
  async (kind) => {
    vi.useFakeTimers();
    const pendingRead = deferred<unknown>();
    const status = vi.fn().mockReturnValue(pendingRead.promise);
    const mounted = await beginVerification(status);
    if (kind === "automatic") await tick(1000);
    else
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh local observation" }),
      );
    const signal = status.mock.calls[0][1].signal as AbortSignal;
    mounted.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pendingRead.resolve({ run: observedRun() });
    });
    await tick(60000);
    expect(status).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("clears a scheduled retry on unmount", async () => {
  vi.useFakeTimers();
  const status = vi.fn().mockRejectedValue(new TypeError("Offline"));
  const mounted = await beginVerification(status);
  await tick(1000);
  mounted.unmount();
  await tick(60000);
  expect(status).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("a manual refresh replaces the scheduled backoff instead of leaving a duplicate poll", async () => {
  vi.useFakeTimers();
  const status = vi
    .fn()
    .mockRejectedValueOnce(new ApiError("Temporarily unavailable", 503))
    .mockResolvedValueOnce({ run: observedRun() })
    .mockResolvedValue({ run: observedRun("succeeded") });
  await beginVerification(status);
  await tick(1000);
  await tick(500);
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh local observation" }),
    );
  });
  expect(status).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
  await tick(500);
  expect(status).toHaveBeenCalledTimes(2);
  await tick(500);
  expect(status).toHaveBeenCalledTimes(3);
  expect(screen.getByText("Verification process completed")).toBeTruthy();
  expect(post).toHaveBeenCalledTimes(2);
});

it.each(["project", "task", "result", "candidate", "content"])(
  "discards obsolete observations when %s identity changes",
  async (identity) => {
    vi.useFakeTimers();
    const pendingRead = deferred<unknown>();
    const status = vi.fn().mockReturnValue(pendingRead.promise);
    let selectedResult = result;
    const mounted = await beginVerification(status, {
      getResult: () => selectedResult,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh local observation" }),
    );
    const signal = status.mock.calls[0][1].signal as AbortSignal;
    if (identity === "result")
      selectedResult = { ...result, id: "other-result" };
    if (identity === "candidate")
      selectedResult = { ...result, candidateCommit: "other-candidate" };
    if (identity === "content")
      selectedResult = { ...result, contentHash: "other-content" };
    const project = vi.mocked(useProject).mock.results.at(-1)!.value;
    vi.mocked(useProject).mockReturnValue({
      ...project,
      session: {
        ...project.session,
        id: identity === "project" ? "other-project" : "project",
        revision: 8,
      },
    });
    await act(async () => {
      mounted.rerender(
        <TaskHandoffPanel
          taskId={identity === "task" ? "other-task" : "task"}
        />,
      );
    });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pendingRead.resolve({ run: observedRun("succeeded") });
    });
    expect(
      screen.queryByRole("region", { name: "Local verification result" }),
    ).toBeNull();
    expect(screen.queryByText("Verification process completed")).toBeNull();
    await tick(60000);
    expect(status).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledTimes(2);
  },
);

it("preserves unresolved start receipts and never retries a start automatically", async () => {
  vi.useFakeTimers();
  const startReply = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Lost start response"))
    .mockResolvedValue({ run: observedRun("succeeded") });
  const status = vi.fn();
  await beginVerification(status, { startReply });
  expect(
    screen.getByRole("button", { name: "Retry verification start" }),
  ).toBeTruthy();
  await tick(60000);
  expect(post).toHaveBeenCalledTimes(2);
  expect(status).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Retry verification start" }),
    );
  });
  expect(vi.mocked(post).mock.calls[1]).toEqual(vi.mocked(post).mock.calls[2]);
  expect(screen.getByText("Verification process completed")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not resume automatic polling if a manual refresh of a terminal run fails", async () => {
  vi.useFakeTimers();
  const status = vi.fn().mockRejectedValue(new TypeError("Offline"));
  await beginVerification(status, { initialState: "succeeded" });
  await tick(60000);
  expect(status).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh local observation" }),
    );
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "Automatic updates stopped",
  );
  await tick(60000);
  expect(status).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledTimes(2);
});

it("binds observations to the project even when the hook is reused without a component key", async () => {
  vi.useFakeTimers();
  const pendingRead = deferred<unknown>();
  vi.mocked(api).mockReturnValue(pendingRead.promise);
  const hook = renderHook(({ projectId }) => useRunObservation(projectId), {
    initialProps: { projectId: "first-project" },
  });
  act(() =>
    hook.result.current.observe(observedRun() as unknown as ExecutionRun),
  );
  await tick(1000);
  const signal = vi.mocked(api).mock.calls[0][1]!.signal as AbortSignal;
  hook.rerender({ projectId: "other-project" });
  expect(signal.aborted).toBe(true);
  expect(hook.result.current.run).toBeNull();
  await act(async () => {
    pendingRead.resolve({ run: observedRun("succeeded") });
  });
  await tick(60000);
  expect(hook.result.current.run).toBeNull();
  expect(hook.result.current.error).toBe("");
  expect(api).toHaveBeenCalledOnce();
  hook.rerender({ projectId: "first-project" });
  await tick(60000);
  expect(hook.result.current.run).toBeNull();
  expect(api).toHaveBeenCalledOnce();
});

it("aborts a replaced run immediately and ignores its late observation", async () => {
  vi.useFakeTimers();
  const pendingRead = deferred<unknown>();
  vi.mocked(api)
    .mockReturnValueOnce(pendingRead.promise)
    .mockResolvedValue({ run: observedRun("succeeded", "new-run") });
  const hook = renderHook(() => useRunObservation("project"));
  act(() =>
    hook.result.current.observe(observedRun() as unknown as ExecutionRun),
  );
  await tick(1000);
  const signal = vi.mocked(api).mock.calls[0][1]!.signal as AbortSignal;
  act(() =>
    hook.result.current.observe(
      observedRun("queued", "new-run") as unknown as ExecutionRun,
    ),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => {
    pendingRead.resolve({ run: observedRun("failed") });
  });
  expect(hook.result.current.run?.id).toBe("new-run");
  expect(hook.result.current.run?.state).toBe("queued");
  await tick(1000);
  expect(api).toHaveBeenLastCalledWith(
    "/projects/project/execution/runs/new-run",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(hook.result.current.run?.state).toBe("succeeded");
  await tick(60000);
  expect(api).toHaveBeenCalledTimes(2);
});

it.each(["preview", "start"])(
  "ignores a late verification %s response after the selected task changes",
  async (stage) => {
    vi.useFakeTimers();
    const pendingMutation = deferred<unknown>();
    vi.mocked(api).mockResolvedValue({ handoffs: [], results: [result] });
    vi.mocked(post).mockImplementation(async (url) =>
      url.endsWith(`/${stage}`) ? pendingMutation.promise : verificationPreview,
    );
    let mounted!: ReturnType<typeof render>;
    await act(async () => {
      mounted = render(<TaskHandoffPanel taskId="task" />);
    });
    fireEvent.click(
      screen.getByText("Verify returned candidate without editing"),
    );
    fireEvent.change(screen.getByLabelText("Local verification command"), {
      target: { value: "test" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: "Preview verification without editing",
        }),
      );
    });
    if (stage === "start") {
      fireEvent.click(screen.getByLabelText(/I authorize this check/));
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: "Run verification without editing",
          }),
        );
      });
    }
    await act(async () => {
      mounted.rerender(<TaskHandoffPanel taskId="other-task" />);
    });
    await act(async () => {
      pendingMutation.resolve(
        stage === "start" ? { run: observedRun() } : verificationPreview,
      );
    });
    expect(
      screen.queryByRole("button", {
        name: "Run verification without editing",
      }),
    ).toBeNull();
    expect(screen.queryByText("Local verification: running")).toBeNull();
    await tick(60000);
    expect(
      vi
        .mocked(api)
        .mock.calls.some(([url]) => url.includes("/execution/runs/")),
    ).toBe(false);
    expect(post).toHaveBeenCalledTimes(stage === "start" ? 2 : 1);
  },
);

it("does not send an obsolete preview after a pending plan flush completes", async () => {
  vi.useFakeTimers();
  const pendingFlush = deferred<boolean>();
  flush.mockReturnValue(pendingFlush.promise);
  vi.mocked(api).mockResolvedValue({ handoffs: [], results: [result] });
  let mounted!: ReturnType<typeof render>;
  await act(async () => {
    mounted = render(<TaskHandoffPanel taskId="task" />);
  });
  fireEvent.click(
    screen.getByText("Verify returned candidate without editing"),
  );
  fireEvent.change(screen.getByLabelText("Local verification command"), {
    target: { value: "test" },
  });
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: "Preview verification without editing",
      }),
    );
  });
  await act(async () => {
    mounted.rerender(<TaskHandoffPanel taskId="other-task" />);
  });
  await act(async () => {
    pendingFlush.resolve(true);
  });
  expect(post).not.toHaveBeenCalled();
});

it("previews a source-free concrete package before export", async () => {
  render(<TaskHandoffPanel taskId="task" />);
  fireEvent.click(screen.getByText("Use an external coding agent"));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Preview implementation handoff" }),
  );
  expect(await screen.findByText(/No repository source included/)).toBeTruthy();
  expect(post).toHaveBeenCalledWith("/projects/project/handoffs", {
    taskId: "task",
    baseRevision: 7,
    supportingContext: "",
  });
  expect(downloadBlob).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Export handoff JSON" }));
  expect(downloadBlob).toHaveBeenCalledOnce();
});

it("renders external HTML as text and verifies only an explicitly previewed command without opening an editing run", async () => {
  vi.mocked(api).mockResolvedValue({ handoffs: [], results: [result] });
  vi.mocked(post).mockImplementation(async (url) =>
    url.endsWith("/preview")
      ? {
          ready: true,
          issues: [],
          preview: {
            id: "verification",
            candidateCommit: "candidate",
            command: "python -m pytest",
            timeoutSeconds: 60,
          },
        }
      : {
          run: {
            id: "observed-run",
            state: "succeeded",
            summary: "Check finished",
            commands: [
              {
                id: "check",
                command: "python -m pytest",
                status: "completed",
                exitCode: 0,
                output: "observed output",
                evidence: { provenance: "host_observed" },
              },
            ],
          },
        },
  );
  const onRun = vi.fn();
  render(<TaskHandoffPanel taskId="task" onRun={onRun} />);
  expect(await screen.findByText("External result reported")).toBeTruthy();
  fireEvent.click(screen.getByText("External test report · untrusted content"));
  expect(screen.getByText(/<script>/)).toBeTruthy();
  expect(document.querySelector("script")).toBeNull();
  expect(onRun).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByText("Verify returned candidate without editing"),
  );
  expect(screen.getByLabelText("Local verification command")).toHaveProperty(
    "value",
    "",
  );
  fireEvent.change(screen.getByLabelText("Local verification command"), {
    target: { value: "python -m pytest" },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Preview verification without editing",
    }),
  );
  const run = await screen.findByRole("button", {
    name: "Run verification without editing",
  });
  expect(run).toHaveProperty("disabled", true);
  expect(post).toHaveBeenCalledWith(
    "/projects/project/external-results/returned/verification/preview",
    {
      contentHash: "resultHash",
      command: "python -m pytest",
      timeoutSeconds: 60,
    },
  );
  expect(post).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByLabelText(/I authorize this check/));
  fireEvent.click(run);
  expect(await screen.findByText("observed output")).toBeTruthy();
  expect(post).toHaveBeenLastCalledWith(
    "/projects/project/external-results/returned/verification/start",
    {
      previewId: "verification",
      mutationId: expect.any(String),
      confirmed: true,
    },
  );
  expect(onRun).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Open local observation review" }),
  );
  expect(onRun).toHaveBeenCalledWith("observed-run");
});

it("changing a verification command clears its preview and authorization", async () => {
  vi.mocked(api).mockResolvedValue({ handoffs: [], results: [result] });
  vi.mocked(post).mockResolvedValue({
    ready: true,
    issues: [],
    preview: {
      id: "verification",
      candidateCommit: "candidate",
      command: "test one",
      timeoutSeconds: 60,
    },
  });
  render(<TaskHandoffPanel taskId="task" />);
  await screen.findByText("External result reported");
  fireEvent.click(
    screen.getByText("Verify returned candidate without editing"),
  );
  fireEvent.change(screen.getByLabelText("Local verification command"), {
    target: { value: "test one" },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Preview verification without editing",
    }),
  );
  fireEvent.click(await screen.findByLabelText(/I authorize this check/));
  fireEvent.change(screen.getByLabelText("Local verification command"), {
    target: { value: "test two" },
  });
  expect(
    screen.queryByRole("button", { name: "Run verification without editing" }),
  ).toBeNull();
  expect(post).toHaveBeenCalledTimes(1);
});

it("retries uncertain verification starts with the same mutation receipt", async () => {
  vi.mocked(api).mockResolvedValue({ handoffs: [], results: [result] });
  vi.mocked(post)
    .mockResolvedValueOnce({
      ready: true,
      issues: [],
      preview: {
        id: "verification",
        candidateCommit: "candidate",
        command: "test",
        timeoutSeconds: 60,
      },
    })
    .mockRejectedValueOnce(new Error("Lost start response"))
    .mockResolvedValueOnce({
      run: {
        id: "verified",
        state: "succeeded",
        summary: "Done",
        commands: [],
      },
    });
  render(<TaskHandoffPanel taskId="task" />);
  await screen.findByText("External result reported");
  fireEvent.click(
    screen.getByText("Verify returned candidate without editing"),
  );
  fireEvent.change(screen.getByLabelText("Local verification command"), {
    target: { value: "test" },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Preview verification without editing",
    }),
  );
  fireEvent.click(await screen.findByLabelText(/I authorize this check/));
  fireEvent.click(
    screen.getByRole("button", { name: "Run verification without editing" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry verification start" }),
  );
  await screen.findByText("Verification process completed");
  expect(vi.mocked(post).mock.calls[1]).toEqual(vi.mocked(post).mock.calls[2]);
});

it("allows a new preview after the server rejects a verification start", async () => {
  vi.mocked(api).mockResolvedValue({ handoffs: [], results: [result] });
  vi.mocked(post)
    .mockResolvedValueOnce({
      ready: true,
      issues: [],
      preview: {
        id: "verification",
        candidateCommit: "candidate",
        command: "test",
        timeoutSeconds: 60,
      },
    })
    .mockRejectedValueOnce(new ApiError("The selected candidate changed", 400));
  render(<TaskHandoffPanel taskId="task" />);
  await screen.findByText("External result reported");
  fireEvent.click(
    screen.getByText("Verify returned candidate without editing"),
  );
  fireEvent.change(screen.getByLabelText("Local verification command"), {
    target: { value: "test" },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Preview verification without editing",
    }),
  );
  fireEvent.click(await screen.findByLabelText(/I authorize this check/));
  fireEvent.click(
    screen.getByRole("button", { name: "Run verification without editing" }),
  );
  await screen.findByText("The selected candidate changed");
  expect(
    screen.queryByRole("button", { name: "Retry verification start" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", {
      name: "Preview verification without editing",
    }),
  ).toHaveProperty("disabled", false);
  expect(screen.queryByLabelText(/I authorize this check/)).toBeNull();
});

it("keeps errors visible and prevents stale external acceptance", async () => {
  vi.mocked(api).mockResolvedValue({
    handoffs: [],
    results: [{ ...result, compatibilityIssues: ["Task scope changed"] }],
  });
  render(<TaskHandoffPanel taskId="task" />);
  await screen.findByText("External result reported");
  fireEvent.change(screen.getByLabelText("Human review note"), {
    target: { value: "Read carefully" },
  });
  expect(
    screen.getByRole("button", { name: "Record accepted review" }),
  ).toHaveProperty("disabled", true);
  vi.mocked(post).mockRejectedValue(new Error("Review service unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Review service unavailable",
  );
});
