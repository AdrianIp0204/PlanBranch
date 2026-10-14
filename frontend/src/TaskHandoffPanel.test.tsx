import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import TaskHandoffPanel from "./TaskHandoffPanel";
import { api, ApiError, post, downloadBlob } from "./api";
import { useProject } from "./store";

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
afterEach(cleanup);

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
  await screen.findByText("Local verification: succeeded");
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
