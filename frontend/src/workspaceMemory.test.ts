import { beforeEach, expect, it, vi, afterEach } from "vitest";
import { type Content } from "./types";
import { WORKSPACE_KEY, initialWorkspacePlace, readWorkspaceMemory, rememberedPlace, rememberWorkspace } from "./workspaceMemory";
const content: Content = { schemaVersion: 1, name: "test", notes: "", diagrams: [{ id: "a", name: "A", nodes: [], edges: [] }], variables: [], nodeLinks: [], matches: [] };
beforeEach(() => localStorage.clear());
it("opens a linked diagram even when the remembered view is Build or storage is unavailable", () => {
  const scenes = { ...content, diagrams: [...content.diagrams, {...content.diagrams[0], id: "b", name: "B"}] };
  rememberWorkspace("one", {diagramId: "a", view: "build", taskId: null});
  expect(initialWorkspacePlace("one", scenes, new URLSearchParams("project=one")).view).toBe("build");
  expect(initialWorkspacePlace("one", scenes, new URLSearchParams("project=other&diagram=b")).view).toBe("build");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw Error("denied"); });
  expect(initialWorkspacePlace("one", scenes, new URLSearchParams("project=one&diagram=b")))
    .toEqual({diagramId: "b", view: "diagram", taskId: null});
  expect(initialWorkspacePlace("one", scenes, new URLSearchParams("project=one&diagram=missing")).diagramId).toBe("a");
});
afterEach(() => vi.restoreAllMocks());
it("remembers project, diagram and Build view without changing content", () => {
  const before = JSON.stringify(content);
  rememberWorkspace("one", { diagramId: "a", view: "build", taskId: null });
  rememberWorkspace("two", { diagramId: "other", view: "diagram", taskId: null });
  expect(readWorkspaceMemory().projectId).toBe("two");
  expect(rememberedPlace("one", content)).toEqual({ diagramId: "a", view: "build", taskId: null });
  expect(JSON.stringify(content)).toBe(before);
});
it("falls back for missing references and malformed storage", () => {
  rememberWorkspace("one", { diagramId: "deleted", view: "build", taskId: "deleted" });
  expect(rememberedPlace("one", content)).toEqual({ diagramId: "a", view: "build", taskId: null });
  localStorage.setItem(WORKSPACE_KEY, "[");
  expect(rememberedPlace("one", content).view).toBe("diagram");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw Error("denied"); });
  expect(readWorkspaceMemory().projectId).toBeNull();
});
