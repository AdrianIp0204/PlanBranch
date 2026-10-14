import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PlanLibrary from "./PlanLibrary";
import { api, post } from "./api";
import { useProject } from "./store";

vi.mock("./api", () => ({ api: vi.fn(), post: vi.fn() }));
vi.mock("./store", () => ({ useProject: vi.fn() }));
const state = { selectedAlternativeId: "baseline", epoch: 0, alternatives: [{ id: "baseline", name: "Original", snapshotId: "one", parentId: null }, { id: "alternate", name: "Offline", snapshotId: "two", parentId: "baseline" }], snapshots: [], decisions: [] };
const flush = vi.fn();
const synchronize = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.open = false; } });
  flush.mockResolvedValue(true);
  synchronize.mockImplementation(async (request) => request({ id: "project", revision: 7 }));
  vi.mocked(useProject).mockReturnValue({ session: { id: "project", revision: 7 }, commit: vi.fn(), flush, synchronize } as unknown as ReturnType<typeof useProject>);
  vi.mocked(api).mockResolvedValue(state);
  vi.mocked(post).mockResolvedValue({ project: { id: "project", revision: 8 } });
});
afterEach(cleanup);

it("saves current work through the save queue before preserving or selecting alternatives", async () => {
  render(<PlanLibrary onClose={vi.fn()} />);
  await screen.findByText("Offline");
  fireEvent.change(screen.getByLabelText("Checkpoint or alternative name"), { target: { value: "Baseline checkpoint" } });
  fireEvent.click(screen.getByRole("button", { name: "Save named checkpoint" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/project/plans/checkpoint", expect.objectContaining({ baseRevision: 7, name: "Baseline checkpoint" })));
  expect(synchronize).toHaveBeenCalledOnce();
  await screen.findByText("Named checkpoint saved.");
  fireEvent.click(screen.getAllByRole("button", { name: "Select alternative" })[1]);
  await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/project/plans/select", expect.objectContaining({ targetId: "alternate" })));
  expect(await screen.findByText(/previous work is saved as a recovery checkpoint/)).toBeTruthy();
});

it("does not compare unsaved conflicted work", async () => {
  flush.mockResolvedValue(false);
  render(<PlanLibrary onClose={vi.fn()} />);
  await screen.findByText("Offline");
  fireEvent.click(screen.getAllByRole("button", { name: "Compare with current" })[0]);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Save or recover your current work before comparing plans.");
  expect(api).toHaveBeenCalledTimes(1);
});

it("shows readable changed fields under the approval semantics and keeps historical references separate", async () => {
  vi.mocked(api).mockImplementation(async (path) => String(path).endsWith("/compare") ? {
    scopeVersion: 1, beforeHash: "before", afterHash: "after", snapshotId: "one",
    changes: [{ section: "Project name and notes", fields: [{ path: "/name", label: "Name", kind: "changed", before: "Offline importer", after: "Private importer" }] },
      { section: "Diagram elements and relationships", fields: [{ path: "/diagram/nodes/node/blocker", label: "Nodes → Validate records → Blocker", kind: "changed", before: "", after: "<script>blocked()</script>" }] }],
    historyChanges: [{ section: "Repository inspection reference history", before: [], after: [{ revision: "historical" }] }],
  } : state);
  render(<PlanLibrary onClose={vi.fn()} />);
  await screen.findByText("Offline");
  fireEvent.click(screen.getAllByRole("button", { name: "Compare with current" })[0]);
  expect(await screen.findByText("Private importer")).toBeTruthy();
  expect(screen.getByText("Nodes → Validate records → Blocker")).toBeTruthy();
  expect(screen.getByText("<script>blocked()</script>").tagName).toBe("DD");
  expect(document.querySelector(".plan-field-change pre")).toBeNull();
  expect(screen.getByText(/Repository inspection history changed · outside intent approval/)).toBeTruthy();
});
