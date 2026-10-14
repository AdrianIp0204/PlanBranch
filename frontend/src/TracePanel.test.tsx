import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import TracePanel from "./TracePanel";
import TaskWorkflowSummary from "./TaskWorkflowSummary";
import { api, post } from "./api";
import { useProject } from "./store";

vi.mock("./api", () => ({ api: vi.fn(), post: vi.fn(), download: vi.fn() }));
vi.mock("./store", () => ({ useProject: vi.fn() }));
const trace = () => ({
  taskTitle: "Validate input",
  requirement: {
    id: "requirement",
    text: "Reject invalid input",
    meaningHash: "requirement-meaning",
  },
  diagramLinks: [
    { nodeId: "node", diagramId: "diagram", title: "Validate", missing: false },
  ],
  criteria: [
    {
      id: "criterion",
      text: "Unknown command is rejected",
      meaningHash: "criterion-meaning",
      verificationState: "not_verified",
      reviews: [],
    },
  ],
  files: [
    {
      path: "main.py",
      kind: "modified",
      fileHash: "file-bytes",
      candidateHash: "candidate",
      baseRevision: "base",
    },
  ],
  runs: [],
  uncertainty: "A passing command supports only the behavior it checks.",
  run: {
    id: "run",
    taskId: "task",
    state: "succeeded",
    sourceCommit: "base",
    candidate: { sha256: "candidate" },
    candidateStale: false,
    planStale: false,
    commands: [
      {
        id: "command",
        command: "pytest",
        verificationState: "external_result_reported",
        output: "<script>malicious()</script>",
        status: "completed",
        exitCode: 0,
      },
    ],
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useProject).mockReturnValue({
    session: { id: "project", revision: 2 },
    commit: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as never);
  vi.mocked(api).mockResolvedValue(trace());
});
afterEach(cleanup);

describe("requirement to candidate evidence", () => {
  it("loads on request, links the diagram and keeps executor prose untrusted", async () => {
    const reveal = vi.fn();
    render(<TracePanel taskId="task" onRevealNode={reveal} />);
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByText("Requirement, code and acceptance evidence"),
    );
    await screen.findByText("Reject invalid input");
    expect(
      screen.getByText(/External result reported/, { selector: "summary" }),
    ).toBeTruthy();
    expect(screen.getByText(/Not verified/)).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    expect(reveal).toHaveBeenCalledWith("diagram", "node");
  });

  it("records an explicit human mapping for exact candidate and criterion without accepting code", async () => {
    vi.mocked(post).mockResolvedValue(trace());
    render(<TracePanel taskId="task" runId="run" />);
    fireEvent.click(
      screen.getByText("Requirement, code and acceptance evidence"),
    );
    await screen.findByText("Reject invalid input");
    fireEvent.click(
      screen.getByText("Record criterion review and associations"),
    );
    fireEvent.change(screen.getByLabelText("Acceptance criterion"), {
      target: { value: "criterion" },
    });
    fireEvent.change(screen.getByLabelText("Supporting command"), {
      target: { value: "command" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "main.py" }));
    fireEvent.change(
      screen.getByLabelText("What you checked, and what remains uncertain"),
      { target: { value: "Read the negative cases; no performance checks." } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm human review" }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith(
      "/projects/project/tasks/task/traceability/reviews",
      expect.objectContaining({
        candidateHash: "candidate",
        criterionHash: "criterion-meaning",
        requirementHash: "requirement-meaning",
        commandId: "command",
        filePaths: ["main.py"],
        confirmed: true,
      }),
    );
  });

  it("blocks review when current code no longer matches the captured diff", async () => {
    const value = trace();
    value.run.candidateStale = true;
    vi.mocked(api).mockResolvedValue(value);
    render(<TracePanel taskId="task" />);
    fireEvent.click(
      screen.getByText("Requirement, code and acceptance evidence"),
    );
    await screen.findByText(/current candidate differs from the captured diff/);
    fireEvent.click(
      screen.getByText("Record criterion review and associations"),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Confirm human review",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

it("gives a next action and a direct prerequisite link without treating approval as execution", async () => {
  vi.mocked(api).mockResolvedValue({
    stage: "Plan",
    nextAction: "Complete Database first.",
    action: "prerequisite",
    approvalCurrent: true,
    blockers: [{ code: "prerequisite_incomplete", taskId: "database", message: "Database still needs its reviewed completion.", action: "open_task", actionLabel: "Open Database prerequisite" }],
    boundaryNote: "Approval and execution authorization are separate.",
  });
  const select = vi.fn(),
    run = vi.fn();
  render(
    <TaskWorkflowSummary
      taskId="task"
      refreshKey={false}
      onRun={run}
      onReview={vi.fn()}
      onSelect={select}
    />,
  );
  await screen.findByText("Complete Database first.");
  fireEvent.click(
    screen.getByRole("button", { name: "Open Database prerequisite" }),
  );
  expect(select).toHaveBeenCalledWith("database");
  expect(run).not.toHaveBeenCalled();
});
