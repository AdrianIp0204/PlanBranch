import { useEffect } from "react";
export function isQuickJumpShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey &&
    !event.repeat && !event.isComposing && event.keyCode !== 229 &&
    event.key.toLowerCase() === "k" && !event.defaultPrevented;
}
export function useQuickJumpShortcut(open: () => void, enabled = true) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!enabled || !isQuickJumpShortcut(event) || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      for (const menu of document.querySelectorAll<HTMLDetailsElement>("details[data-popup][open]")) menu.open = false;
      open();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [enabled, open]);
}
