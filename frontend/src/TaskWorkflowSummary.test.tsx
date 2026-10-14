import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TaskWorkflowSummary from "./TaskWorkflowSummary";
import { api } from "./api";
import { useProject } from "./store";

vi.mock("./api", () => ({ api: vi.fn() }));
vi.mock("./store", () => ({ useProject: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useProject).mockReturnValue({ session: { id: "project", revision: 1 } } as ReturnType<typeof useProject>);
});
afterEach(cleanup);

it.each(["review_result", "finish_task", "apply_changes", "commit_changes", "refresh_evidence"])("routes %s to the exact prerequisite result without running it", async (action) => {
  vi.mocked(api).mockResolvedValue({ stage: "Prerequisites need attention", action: "prerequisite", approvalCurrent: true,
    nextAction: "The prerequisite needs attention.", boundaryNote: "Separate decisions.",
    blockers: [{ code: "prerequisite_apply_required", taskId: "prerequisite", runId: "recorded-run", action,
      actionLabel: "Open prerequisite correction", message: "Apply the accepted prerequisite changes first." }] });
  const onRun = vi.fn(), onReview = vi.fn(), onSelect = vi.fn();
  render(<TaskWorkflowSummary taskId="dependent" refreshKey={false} onRun={onRun} onReview={onReview} onSelect={onSelect} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open prerequisite correction" }));
  expect(onReview).toHaveBeenCalledWith("prerequisite", "recorded-run");
  expect(onRun).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Review run authorization" })).toBeNull();
});

it("opens a manually completed prerequisite task to correct its progress", async () => {
  vi.mocked(api).mockResolvedValue({ stage: "Prerequisites need attention", action: "prerequisite", approvalCurrent: true,
    nextAction: "Done without evidence.", boundaryNote: "Separate decisions.",
    blockers: [{ code: "prerequisite_no_result", taskId: "prerequisite", action: "open_task",
      actionLabel: "Open prerequisite task", message: "Reopen and review an authorized result." }] });
  const onSelect = vi.fn();
  render(<TaskWorkflowSummary taskId="dependent" refreshKey={false} onRun={vi.fn()} onReview={vi.fn()} onSelect={onSelect} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open prerequisite task" }));
  expect(onSelect).toHaveBeenCalledWith("prerequisite");
});
