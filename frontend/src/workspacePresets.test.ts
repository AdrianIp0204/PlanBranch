import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { presetLayout, savePersonalLayout, readPersonalLayout, PERSONAL_LAYOUT_KEY } from "./workspacePresets";
beforeEach(() => localStorage.clear()); afterEach(() => vi.restoreAllMocks());
it("provides compact presets without carrying content or graph state", () => {
  expect(presetLayout("planning", 1440, 900).layout.sidePanel).toBe("planning");
  expect(presetLayout("review", 1440, 900).layout.navigationOpen).toBe(false);
  expect(presetLayout("build", 1440, 900).view).toBe("build");
  expect(Object.keys(presetLayout("build"))).toEqual(["layout", "view"]);
});
it("bounds restored layouts and handles invalid/unavailable storage", () => {
  const saved = presetLayout("review", 1440, 900); saved.layout.chatWidth = 9999;
  expect(savePersonalLayout(saved)).toBe(true);
  expect(readPersonalLayout()!.layout.chatWidth).toBeLessThanOrEqual(680);
  localStorage.setItem(PERSONAL_LAYOUT_KEY, "null"); expect(readPersonalLayout()).toBeNull();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("full"); });
  expect(savePersonalLayout(saved)).toBe(false);
});
