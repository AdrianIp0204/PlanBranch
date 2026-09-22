/* Quality-of-life checks reuse disposable servers and the external-request blocker. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupBrowser, until } = require("./browser-harness.cjs");
const { prepareUxFixture, openUxPanels, measureWorkspace, measureContrast, withBrowserZoom } = require("./ux-fixture.cjs");

const baselineOnly = process.env.PLANBRANCH_QOL_PHASE === "baseline";
async function settings(page) {
  const trigger = page.getByRole("button", { name: "Settings", exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.waitFor();
  return dialog;
}
async function selectText(select, text) {
  const option = select.locator("option").filter({ hasText: text });
  assert.equal(await option.count(), 1);
  await select.selectOption(await option.getAttribute("value"));
}
async function selectedText(select) {
  return select.locator("option:checked").innerText();
}
async function workspaceColor(page) {
  return page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
}

test("quality-of-life representative workspace at both target sizes", { timeout: 120000 }, async (t) => {
  const phase = process.env.PLANBRANCH_QOL_PHASE || "after";
  const h = await setupBrowser(t, {
    name: `qol-${phase}`,
    planningFixture: true,
    viewport: { width: 1440, height: 900 },
  });
  const p = h.page;
  const fixture = await prepareUxFixture(h);
  await openUxPanels(h, fixture);
  await h.saved();
  const before = await h.api(`/projects/${fixture.id}`);
  const measurements = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
    await p.setViewportSize(viewport);
    await p.getByTestId("diagram-canvas").waitFor();
    await p.getByRole("region", { name: "Variable catalogue" }).waitFor();
    await p.locator(".inspector").getByLabel("Title", { exact: true }).waitFor();
    const observed = await measureWorkspace(p);
    assert.ok(observed.document.width <= viewport.width + 1, "Essential controls stay within the viewport");
    assert.ok(observed.canvas.width > 250, "The diagram retains usable horizontal space");
    measurements.push(observed);
    await p.screenshot({ path: path.join(h.output, `${phase}-${viewport.width}x${viewport.height}.png`) });
  }
  const after = await h.api(`/projects/${fixture.id}`);
  assert.deepEqual(after.content, before.content, "Responsive layout preserves manual content");
  assert.deepEqual(after.history, before.history, "Layout does not add manual history");
  fs.writeFileSync(path.join(h.output, "qol-workspace.json"), JSON.stringify({
    phase, base: h.base, projectId: fixture.id, measurements,
    document: await p.evaluate(() => ({ title: document.title, scripts: [...document.scripts].map(script => script.src) })),
  }, null, 2));
  console.log(`QOL_ARTIFACTS=${h.output}`);
});

test("Settings preferences persist without editing the plan or approval and respond to system theme", { timeout: 120000, skip: baselineOnly }, async (t) => {
  const h = await setupBrowser(t, { name: "qol-settings", planningFixture: true, viewport: { width: 1440, height: 900 } });
  const p = h.page;
  await h.saved();
  const graphNode = p.getByTestId("diagram-canvas").locator(".react-flow__node").first();
  const nodeSize = await graphNode.evaluate(el => ({ width: el.offsetWidth, height: el.offsetHeight }));
  const original = await h.api(`/projects/${h.initial.id}`);
  const approval = await h.api(`/projects/${h.initial.id}/planning/approve`, "POST", {
    baseRevision: original.revision, mutationId: crypto.randomUUID(),
  });
  assert.equal(approval.approval.current, true);
  let dialog = await settings(p);
  await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
  await selectText(dialog.getByLabel("Theme", { exact: true }), /^Light$/);
  const light = await workspaceColor(p);
  await p.keyboard.press("Escape");
  await p.screenshot({ path: path.join(h.output, "light-1440x900.png") });
  dialog = await settings(p);
  await selectText(dialog.getByLabel("Theme", { exact: true }), /^Dark$/);
  await until(async () => await workspaceColor(p) !== light);
  const dark = await workspaceColor(p);
  await selectText(dialog.getByLabel("Text size", { exact: true }), /Larger/);
  await selectText(dialog.getByLabel("Density", { exact: true }), /^Compact$/);
  await dialog.getByRole("button", { name: "Editor", exact: true }).click();
  await dialog.getByLabel("Show grid", { exact: true }).uncheck();
  await dialog.getByLabel("Show minimap", { exact: true }).uncheck();
  await dialog.getByLabel("Snap to grid", { exact: true }).uncheck();
  await p.keyboard.press("Escape");
  await until(() => p.getByRole("button", { name: "Settings", exact: true }).evaluate(el => document.activeElement === el));
  const canvas = p.getByTestId("diagram-canvas");
  assert.equal(await canvas.locator(".react-flow__background").isVisible(), false);
  assert.equal(await canvas.locator(".react-flow__minimap").isVisible(), false);
  assert.deepEqual(await graphNode.evaluate(el => ({ width: el.offsetWidth, height: el.offsetHeight })), nodeSize,
    "Text size and density preferences keep graph node geometry stable");
  await p.screenshot({ path: path.join(h.output, "dark-1440x900.png") });
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.screenshot({ path: path.join(h.output, "dark-1280x800.png") });
  await p.setViewportSize({ width: 1440, height: 900 });
  const contrast = await measureContrast(p);
  for (const item of contrast) assert.ok(item.ratio >= 4.45, `${item.selector} contrast ${item.ratio}`);
  await p.reload();
  await p.getByTestId("diagram-canvas").waitFor();
  assert.equal(await workspaceColor(p), dark);
  dialog = await settings(p);
  await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
  assert.match(await selectedText(dialog.getByLabel("Theme", { exact: true })), /^Dark$/);
  assert.match(await selectedText(dialog.getByLabel("Text size", { exact: true })), /Larger/);
  assert.match(await selectedText(dialog.getByLabel("Density", { exact: true })), /^Compact$/);
  await dialog.getByRole("button", { name: "Editor", exact: true }).click();
  for (const label of ["Show grid", "Show minimap", "Snap to grid"])
    assert.equal(await dialog.getByLabel(label, { exact: true }).isChecked(), false);
  await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
  await selectText(dialog.getByLabel("Theme", { exact: true }), /^System$/);
  await p.emulateMedia({ colorScheme: "light" });
  await until(async () => await workspaceColor(p) === light);
  await p.emulateMedia({ colorScheme: "dark" });
  await until(async () => await workspaceColor(p) === dark);
  await dialog.getByRole("button", { name: "Agent", exact: true }).click();
  const settingsModel = dialog.getByRole("combobox", { name: "Model", exact: true });
  await until(async () => await settingsModel.locator('option[value="fixture-fast"]').count() === 1);
  await settingsModel.selectOption("fixture-fast");
  await dialog.getByRole("combobox", { name: "Reasoning effort", exact: true }).selectOption("medium");
  await p.keyboard.press("Escape");
  const chat = p.getByRole("complementary", { name: "Planning conversation" });
  if (!(await chat.isVisible())) await p.getByRole("button", { name: "Toggle planning chat", exact: true }).click();
  const chatModel = chat.getByRole("combobox", { name: "Model", exact: true });
  await until(async () => await chatModel.locator('option[value="fixture-fast"]').count() === 1);
  assert.equal(await chatModel.inputValue(), "fixture-fast");
  assert.equal(await chat.getByRole("combobox", { name: "Reasoning effort", exact: true }).inputValue(), "medium");
  await chatModel.selectOption("fixture-deep");
  await chat.getByRole("combobox", { name: "Reasoning effort", exact: true }).selectOption("high");
  dialog = await settings(p);
  await dialog.getByRole("button", { name: "Agent", exact: true }).click();
  await until(async () => await dialog.getByRole("combobox", { name: "Model", exact: true }).inputValue() === "fixture-deep");
  assert.equal(await dialog.getByRole("combobox", { name: "Reasoning effort", exact: true }).inputValue(), "high");
  await p.keyboard.press("Escape");
  const unchanged = await h.api(`/projects/${h.initial.id}`);
  assert.deepEqual(unchanged.content, original.content);
  assert.deepEqual(unchanged.history, original.history);
  assert.equal((await h.api(`/projects/${h.initial.id}/planning`)).approval.id, approval.approval.id);
  assert.equal((await h.api(`/projects/${h.initial.id}/planning`)).approval.current, true);
  assert.equal((await h.api(`/projects/${h.initial.id}/planning`)).request, null, "Preference changes never send a planning request");
  fs.writeFileSync(path.join(h.output, "contrast.json"), JSON.stringify(contrast, null, 2));
});

test("Settings stays keyboard accessible at narrow size and real 200 percent zoom", { timeout: 120000, skip: baselineOnly }, async (t) => {
  const h = await setupBrowser(t, { name: "qol-settings-access", planningFixture: true, viewport: { width: 720, height: 700 } });
  const check = async (page, filename) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const dialog = await settings(page);
    for (const section of ["Appearance", "Editor", "Agent", "Data & About"]) {
      const button = dialog.getByRole("button", { name: section, exact: true });
      await button.focus();
      await button.press("Enter");
      assert.ok(await button.isVisible());
    }
    await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
    await selectText(dialog.getByLabel("Text size", { exact: true }), /Larger/);
    await selectText(dialog.getByLabel("Theme", { exact: true }), /^Dark$/);
    await dialog.getByLabel("Theme", { exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.closest("dialog") !== null), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(h.output, filename) });
    await page.keyboard.press("Escape");
    await until(() => page.getByRole("button", { name: "Settings", exact: true }).evaluate(el => document.activeElement === el));
  };
  await check(h.page, "settings-narrow.png");
  await withBrowserZoom(h, async (zoomed, setZoom) => {
    assert.equal(await setZoom(2), 2);
    assert.equal(await zoomed.page.evaluate(() => devicePixelRatio), 2);
    await check(zoomed.page, "settings-zoom-200.png");
  });
});

test("dark workspace exports a light full-diagram PNG with distant content", { timeout: 120000, skip: baselineOnly }, async (t) => {
  const h = await setupBrowser(t, { name: "qol-light-export", planningFixture: true, viewport: { width: 1280, height: 800 } });
  const p = h.page;
  await h.saveContent(h.initial.id, content => {
    const diagram = content.diagrams[0];
    const original = diagram.nodes.find(node => node.type === "process");
    const far = { ...structuredClone(original), id: crypto.randomUUID(), title: "Distant export check", position: { x: 1650, y: 400 }, checklist: [] };
    diagram.nodes.push(far);
    diagram.edges.push({ id: crypto.randomUUID(), source: original.id, target: far.id, sourceHandle: "out", targetHandle: "in", label: "Visible in full export" });
  }, "Prepare distant export fixture");
  await p.reload();
  await p.getByTestId("diagram-canvas").waitFor();
  const dialog = await settings(p);
  await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
  await selectText(dialog.getByLabel("Theme", { exact: true }), /^Dark$/);
  await p.keyboard.press("Escape");
  const dark = await workspaceColor(p);
  await p.locator(".export-menu > summary").click();
  const download = p.waitForEvent("download", { timeout: 45000 });
  await p.getByRole("button", { name: "Full diagram PNG", exact: true }).click();
  const filename = path.join(h.output, "light-full-diagram.png");
  await (await download).saveAs(filename);
  const bytes = fs.readFileSync(filename);
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  assert.ok(bytes.readUInt32BE(16) > 3300, "Export includes the offscreen node");
  const pixels = await p.evaluate(async url => {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    const corner = [...context.getImageData(2, 2, 1, 1).data];
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0, distantInk = 0;
    for (let y = 0; y < canvas.height; y += 3) for (let x = 0; x < canvas.width; x += 3) {
      const i = (y * canvas.width + x) * 4;
      if (data[i] < 180 && data[i + 1] < 180 && data[i + 2] < 180 && data[i + 3] > 200) {
        ink++; if (x > canvas.width * .85) distantInk++;
      }
    }
    return { corner, ink, distantInk };
  }, `data:image/png;base64,${bytes.toString("base64")}`);
  assert.ok(pixels.corner.slice(0, 3).every(value => value > 230), "Export padding uses the explicit light palette");
  assert.equal(pixels.corner[3], 255);
  assert.ok(pixels.ink > 500 && pixels.distantInk > 40, "Text and distant content remain visible");
  assert.equal(await workspaceColor(p), dark, "Export does not switch the working theme");
  await until(async () => await p.locator(".png-export").count() === 0);
});

test("startup resumes the chosen project, diagram and Build task and permits the project list", { timeout: 120000, skip: baselineOnly }, async (t) => {
  const h = await setupBrowser(t, { name: "qol-resume", planningFixture: true });
  const p = h.page;
  const second = await h.api("/projects", "POST", { name: "Resume another workspace" });
  const diagramId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const prepared = await h.saveContent(second.id, content => {
    content.diagrams.push({ id: diagramId, name: "Secondary workflow", nodes: [], edges: [] });
    content.buildTasks = [{ id: taskId, title: "Remember the selected task", deliverable: "Recover the same workspace", nodeLinks: [], prerequisiteIds: [], expectedFiles: [], acceptanceChecks: [], status: "not_started" }];
  });
  await p.reload();
  await p.getByTestId("diagram-canvas").waitFor();
  assert.ok(await p.locator(`.react-flow__node[data-id="${h.initial.content.diagrams[0].nodes[0].id}"]`).count(),
    "Creating a newer project through the API does not replace the remembered project");
  const projects = p.getByRole("navigation", { name: "Projects", exact: true });
  await projects.getByRole("button").filter({ hasText: prepared.content.name }).click();
  await p.getByRole("navigation", { name: "Diagrams", exact: true }).getByRole("button").filter({ hasText: "Secondary workflow" }).click();
  await p.locator("#canvas-title > span").filter({ hasText: "Secondary workflow" }).waitFor();
  await p.getByRole("group", { name: "Plan views", exact: true }).getByRole("button", { name: "Build", exact: true }).click();
  await p.getByRole("region", { name: "Build tasks editor", exact: true }).getByRole("button", { name: "Task: Remember the selected task", exact: true }).click();
  await h.restart();
  assert.equal(await p.getByRole("group", { name: "Plan views", exact: true }).getByRole("button", { name: "Build", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await p.getByRole("region", { name: "Build tasks editor", exact: true }).getByLabel("Task title", { exact: true }).inputValue(), "Remember the selected task");
  await p.getByRole("group", { name: "Plan views", exact: true }).getByRole("button", { name: "Diagram", exact: true }).click();
  await p.locator("#canvas-title > span").filter({ hasText: "Secondary workflow" }).waitFor();
  let dialog = await settings(p);
  await dialog.getByRole("button", { name: "Editor", exact: true }).click();
  await selectText(dialog.getByLabel("Startup", { exact: true }), /^Show projects$/);
  await p.keyboard.press("Escape");
  await p.reload();
  await p.getByRole("navigation", { name: "Projects", exact: true }).getByRole("button", { name: prepared.content.name, exact: true }).waitFor();
  assert.equal(await p.getByRole("group", { name: "Plan views", exact: true }).count(), 0);
  assert.equal(await p.getByTestId("diagram-canvas").count(), 0);
  await p.getByRole("navigation", { name: "Projects", exact: true }).getByRole("button", { name: prepared.content.name, exact: true }).click();
  await p.locator("#canvas-title > span").filter({ hasText: "Secondary workflow" }).waitFor();
  dialog = await settings(p);
  await dialog.getByRole("button", { name: "Editor", exact: true }).click();
  await selectText(dialog.getByLabel("Startup", { exact: true }), /^Reopen last workspace$/);
  await p.keyboard.press("Escape");
  const unchanged = await h.api(`/projects/${second.id}`);
  assert.deepEqual(unchanged.content, prepared.content);
  assert.deepEqual(unchanged.history, prepared.history);
  await h.saveContent(second.id, content => { content.diagrams = content.diagrams.filter(diagram => diagram.id !== diagramId); }, "Remove remembered diagram fixture");
  await p.reload();
  await p.locator("#canvas-title > span").filter({ hasText: prepared.content.diagrams[0].name }).waitFor();
  assert.equal((await h.api(`/projects/${second.id}/planning`)).request, null, "Recovery never sends an agent request");
});


test("grid preference also follows into Tidy and proposed-plan previews", { timeout: 90000 }, async (t) => {
  const h = await setupBrowser(t, { name: "qol-preview-grid", planningFixture: true });
  const p = h.page;
  let dialog = await settings(p);
  await dialog.getByRole("button", { name: "Editor", exact: true }).click();
  await dialog.getByLabel("Show grid", { exact: true }).uncheck();
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: "Tidy diagram", exact: true }).click();
  await p.getByTestId("tidy-preview").waitFor();
  assert.equal(await p.getByTestId("tidy-preview").locator(".react-flow__background").count(), 0);
  await p.getByRole("dialog", { name: "Tidy diagram", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
  await h.saved();
  const before = await h.api(`/projects/${h.initial.id}`);
  await p.getByRole("button", { name: "Toggle planning chat", exact: true }).click();
  const composer = p.getByLabel("Message Codex", { exact: true });
  await until(() => composer.isEditable());
  await composer.fill("Suggest a review step for the grid preview fixture.");
  await p.getByRole("button", { name: "Send", exact: true }).click();
  const review = p.getByRole("region", { name: "Proposed changes workspace", exact: true });
  await review.waitFor();
  assert.equal(await review.locator(".react-flow__background").count(), 0);
  dialog = await settings(p);
  await dialog.getByRole("button", { name: "Editor", exact: true }).click();
  await dialog.getByLabel("Show grid", { exact: true }).check();
  await p.keyboard.press("Escape");
  await until(async () => await review.locator(".react-flow__background").count() === 1);
  const after = await h.api(`/projects/${h.initial.id}`);
  assert.deepEqual(after.content, before.content);
  assert.deepEqual(after.history, before.history);
});
