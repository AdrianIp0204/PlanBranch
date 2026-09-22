import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { isQuickJumpShortcut, useQuickJumpShortcut } from "./useQuickJumpShortcut";
afterEach(() => { cleanup(); document.body.innerHTML = ""; });
it("ignores composition, repeats and unrelated text shortcuts", () => {
  expect(isQuickJumpShortcut(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))).toBe(true);
  for (const options of [{ key: "k" }, { key: "z", ctrlKey: true }, { key: "k", ctrlKey: true, isComposing: true }, { key: "k", ctrlKey: true, repeat: true }, { key: "k", ctrlKey: true, altKey: true }])
    expect(isQuickJumpShortcut(new KeyboardEvent("keydown", options))).toBe(false);
});
it("does not steal keyboard focus from an open modal", () => {
  const open = vi.fn(); renderHook(() => useQuickJumpShortcut(open));
  document.body.innerHTML = '<dialog open><input /></dialog>';
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
  expect(open).not.toHaveBeenCalled();
  document.body.innerHTML = "";
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  expect(open).toHaveBeenCalledTimes(1);
});
