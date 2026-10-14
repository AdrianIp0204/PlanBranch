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
const content = { buildTasks: [{ id: "task", title: "Build storage" }], diagrams: [{ id: "diagram", name: "Import records", nodes: [{ id: "node", title: "Validate records" }], edges: [{ id: "edge", label: "Valid input" }] }] };
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.open = false; } });
  flush.mockResolvedValue(true);
  synchronize.mockImplementation(async (request) => request({ id: "project", revision: 7 }));
  vi.mocked(useProject).mockReturnValue({ session: { id: "project", revision: 7, content }, commit: vi.fn(), flush, synchronize } as unknown as ReturnType<typeof useProject>);
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

it.each([
  ["Tasks, dependencies and acceptance criteria", "/tasks/task/title", "Open task: Build storage", { kind: "task", id: "task" }],
  ["Diagram elements and relationships", "/diagram/nodes/node/blocker", "Open node: Validate records", { kind: "node", id: "node", diagramId: "diagram" }],
  ["Diagram elements and relationships", "/diagram/edges/edge/label", "Open connection: Valid input", { kind: "edge", id: "edge", diagramId: "diagram" }],
  ["Diagram elements and relationships", "/diagram/name", "Open diagram: Import records", { kind: "diagram", id: "diagram", diagramId: "diagram" }],
])("opens the existing entity from a changed %s field without altering the plan", async (section, path, label, target) => {
  vi.mocked(api).mockImplementation(async (url) => String(url).endsWith("/compare") ? {
    scopeVersion: 1, changes: [{ section, before: { fullSection: "saved data" }, after: { fullSection: "current data" }, fields: [{ path, label: "Changed field", kind: "changed", before: "Old", after: "New" }] }],
  } : state);
  const onNavigate = vi.fn(), onClose = vi.fn();
  render(<PlanLibrary onClose={onClose} onNavigate={onNavigate} />);
  await screen.findByText("Offline");
  fireEvent.click(screen.getAllByRole("button", { name: "Compare with current" })[0]);
  const button = await screen.findByRole("button", { name: String(label) });
  const raw = screen.getByText(`Raw comparison data: ${section}`).closest("details")!;
  expect(raw.open).toBe(false);
  expect(raw.textContent).toContain('"fullSection": "saved data"');
  expect(raw.textContent).toContain('"fullSection": "current data"');
  fireEvent.click(button);
  expect(onNavigate).toHaveBeenCalledWith(target);
  expect(onClose).toHaveBeenCalledOnce();
  expect(post).not.toHaveBeenCalled();
});

it("keeps removed entity values visible without offering a dead navigation link", async () => {
  vi.mocked(api).mockImplementation(async (url) => String(url).endsWith("/compare") ? {
    scopeVersion: 1, changes: [{ section: "Diagram elements and relationships", before: [], after: [], fields: [{ path: "/diagram/nodes/removed/title", label: "Removed node → Title", kind: "removed", before: "Historic design", after: null }] }],
  } : state);
  render(<PlanLibrary onClose={vi.fn()} onNavigate={vi.fn()} />);
  await screen.findByText("Offline");
  fireEvent.click(screen.getAllByRole("button", { name: "Compare with current" })[0]);
  expect(await screen.findByText("Historic design")).toBeTruthy();
  expect(screen.getByText(/This node is not in the selected plan/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Open node/ })).toBeNull();
});
