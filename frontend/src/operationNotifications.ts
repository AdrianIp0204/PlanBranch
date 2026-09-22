import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { usePreferences } from "./preferences";

export type OperationKind = "planning" | "scan" | "execution";
export type OperationTarget = { kind: OperationKind; id: string; taskId?: string; messageId?: string };
export type OperationStatus = OperationTarget & {
  state: string;
  createdAt?: string | null;
  taskTitle?: string | null;
  needsInput?: boolean;
  needsReview?: boolean;
  hasIssues?: boolean;
};
export type OperationNotice = {
  id: string;
  target: OperationTarget;
  title: string;
  detail: string;
  severity: "info" | "warning" | "error";
  navigationError?: string;
};
type Observed = { state: string; notified: string[] };
type Ledger = Record<string, Observed>;
type LedgerStorage = Pick<Storage, "getItem" | "setItem">;
const activeStates = new Set(["queued", "pending", "running", "scanning", "cancelling"]);
const terminalStates = new Set(["succeeded", "completed", "partial", "failed", "cancelled", "interrupted"]);
export const notificationLedgerKey = (projectId: string) => `planbranch.notifications.v1.${projectId}`;
const operationKey = (operation: OperationTarget) => `${operation.kind}:${operation.id}`;

function readLedger(storage: LedgerStorage | null, key: string): Ledger {
  const ledger: Ledger = {};
  try {
    const saved = JSON.parse(storage?.getItem(key) ?? "null");
    if (saved?.version !== 1 || !Array.isArray(saved.entries)) return ledger;
    for (const entry of saved.entries.slice(-1000)) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, value] = entry;
      if (typeof id !== "string" || id.length > 250 || !/^(planning|scan|execution):/.test(id) || typeof value?.state !== "string" || !Array.isArray(value.notified)) continue;
      ledger[id] = { state: value.state, notified: value.notified.filter((state: unknown): state is string => typeof state === "string" && terminalStates.has(state)) };
    }
  } catch { /* A quiet in-memory ledger still avoids repeated delivery in this window. */ }
  return ledger;
}
function browserStorage(): LedgerStorage | null {
  try { return window.localStorage; } catch { return null; }
}
export function describeOperation(operation: OperationStatus): OperationNotice {
  const target: OperationTarget = { kind: operation.kind, id: operation.id, ...(operation.taskId ? { taskId: operation.taskId } : {}), ...(operation.messageId ? { messageId: operation.messageId } : {}) };
  let title: string, detail: string, severity: OperationNotice["severity"] = "info";
  if (operation.kind === "planning") {
    title = operation.needsInput ? "Codex needs your answer" : operation.needsReview ? "Plan changes ready for review" : "Codex replied";
    detail = operation.needsInput ? "Open the planning questions to continue." : "Open planning chat to review the response.";
  } else if (operation.kind === "scan") {
    title = "Python scan finished";
    detail = "Review the detected symbols.";
    if (operation.hasIssues || operation.state === "partial") {
      title = "Python scan finished with issues";
      detail = "Review skipped files and scan errors. Unchecked evidence remains stale.";
      severity = "warning";
    }
  } else {
    title = "Coding step ready for review";
    detail = `${operation.taskTitle ? operation.taskTitle + " · " : ""}Review changes and recorded checks.`;
  }
  if (["failed", "cancelled", "interrupted"].includes(operation.state)) {
    const label = operation.kind === "planning" ? "Planning" : operation.kind === "scan" ? "Python scan" : "Coding step";
    title = `${label} ${operation.state}`;
    detail = operation.kind === "execution" ? "Open run details and any preserved work." : operation.kind === "scan" ? "Open scan results. Unchecked evidence remains stale." : "Open chat for recovery options.";
    severity = operation.state === "failed" ? "error" : "warning";
  }
  return { id: `${operationKey(operation)}:${operation.state}`, target, title, detail, severity };
}

/** Historical terminal rows form a silent baseline. Fresh rows and observed
 * active→terminal transitions notify once per operation/outcome, including retries. */
export class OperationTracker {
  private ledger: Ledger;
  private initialized = false;
  private readonly key: string;
  constructor(projectId: string, private readonly mountedAt = Date.now(), private readonly storage = browserStorage()) {
    this.key = notificationLedgerKey(projectId);
    this.ledger = readLedger(storage, this.key);
  }
  observe(operations: OperationStatus[]): OperationNotice[] {
    const shared = readLedger(this.storage, this.key);
    const notices: OperationNotice[] = [];
    for (const operation of operations) {
      if (!operation || !["planning", "scan", "execution"].includes(operation.kind) || typeof operation.id !== "string" || !operation.id || typeof operation.state !== "string") continue;
      const key = operationKey(operation);
      const previous = this.ledger[key] ?? shared[key];
      const notified = new Set([...(previous?.notified ?? []), ...(shared[key]?.notified ?? [])]);
      if (terminalStates.has(operation.state) && !notified.has(operation.state)) {
        // A request started after mounting may finish before the first poll returns.
        const beganHere = !!operation.createdAt && Date.parse(operation.createdAt) >= this.mountedAt;
        if (this.initialized || (previous && activeStates.has(previous.state)) || beganHere) notices.push(describeOperation(operation));
        notified.add(operation.state);
      }
      this.ledger[key] = { state: operation.state, notified: [...notified] };
    }
    this.initialized = true;
    const combined = { ...shared, ...this.ledger };
    for (const [key, value] of Object.entries(shared)) {
      combined[key].notified = [...new Set([...value.notified, ...combined[key].notified])];
    }
    // Retain currently active operations even when very old terminal history is pruned.
    const entries = Object.entries(combined);
    const retained = [...entries.filter(([, value]) => !activeStates.has(value.state)).slice(-900), ...entries.filter(([, value]) => activeStates.has(value.state)).slice(-100)];
    this.ledger = Object.fromEntries(retained);
    try { this.storage?.setItem(this.key, JSON.stringify({ version: 1, entries: retained })); } catch { /* Keep the live ledger. */ }
    return notices;
  }
}

export function desktopNotificationPermission(): NotificationPermission | "unsupported" {
  try { return typeof Notification === "undefined" ? "unsupported" : Notification.permission; } catch { return "unsupported"; }
}
/** Invoke from an explicit Settings button, never from polling or initialization. */
export async function requestDesktopNotificationPermission() {
  if (desktopNotificationPermission() === "unsupported") return "unsupported" as const;
  try { return await Notification.requestPermission(); } catch { return "denied" as const; }
}
let soundContext: AudioContext | null = null;
/** The user gesture that enables sound also unlocks browser audio when supported. */
export async function prepareNotificationSound(): Promise<boolean> {
  try {
    if (typeof AudioContext === "undefined") return false;
    if (!soundContext || soundContext.state === "closed") soundContext = new AudioContext();
    if (soundContext.state === "suspended") await soundContext.resume();
    return soundContext.state === "running";
  } catch { return false; }
}
function playNotificationSound() {
  const context = soundContext;
  if (!context || context.state !== "running") return;
  try {
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 620;
    gain.gain.setValueAtTime(0.025, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.start(); oscillator.stop(context.currentTime + 0.13);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  } catch { /* In-app results remain available when audio is blocked. */ }
}
export function deliverOptionalNotification(notice: OperationNotice, preferences: { sound: boolean; desktop: boolean }, onOpen: () => void) {
  if (preferences.sound) playNotificationSound();
  if (!preferences.desktop || desktopNotificationPermission() !== "granted") return;
  try {
    const notification = new Notification(notice.title, { body: notice.detail, tag: notice.id, silent: true });
    notification.onclick = () => { notification.close(); window.focus(); onOpen(); };
  } catch { /* Unsupported browser delivery never suppresses the in-app notice. */ }
}

export function useOperationNotifications(projectId: string | null, onNavigate: (target: OperationTarget) => void | Promise<void>) {
  const { preferences } = usePreferences();
  const settings = useRef(preferences), navigate = useRef(onNavigate);
  settings.current = preferences; navigate.current = onNavigate;
  const [notices, setNotices] = useState<OperationNotice[]>([]);
  const project = useRef(projectId), noticeProject = useRef(projectId);
  project.current = projectId;
  const dismiss = (id: string) => setNotices((items) => items.filter((item) => item.id !== id));
  const open = async (notice: OperationNotice) => {
    const expectedProject = projectId;
    if (project.current !== expectedProject) return;
    try {
      await navigate.current(notice.target);
      if (project.current === expectedProject) dismiss(notice.id);
    } catch (reason) {
      if (project.current === expectedProject) setNotices((items) => items.map((item) => item.id === notice.id ? { ...item, navigationError: reason instanceof Error ? reason.message : "The result could not be opened. Try again." } : item));
    }
  };
  const openCurrent = useRef(open);
  openCurrent.current = open;
  useEffect(() => {
    if (!preferences.sound) return;
    // Browsers may suspend audio on reload. A later ordinary user gesture can
    // unlock sound already opted into; no sound or permission prompt occurs here.
    const unlock = () => { void prepareNotificationSound(); };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => { window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
  }, [preferences.sound]);
  useEffect(() => {
    noticeProject.current = projectId;
    setNotices([]);
    if (!projectId) return;
    const tracker = new OperationTracker(projectId);
    const controller = new AbortController();
    let active = true, pending = false, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!active || pending) return;
      pending = true;
      let delay = 2000;
      try {
        const feed = await api<{ operations: OperationStatus[] }>(`/projects/${projectId}/operations`, { signal: controller.signal });
        if (!active) return;
        const consume = () => active ? tracker.observe(feed.operations) : [];
        const fresh = navigator.locks?.request
          ? await navigator.locks.request(notificationLedgerKey(projectId), consume)
          : consume();
        if (!active || !fresh.length) return;
        setNotices((items) => [...items, ...fresh.filter((notice) => !items.some((item) => item.id === notice.id))].slice(-3));
        for (const notice of fresh) deliverOptionalNotification(notice, settings.current, () => {
          if (project.current === projectId) void openCurrent.current(notice);
        });
      } catch { delay = 5000; /* An unavailable status feed is not an operation failure. */ }
      finally { pending = false; if (active) timer = setTimeout(poll, delay); }
    };
    const refresh = () => { if (timer) clearTimeout(timer); void poll(); };
    void poll();
    window.addEventListener("focus", refresh);
    return () => { active = false; controller.abort(); if (timer) clearTimeout(timer); window.removeEventListener("focus", refresh); };
  }, [projectId]);
  return { notices: noticeProject.current === projectId ? notices : [], dismiss, open };
}
