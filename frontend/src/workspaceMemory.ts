import type { Content } from "./types";
export const WORKSPACE_KEY = "planbranch.workspace.v1";
export type WorkspacePlace = { diagramId: string; view: "diagram" | "build"; taskId: string | null };
type Memory = { projectId: string | null; projects: Record<string, WorkspacePlace> };
export function readWorkspaceMemory(): Memory {
  try {
    const raw = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || "{}");
    if (!raw || typeof raw !== "object") return { projectId: null, projects: {} };
    const projects: Memory["projects"] = {};
    if (raw.projects && typeof raw.projects === "object") for (const [id, place] of Object.entries(raw.projects).slice(-50)) {
      if (!place || typeof place !== "object") continue;
      const p = place as Partial<WorkspacePlace>;
      if (typeof p.diagramId !== "string") continue;
      projects[id] = { diagramId: p.diagramId, view: p.view === "build" ? "build" : "diagram", taskId: typeof p.taskId === "string" ? p.taskId : null };
    }
    return { projectId: typeof raw.projectId === "string" ? raw.projectId : null, projects };
  } catch { return { projectId: null, projects: {} }; }
}
export function rememberedPlace(projectId: string, content: Content): WorkspacePlace {
  const place = readWorkspaceMemory().projects[projectId];
  return {
    diagramId: content.diagrams.some(d => d.id === place?.diagramId) ? place.diagramId : content.diagrams[0]?.id ?? "",
    view: place?.view ?? "diagram",
    taskId: content.buildTasks?.some(t => t.id === place?.taskId) ? place.taskId : null,
  };
}
export function rememberWorkspace(projectId: string, place: WorkspacePlace) {
  try {
    const saved = readWorkspaceMemory();
    delete saved.projects[projectId];
    saved.projects[projectId] = place;
    saved.projectId = projectId;
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ ...saved, projects: Object.fromEntries(Object.entries(saved.projects).slice(-50)) }));
  } catch { /* Navigation remains usable without browser storage. */ }
}
