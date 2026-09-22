import { useSyncExternalStore } from "react";
import { validModelSelection, type ModelSelection } from "./planning";

export const PREFERENCES_KEY = "planbranch.preferences.v1";
export const LEGACY_MODEL_KEY = "flowdesk.planning-model.v1";
export type Preferences = {
  theme: "system" | "light" | "dark";
  textSize: "default" | "large";
  density: "comfortable" | "compact";
  grid: boolean;
  minimap: boolean;
  snap: boolean;
  startup: "resume" | "projects";
  model: ModelSelection;
  sound: boolean;
  desktop: boolean;
};
export const defaultPreferences: Preferences = {
  theme: "system", textSize: "default", density: "comfortable",
  grid: true, minimap: true, snap: true, startup: "resume",
  model: { mode: "default" }, sound: false, desktop: false,
};
export function normalizePreferences(value: unknown): Preferences {
  const p = value && typeof value === "object" ? value as Partial<Preferences> : {};
  return {
    theme: p.theme === "light" || p.theme === "dark" ? p.theme : "system",
    textSize: p.textSize === "large" ? "large" : "default",
    density: p.density === "compact" ? "compact" : "comfortable",
    grid: typeof p.grid === "boolean" ? p.grid : true,
    minimap: typeof p.minimap === "boolean" ? p.minimap : true,
    snap: typeof p.snap === "boolean" ? p.snap : true,
    startup: p.startup === "projects" ? "projects" : "resume",
    model: validModelSelection(p.model) ? p.model! : { mode: "default" },
    sound: p.sound === true, desktop: p.desktop === true,
  };
}
let snapshot: Preferences | undefined;
let lastRaw: string | null | undefined;
let lastLegacy: string | null | undefined;
const listeners = new Set<() => void>();
let storageUnavailable = false;
export function readPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    const legacy = localStorage.getItem(LEGACY_MODEL_KEY);
    if (snapshot && raw === lastRaw && legacy === lastLegacy) return snapshot;
    let parsed: unknown;
    try { parsed = raw ? JSON.parse(raw) : { model: legacy ? JSON.parse(legacy) : undefined }; }
    catch { parsed = {}; }
    snapshot = normalizePreferences(parsed);
    lastRaw = raw;
    lastLegacy = legacy;
  } catch {
    storageUnavailable = true;
  }
  return snapshot ??= normalizePreferences({});
}
export function updatePreferences(patch: Partial<Preferences>) {
  const previous = readPreferences();
  snapshot = normalizePreferences({ ...previous, ...patch });
  try {
    const raw = JSON.stringify(snapshot);
    localStorage.setItem(PREFERENCES_KEY, raw);
    lastRaw = raw;
    if (patch.model) {
      const legacy = JSON.stringify(snapshot.model);
      localStorage.setItem(LEGACY_MODEL_KEY, legacy);
      lastLegacy = legacy;
    }
    storageUnavailable = false;
  } catch {
    // The in-memory snapshot still serves every control in this window.
    storageUnavailable = true;
  }
  applyAppearance(snapshot);
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function usePreferences() {
  const preferences = useSyncExternalStore(subscribe, readPreferences);
  return { preferences, updatePreferences, storageUnavailable };
}
export function applyAppearance(preferences = readPreferences()) {
  const dark = preferences.theme === "dark" || (preferences.theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.textSize = preferences.textSize;
  document.documentElement.dataset.density = preferences.density;
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}
export function initializePreferences() {
  applyAppearance();
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => applyAppearance());
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === PREFERENCES_KEY || event.key === LEGACY_MODEL_KEY) {
      lastRaw = undefined;
      applyAppearance();
      listeners.forEach((listener) => listener());
    }
  });
}
