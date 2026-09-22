import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  updateAgentPreference,
  applyAppearance,
  defaultPreferences,
  LEGACY_MODEL_KEY,
  normalizePreferences,
  PREFERENCES_KEY,
  readPreferences,
  updatePreferences,
  usePreferences,
} from "./preferences";
beforeEach(() => {
  localStorage.clear();
  readPreferences();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("normalizes malformed preferences and migrates an existing model choice", () => {
  expect(
    normalizePreferences({
      theme: "purple",
      textSize: 200,
      grid: "no",
      model: { mode: "invalid" },
    }),
  ).toEqual(defaultPreferences);
  localStorage.setItem(
    LEGACY_MODEL_KEY,
    JSON.stringify({
      mode: "explicit",
      model: "known",
      reasoningEffort: "high",
    }),
  );
  expect(readPreferences().model).toEqual({
    mode: "explicit",
    model: "known",
    reasoningEffort: "high",
  });
  updatePreferences({ theme: "dark" });
  expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!).model.model).toBe(
    "known",
  );
  localStorage.setItem(PREFERENCES_KEY, "{");
  expect(readPreferences().theme).toBe("system");
});
it("keeps settings and composer subscribers synchronized, including model defaults", () => {
  const a = renderHook(usePreferences);
  const b = renderHook(usePreferences);
  act(() =>
    a.result.current.updatePreferences({
      theme: "dark",
      model: { mode: "explicit", model: "known", reasoningEffort: "low" },
    }),
  );
  expect(b.result.current.preferences.theme).toBe("dark");
  expect(b.result.current.preferences.model).toEqual(
    a.result.current.preferences.model,
  );
  expect(document.documentElement.dataset.theme).toBe("dark");
});
it("retains shared in-memory controls when persistence fails", () => {
  const a = renderHook(usePreferences);
  const b = renderHook(usePreferences);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  act(() => a.result.current.updatePreferences({ theme: "dark", grid: false }));
  expect(b.result.current.preferences.grid).toBe(false);
  expect(a.result.current.storageUnavailable).toBe(true);
});
it("uses system appearance only without an explicit override", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  applyAppearance({ ...defaultPreferences, theme: "system" });
  expect(document.documentElement.dataset.theme).toBe("dark");
  applyAppearance({ ...defaultPreferences, theme: "light" });
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("migrates legacy Codex into both purposes without adding provider to its payload", () => {
  const legacy = {
    mode: "explicit" as const,
    model: "known",
    reasoningEffort: "high",
  };
  localStorage.setItem(LEGACY_MODEL_KEY, JSON.stringify(legacy));
  expect(readPreferences().planningAgent.selections.codex).toEqual(legacy);
  expect(readPreferences().codingAgent.selections.codex).toEqual(legacy);
  updateAgentPreference("planning", "ollama", {
    provider: "ollama",
    mode: "explicit",
    model: "local",
    reasoningEffort: null,
  });
  updatePreferences({ theme: "dark" });
  expect(readPreferences().planningAgent.provider).toBe("ollama");
  expect(readPreferences().codingAgent.selections.codex).toEqual(legacy);
  expect(JSON.parse(localStorage.getItem(LEGACY_MODEL_KEY)!)).toEqual(legacy);
});
it("rejects unknown provider selections without silently treating them as Codex", () => {
  const normalized = normalizePreferences({
    planningAgent: {
      provider: "ollama",
      selections: {
        ollama: { mode: "default", provider: "ollama" },
        codex: {
          mode: "explicit",
          provider: "untrusted",
          model: "m",
          reasoningEffort: null,
        },
      },
    },
  });
  expect(normalized.planningAgent.provider).toBe("ollama");
  expect(normalized.planningAgent.selections.ollama).toBeUndefined();
  expect(normalized.planningAgent.selections.codex).toEqual({
    mode: "default",
  });
});
