// Runs before stylesheet paint; the shared store owns subsequent updates.
(() => {
  let p = {};
  try { p = JSON.parse(localStorage.getItem("planbranch.preferences.v1") || "{}") || {}; } catch {}
  const dark = p.theme === "dark" || (p.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.textSize = p.textSize === "large" ? "large" : "default";
  root.dataset.density = p.density === "compact" ? "compact" : "comfortable";
  root.style.colorScheme = dark ? "dark" : "light";
})();
