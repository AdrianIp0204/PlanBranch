import { clamp, defaultLayout, type Layout } from "./layout";
export type WorkspacePreset = "planning" | "review" | "build";
export type SavedLayout = { layout: Layout; view: "diagram" | "build" };
export const PERSONAL_LAYOUT_KEY = "planbranch.personal-layout.v1";
export function boundLayout(layout: Layout, width = window.innerWidth, height = window.innerHeight): Layout {
  return { ...layout,
    inspectorWidth: clamp(layout.inspectorWidth, 280, Math.max(280, Math.min(520, width - 48))),
    chatWidth: clamp(layout.chatWidth, 300, Math.max(300, Math.min(680, width - 48))),
    composerHeight: clamp(layout.composerHeight, 100, Math.max(100, Math.min(600, height - 320))),
    catalogueHeight: clamp(layout.catalogueHeight, 230, Math.max(230, Math.min(600, height - 400))),
  };
}
export function presetLayout(name: WorkspacePreset, width = window.innerWidth, height = window.innerHeight): SavedLayout {
  const layout = defaultLayout(width);
  layout.sidePanel = "planning";
  layout.inspectorOpen = name !== "build";
  layout.navigationOpen = name === "planning" && width > 1050;
  layout.chatWidth = name === "review" ? 440 : 400;
  layout.catalogueOpen = false;
  return { layout: boundLayout(layout, width, height), view: name === "build" ? "build" : "diagram" };
}
export function readPersonalLayout(): SavedLayout | null {
  try {
    const value = JSON.parse(localStorage.getItem(PERSONAL_LAYOUT_KEY) || "null");
    if (!value || !value.layout || !["diagram", "build"].includes(value.view)) return null;
    const d = defaultLayout(); const raw = value.layout;
    for (const key of ["navigationOpen", "inspectorOpen", "catalogueOpen"] as const) if (typeof raw[key] === "boolean") d[key] = raw[key];
    if (["inspector", "planning"].includes(raw.sidePanel)) d.sidePanel = raw.sidePanel;
    for (const key of ["inspectorWidth", "chatWidth", "composerHeight", "catalogueHeight"] as const) if (typeof raw[key] === "number" && Number.isFinite(raw[key])) d[key] = raw[key];
    return { layout: boundLayout(d), view: value.view };
  } catch { return null; }
}
export function savePersonalLayout(value: SavedLayout): boolean {
  try { localStorage.setItem(PERSONAL_LAYOUT_KEY, JSON.stringify(value)); return true; } catch { return false; }
}
