import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { api } from "./api";
import { OperationTracker, describeOperation, deliverOptionalNotification, desktopNotificationPermission, requestDesktopNotificationPermission, useOperationNotifications, type OperationStatus } from "./operationNotifications";
import ActivityNotices from "./ActivityNotices";
vi.mock("./api", () => ({ api: vi.fn() }));
vi.mock("./preferences", () => ({ usePreferences: () => ({ preferences: { sound: false, desktop: false } }) }));
const operation = (id: string, state: string, extra: Partial<OperationStatus> = {}): OperationStatus => ({ kind: "planning", id, state, createdAt: new Date(1000).toISOString(), ...extra });
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("operation notification ledger", () => {
  it("silences historical results, sees fast completions, and deduplicates outcomes across remounts and tabs", () => {
    const first = new OperationTracker("p", 10000);
    expect(first.observe([operation("old", "succeeded")])).toEqual([]);
    expect(first.observe([operation("fast", "succeeded")])).toHaveLength(1);
    expect(first.observe([operation("fast", "succeeded")])).toEqual([]);
    const reopened = new OperationTracker("p", 20000);
    expect(reopened.observe([operation("fast", "succeeded"), operation("old", "succeeded")])).toEqual([]);
    expect(first.observe([operation("active", "running")])).toEqual([]);
    const secondTab = new OperationTracker("p", 20000);
    secondTab.observe([operation("active", "running")]);
    expect(first.observe([operation("active", "failed")])).toHaveLength(1);
    expect(secondTab.observe([operation("active", "failed")])).toEqual([]);
    first.observe([operation("active", "running")]);
    expect(first.observe([operation("active", "failed")])).toEqual([]);
    first.observe([operation("active", "running")]);
    expect(first.observe([operation("active", "succeeded")])).toHaveLength(1);
  });
  it("recovers an observed running operation across restart and catches one started during the initial poll", () => {
    new OperationTracker("p", 10000).observe([operation("running", "running")]);
    const restarted = new OperationTracker("p", 20000);
    expect(restarted.observe([operation("running", "succeeded")])).toHaveLength(1);
    const fresh = new OperationTracker("new", 10000);
    expect(fresh.observe([operation("fast", "succeeded", { createdAt: new Date(12000).toISOString() })])).toHaveLength(1);
    expect(new OperationTracker("other", 20000).observe([operation("fast", "succeeded")])).toEqual([]);
  });
  it("keeps live deduplication when storage is unavailable and never treats an unknown state as failure", () => {
    const denied = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
    const tracker = new OperationTracker("p", 10000, denied);
    tracker.observe([]);
    expect(tracker.observe([operation("unknown", "future-state")])).toEqual([]);
    expect(tracker.observe([operation("done", "succeeded")])).toHaveLength(1);
    expect(tracker.observe([operation("done", "succeeded")])).toEqual([]);
  });
  it("reports questions, review, partial evidence, cancellation, and failure without claiming test success", () => {
    expect(describeOperation(operation("p", "succeeded", { needsInput: true })).title).toBe("Codex needs your answer");
    expect(describeOperation(operation("p", "succeeded", { messageId: "exact-reply" })).target).toEqual({ kind: "planning", id: "p", messageId: "exact-reply" });
    expect(describeOperation(operation("p", "succeeded", { needsReview: true })).title).toBe("Plan changes ready for review");
    expect(describeOperation(operation("s", "partial", { kind: "scan" })).severity).toBe("warning");
    expect(describeOperation(operation("s", "completed", { kind: "scan", hasIssues: true })).detail).toContain("stale");
    for (const state of ["failed", "cancelled", "interrupted", "succeeded"]) {
      const notice = describeOperation(operation("e", state, { kind: "execution", taskId: "task", taskTitle: "Parse commands" }));
      expect(notice.target).toEqual({ kind: "execution", id: "e", taskId: "task" });
      expect(notice.title + notice.detail).not.toMatch(/tests? passed|task complete|successfully/i);
      expect(notice.title).toContain(state === "succeeded" ? "ready for review" : state);
    }
  });
});

describe("optional browser delivery", () => {
  it("never requests permission automatically and gracefully handles denial and unsupported browsers", async () => {
    const construct = vi.fn(), request = vi.fn(async () => "denied" as const);
    class DeniedNotification { static permission = "denied"; static requestPermission = request; constructor() { construct(); } }
    vi.stubGlobal("Notification", DeniedNotification);
    const notice = describeOperation(operation("p", "succeeded"));
    deliverOptionalNotification(notice, { sound: false, desktop: true }, vi.fn());
    expect(construct).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    expect(await requestDesktopNotificationPermission()).toBe("denied");
    expect(request).toHaveBeenCalledTimes(1);
    vi.stubGlobal("Notification", undefined);
    expect(desktopNotificationPermission()).toBe("unsupported");
    expect(await requestDesktopNotificationPermission()).toBe("unsupported");
  });
  it("uses opt-in and an operation tag for desktop delivery, with no automatic request", () => {
    const construct = vi.fn();
    class GrantedNotification { static permission = "granted"; static requestPermission = vi.fn(); constructor(...args: unknown[]) { construct(...args); } }
    vi.stubGlobal("Notification", GrantedNotification);
    const notice = describeOperation(operation("p", "succeeded"));
    deliverOptionalNotification(notice, { sound: false, desktop: false }, vi.fn());
    expect(construct).not.toHaveBeenCalled();
    deliverOptionalNotification(notice, { sound: false, desktop: true }, vi.fn());
    expect(construct).toHaveBeenCalledExactlyOnceWith(notice.title, { body: notice.detail, tag: notice.id, silent: true });
    expect(GrantedNotification.requestPermission).not.toHaveBeenCalled();
  });
});

describe("quiet activity UI and polling", () => {
  it("does not steal typing focus and navigation stays explicit", () => {
    const notice = describeOperation(operation("p", "succeeded"));
    const open = vi.fn(), dismiss = vi.fn();
    const { rerender } = render(<><input aria-label="Draft" /><ActivityNotices notices={[]} open={open} dismiss={dismiss} /></>);
    const input = screen.getByLabelText("Draft"); input.focus();
    rerender(<><input aria-label="Draft" /><ActivityNotices notices={[notice]} open={open} dismiss={dismiss} /></>);
    expect(document.activeElement).toBe(input);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Codex replied" }));
    expect(open).toHaveBeenCalledExactlyOnceWith(notice);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Codex replied" }));
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(notice.id);
    expect(document.activeElement).toBe(input);
  });
  it("ignores a failed poll, then delivers a terminal result once and keeps navigation errors actionable", async () => {
    vi.useFakeTimers();
    vi.mocked(api).mockResolvedValueOnce({ operations: [operation("p", "running")] }).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ operations: [operation("p", "failed")] });
    const navigate = vi.fn(async () => { throw new Error("Save failed; draft retained."); });
    const { result } = renderHook(() => useOperationNotifications("project", navigate));
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current.notices).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(result.current.notices).toHaveLength(1);
    await act(async () => { await result.current.open(result.current.notices[0]); });
    expect(result.current.notices[0].navigationError).toContain("Save failed");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current.notices).toHaveLength(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
