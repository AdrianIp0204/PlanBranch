import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import ExecutionDialog from "./ExecutionDialog";
import { updateAgentPreference } from "./preferences";
import BuildView from "./BuildView";
import { api, post, ApiError } from "./api";
import { useProject, type Store } from "./store";
import { fromEnvelope } from "./history";
import { createBuildTask } from "./buildTasks";
import { copy, emptyBrief, type Envelope } from "./types";
import {
  readExecutionReceipt,
  writeExecutionReceipt,
  type ExecutionRun,
  type ExecutionState,
  type ExecutionPreviewResult,
} from "./execution";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: vi.fn(),
  post: vi.fn(),
}));
vi.mock("./store", () => ({ useProject: vi.fn() }));
const base = "/projects/project/execution";
const timestamp = "2026-09-21T01:00:00Z";
function fixture(): Envelope {
  const task = {
    ...createBuildTask(),
    id: "task",
    title: "Build importer",
    deliverable: "A working import command",
    expectedFiles: ["src/import.py"],
    acceptanceChecks: [{ id: "check", text: "Reject invalid input" }],
  };
  const content = {
    schemaVersion: 3 as const,
    name: "Project",
    notes: "",
    brief: { ...emptyBrief(), requirements: "Keep imports local" },
    buildTasks: [task],
    diagrams: [{ id: "diagram", name: "Main", nodes: [], edges: [] }],
    variables: [],
    nodeLinks: [],
    matches: [],
  };
  return {
    id: "project",
    revision: 3,
    savedAt: timestamp,
    content,
    cursor: "baseline",
    history: [{ id: "baseline", label: "Start", content: copy(content) }],
    views: {},
  };
}
function result(): ExecutionRun {
  return {
    id: "run",
    previewId: "preview",
    taskId: "task",
    taskTitle: "Build importer",
    state: "succeeded",
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceCommit: "abc123",
    summary: "Agent says all tests passed",
    error: null,
    progress: "Results captured",
    acceptedDigest: null,
    completedCursor: null,
    applied: false,
    repository: { id: "repo", path: "C:/fixture/repo" },
    context: {
      task: copy(envelope.content.buildTasks![0]),
      brief: emptyBrief(),
      linkedNodes: [],
      sourceCommit: "abc123",
      generation: null,
    },
    worktreePath: "C:/fixture/worktree",
    commands: [
      {
        id: "command",
        command: "pytest",
        status: "completed",
        exitCode: 1,
        output: "Observed failing test <script>danger()</script>",
      },
    ],
    events: [],
    artifact: {
      digest: "result-digest",
      sourceCommit: "abc123",
      files: [
        {
          path: "src/import.py",
          kind: "modified",
          binary: false,
          oldSize: 2,
          newSize: 4,
          patch: "+<script>inert()</script>",
        },
      ],
    },
    planStale: false,
    sourceStale: false,
    applyPlanStale: false,
    applyState: null,
    applyRequest: null,
  };
}
let envelope: Envelope,
  store: Store,
  state: ExecutionState,
  run: ExecutionRun,
  preview: ExecutionPreviewResult;
let read: (path: string) => Promise<unknown>;
let write: (path: string, body: any) => Promise<unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {
      this.open = false;
    },
  });
  envelope = fixture();
  store = {
    session: fromEnvelope(envelope),
    getSnapshot: () => store.session,
    commit: vi.fn(),
    flush: vi.fn(async () => true),
    synchronize: vi.fn(async (request) => {
      const next = await request(store.session);
      store.session = fromEnvelope(next);
      return next;
    }),
    change: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    setView: vi.fn(),
    saveStatus: "saved",
    saveError: "",
  };
  vi.mocked(useProject).mockImplementation(() => store);
  run = result();
  state = {
    repository: { id: "repo", path: "C:/fixture/repo" },
    runs: [],
    agent: { available: true, label: "Codex CLI" },
    ownership: { available: true },
  };
  preview = {
    ready: true,
    issues: [],
    preview: {
      id: "preview",
      baseRevision: 3,
      createdAt: timestamp,
      repositoryId: "repo",
      approvalId: "approval",
      repository: { path: "C:/fixture/repo", head: "abc123", dirty: true },
      ...run.context,
    },
  };
  read = async (path) => {
    if (path.startsWith("/planning/capabilities"))
      return {
        status: "ready",
        source: "cli_catalogue",
        cliVersion: "test",
        fetchedAt: timestamp,
        models: [
          {
            id: "fast",
            label: "Fast",
            description: "Fast",
            defaultReasoningEffort: "low",
            reasoningEfforts: [{ id: "low", description: "Low" }],
            isDefault: true,
          },
        ],
      };
    if (path === base) return copy(state);
    if (path === `${base}/runs/run`) return { run: copy(run) };
    throw new Error(`Unexpected read: ${path}`);
  };
  write = async (path) => {
    if (path === `${base}/preview`) return copy(preview);
    if (path === `${base}/runs`) {
      state.runs = [copy(run)];
      return { run: copy(run) };
    }
    throw new Error(`Unexpected write: ${path}`);
  };
  vi.mocked(api).mockImplementation(((path: string) =>
    read(path)) as typeof api);
  vi.mocked(post).mockImplementation(((path: string, body: unknown) =>
    write(path, body)) as typeof post);
});
afterEach(cleanup);
async function open(history = false) {
  const rendered = render(
    <ExecutionDialog
      taskId="task"
      onClose={vi.fn()}
      initialHistory={history}
    />,
  );
  await screen.findByRole("region", {
    name: history ? "Observed commands" : "Execution repository",
  });
  return rendered;
}
async function previewRun() {
  fireEvent.click(screen.getByRole("button", { name: "Preview run" }));
  await screen.findByRole("region", { name: "Run preview" });
}
async function settle() {
  await waitFor(() =>
    expect(
      screen.queryByText(
        /^(Starting run|Checking run|Accept changes|Complete task|Apply to checkout)…$/,
      ),
    ).toBeNull(),
  );
}

describe("execution review and explicit actions", () => {
  it("opens the exact historical notification run instead of the latest run", async () => {
    const historical = {
      ...copy(run),
      id: "older",
      previewId: "older-preview",
      summary: "Historical result",
    };
    state.runs = [run, historical];
    const originalRead = read;
    read = async (path) =>
      path === `${base}/runs/older` ? { run: historical } : originalRead(path);
    render(
      <ExecutionDialog
        taskId="task"
        onClose={vi.fn()}
        initialHistory
        initialRunId="older"
      />,
    );
    await screen.findByText("Historical result");
    expect(
      (screen.getByLabelText("Execution history") as HTMLSelectElement).value,
    ).toBe("older");
    expect(api).not.toHaveBeenCalledWith(`${base}/runs/run`);
    expect(post).not.toHaveBeenCalled();
  });
  it("keeps an unrelated uncertain action intact while viewing a notification run", async () => {
    const historical = {
      ...copy(run),
      id: "older",
      previewId: "older-preview",
      summary: "Historical result",
    };
    state.runs = [run, historical];
    const pending = {
      kind: "apply" as const,
      runId: run.id,
      body: {
        mutationId: "original-apply",
        digest: "result-digest",
        confirmed: true as const,
      },
    };
    writeExecutionReceipt("project", pending);
    const originalRead = read;
    read = async (path) =>
      path === `${base}/runs/older` ? { run: historical } : originalRead(path);
    render(
      <ExecutionDialog taskId="task" onClose={vi.fn()} initialRunId="older" />,
    );
    await screen.findByText("Historical result");
    expect(readExecutionReceipt("project")).toEqual(pending);
    expect(screen.getByRole("button", { name: "Retry apply" })).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    write = async () => ({ run: { ...run, applied: true } });
    fireEvent.click(screen.getByRole("button", { name: "Retry apply" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledExactlyOnceWith(
        `${base}/runs/run/apply`,
        pending.body,
      ),
    );
  });
  it("previews saved inputs without executing and starts only the reviewed preview", async () => {
    await open();
    expect(post).not.toHaveBeenCalled();
    await previewRun();
    expect(store.flush).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledExactlyOnceWith(`${base}/preview`, {
      taskId: "task",
      selection: { mode: "default" },
    });
    expect(
      screen.getByText(
        "Uncommitted checkout changes are excluded from this run.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run step" }));
    await screen.findByRole("region", { name: "Observed commands" });
    expect(post).toHaveBeenLastCalledWith(`${base}/runs`, {
      mutationId: expect.any(String),
      previewId: "preview",
      confirmed: true,
    });
    expect(readExecutionReceipt("project")).toBeNull();
  });
  it("keeps all authored brief fields available in the reviewed requirements disclosure", async () => {
    const brief = {
      goal: "A local importer",
      audience: "Local developers",
      requirements: "Import CSV",
      constraints: "Offline only",
      outOfScope: "No cloud sync",
      decisions: "Use SQLite",
      assumptions: "Files fit memory",
    };
    store.session.content.brief = brief;
    preview.preview.brief = brief;
    await open();
    await previewRun();
    for (const label of [
      "Goal",
      "Intended user",
      "Requirements",
      "Constraints",
      "Out of scope",
      "Agreed decisions",
      "Assumptions",
    ])
      expect(screen.getByText(label, { selector: "strong" })).toBeTruthy();
    for (const value of Object.values(brief))
      expect(
        screen.getByText(
          (_, node) =>
            node?.tagName === "P" && node.textContent?.endsWith(value) === true,
        ),
      ).toBeTruthy();
    expect(post).toHaveBeenCalledOnce();
  });
  it("keeps repository confirmation separate from running and prevents a blocked preview", async () => {
    state.repository = null;
    preview.ready = false;
    preview.issues = ["Approve the saved plan first."];
    write = async (path, body) => {
      if (path === `${base}/repository`) {
        expect(body).toEqual({
          path: "C:/new-repo",
          confirmed: true,
          mutationId: expect.any(String),
        });
        state.repository = { id: "repo", path: body.path };
        return copy(state);
      }
      return copy(preview);
    };
    await open();
    fireEvent.change(screen.getByLabelText("Repository folder"), {
      target: { value: "C:/new-repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use repository" }));
    await screen.findByText("C:/new-repo");
    await previewRun();
    expect(screen.getByText("Approve the saved plan first.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Run step" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      vi.mocked(post).mock.calls.some(([path]) => path === `${base}/runs`),
    ).toBe(false);
  });
  it("invalidates preview when model changes and when the saved plan revision changes", async () => {
    const view = await open();
    await previewRun();
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "fast" },
    });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Run preview" })).toBeNull(),
    );
    await previewRun();
    expect(post).toHaveBeenLastCalledWith(`${base}/preview`, {
      taskId: "task",
      selection: { mode: "explicit", model: "fast", reasoningEffort: "low" },
    });
    store.session = { ...store.session, revision: 4 };
    view.rerender(<ExecutionDialog taskId="task" onClose={vi.fn()} />);
    expect(
      (screen.getByRole("button", { name: "Run step" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/plan changed after this preview/)).toBeTruthy();
  });
  it("distinguishes agent claims from observed failures and keeps diffs inert", async () => {
    state.runs = [run];
    await open(true);
    expect(
      within(screen.getByRole("region", { name: "Agent report" })).getByText(
        "Agent says all tests passed",
      ),
    ).toBeTruthy();
    const commands = screen.getByRole("region", { name: "Observed commands" });
    expect(within(commands).getByText("Exit 1")).toBeTruthy();
    expect(
      within(commands).getByText(
        "Observed failing test <script>danger()</script>",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Finished", { selector: "span" })).toBeTruthy();
    expect(
      screen.getByText(
        "1 command failed. Review the observed output before accepting.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("succeeded", { exact: true })).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("+<script>inert()</script>")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
  it("shows reviewed executable mode changes even when file contents are unchanged", async () => {
    run.artifact!.files[0] = {
      ...run.artifact!.files[0],
      oldMode: "100644",
      newMode: "100755",
      patch: "",
    };
    state.runs = [run];
    await open(true);
    expect(screen.getByText("File mode: regular → executable")).toBeTruthy();
    expect(screen.getByText("No text diff available.")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
  it("accepts, completes through synchronized history, and separately confirms checkout apply", async () => {
    state.runs = [run];
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    write = async (path, body) => {
      if (path.endsWith("/accept")) {
        run.acceptedDigest = body.digest;
        return { run: copy(run) };
      }
      if (path.endsWith("/complete")) {
        expect(body.baseRevision).toBe(3);
        run.completedCursor = "completed";
        run.planStale = true;
        const project = copy(envelope);
        project.revision++;
        project.content.buildTasks![0].status = "done";
        project.history.push({
          id: "completed",
          label: "Complete task",
          content: copy(project.content),
        });
        project.cursor = "completed";
        return { run: copy(run), project };
      }
      if (path.endsWith("/apply")) {
        run.applied = true;
        return { run: copy(run) };
      }
      throw new Error(path);
    };
    await open(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Complete task",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Accept changes" }));
    await screen.findByRole("button", { name: "Changes accepted" });
    await settle();
    expect(store.synchronize).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Complete task" }));
    await screen.findByRole("button", { name: "Completion recorded" });
    await settle();
    expect(store.synchronize).toHaveBeenCalledOnce();
    expect(store.session.content.buildTasks![0].status).toBe("done");
    expect(
      (
        screen.getByRole("button", {
          name: "Apply to checkout",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Apply to checkout" }));
    await screen.findByRole("button", { name: "Applied to checkout" });
    expect(confirm).toHaveBeenCalledOnce();
    expect(post).toHaveBeenLastCalledWith(`${base}/runs/run/apply`, {
      mutationId: expect.any(String),
      digest: "result-digest",
      confirmed: true,
    });
    confirm.mockRestore();
  });
  it("requires explicit cancel and blocks accepting stale results", async () => {
    run.state = "running";
    run.artifact = null;
    state.runs = [run];
    write = async () => {
      run.state = "cancelled";
      return { run: copy(run) };
    };
    await open(true);
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    await screen.findByText("cancelled");
    expect(post).toHaveBeenCalledExactlyOnceWith(`${base}/runs/run/cancel`, {
      mutationId: expect.any(String),
    });
    run = {
      ...result(),
      planStale: true,
      applyPlanStale: true,
      acceptedDigest: "result-digest",
    };
    fireEvent.click(screen.getByRole("button", { name: "Check run status" }));
    await screen.findByText(/approved plan changed/);
    expect(
      (
        screen.getByRole("button", {
          name: "Complete task",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Apply to checkout",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe("uncertain execution recovery", () => {
  it("discovers a committed run after a lost start response without sending another request", async () => {
    write = async (path) => {
      if (path.endsWith("/preview")) return preview;
      state.runs = [run];
      throw new Error("Response lost");
    };
    await open();
    await previewRun();
    fireEvent.click(screen.getByRole("button", { name: "Run step" }));
    await screen.findByRole("region", { name: "Observed commands" });
    await settle();
    expect(
      vi.mocked(post).mock.calls.filter(([path]) => path === `${base}/runs`),
    ).toHaveLength(1);
    expect(readExecutionReceipt("project")).toBeNull();
    expect(screen.queryByText("Response lost")).toBeNull();
  });
  it("retains an unresolved start across reopening and retries only the identical reviewed request", async () => {
    write = async (path) => {
      if (path.endsWith("/preview")) return preview;
      throw new Error("Offline");
    };
    const view = await open();
    await previewRun();
    fireEvent.click(screen.getByRole("button", { name: "Run step" }));
    await screen.findByText("Offline");
    const original = readExecutionReceipt("project")!;
    expect(original.kind).toBe("start");
    view.unmount();
    await open();
    expect(
      vi.mocked(post).mock.calls.filter(([path]) => path === `${base}/runs`),
    ).toHaveLength(1);
    write = async () => ({ run });
    fireEvent.click(screen.getByRole("button", { name: "Retry run request" }));
    await screen.findByRole("region", { name: "Observed commands" });
    expect(post).toHaveBeenLastCalledWith(`${base}/runs`, original.body);
  });
  it("recovers the pending run for completion and preserves its original base revision on retry", async () => {
    run.acceptedDigest = "result-digest";
    state.runs = [run];
    const original = {
      kind: "complete" as const,
      runId: "run",
      body: {
        mutationId: "completion-receipt",
        digest: "result-digest",
        baseRevision: 2,
        confirmed: true as const,
      },
    };
    writeExecutionReceipt("project", original);
    write = async () => ({
      run: { ...run, completedCursor: "complete" },
      project: envelope,
    });
    render(<ExecutionDialog taskId="task" onClose={vi.fn()} />);
    await screen.findByRole("region", { name: "Observed commands" });
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry completion" }));
    await settle();
    expect(post).toHaveBeenCalledExactlyOnceWith(
      `${base}/runs/run/complete`,
      original.body,
    );
    expect(store.synchronize).toHaveBeenCalledOnce();
  });
  it("allows a new deliberate Apply only after the server confirms the exact earlier request wrote no files", async () => {
    run.acceptedDigest = "result-digest";
    state.runs = [run];
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let firstBody: unknown;
    write = async (_path, body) => {
      if (!firstBody) {
        firstBody = copy(body);
        throw new ApiError("Checkout file changed; no files written.", 409, {
          executionReceipt: { mutationId: body.mutationId, state: "failed" },
        });
      }
      return { run: { ...run, applied: true } };
    };
    await open(true);
    fireEvent.click(screen.getByRole("button", { name: "Apply to checkout" }));
    await screen.findByText("Checkout file changed; no files written.");
    await settle();
    expect(readExecutionReceipt("project")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry apply" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply to checkout" }));
    await screen.findByRole("button", { name: "Applied to checkout" });
    expect(vi.mocked(post).mock.calls[1][1]).not.toEqual(firstBody);
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });
  it.each([
    undefined,
    { executionReceipt: { mutationId: "unrelated-request", state: "failed" } },
  ])(
    "retains an uncertain Apply receipt when no matching terminal receipt is returned",
    async (data) => {
      run.acceptedDigest = "result-digest";
      state.runs = [run];
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      write = async () => {
        throw new ApiError("Apply confirmation unavailable", 409, data);
      };
      await open(true);
      fireEvent.click(
        screen.getByRole("button", { name: "Apply to checkout" }),
      );
      await screen.findByText("Apply confirmation unavailable");
      await settle();
      expect(readExecutionReceipt("project")?.kind).toBe("apply");
      expect(screen.getByRole("button", { name: "Retry apply" })).toBeTruthy();
      expect(
        (
          screen.getByRole("button", {
            name: "Apply to checkout",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      confirm.mockRestore();
    },
  );
  it("recovers Apply's server receipt after browser storage loss, with deliberate confirmation", async () => {
    run.acceptedDigest = "result-digest";
    run.applyState = {
      state: "applying",
      digest: "result-digest",
      updatedAt: timestamp,
      completed: [],
      fileCount: 1,
    };
    run.applyRequest = {
      mutationId: "durable-apply",
      digest: "result-digest",
      confirmed: true,
    };
    state.runs = [run];
    write = async () => ({
      run: {
        ...run,
        applied: true,
        applyState: { ...run.applyState!, state: "applied" },
      },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await open(true);
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry apply to checkout" }),
    );
    await settle();
    expect(post).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry apply to checkout" }),
    );
    await screen.findByRole("button", { name: "Applied to checkout" });
    expect(post).toHaveBeenCalledExactlyOnceWith(
      `${base}/runs/run/apply`,
      run.applyRequest,
    );
    confirm.mockRestore();
  });
});

describe("Build execution entry points", () => {
  it("opens a preview workspace without running and returns focus to its launcher", async () => {
    render(
      <BuildView selectedId="task" onSelect={vi.fn()} onRevealNode={vi.fn()} />,
    );
    const opener = screen.getByRole("button", { name: "Run step" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Run step" });
    await within(dialog).findByRole("region", { name: "Execution repository" });
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close dialog" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it("keeps previous run history accessible when the last task has been removed", async () => {
    store.session.content.buildTasks = [];
    state.runs = [run];
    render(
      <BuildView selectedId={null} onSelect={vi.fn()} onRevealNode={vi.fn()} />,
    );
    expect(
      (screen.getByRole("button", { name: "Run step" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Execution history" }));
    await screen.findByRole("region", { name: "Observed commands" });
    expect(post).not.toHaveBeenCalled();
  });
});

it("uses coding provider defaults independently and invalidates a preview when provider changes", async () => {
  updateAgentPreference("planning", "openai", {
    provider: "openai",
    mode: "explicit",
    model: "planning-only",
    reasoningEffort: null,
  });
  updateAgentPreference("coding", "ollama", {
    provider: "ollama",
    mode: "explicit",
    model: "local-coder",
    reasoningEffort: null,
  });
  state.agent.available = false;
  const originalRead = read;
  read = async (path) =>
    path.startsWith("/agent/status")
      ? { agent: { available: true, label: "Ollama" } }
      : path.includes("provider=ollama")
        ? {
            status: "ready",
            provider: "ollama",
            source: "ollama",
            cliVersion: null,
            fetchedAt: null,
            models: [
              {
                id: "local-coder",
                label: "Local coder",
                description: "",
                defaultReasoningEffort: null,
                reasoningEfforts: [],
                isDefault: true,
                capabilities: { tools: true },
              },
            ],
          }
        : originalRead(path);
  await open();
  await screen.findByRole("option", { name: "Local coder" });
  expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe(
    "ollama",
  );
  await previewRun();
  expect(post).toHaveBeenCalledWith(`${base}/preview`, {
    taskId: "task",
    selection: {
      provider: "ollama",
      mode: "explicit",
      model: "local-coder",
      reasoningEffort: null,
    },
  });
  fireEvent.change(screen.getByLabelText("Provider"), {
    target: { value: "codex" },
  });
  expect(screen.queryByRole("region", { name: "Run preview" })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Run step" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("answers a paused run explicitly and retries the same frozen continuation after a lost acknowledgement", async () => {
  run.state = "interrupted";
  run.question = {
    id: "question-set",
    createdAt: timestamp,
    questions: [
      {
        id: "storage",
        kind: "choice",
        prompt: "Which storage?",
        options: [
          { id: "sqlite", label: "SQLite", description: "Local database" },
          { id: "json", label: "JSON", description: "Local file" },
        ],
        recommendedOptionId: "sqlite",
      },
    ],
  };
  run.context.generation = {
    selection: {
      provider: "ollama",
      mode: "explicit",
      model: "original-coder",
      reasoningEffort: null,
    },
    cliVersion: null,
    instructionVersion: "test",
    instructionHash: "hash",
    protocolVersion: 1,
  };
  state.runs = [run];
  let attempts = 0;
  write = async (path, body) => {
    if (path === `${base}/runs/run/answer`) {
      if (++attempts === 1)
        throw new Error("Continuation acknowledgement lost");
      run.question = null;
      run.state = "running";
      return { run: copy(run) };
    }
    throw new Error(`Unexpected write ${path}`);
  };
  const view = await open(true);
  expect(post).not.toHaveBeenCalled();
  for (const label of ["Accept changes", "Complete task", "Apply to checkout"])
    expect(
      (screen.getByRole("button", { name: label }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText("Continuation acknowledgement lost");
  const captured = vi.mocked(post).mock.calls[0][1];
  expect(captured).toMatchObject({
    questionId: "question-set",
    digest: "result-digest",
    confirmed: true,
    answers: [{ questionId: "storage", optionId: "sqlite", text: null }],
  });
  expect(captured).not.toHaveProperty("selection");
  view.unmount();
  updateAgentPreference("coding", "openai", {
    provider: "openai",
    mode: "explicit",
    model: "different-coder",
    reasoningEffort: null,
  });
  await open(true);
  expect(attempts).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry answer" }));
  await waitFor(() => expect(attempts).toBe(2));
  expect(vi.mocked(post).mock.calls[1][1]).toEqual(captured);
  expect(
    screen.queryByRole("region", { name: "Execution questions" }),
  ).toBeNull();
});

it("discovers a durable question continuation after restart without sending it automatically", async () => {
  run.state = "interrupted";
  const body = {
    mutationId: "frozen-answer",
    questionId: "pending",
    answers: [{ questionId: "q", optionId: null, text: "Keep local files" }],
    digest: "result-digest",
    confirmed: true as const,
  };
  run.question = {
    id: "pending",
    createdAt: timestamp,
    questions: [
      {
        id: "q",
        kind: "text",
        prompt: "Which files?",
        options: [],
        recommendedOptionId: null,
      },
    ],
    answerRequest: body,
  };
  state.runs = [run];
  write = async (path, value) => {
    expect(path).toBe(`${base}/runs/run/answer`);
    expect(value).toEqual(body);
    run.question = null;
    run.state = "running";
    return { run: copy(run) };
  };
  await open(true);
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry continuation" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledExactlyOnceWith(
      `${base}/runs/run/answer`,
      body,
    ),
  );
});

it("shows the frozen command restrictions and reported usage independently of agent claims", async () => {
  run.context.generation = {
    provider: "ollama",
    selection: {
      provider: "ollama",
      mode: "explicit",
      model: "local-coder",
      reasoningEffort: null,
    },
    cliVersion: null,
    instructionVersion: "coding-v1",
    instructionHash: "hash",
    protocolVersion: 4,
    commandPolicy: {
      version: "docker-tmpfs-v1",
      available: true,
      imageLabel: "reviewed-image:1",
      imageId: "sha256:fixed",
      network: "none",
      maxSeconds: 120,
      memoryBytes: 536870912,
      workspaceBytes: 167772160,
      pids: 64,
    },
  };
  run.events = [
    {
      type: "usage",
      provider: "ollama",
      turn: 2,
      usage: { prompt_eval_count: 200, eval_count: 40 },
      at: timestamp,
    },
  ];
  state.runs = [run];
  await open(true);
  expect(screen.getByText("reviewed-image:1")).toBeTruthy();
  expect(screen.getByText(/network access disabled/)).toBeTruthy();
  expect(screen.getByText("512 MiB")).toBeTruthy();
  const usage = screen.getByRole("region", { name: "Reported model usage" });
  expect(within(usage).getByText("200")).toBeTruthy();
  expect(within(usage).getByText("prompt eval count")).toBeTruthy();
  expect(within(usage).getByText(/No cost is inferred/)).toBeTruthy();
  expect(screen.getByText(/^1 command failed\./)).toBeTruthy();
});
it("does not imply command checks ran when the frozen sandbox is unavailable", async () => {
  run.context.generation = {
    selection: {
      provider: "openai",
      mode: "explicit",
      model: "cloud-coder",
      reasoningEffort: null,
    },
    cliVersion: null,
    instructionVersion: "coding-v1",
    instructionHash: "hash",
    protocolVersion: 4,
    commandPolicy: {
      version: "docker-tmpfs-v1",
      available: false,
      reason: "A verified image is required.",
    },
  };
  run.commands = [];
  state.runs = [run];
  await open(true);
  expect(screen.getByText("Command checks unavailable.")).toBeTruthy();
  expect(screen.getByText("A verified image is required.")).toBeTruthy();
  expect(screen.getByText("No command results recorded.")).toBeTruthy();
  expect(screen.getByText("No usage reported by the provider.")).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
});
