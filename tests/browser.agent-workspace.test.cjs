/* Agent workspace visual fixture. Uses only owned, disposable application data. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupBrowser, until, wait } = require("./browser-harness.cjs");
const { withBrowserZoom, measureContrast } = require("./ux-fixture.cjs");
const mode = process.env.FLOWDESK_AGENT_BASELINE === "1" ? "baseline" : "after";
const conversation = (p) =>
  p.getByRole("tab", { name: /^(Conversation|Chat)$/ });
const review = (p) => p.getByRole("tab", { name: /^(Review|Changes)/ });
const panel = (p) =>
  p.getByRole("complementary", { name: "Planning conversation" });
async function openChat(p, { waitForRestoredProposal = false } = {}) {
  await p
    .getByRole("button", { name: "Toggle planning chat", exact: true })
    .waitFor();
  await until(async () =>
    p.evaluate(() => {
      const workspace = document.querySelector(".workspace");
      return (
        workspace &&
        workspace.classList.contains("compact-workspace") ===
          (innerWidth <= 900 || innerHeight <= 650)
      );
    }),
  );
  if (!(await panel(p).isVisible()))
    await p
      .getByRole("button", { name: "Toggle planning chat", exact: true })
      .click();
  await panel(p).waitFor();
  await conversation(p).click();
  await until(
    async () => !(await panel(p).getByText("Loading conversation…").count()),
  );
  const back = p.getByRole("button", { name: "Back to plan", exact: true });
  if (waitForRestoredProposal) {
    // A fresh browser restores the pending proposal after loading chat. Wait
    // for its draft before leaving, rather than racing the asynchronous fetch.
    await back.waitFor();
    const draftState = p.getByTestId("proposal-draft-state");
    await draftState.waitFor();
    await until(async () => (await draftState.innerText()) !== "Loading draft…");
  }
  if (await back.isVisible()) await back.click();
  if (!(await panel(p).isVisible()))
    await p
      .getByRole("button", { name: "Toggle planning chat", exact: true })
      .click();
  await conversation(p).click();
}
async function request(h, text) {
  const envelope = await h.api("/projects/" + h.initial.id);
  const result = await h.api(
    `/projects/${h.initial.id}/planning/messages`,
    "POST",
    {
      mutationId: crypto.randomUUID(),
      text,
      diagramId: envelope.content.diagrams[0].id,
      nodeId: null,
    },
  );
  return until(async () => {
    const value = await h.api(`/projects/${h.initial.id}/planning`);
    return value.request && value.request.status !== "running" ? value : false;
  });
}
async function assertActionInDock(p, locator) {
  const bounds = await locator.boundingBox();
  const dock = await p.locator(".planning-pane").boundingBox();
  assert.ok(
    bounds &&
      dock &&
      bounds.y >= dock.y &&
      bounds.y + bounds.height <= dock.y + dock.height + 1,
    "Action remains within the dock without scrolling its container: " +
      JSON.stringify({ bounds, dock }),
  );
  assert.ok(
    await p
      .locator(".planning-pane")
      .evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
    "No outer dock overflow",
  );
}
async function compactCommentsAndChanges(h, nodeId, label) {
  const p = h.page;
  await p
    .getByRole("group", { name: "Workspace views" })
    .getByRole("button", { name: "Canvas", exact: true })
    .click();
  const savedCanvas = p.getByTestId("diagram-canvas");
  await savedCanvas.locator(".react-flow__controls-fitview").click();
  await savedCanvas.locator(`.react-flow__node[data-id="${nodeId}"]`).click();
  await openChat(p);
  await p.getByRole("tab", { name: /^Comments/ }).click();
  const input = p.getByLabel(/^Comment on:/);
  await input.fill("Keep this comment editable at narrow sizes. ".repeat(16));
  const add = p.getByRole("button", { name: "Add comment", exact: true });
  await assertActionInDock(p, add);
  await input.focus();
  await p.keyboard.press("Tab");
  assert.equal(
    await add.evaluate((el) => document.activeElement === el),
    true,
    "Tab reaches Add comment",
  );
  await p.screenshot({
    path: path.join(h.output, `${mode}-${label}-comments.png`),
  });
  const oldCount = await p
    .getByRole("button", { name: "Resolve comment", exact: true })
    .count();
  await p.keyboard.press("Enter");
  await until(
    async () =>
      (await p
        .getByRole("button", { name: "Resolve comment", exact: true })
        .count()) > oldCount && (await input.inputValue()) === "",
  );
  await p.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await review(p).click();
  await p.locator("#planning-view-review").waitFor();
  const accept = p
    .getByRole("button", { name: "Review on canvas", exact: true })
    .first();
  await accept.focus();
  await p.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await accept.evaluate((el) => document.activeElement === el),
    true,
    "Native focus reaches visual review",
  );
  await p.screenshot({
    path: path.join(h.output, `${mode}-${label}-changes-focused.png`),
  });
  await assertActionInDock(p, accept);
  await p.keyboard.press("Tab");
  assert.equal(
    await p
      .locator(".planning-change-details > summary")
      .first()
      .evaluate((el) => document.activeElement === el),
    true,
    "Text details follow the visual review action in keyboard order",
  );
  await p.screenshot({
    path: path.join(h.output, `${mode}-${label}-changes.png`),
  });
}
async function measure(p) {
  return p.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        bottom: b.bottom,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      documentWidth: document.documentElement.scrollWidth,
      dock: rect(document.querySelector(".planning-pane")),
      panel: rect(document.querySelector(".planning-panel")),
      transcript: rect(
        document.querySelector("#planning-view-conversation .planning-scroll"),
      ),
      composer: rect(
        document.querySelector(
          "#planning-view-conversation .planning-composer",
        ),
      ),
      canvas: rect(document.querySelector('[data-testid="diagram-canvas"]')),
      send: rect(
        [...document.querySelectorAll("button")].find((x) =>
          ["Send", "Change direction"].includes(x.textContent.trim()),
        ),
      ),
    };
  });
}
async function capture(
  h,
  label,
  measurements,
  {
    sizes = [
      [1280, 800],
      [1440, 900],
    ],
  } = {},
) {
  for (const [width, height] of sizes) {
    await h.page.setViewportSize({ width, height });
    await wait(180);
    if (width < 900) await openChat(h.page);
    measurements[`${label}-${width}x${height}`] = await measure(h.page);
    if (mode === "after" && label !== "review")
      await assertDockFits(h.page, { historyMinimum: width < 900 ? 80 : 160 });
    await h.page.screenshot({
      path: path.join(h.output, `${mode}-${label}-${width}x${height}.png`),
    });
  }
}

test(
  "agent workspace representative production views and genuine browser zoom",
  { timeout: 240000 },
  async (t) => {
    const h = await setupBrowser(t, {
      name: `agent-workspace-${mode}`,
      planningFixture: true,
      viewport: { width: 1280, height: 800 },
    });
    console.log("Agent workspace artifacts: " + h.output);
    const p = h.page,
      measurements = {};
    t.after(() =>
      fs.writeFileSync(
        path.join(h.output, "measurements.json"),
        JSON.stringify(measurements, null, 2),
      ),
    );
    const original = structuredClone(h.initial.content);
    await h.saveContent(
      h.initial.id,
      (c) => {
        c.diagrams[0].nodes = [];
        c.diagrams[0].edges = [];
        c.nodeLinks = [];
      },
      "Empty visual fixture",
    );
    await p.reload();
    await p.getByTestId("diagram-canvas").waitFor();
    await openChat(p);
    await capture(h, "empty", measurements);
    const populated = await h.saveContent(
      h.initial.id,
      (c) => {
        Object.assign(c, original);
        c.name = "Import records · agent planning";
        const d = c.diagrams[0];
        d.name = "Validate records and retry safely";
        const n = d.nodes.find((n) => n.type === "decision");
        n.title =
          "Validate each incoming record before writing persistent changes";
        n.notes =
          "Retain invalid records with a useful explanation so a person can review and retry them. ".repeat(
            8,
          );
      },
      "Representative branching plan",
    );
    await p.reload();
    await p.getByTestId("diagram-canvas").waitFor();
    await openChat(p);
    await p.locator(".react-flow__controls-fitview").click();
    await capture(h, "populated", measurements);
    for (let i = 0; i < 5; i++)
      await request(
        h,
        `Discuss the import plan, iteration ${i + 1}. ` +
          "Keep the original record, show validation errors, and allow review before retrying. ".repeat(
            6,
          ),
      );
    await p.reload();
    await p.getByTestId("diagram-canvas").waitFor();
    await openChat(p);
    await p.locator(".react-flow__controls-fitview").click();
    const node = populated.content.diagrams[0].nodes.find(
      (n) => n.type === "decision",
    );
    await p.locator(`.react-flow__node[data-id="${node.id}"]`).click();
    await p
      .getByLabel("Message Codex", { exact: true })
      .fill(
        "Keep the existing validation loop and add a clear review step before retrying.",
      );
    await capture(h, "long-chat-selected-node", measurements);
    await p.locator("#open-catalogue").click();
    await capture(h, "catalogue", measurements);
    await p
      .getByRole("button", { name: "Close variable panel", exact: true })
      .click();
    await request(h, "Add a review step");
    await p.reload();
    await p.getByTestId("diagram-canvas").waitFor();
    await openChat(p);
    await review(p).click();
    await p.getByRole("article", { name: "Add a review step" }).waitFor();
    await capture(h, "review", measurements);
    await request(h, "Discuss failure fixture fail once");
    await p.reload();
    await p.getByTestId("diagram-canvas").waitFor();
    await openChat(p);
    await p
      .getByRole("button", { name: "Retry agent reply", exact: true })
      .waitFor();
    await capture(h, "failed-request", measurements);
    await p.emulateMedia({ reducedMotion: "reduce" });
    await capture(h, "narrow", measurements, { sizes: [[720, 700]] });
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    if (mode === "after") await compactCommentsAndChanges(h, node.id, "narrow");
    await withBrowserZoom(h, async (zoomed, setZoom) => {
      await openChat(zoomed.page, { waitForRestoredProposal: mode === "after" });
      const factor = await setZoom(2);
      assert.equal(factor, 2);
      // Closing the proposal returns to Canvas; select Chat in the compact view.
      await openChat(zoomed.page);
      const value = await measure(zoomed.page);
      measurements.zoom200 = value;
      assert.equal(value.viewport.width, 640);
      assert.equal(value.viewport.devicePixelRatio, 2);
      assert.ok(value.documentWidth <= value.viewport.width + 1);
      if (mode === "after")
        await assertDockFits(zoomed.page, { historyMinimum: 70 });
      await zoomed.page.screenshot({
        path: path.join(h.output, `${mode}-zoom-200.png`),
      });
      if (mode === "after")
        await compactCommentsAndChanges(zoomed, node.id, "zoom-200");
    });
    measurements.contrast = await measureContrast(p);
  },
);
async function assertDockFits(p, { historyMinimum = 160 } = {}) {
  const m = await measure(p);
  assert.ok(
    m.dock && m.composer && m.transcript && m.send,
    "Conversation regions are present",
  );
  assert.ok(
    m.dock.y >= -1 && m.dock.bottom <= m.viewport.height + 1,
    "Dock remains inside the viewport",
  );
  assert.ok(
    m.dock.scrollHeight <= m.dock.clientHeight + 1,
    "Dock has no outer overflow",
  );
  assert.ok(
    m.panel.scrollHeight <= m.panel.clientHeight + 1,
    "Panel has no outer overflow",
  );
  assert.ok(
    m.send.y >= m.dock.y && m.send.bottom <= m.dock.bottom + 1,
    "Send is visible without scrolling the dock",
  );
  assert.ok(m.composer.bottom <= m.dock.bottom + 1, "Composer stays bounded");
  assert.ok(
    m.transcript.height >= historyMinimum - 1,
    "History retains a useful viewport",
  );
  const heading = await p.locator(".planning-heading").boundingBox();
  assert.ok(
    heading &&
      heading.y >= m.dock.y - 1 &&
      heading.y + heading.height <= m.dock.bottom + 1,
    "Dock header is visible",
  );
  assert.ok(
    m.documentWidth <= m.viewport.width + 1,
    "No horizontal page overflow",
  );
  for (const name of ["Model", "Reasoning effort"]) {
    const control = p.getByRole("combobox", { name, exact: true });
    const bounds = await control.boundingBox();
    assert.ok(
      bounds &&
        bounds.x >= m.dock.x &&
        bounds.y >= m.dock.y &&
        bounds.x + bounds.width <= m.dock.x + m.dock.width + 1 &&
        bounds.y + bounds.height <= m.dock.bottom + 1,
      `${name} is visible alongside Send without scrolling the dock`,
    );
  }
  return m;
}

test(
  "bounded dock and composer resizing preserve the saved plan, draft and reading position",
  { timeout: 180000, skip: mode === "baseline" },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "agent-workspace-resize",
        planningFixture: true,
        viewport: { width: 1280, height: 800 },
      }),
      p = h.page;
    await openChat(p);
    const inspectorWidthBefore = await p.evaluate(
      () =>
        JSON.parse(localStorage.getItem("flowdesk.layout.v1")).inspectorWidth,
    );
    for (let i = 0; i < 4; i++)
      await request(
        h,
        "Discuss saved planning requirements " +
          i +
          ". " +
          "Keep the existing review loop and stable identifiers. ".repeat(8),
      );
    await p.reload();
    await openChat(p);
    await p.locator(".react-flow__controls-fitview").click();
    const selected = h.initial.content.diagrams[0].nodes.find(
      (n) => n.type === "process",
    );
    await p.locator(`.react-flow__node[data-id="${selected.id}"]`).click();
    const draft =
      "Keep this unsent draft while moving the divider.\n" +
      "Long input remains editable. ".repeat(25);
    await p.getByLabel("Message Codex", { exact: true }).fill(draft);
    await p.getByRole("button", { name: "Save", exact: true }).click();
    await h.saved();
    const before = await h.api("/projects/" + h.initial.id);
    const viewport = await p
      .locator(".react-flow__viewport")
      .getAttribute("style");
    const composer = p.getByRole("separator", {
      name: "Resize message composer",
      exact: true,
    });
    const width = p.getByRole("separator", {
      name: "Resize planning chat",
      exact: true,
    });
    await assertDockFits(p);
    const closedCatalogueHeight = (await measure(p)).dock.height;
    await p.locator("#open-catalogue").click();
    assert.equal(
      Math.round((await measure(p)).dock.height),
      Math.round(closedCatalogueHeight),
      "Catalogue does not consume chat height",
    );
    await assertDockFits(p);
    for (const key of ["Home", "End", "ArrowDown", "Shift+ArrowUp"]) {
      await composer.focus();
      await p.keyboard.press(key);
      await assertDockFits(p);
    }
    const oldHeight = Number(await composer.getAttribute("aria-valuenow"));
    const box = await composer.boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 35, {
      steps: 4,
    });
    await p.mouse.up();
    assert.ok(
      Number(await composer.getAttribute("aria-valuenow")) < oldHeight,
      "Pointer shrinks the composer",
    );
    await assertDockFits(p);
    for (const key of ["Home", "End", "ArrowRight", "Shift+ArrowLeft"]) {
      await width.focus();
      await p.keyboard.press(key);
      await assertDockFits(p);
    }
    assert.equal(
      await p.getByLabel("Message Codex", { exact: true }).inputValue(),
      draft,
    );
    assert.equal(
      await p.locator(".react-flow__viewport").getAttribute("style"),
      viewport,
    );
    assert.ok(
      (
        await p
          .locator(`.react-flow__node[data-id="${selected.id}"]`)
          .getAttribute("class")
      ).includes("selected"),
    );
    const after = await h.api("/projects/" + h.initial.id);
    assert.deepEqual(after.content, before.content);
    assert.deepEqual(after.history, before.history);
    assert.equal(after.cursor, before.cursor);
    assert.equal(after.revision, before.revision);
    const persisted = await p.evaluate(() =>
      JSON.parse(localStorage.getItem("flowdesk.layout.v1")),
    );
    assert.ok(Number.isFinite(persisted.chatWidth));
    assert.ok(Number.isFinite(persisted.composerHeight));
    assert.equal(
      persisted.inspectorWidth,
      inspectorWidthBefore,
      "Chat resizing does not change inspector preference",
    );
    await p.reload();
    await openChat(p);
    await assertDockFits(p);
    assert.equal(
      await p.getByLabel("Message Codex", { exact: true }).inputValue(),
      draft,
    );
    const reloaded = await p.evaluate(() =>
      JSON.parse(localStorage.getItem("flowdesk.layout.v1")),
    );
    assert.equal(reloaded.chatWidth, persisted.chatWidth);
    assert.equal(reloaded.composerHeight, persisted.composerHeight);
    // Incoming replies must not pull a reader away from older messages.
    const scroll = p.locator("#planning-view-conversation .planning-scroll");
    await p
      .getByLabel("Message Codex", { exact: true })
      .fill("Discuss a slow update");
    await p.getByRole("button", { name: "Send", exact: true }).click();
    await p.getByLabel("Message Codex", { exact: true }).fill(draft);
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await until(
      async () =>
        await p.getByRole("button", { name: /^Jump to latest/ }).isVisible(),
    );
    assert.equal(await scroll.evaluate((el) => el.scrollTop), 0);
    await p.getByRole("button", { name: /^Jump to latest/ }).click();
    await until(
      async () =>
        await scroll.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop < 70,
        ),
    );
    await p.locator(".layout-menu > summary").click();
    await p
      .getByRole("button", { name: "Restore default layout", exact: true })
      .click();
    await openChat(p);
    await assertDockFits(p);
    await p.emulateMedia({ reducedMotion: "reduce" });
    await p.getByLabel("Message Codex", { exact: true }).focus();
    await p.setViewportSize({ width: 720, height: 700 });
    await until(
      async () => (await p.locator(".workspace.compact-workspace").count()) > 0,
    );
    assert.equal(
      await p
        .getByLabel("Message Codex", { exact: true })
        .evaluate((el) => document.activeElement === el),
      true,
      "Breakpoint retains composer focus",
    );
    await assertDockFits(p, { historyMinimum: 80 });
    assert.equal(
      await p.getByLabel("Message Codex", { exact: true }).inputValue(),
      draft,
    );
  },
);

async function waitForModels(p) {
  const model = p.getByRole("combobox", { name: "Model", exact: true });
  await until(
    async () =>
      (await model.locator('option[value="fixture-fast"]').count()) === 1,
  );
  return model;
}

test(
  "older planning server blocks sends and preserves drafts and model choices until connection recovery",
  { timeout: 90000, skip: mode === "baseline" },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "agent-server-upgrade",
        planningFixture: true,
        viewport: { width: 1280, height: 800 },
      }),
      p = h.page;
    await openChat(p);
    await waitForModels(p);
    const draft = "Discuss a Python todo CLI without losing this unsent draft.";
    const composer = p.getByLabel("Message Codex", { exact: true });
    const model = p.getByRole("combobox", { name: "Model", exact: true });
    const effort = p.getByRole("combobox", {
      name: "Reasoning effort",
      exact: true,
    });
    const send = p.getByRole("button", { name: "Send", exact: true });
    await composer.fill(draft);
    await h.saved();
    const before = await h.api("/projects/" + h.initial.id);
    const capabilityRoute = "**/api/planning/capabilities";
    let incompatible = true,
      posts = 0;
    await p.route(capabilityRoute, async (route) => {
      if (incompatible)
        return route.fulfill({
          status: 404,
          json: { error: "Unknown API route." },
        });
      return route.continue();
    });
    await p.route("**/planning/messages", async (route) => {
      posts++;
      await route.continue();
    });
    const recovery = p.getByRole("button", {
      name: "Check connection",
      exact: true,
    });
    async function assertBlocked() {
      await recovery.waitFor();
      assert.match(
        await p.locator("#planning-model-problem").innerText(),
        /Restart PlanBranch.*Your draft remains here/,
      );
      assert.equal(await composer.inputValue(), draft);
      assert.equal(await send.isDisabled(), true);
      await composer.focus();
      await p.keyboard.press("Control+Enter");
      await wait(200);
      assert.equal(posts, 0, "Keyboard cannot send to an incompatible server");
    }
    await p.reload();
    await openChat(p);
    await assertBlocked();
    assert.equal(await model.inputValue(), "");
    incompatible = false;
    await recovery.click();
    await waitForModels(p);
    await model.selectOption("fixture-deep");
    await effort.selectOption("high");
    assert.equal(await send.isEnabled(), true);

    // The same protection must preserve a saved explicit choice, not reset it.
    incompatible = true;
    await p.reload();
    await openChat(p);
    await assertBlocked();
    assert.equal(await model.inputValue(), "fixture-deep");
    assert.deepEqual(
      await p.evaluate(() =>
        JSON.parse(localStorage.getItem("flowdesk.planning-model.v1")),
      ),
      { mode: "explicit", model: "fixture-deep", reasoningEffort: "high" },
    );
    await assertNoPlanChange(h, before);
    await p.screenshot({ path: path.join(h.output, "restart-guidance.png") });
    incompatible = false;
    await recovery.click();
    await waitForModels(p);
    assert.equal(await model.inputValue(), "fixture-deep");
    assert.equal(await effort.inputValue(), "high");
    assert.equal(await composer.inputValue(), draft);
    await composer.focus();
    await p.keyboard.press("Control+Enter");
    const result = await requestState(h, "succeeded", draft);
    assert.equal(posts, 1);
    assert.deepEqual(result.request.generation.selection, {
      mode: "explicit",
      model: "fixture-deep",
      reasoningEffort: "high",
    });
    await assertNoPlanChange(h, before);
  },
);

test(
  "legacy selection rejection keeps the draft and recovers without an uncertain retry or silent default",
  { timeout: 90000, skip: mode === "baseline" },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "agent-selection-rejection",
        planningFixture: true,
      }),
      p = h.page;
    await openChat(p);
    const model = await waitForModels(p);
    await model.selectOption("fixture-deep");
    const effort = p.getByRole("combobox", {
      name: "Reasoning effort",
      exact: true,
    });
    await effort.selectOption("high");
    const payloads = [];
    await p.route("**/planning/messages", async (route) => {
      payloads.push(route.request().postDataJSON());
      if (payloads.length === 1)
        return route.fulfill({
          status: 400,
          json: { error: "Unexpected fields in planning message: selection." },
        });
      return route.continue();
    });
    const draft = "Discuss model settings after a server upgrade.";
    await sendUi(p, draft);
    const recovery = p.getByRole("button", {
      name: "Check connection",
      exact: true,
    });
    await recovery.waitFor();
    const composer = p.getByLabel("Message Codex", { exact: true });
    assert.equal(await composer.inputValue(), draft);
    assert.equal(
      await p.getByRole("button", { name: "Send", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await p
        .getByRole("button", { name: "Send as new request", exact: true })
        .count(),
      0,
      "A confirmed rejection must not imply the request may have committed",
    );
    assert.equal(
      await p
        .getByText("Unexpected fields in planning message: selection.", {
          exact: true,
        })
        .count(),
      0,
    );
    await composer.focus();
    await p.keyboard.press("Control+Enter");
    await wait(200);
    assert.equal(payloads.length, 1);
    assert.equal(
      (await h.api(`/projects/${h.initial.id}/planning`)).messages.length,
      0,
    );
    await recovery.click();
    await waitForModels(p);
    assert.equal(await model.inputValue(), "fixture-deep");
    assert.equal(await effort.inputValue(), "high");
    assert.equal(await composer.inputValue(), draft);
    await p.getByRole("button", { name: "Send", exact: true }).click();
    const result = await requestState(h, "succeeded", draft);
    assert.equal(payloads.length, 2);
    assert.notEqual(payloads[0].mutationId, payloads[1].mutationId);
    assert.deepEqual(payloads[1].selection, payloads[0].selection);
    assert.deepEqual(result.request.generation.selection, {
      mode: "explicit",
      model: "fixture-deep",
      reasoningEffort: "high",
    });
    assert.equal(
      result.messages.filter((message) => message.role === "user").length,
      1,
    );
  },
);

test(
  "ordinary model discovery failure keeps CLI default usable",
  { timeout: 90000, skip: mode === "baseline" },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "agent-model-discovery-fallback",
        planningFixture: true,
      }),
      p = h.page;
    await p.route("**/api/planning/capabilities", (route) =>
      route.fulfill({
        status: 200,
        json: {
          status: "unavailable",
          source: "cli_catalogue",
          cliVersion: "fixture",
          fetchedAt: null,
          models: [],
          reason: "Model discovery is temporarily unavailable.",
        },
      }),
    );
    await p.reload();
    await openChat(p);
    await p.locator("#planning-model-problem").waitFor();
    assert.match(
      await p.locator("#planning-model-problem").innerText(),
      /Model discovery is temporarily unavailable/,
    );
    assert.equal(
      await p
        .getByRole("button", { name: "Check connection", exact: true })
        .count(),
      0,
    );
    const draft = "Discuss the default model while discovery is unavailable.";
    await sendUi(p, draft);
    const result = await requestState(h, "succeeded", draft);
    assert.deepEqual(result.request.generation.selection, { mode: "default" });
  },
);
async function sendUi(p, text) {
  await conversation(p).click();
  await p.getByLabel("Message Codex", { exact: true }).fill(text);
  await p.getByRole("button", { name: "Send", exact: true }).click();
}
async function requestState(h, status, text) {
  return until(async () => {
    const value = await h.api(`/projects/${h.initial.id}/planning`);
    return value.request?.status === status &&
      (!text || value.request.text === text)
      ? value
      : false;
  });
}

test(
  "model selection uses supported efforts and retry retains the original request contract",
  { timeout: 150000, skip: mode === "baseline" },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "agent-model-retry",
        planningFixture: true,
        viewport: { width: 1280, height: 800 },
      }),
      p = h.page;
    await openChat(p);
    const model = await waitForModels(p),
      effort = p.getByRole("combobox", {
        name: "Reasoning effort",
        exact: true,
      });
    await model.selectOption("fixture-fast");
    assert.equal(await effort.inputValue(), "low");
    assert.deepEqual(
      await effort
        .locator("option")
        .evaluateAll((options) => options.map((option) => option.value)),
      ["low", "medium"],
    );
    const text = "Discuss model settings fail once";
    await sendUi(p, text);
    await p
      .getByRole("button", { name: "Retry agent reply", exact: true })
      .waitFor();
    const failed = await requestState(h, "failed", text);
    assert.deepEqual(failed.request.generation.selection, {
      mode: "explicit",
      model: "fixture-fast",
      reasoningEffort: "low",
    });
    assert.ok(failed.request.generation.instructionHash);
    await model.selectOption("fixture-deep");
    assert.equal(
      await effort.inputValue(),
      "medium",
      "An incompatible effort changes to the advertised default",
    );
    assert.deepEqual(
      await effort
        .locator("option")
        .evaluateAll((options) => options.map((option) => option.value)),
      ["medium", "high"],
    );
    await effort.selectOption("high");
    await p
      .getByRole("button", { name: "Retry agent reply", exact: true })
      .click();
    const retried = await requestState(h, "succeeded", text);
    assert.equal(retried.request.id, failed.request.id);
    assert.ok(
      retried.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.text.includes("Requested model: fixture-fast / low."),
      ),
      "The provider actually receives the original retry settings",
    );
    assert.deepEqual(
      retried.request.generation,
      failed.request.generation,
      "Retry uses the original immutable configuration",
    );
    assert.equal(
      retried.messages.filter(
        (message) => message.role === "user" && message.text === text,
      ).length,
      1,
    );
    assert.equal(
      await model.inputValue(),
      "fixture-deep",
      "Retry does not reset the next-request preference",
    );
    assert.equal(await effort.inputValue(), "high");
    const help = p.getByRole("button", {
      name: "Planning settings and sharing help",
      exact: true,
    });
    await help.click();
    const dialog = p.getByRole("dialog", {
      name: "Planning settings",
      exact: true,
    });
    await dialog
      .locator("summary")
      .filter({ hasText: "Latest request details" })
      .click();
    await dialog.getByText("fixture-fast · low", { exact: true }).waitFor();
    await p.keyboard.press("Escape");
    await until(
      async () => await help.evaluate((el) => document.activeElement === el),
    );
    await sendUi(p, "Discuss the next model settings selection");
    const latest = await requestState(
      h,
      "succeeded",
      "Discuss the next model settings selection",
    );
    assert.notEqual(latest.request.id, retried.request.id);
    assert.ok(
      latest.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.text.includes("Requested model: fixture-deep / high."),
      ),
      "The provider receives the newly selected model and effort",
    );
    assert.deepEqual(latest.request.generation.selection, {
      mode: "explicit",
      model: "fixture-deep",
      reasoningEffort: "high",
    });
    await assertDockFits(p);
    await p.screenshot({
      path: path.join(h.output, "model-controls-1280.png"),
    });
    await p.reload();
    await openChat(p);
    await waitForModels(p);
    assert.equal(await model.inputValue(), "fixture-deep");
    assert.equal(await effort.inputValue(), "high");
    await model.focus();
    await p.keyboard.press("Tab");
    assert.equal(
      await effort.evaluate((el) => document.activeElement === el),
      true,
      "Keyboard reaches reasoning immediately after model",
    );
    await p.setViewportSize({ width: 720, height: 700 });
    await openChat(p);
    await assertDockFits(p, { historyMinimum: 80 });
  },
);

test(
  "unavailable and stale model catalogues require an explicit recoverable choice",
  { timeout: 120000, skip: mode === "baseline" },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "agent-model-catalogue",
        planningFixture: true,
        viewport: { width: 1440, height: 900 },
      }),
      p = h.page;
    await openChat(p);
    const model = await waitForModels(p),
      effort = p.getByRole("combobox", {
        name: "Reasoning effort",
        exact: true,
      });
    await model.selectOption("fixture-deep");
    await effort.selectOption("high");
    const cachedCatalogue = await h.api("/planning/capabilities");
    let catalogueMode = "unavailable";
    const url = "**/api/planning/capabilities";
    await p.route(url, async (route) => {
      if (catalogueMode === "unavailable")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "unavailable",
            source: "cli_catalogue",
            cliVersion: "fixture",
            fetchedAt: null,
            models: cachedCatalogue.models,
            reason: "Fixture catalogue is temporarily unavailable.",
          }),
        });
      const response = await route.fetch(),
        body = await response.json();
      body.models = body.models.filter((item) => item.id !== "fixture-deep");
      await route.fulfill({ response, json: body });
    });
    await p.reload();
    await openChat(p);
    await p
      .getByLabel("Message Codex", { exact: true })
      .fill("Discuss after a catalogue interruption");
    assert.equal(
      await model.inputValue(),
      "fixture-deep",
      "Unavailable metadata never silently changes a saved explicit choice",
    );
    await p
      .getByText(
        "This model cannot be verified. Refresh models or choose CLI default.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await p.getByRole("button", { name: "Send", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await effort.isDisabled(),
      true,
      "Cached choices cannot enable effort controls while capabilities are unavailable",
    );
    catalogueMode = "stale";
    await p.reload();
    await openChat(p);
    await p
      .getByText(
        "Your saved model is no longer listed. Choose another model or CLI default.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await model.inputValue(), "fixture-deep");
    assert.equal(
      await p.getByRole("button", { name: "Send", exact: true }).isDisabled(),
      true,
    );
    await model.selectOption("");
    assert.equal(await effort.isDisabled(), true);
    await p.getByRole("button", { name: "Send", exact: true }).click();
    const result = await requestState(
      h,
      "succeeded",
      "Discuss after a catalogue interruption",
    );
    assert.deepEqual(result.request.generation.selection, { mode: "default" });
    await p.unroute(url);
    await p
      .getByRole("button", {
        name: "Planning settings and sharing help",
        exact: true,
      })
      .click();
    const dialog = p.getByRole("dialog", {
      name: "Planning settings",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Refresh models", exact: true })
      .click();
    await until(
      async () =>
        (await model.locator('option[value="fixture-deep"]').count()) === 1,
    );
    await p.keyboard.press("Escape");
    await model.selectOption("fixture-fast");
    assert.equal(await effort.inputValue(), "low");
    await assertDockFits(p);
  },
);

const clarification = (p) =>
  p
    .getByRole("region", { name: "Clarification questions", exact: true })
    .last();
async function waitForQuestion(h, state = "open") {
  return until(async () => {
    const planning = await h.api(`/projects/${h.initial.id}/planning`);
    return planning.questionSets?.find((set) => set.state === state) || false;
  });
}
async function draftAnswers(
  p,
  custom = "Personal use, without sharing a database",
) {
  const card = clarification(p);
  await card.waitFor();
  const storage = card.getByRole("radio", { name: /SQLite/i });
  await storage.focus();
  await p.keyboard.press("Space");
  assert.equal(await storage.isChecked(), true);
  await card.getByRole("button", { name: "Next", exact: true }).click();
  // Question navigation deliberately returns focus on the next frame. Wait
  // for that transition before moving focus to an answer with the keyboard.
  await until(async () =>
    card
      .locator(".planning-question-progress")
      .evaluate(
        (el) =>
          document.activeElement === el && el.textContent === "Question 2 of 2",
      ),
  );
  const other = card.getByRole("radio", {
    name: "Something else",
    exact: true,
  });
  await other.focus();
  await p.keyboard.press("Space");
  assert.equal(await other.isChecked(), true);
  await card
    .getByRole("textbox", { name: "Your answer", exact: true })
    .fill(custom);
  return card;
}
async function assertNoPlanChange(h, before) {
  const after = await h.api("/projects/" + h.initial.id);
  assert.deepEqual(after.content, before.content);
  assert.deepEqual(after.history, before.history);
  assert.equal(after.cursor, before.cursor);
  assert.equal(after.revision, before.revision);
}

test(
  "clarification choices, custom answers and lost acknowledgements preserve one durable continuation",
  { timeout: 150000, skip: mode === "baseline" },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "agent-questions-answers",
        planningFixture: true,
        viewport: { width: 1280, height: 800 },
      }),
      p = h.page;
    await openChat(p);
    await h.saved();
    const before = await h.api("/projects/" + h.initial.id);
    await sendUi(p, "Clarify requirements");
    const openSet = await waitForQuestion(h);
    const card = clarification(p);
    await card.waitFor();
    assert.equal(
      await card.getByRole("radio", { checked: true }).count(),
      0,
      "A recommendation never selects an answer",
    );
    assert.equal(
      await p
        .getByRole("button", { name: "Approve plan", exact: true })
        .isDisabled(),
      true,
    );
    await draftAnswers(p);
    await p.screenshot({
      path: path.join(h.output, "questions-custom-1280.png"),
    });
    const divider = p.getByRole("separator", {
      name: "Resize message composer",
      exact: true,
    });
    await divider.focus();
    await p.keyboard.press("ArrowUp");
    await p
      .getByRole("button", { name: "Close planning conversation", exact: true })
      .click();
    await openChat(p);
    await p.reload();
    await openChat(p);
    const recovered = clarification(p);
    await recovered.waitFor();
    if (await recovered.getByRole("radio", { name: /SQLite/i }).count()) {
      assert.equal(
        await recovered.getByRole("radio", { name: /SQLite/i }).isChecked(),
        true,
      );
      await recovered
        .getByRole("button", { name: "Next", exact: true })
        .click();
    }
    assert.equal(
      await recovered
        .getByRole("radio", { name: "Something else", exact: true })
        .isChecked(),
      true,
    );
    assert.equal(
      await recovered
        .getByRole("textbox", { name: "Your answer", exact: true })
        .inputValue(),
      "Personal use, without sharing a database",
    );
    assert.equal(
      (await waitForQuestion(h)).id,
      openSet.id,
      "Layout and reload do not make a question stale",
    );
    await assertNoPlanChange(h, before);
    let lost = false;
    const payloads = [];
    const answerRoute = "**/planning/questions/*/answers";
    await p.route(answerRoute, async (route) => {
      payloads.push(route.request().postDataJSON());
      if (!lost) {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await recovered
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await p
      .getByRole("button", { name: "Retry answers", exact: true })
      .waitFor();
    const committed = await waitForQuestion(h, "answered");
    await p.getByRole("button", { name: "Retry answers", exact: true }).click();
    await until(
      async () =>
        !(await p
          .getByRole("button", { name: "Retry answers", exact: true })
          .count()),
    );
    await p.unroute(answerRoute);
    assert.equal(payloads.length, 2);
    assert.deepEqual(
      payloads[0],
      payloads[1],
      "Lost response retries the exact answer transaction",
    );
    const answered = await waitForQuestion(h, "answered");
    assert.equal(answered.id, openSet.id);
    assert.equal(
      answered.continuationRequestId,
      committed.continuationRequestId,
    );
    const finalState = await requestState(h, "succeeded");
    assert.equal(finalState.request.id, answered.continuationRequestId);
    assert.equal(
      finalState.questionSets.filter((set) => set.state === "answered").length,
      1,
    );
    await assertNoPlanChange(h, before);
    const savedMessages = finalState.messages;
    await h.restart();
    await openChat(p);
    const restored = await h.api(`/projects/${h.initial.id}/planning`);
    assert.deepEqual(
      restored.questionSets.find((set) => set.id === answered.id).answers,
      answered.answers,
    );
    assert.deepEqual(restored.messages, savedMessages);
    await assertNoPlanChange(h, before);
  },
);

test(
  "failed answer continuation retains answers and frozen model settings on retry",
  { timeout: 150000, skip: mode === "baseline" },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "agent-questions-retry",
        planningFixture: true,
        viewport: { width: 1440, height: 900 },
      }),
      p = h.page;
    await openChat(p);
    const model = await waitForModels(p),
      effort = p.getByRole("combobox", {
        name: "Reasoning effort",
        exact: true,
      });
    await model.selectOption("fixture-fast");
    await sendUi(p, "Clarify requirements fail continuation once");
    await waitForQuestion(h);
    await draftAnswers(p, "A small internal team");
    await model.selectOption("fixture-deep");
    await effort.selectOption("high");
    await clarification(p)
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await p
      .getByRole("button", { name: "Retry agent reply", exact: true })
      .waitFor();
    const failed = await requestState(h, "failed");
    const answered = failed.questionSets.find(
      (set) => set.state === "answered",
    );
    assert.ok(answered);
    assert.equal(failed.request.id, answered.continuationRequestId);
    assert.deepEqual(failed.request.generation.selection, {
      mode: "explicit",
      model: "fixture-deep",
      reasoningEffort: "high",
    });
    await model.selectOption("fixture-fast");
    await effort.selectOption("medium");
    await p
      .getByRole("button", { name: "Retry agent reply", exact: true })
      .click();
    const done = await requestState(h, "succeeded");
    assert.equal(done.request.id, failed.request.id);
    assert.deepEqual(done.request.generation, failed.request.generation);
    assert.deepEqual(
      done.questionSets.find((set) => set.id === answered.id).answers,
      answered.answers,
    );
    assert.equal(
      done.questionSets.filter((set) => set.state === "answered").length,
      1,
    );
    await h.restart();
    await openChat(p);
    const restarted = await h.api(`/projects/${h.initial.id}/planning`);
    assert.deepEqual(
      restarted.questionSets.find((set) => set.id === answered.id).answers,
      answered.answers,
    );
    await until(
      async () =>
        !(await p
          .getByRole("button", { name: "Approve plan", exact: true })
          .isDisabled()),
    );
    await p.getByRole("button", { name: "Approve plan", exact: true }).click();
    await until(
      async () =>
        (await h.api(`/projects/${h.initial.id}/planning`)).approval
          ?.current === true,
    );
  },
);

test(
  "questions become outdated after manual edits and changing direction releases approval blockers",
  { timeout: 150000, skip: mode === "baseline" },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "agent-questions-stale",
        planningFixture: true,
        viewport: { width: 1280, height: 800 },
      }),
      p = h.page;
    await openChat(p);
    await sendUi(p, "Clarify requirements");
    const oldSet = await waitForQuestion(h);
    await draftAnswers(p, "Draft answer survives plan changes");
    await p.getByRole("button", { name: "Add Process", exact: true }).click();
    await p.getByRole("button", { name: "Save", exact: true }).click();
    await h.saved();
    const newer = await h.api("/projects/" + h.initial.id);
    await clarification(p)
      .getByRole("button", { name: "Ask again using this plan", exact: true })
      .waitFor();
    assert.equal((await waitForQuestion(h, "stale")).id, oldSet.id);
    await clarification(p)
      .getByRole("button", { name: "Ask again using this plan", exact: true })
      .click();
    const refreshed = await waitForQuestion(h);
    assert.notEqual(refreshed.id, oldSet.id);
    const refreshedState = await h.api(`/projects/${h.initial.id}/planning`);
    assert.equal(
      refreshedState.questionSets.find((set) => set.id === oldSet.id).state,
      "superseded",
    );
    assert.deepEqual(refreshed.baseSnapshot, newer.content);
    const earlier = p.locator("details").filter({
      has: p.locator("summary", { hasText: "Earlier questions replaced" }),
    });
    await earlier.locator("summary").click();
    assert.match(
      await earlier.innerText(),
      /Draft answer survives plan changes/,
    );
    await assertNoPlanChange(h, newer);
    await p
      .getByLabel("Message Codex", { exact: true })
      .fill("Discuss a new direction without further questions");
    await p
      .getByRole("button", { name: "Change direction", exact: true })
      .click();
    const changed = await requestState(
      h,
      "succeeded",
      "Discuss a new direction without further questions",
    );
    assert.equal(
      changed.questionSets.find((set) => set.id === oldSet.id).state,
      "superseded",
    );
    assert.equal(
      changed.questionSets.filter((set) =>
        ["open", "stale"].includes(set.state),
      ).length,
      0,
    );
    await assertNoPlanChange(h, newer);
    await until(
      async () =>
        !(await p
          .getByRole("button", { name: "Approve plan", exact: true })
          .isDisabled()),
    );
  },
);

test(
  "clarification cards stay keyboard-accessible in a bounded dock at narrow size and real 200% zoom",
  { timeout: 150000, skip: mode === "baseline" },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "agent-questions-layout",
        planningFixture: true,
        viewport: { width: 1280, height: 800 },
      }),
      p = h.page;
    await openChat(p);
    await sendUi(p, "Clarify requirements");
    await waitForQuestion(h);
    await draftAnswers(
      p,
      "A small offline tool with a long custom answer. ".repeat(15),
    );
    const measurements = {};
    for (const size of [
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
      { width: 720, height: 700 },
    ]) {
      await p.setViewportSize(size);
      await openChat(p);
      const card = clarification(p);
      await card.waitFor();
      const next = card.getByRole("button", { name: "Continue", exact: true });
      await next.focus();
      await p.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await assertActionInDock(p, next);
      measurements[`${size.width}x${size.height}`] = await assertDockFits(p, {
        historyMinimum: size.width < 900 ? 80 : 160,
      });
      assert.equal(
        await card.evaluate(
          (el) =>
            ["auto", "scroll"].includes(getComputedStyle(el).overflowY) &&
            el.scrollHeight > el.clientHeight,
        ),
        false,
        "Question card does not add a nested scrollbar",
      );
      await p.screenshot({
        path: path.join(h.output, `questions-${size.width}x${size.height}.png`),
      });
    }
    await withBrowserZoom(h, async (zoomed, setZoom) => {
      await openChat(zoomed.page);
      const factor = await setZoom(2);
      assert.equal(factor, 2);
      await draftAnswers(
        zoomed.page,
        "Custom answer entered using the zoomed keyboard interface",
      );
      const card = clarification(zoomed.page),
        go = card.getByRole("button", { name: "Continue", exact: true });
      await go.focus();
      await zoomed.page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      assert.equal(
        await go.evaluate((el) => document.activeElement === el),
        true,
      );
      await assertActionInDock(zoomed.page, go);
      const bounds = await assertDockFits(zoomed.page, { historyMinimum: 60 });
      assert.equal(bounds.viewport.width, 640);
      assert.equal(bounds.viewport.devicePixelRatio, 2);
      measurements.zoom200 = bounds;
      await zoomed.page.screenshot({
        path: path.join(h.output, "questions-zoom-200.png"),
      });
      await zoomed.page.keyboard.press("Enter");
      await requestState(h, "succeeded");
      assert.equal((await waitForQuestion(h, "answered")).state, "answered");
    });
    fs.writeFileSync(
      path.join(h.output, "question-measurements.json"),
      JSON.stringify(measurements, null, 2),
    );
  },
);

test(
  "free-text clarification validates an empty answer and preserves submitted text inertly",
  { timeout: 90000, skip: mode === "baseline" },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "agent-question-text",
        planningFixture: true,
        viewport: { width: 1280, height: 800 },
      }),
      p = h.page;
    await openChat(p);
    await sendUi(p, "Clarify text requirement");
    const question = await waitForQuestion(h);
    const card = clarification(p);
    assert.equal(await card.getByRole("radio").count(), 0);
    await card.getByRole("button", { name: "Continue", exact: true }).click();
    assert.match(
      await card.getByRole("alert").innerText(),
      /Enter your answer/,
    );
    assert.equal((await waitForQuestion(h)).id, question.id);
    const answer =
      "Keep <script>window.questionInjected=true</script> as literal project text.";
    await card
      .getByRole("textbox", { name: "Your answer", exact: true })
      .fill(answer);
    await card.getByRole("button", { name: "Continue", exact: true }).click();
    const answered = await waitForQuestion(h, "answered");
    assert.deepEqual(answered.answers, [
      { questionId: "success", optionId: null, text: answer },
    ]);
    await p
      .getByRole("region", { name: "Answered questions", exact: true })
      .waitFor();
    assert.match(
      await p
        .getByRole("region", { name: "Answered questions", exact: true })
        .innerText(),
      /<script>/,
    );
    assert.equal(await p.evaluate(() => window.questionInjected), undefined);
  },
);

test(
  "late message and answer acknowledgements preserve a newly focused menu",
  { timeout: 120000, skip: mode === "baseline" },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "agent-focus-ack",
        planningFixture: true,
        viewport: { width: 1440, height: 900 },
      }),
      p = h.page;
    await openChat(p);
    await waitForModels(p);
    async function holdAcknowledgement(pattern) {
      let release,
        finish,
        received = false;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const done = new Promise((resolve) => {
        finish = resolve;
      });
      t.after(() => release());
      await p.route(pattern, async (route) => {
        try {
          const response = await route.fetch();
          received = true;
          await gate;
          await route.fulfill({ response });
        } finally {
          finish();
        }
      });
      return {
        wait: () => until(() => received),
        release: async () => {
          release();
          await done;
          await p.unroute(pattern);
        },
      };
    }
    const menu = p.locator(".layout-menu");
    async function openMenu() {
      await menu.locator("summary").click();
      assert.equal(await menu.evaluate((el) => el.open), true);
      assert.equal(
        await menu
          .locator("summary")
          .evaluate((el) => document.activeElement === el),
        true,
      );
    }
    async function assertMenuFocus() {
      assert.equal(
        await menu.evaluate((el) => el.open),
        true,
        "An acknowledgement must not close a menu opened while waiting",
      );
      assert.equal(
        await menu
          .locator("summary")
          .evaluate((el) => document.activeElement === el),
        true,
      );
      await p.keyboard.press("Escape");
    }
    const message = await holdAcknowledgement("**/planning/messages");
    await sendUi(p, "Discuss a delayed acknowledgement");
    await message.wait();
    await openMenu();
    await message.release();
    await until(
      async () =>
        !(await p
          .getByRole("button", { name: "Sending�", exact: true })
          .count()),
    );
    await assertMenuFocus();
    await requestState(h, "succeeded", "Discuss a delayed acknowledgement");

    await sendUi(p, "Clarify text requirement");
    await waitForQuestion(h);
    await clarification(p)
      .getByRole("textbox", { name: "Your answer", exact: true })
      .fill("Keep the current keyboard focus while saving answers.");
    const answer = await holdAcknowledgement("**/planning/questions/*/answers");
    await clarification(p)
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await answer.wait();
    await openMenu();
    await answer.release();
    await until(
      async () =>
        (await p
          .getByText("Answers submitted. Codex is continuing the plan.", {
            exact: true,
          })
          .count()) > 0,
    );
    await p
      .getByRole("region", { name: "Answered questions", exact: true })
      .waitFor();
    await assertMenuFocus();
  },
);
