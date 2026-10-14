import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TaskHandoffPanel from "./TaskHandoffPanel";
import { api, post, downloadBlob } from "./api";
import { useProject } from "./store";

vi.mock("./api", () => ({ api: vi.fn(), post: vi.fn(), downloadBlob: vi.fn() }));
vi.mock("./store", () => ({ useProject: vi.fn() }));
const flush = vi.fn();
const exported = { manifest: { schema: "planbranch.task-handoff.v1", handoffId: "handoff", taskId: "task", contentHash: "hash", baseCommit: "base", sourceIncluded: false, expectedReturn: { schema: "planbranch.external-result.v1", candidateCommit: "REPLACE" } }, markdown: "# Approved implementation brief" };
const result = { id: "returned", handoffId: "handoff", origin: "external", verificationState: "External result reported", baseCommit: "base", candidateCommit: "candidate", contentHash: "resultHash", compatibilityIssues: [], report: { origin: "host", html: "<script>alert('untrusted')</script>" }, reportTrust: "Untrusted external claims; no local checks were performed.", files: [{ path: "main.py", diff: "+ value = 2", binary: false }], reviews: [] };
beforeEach(() => {
  vi.clearAllMocks(); flush.mockResolvedValue(true);
  vi.mocked(useProject).mockReturnValue({ session: { id: "project", revision: 7 }, commit: vi.fn(), flush, getSnapshot: () => ({ revision: 7 }) } as unknown as ReturnType<typeof useProject>);
  vi.mocked(api).mockResolvedValue({ handoffs: [], results: [] });
  vi.mocked(post).mockResolvedValue(exported);
});
afterEach(cleanup);

it("previews a source-free concrete package before export", async () => {
  render(<TaskHandoffPanel taskId="task" />);
  fireEvent.click(screen.getByText("Use an external coding agent"));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Preview implementation handoff" }));
  expect(await screen.findByText(/No repository source included/)).toBeTruthy();
  expect(post).toHaveBeenCalledWith("/projects/project/handoffs", { taskId: "task", baseRevision: 7, supportingContext: "" });
  expect(downloadBlob).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Export handoff JSON" }));
  expect(downloadBlob).toHaveBeenCalledOnce();
});

it("renders forged external HTML as text and preflights explicit local execution", async () => {
  vi.mocked(api).mockResolvedValue({ handoffs: [], results: [result] });
  vi.mocked(post).mockResolvedValue({ candidateCommit: "candidate" });
  const onRun = vi.fn();
  render(<TaskHandoffPanel taskId="task" onRun={onRun} />);
  expect(await screen.findByText("External result reported")).toBeTruthy();
  fireEvent.click(screen.getByText("External test report · untrusted content"));
  expect(screen.getByText(/<script>/)).toBeTruthy();
  expect(document.querySelector("script")).toBeNull();
  expect(onRun).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Preview authorized local execution" }));
  await waitFor(() => expect(onRun).toHaveBeenCalledOnce());
  expect(post).toHaveBeenCalledWith("/projects/project/external-results/returned/prepare-run", { contentHash: "resultHash" });
});

it("keeps errors visible and prevents stale external acceptance", async () => {
  vi.mocked(api).mockResolvedValue({ handoffs: [], results: [{ ...result, compatibilityIssues: ["Task scope changed"] }] });
  render(<TaskHandoffPanel taskId="task" />);
  await screen.findByText("External result reported");
  fireEvent.change(screen.getByLabelText("Human review note"), { target: { value: "Read carefully" } });
  expect(screen.getByRole("button", { name: "Record accepted review" })).toHaveProperty("disabled", true);
  vi.mocked(post).mockRejectedValue(new Error("Review service unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Review service unavailable");
});
