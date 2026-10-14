const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { setupBrowser, until } = require("./browser-harness.cjs");

test("selected source has exact preview consent, grounded proposal, freshness and restart metadata", { timeout: 120000 }, async (t) => {
  const h = await setupBrowser(t, { name: "repository-context", planningFixture: true });
  fs.writeFileSync(path.join(h.sourceDir, "app.py"), 'def helper():\n    return "selected_marker"\npassword = "excluded_credential"\n');
  fs.writeFileSync(path.join(h.sourceDir, ".env"), "API_KEY=excluded_credential");
  for (const args of [["init"], ["add", "."], ["-c", "user.name=Browser fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]]) {
    execFileSync("git", ["-C", h.sourceDir, ...args], { windowsHide: true, stdio: "pipe" });
  }
  await h.api(`/projects/${h.initial.id}/source`, "POST", { root: h.sourceDir, confirmed: true });
  const p = h.page;
  const dock = p.getByRole("complementary", { name: "Planning conversation" });
  if (!(await dock.isVisible())) await p.getByRole("button", { name: "Toggle planning chat", exact: true }).click();
  await p.getByRole("tab", { name: "Chat", exact: true }).click();
  await dock.getByLabel("Model", { exact: true }).selectOption("fixture-fast");
  await p.getByLabel("Message Codex", { exact: true }).fill("Inspect selected helper and propose reuse");
  await p.getByLabel("Include selected repository context in this request").check();
  await dock.getByRole("button", { name: "Send", exact: true }).click();
  const dialog = p.getByRole("dialog", { name: "Include selected repository context" });
  await dialog.getByLabel("app.py", { exact: true }).check();
  assert.equal(await dialog.getByLabel(".env", { exact: true }).count(), 0);
  await dialog.getByRole("button", { name: "Preview outgoing request" }).click();
  await dialog.getByText("selected_marker", { exact: false }).first().waitFor();
  assert.equal((await dialog.innerText()).includes("excluded_credential"), false);
  assert.equal((await h.api(`/projects/${h.initial.id}/planning`)).request, null);
  assert.equal(await dialog.getByRole("button", { name: "Confirm and send this package" }).isDisabled(), true);
  await dialog.getByLabel(/I confirm sending this frozen package/).check();
  await dialog.getByRole("button", { name: "Confirm and send this package" }).click();
  const state = await until(async () => {
    const state = await h.api(`/projects/${h.initial.id}/planning`);
    if (state.request?.status === "failed") throw new Error(state.request.error);
    return state.request?.status === "succeeded" ? state : false;
  });
  assert.equal(state.proposals[0].title, "Reuse inspected helper");
  assert.equal(state.request.sourceContext.files[0].path, "app.py");
  await p.getByRole("tab", { name: "Changes", exact: true }).click();
  await dock.getByText(/Inspected source/).click();
  await dock.getByRole("button", { name: "Check source freshness" }).click();
  await dock.getByText("Source bytes and revision still match").waitFor();
  fs.writeFileSync(path.join(h.sourceDir, "app.py"), "changed = True\n");
  await dock.getByRole("button", { name: "Check source freshness" }).click();
  await dock.getByText("Stale reference — source or revision changed").waitFor();
  await p.screenshot({ path: path.join(h.output, "source-reference-review.png"), fullPage: true });
  await h.restart();
  assert.equal((await h.api(`/projects/${h.initial.id}/planning`)).proposals[0].sourceContext.packageHash, state.request.sourceContext.packageHash);
});
