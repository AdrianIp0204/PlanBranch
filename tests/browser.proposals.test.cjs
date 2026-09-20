const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { setupBrowser, until } = require("./browser-harness.cjs");
const { withBrowserZoom } = require("./ux-fixture.cjs");
const workspace = (p) =>
  p.getByRole("region", { name: "Proposed changes workspace" });
async function openChat(p) {
  await p.getByTestId("diagram-canvas").waitFor();
  await until(async () =>
    p.evaluate(() => {
      const w = document.querySelector(".workspace");
      return (
        w &&
        w.classList.contains("compact-workspace") ===
          (innerWidth <= 900 || innerHeight <= 650)
      );
    }),
  );
  if (
    !(await p
      .getByRole("complementary", { name: "Planning conversation" })
      .isVisible())
  )
    await p
      .getByRole("button", { name: "Toggle planning chat", exact: true })
      .click();
  await p.getByRole("tab", { name: "Chat", exact: true }).click();
  await p.getByLabel("Message Codex", { exact: true }).waitFor();
}
async function send(h, text) {
  await h.page.getByRole("tab", { name: "Chat", exact: true }).click();
  await h.page.getByLabel("Message Codex", { exact: true }).fill(text);
  await h.page.getByRole("button", { name: "Send", exact: true }).click();
  return until(async () => {
    const state = await h.api(`/projects/${h.initial.id}/planning`);
    return state.request?.status === "succeeded" &&
      state.messages.some((m) => m.text === text)
      ? state
      : false;
  });
}
async function makeProposal(h) {
  await openChat(h.page);
  const result = await send(h, "Add a review step");
  await workspace(h.page).waitFor();
  await until(
    async () =>
      (await workspace(h.page).locator(".react-flow__node").count()) === 1,
  );
  return result.proposals[0];
}
async function manualTitle(p, title) {
  await workspace(p)
    .getByRole("button", { name: "Edit manually", exact: true })
    .click();
  await workspace(p).locator(".react-flow__node").first().dblclick();
  await workspace(p).getByLabel("Title", { exact: true }).fill(title);
  await workspace(p).getByLabel("Title", { exact: true }).press("Tab");
}

test(
  "proposal canvas isolates manual edits, restores draft, and applies as one undoable change",
  { timeout: 90000 },
  async (t) => {
    const h = await setupBrowser(t, {
      name: "proposal-workspace",
      seed: { name: "Visual review" },
      planningFixture: true,
      viewport: { width: 1280, height: 800 },
    });
    const p = h.page,
      url = `/projects/${h.initial.id}`,
      original = await h.api(url);
    const proposal = await makeProposal(h);
    assert.deepEqual((await h.api(url)).content, original.content);
    await p.screenshot({ path: path.join(h.output, "proposal-1280.png") });
    await workspace(p)
      .getByRole("button", { name: "Before", exact: true })
      .click();
    assert.equal(await workspace(p).locator(".react-flow__node").count(), 0);
    await workspace(p)
      .getByRole("button", { name: "Proposed", exact: true })
      .click();
    await manualTitle(p, "Check the stored tasks");
    await workspace(p)
      .getByRole("button", { name: "Close details", exact: true })
      .click();
    await workspace(p)
      .getByRole("button", { name: "Add node", exact: true })
      .click();
    await workspace(p)
      .getByLabel("Title", { exact: true })
      .fill("Display the tasks");
    await workspace(p).getByLabel("Title", { exact: true }).press("Tab");
    await workspace(p)
      .getByRole("button", { name: "Close details", exact: true })
      .click();
    await workspace(p)
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    const dialog = p.getByRole("dialog");
    await dialog
      .getByLabel("From", { exact: true })
      .selectOption({ label: "Check the stored tasks" });
    await dialog
      .getByLabel("To", { exact: true })
      .selectOption({ label: "Display the tasks" });
    await dialog.getByLabel("Branch label", { exact: true }).fill("Ready");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await workspace(p)
      .getByRole("button", { name: "Undo manual edit", exact: true })
      .click();
    assert.equal(await workspace(p).locator(".react-flow__edge").count(), 0);
    await workspace(p)
      .getByRole("button", { name: "Redo manual edit", exact: true })
      .click();
    await until(
      async () =>
        (await workspace(p).locator(".react-flow__edge").count()) === 1,
    );
    assert.deepEqual(
      await h.api(url),
      original,
      "Preview editing never autosaves into the project",
    );
    await p.reload();
    await workspace(p).waitFor();
    await workspace(p)
      .getByText("Check the stored tasks", { exact: true })
      .waitFor();
    assert.equal(await workspace(p).locator(".react-flow__node").count(), 2);
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.screenshot({ path: path.join(h.output, "proposal-1440.png") });
    await workspace(p)
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await workspace(p).waitFor({ state: "hidden" });
    const applied = await h.api(url);
    assert.equal(applied.history.length, original.history.length + 1);
    assert.equal(applied.content.diagrams[0].nodes.length, 2);
    assert.equal(applied.content.diagrams[0].edges[0].label, "Ready");
    assert.equal(
      applied.content.diagrams[0].nodes[0].title,
      "Check the stored tasks",
    );
    assert.equal(
      (await h.api(url + "/planning")).proposals.find(
        (v) => v.id === proposal.id,
      ).state,
      "accepted",
    );
    await p.getByRole("button", { name: "Undo", exact: true }).click();
    await h.saved();
    assert.deepEqual((await h.api(url)).content, original.content);
  },
);

test(
  "proposal revision sends the visible candidate and discard leaves the saved plan intact",
  { timeout: 90000 },
  async (t) => {
    const h = await setupBrowser(t, {
      name: "proposal-revision",
      seed: { name: "Revise candidate" },
      planningFixture: true,
      viewport: { width: 1440, height: 900 },
    });
    const p = h.page,
      url = `/projects/${h.initial.id}`,
      original = await h.api(url);
    const initial = await makeProposal(h);
    await manualTitle(p, "Keep this manual title");
    await workspace(p)
      .getByRole("button", { name: "Ask Codex", exact: true })
      .click();
    await p.getByText("Revising:", { exact: false }).waitFor();
    const result = await send(
      h,
      "Revise the visible proposal to add a clearer check",
    );
    await until(
      async () =>
        (await workspace(p)
          .getByText("Revised review step", { exact: true })
          .count()) === 1,
    );
    const updated = result.proposals.find((v) => v.id !== initial.id);
    const detail = await h.api(url + "/planning/proposals/" + updated.id);
    assert.equal(
      detail.content.diagrams[0].nodes[0].title,
      "Keep this manual title",
    );
    assert.match(
      detail.content.diagrams[0].nodes[0].description,
      /Revised from the visible candidate/,
    );
    assert.deepEqual(await h.api(url), original);
    await workspace(p)
      .getByRole("button", { name: "Discard", exact: true })
      .click();
    await workspace(p).waitFor({ state: "hidden" });
    assert.equal(
      (await h.api(url + "/planning")).proposals.find(
        (v) => v.id === updated.id,
      ).state,
      "rejected",
    );
    assert.deepEqual(await h.api(url), original);
  },
);

test(
  "stale proposal cannot replace newer content and keeps its manual draft on conflict",
  { timeout: 90000 },
  async (t) => {
    const h = await setupBrowser(t, {
      name: "proposal-stale",
      seed: { name: "Concurrent review" },
      planningFixture: true,
      viewport: { width: 1280, height: 800 },
    });
    const p = h.page,
      url = `/projects/${h.initial.id}`;
    await makeProposal(h);
    await manualTitle(p, "My candidate is retained");
    await h.saveContent(h.initial.id, (content) => {
      content.notes = "Newer edits from another window";
    });
    await workspace(p)
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await workspace(p).getByRole("alert").waitFor();
    assert.equal(
      await workspace(p).getByLabel("Title", { exact: true }).inputValue(),
      "My candidate is retained",
    );
    assert.equal((await h.api(url)).content.diagrams[0].nodes.length, 0);
    await p.reload();
    await openChat(p);
    await p.getByRole("tab", { name: /^Changes/ }).click();
    await p
      .getByRole("button", { name: "Review on canvas", exact: true })
      .click();
    await workspace(p).waitFor();
    assert.equal(
      await workspace(p)
        .getByRole("button", { name: "Apply changes", exact: true })
        .isEnabled(),
      false,
    );
    assert.equal(
      await workspace(p)
        .getByRole("button", { name: "Ask Codex", exact: true })
        .isEnabled(),
      true,
    );
    assert.equal(
      (await h.api(url)).content.notes,
      "Newer edits from another window",
    );
  },
);

test(
  "branching proposal remains usable at narrow widths and 200% browser zoom",
  { timeout: 90000 },
  async (t) => {
    const h = await setupBrowser(t, {
      name: "proposal-responsive",
      planningFixture: true,
      viewport: { width: 1440, height: 900 },
    });
    const p = h.page;
    await openChat(p);
    await send(h, "Add a review step");
    await workspace(p).waitFor();
    await until(
      async () =>
        (await workspace(p).locator(".react-flow__node").count()) ===
        h.initial.content.diagrams[0].nodes.length + 1,
    );
    await p.screenshot({ path: path.join(h.output, "branching-1440.png") });
    await p.setViewportSize({ width: 1280, height: 800 });
    await p.screenshot({ path: path.join(h.output, "branching-1280.png") });
    await p.setViewportSize({ width: 720, height: 700 });
    await until(async () =>
      p
        .locator(".workspace")
        .evaluate((el) => el.classList.contains("compact-workspace")),
    );
    await p.getByRole("button", { name: "Canvas", exact: true }).click();
    await workspace(p)
      .getByRole("button", { name: "Apply changes", exact: true })
      .waitFor();
    await workspace(p)
      .getByRole("button", { name: "Ask Codex", exact: true })
      .click();
    await p.getByLabel("Message Codex", { exact: true }).waitFor();
    await p.getByRole("button", { name: "Canvas", exact: true }).click();
    await workspace(p)
      .getByRole("button", { name: "Edit manually", exact: true })
      .click();
    await workspace(p)
      .getByRole("button", { name: "Add node", exact: true })
      .click();
    await workspace(p)
      .getByLabel("Title", { exact: true })
      .fill("A narrow-window edit");
    assert.equal(
      await workspace(p)
        .getByRole("button", { name: "Open catalogue", exact: true })
        .isVisible(),
      false,
    );
    await workspace(p)
      .getByRole("button", { name: "Close details", exact: true })
      .click();
    await p.screenshot({ path: path.join(h.output, "proposal-narrow.png") });
    await p.emulateMedia({ reducedMotion: "reduce" });
    await p.setViewportSize({ width: 1280, height: 800 });
    await withBrowserZoom(h, async (zoomed, setZoom) => {
      const zp = zoomed.page;
      await openChat(zp);
      await workspace(zp).waitFor();
      await zp.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(await setZoom(2), 2);
      await until(async () =>
        zp.evaluate(() => innerWidth === 640 && innerHeight === 400),
      );
      await zp.getByRole("button", { name: "Canvas", exact: true }).click();
      for (const name of [
        "Apply changes",
        "Ask Codex",
        "Discard",
        "Back to plan",
      ]) {
        const action = workspace(zp).getByRole("button", { name, exact: true });
        const box = await action.boundingBox();
        const height = await zp.evaluate(() => innerHeight);
        assert.ok(
          box && box.y >= 0 && box.y + box.height <= height,
          name + " stays reachable at 200%",
        );
      }
      await zp.screenshot({
        path: path.join(h.output, "proposal-zoom-200.png"),
      });
    });
    assert.deepEqual(
      (await h.api("/projects/" + h.initial.id)).content,
      h.initial.content,
    );
  },
);
