/* Navigation simplification keeps each existing action reachable through real controls. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupBrowser, until } = require("./browser-harness.cjs");
const { prepareUxFixture, openUxPanels, withBrowserZoom, openProjectMenu } = require("./ux-fixture.cjs");

const projectMenu = p => p.locator(".export-menu");
const projectTrigger = p => projectMenu(p).locator("summary");
async function focused(locator) {
  await until(() => locator.evaluate(el => document.activeElement === el));
}
async function setTheme(p, theme) {
  await p.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = p.getByRole("dialog", { name: "Settings", exact: true });
  await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
  await dialog.getByLabel("Theme", { exact: true }).selectOption(theme);
  await p.keyboard.press("Escape");
  await focused(p.getByRole("button", { name: "Settings", exact: true }));
  await until(() => p.evaluate(expected => document.documentElement.dataset.theme === expected, theme));
}
async function keyboardProjectMenu(p) {
  const trigger = projectTrigger(p);
  assert.equal(await trigger.getAttribute("aria-label"), "Project actions");
  await trigger.focus();
  await trigger.press("Enter");
  assert.equal(await projectMenu(p).evaluate(el => el.open), true);
  const actions = projectMenu(p).getByRole("button");
  assert.equal(await actions.count(), 9, "All existing project actions remain available");
  for (const name of ["Project brief", "Save", "Scan Python", "Project JSON", "Full diagram PNG", "Implementation brief", /Import JSON$/, /Load example$/, "Back up database"])
    assert.equal(await projectMenu(p).getByRole("button", { name, exact: true }).count(), 1);
  for (let index = 0; index < await actions.count(); index++) {
    await p.keyboard.press("Tab");
    const action = actions.nth(index);
    await focused(action);
    assert.equal(await action.evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    }), true, `${await action.innerText()} is visibly reachable through the keyboard`);
  }
  return trigger;
}
async function closedChrome(p) {
  assert.equal(await projectMenu(p).evaluate(el => el.open), false);
  assert.equal(await p.getByRole("button", { name: "Save", exact: true }).isVisible(), false, "Secondary actions stay grouped until requested");
  assert.equal(await p.locator(".sidebar .palette").count(), 0, "Node choices are not duplicated in navigation");
  assert.equal(await p.getByRole("group", { name: "Plan views", exact: true }).count(), 1);
  const geometry = await p.locator(".topbar").evaluate(el => ({
    width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
    controls: [...el.querySelectorAll("button, summary")].filter(control => {
      const closed = control.closest("details:not([open])");
      return (!closed || closed.querySelector("summary") === control) && control.getClientRects().length && getComputedStyle(control).visibility !== "hidden";
    }).map(control => ({ name: control.getAttribute("aria-label") || control.textContent.trim(), ...control.getBoundingClientRect().toJSON() })),
  }));
  assert.ok(geometry.documentWidth <= geometry.width + 1, "Grouped controls do not cause page-wide overflow");
  for (const control of geometry.controls)
    assert.ok(control.left >= 0 && control.right <= geometry.width + 1 && control.top >= 0 && control.bottom <= geometry.height + 1, `${control.name} stays inside the window`);
  return geometry;
}

test("grouped project and node actions stay readable, keyboard reachable, and preserve the plan", { timeout: 180000 }, async t => {
  const h = await setupBrowser(t, { name: "declutter", planningFixture: true, viewport: { width: 1440, height: 900 } });
  const p = h.page, fixture = await prepareUxFixture(h);
  await openUxPanels(h, fixture);
  await h.saved();
  const before = await h.api(`/projects/${fixture.id}`);
  const measurements = [];
  const capture = async (page, key) => {
    measurements.push({ key, ...await closedChrome(page) });
    await page.screenshot({ path: path.join(h.output, `${key}.png`) });
    const trigger = await keyboardProjectMenu(page);
    await page.screenshot({ path: path.join(h.output, `${key}-project-menu.png`) });
    await page.keyboard.press("Escape");
    await focused(trigger);
    if (await page.locator(".workspace").evaluate(el => el.classList.contains("compact-workspace"))) {
      const navigation = page.getByRole("button", { name: "Toggle navigation", exact: true });
      if (await navigation.getAttribute("aria-expanded") !== "true") await navigation.click();
      const geometry = await page.evaluate(() => ({ header: document.querySelector(".topbar").getBoundingClientRect().toJSON(), navigation: document.querySelector("#workspace-navigation").getBoundingClientRect().toJSON() }));
      await page.screenshot({ path: path.join(h.output, `${key}-navigation.png`) });
      assert.ok(geometry.navigation.top >= geometry.header.bottom - 1, "Compact navigation starts below the complete header");
      assert.equal(await navigation.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }), true, "Navigation can be closed from the visible header");
      await navigation.click();
    }
  };
  for (const theme of ["light", "dark"]) {
    await p.setViewportSize({ width: 1440, height: 900 });
    await setTheme(p, theme);
    for (const [width, height] of [[1440, 900], [1280, 800], [720, 700]]) {
      await p.setViewportSize({ width, height });
      await until(() => p.locator(".workspace").evaluate(el => el.classList.contains("compact-workspace") === (innerWidth <= 900 || innerHeight <= 650)));
      await capture(p, `${theme}-${width}x${height}`);
    }
  }
  await p.setViewportSize({ width: 1440, height: 900 });
  // A dialog opened from a closed-on-activation menu returns to its visible trigger.
  await projectTrigger(p).focus();
  await p.keyboard.press("Enter");
  await p.keyboard.press("Tab");
  await focused(projectMenu(p).getByRole("button", { name: "Project brief", exact: true }));
  await p.keyboard.press("Enter");
  await p.getByRole("dialog", { name: "Project brief", exact: true }).waitFor();
  await p.keyboard.press("Escape");
  await focused(projectTrigger(p));
  const add = p.locator(".add-menu");
  await add.locator("summary").focus();
  await p.keyboard.press("Enter");
  for (const name of ["Add Start", "Add End", "Add Process", "Add Decision", "Add Input / output", "Add Note"]) {
    await p.keyboard.press("Tab");
    await focused(add.getByRole("button", { name, exact: true }));
  }
  await p.keyboard.press("Escape");
  await focused(add.locator("summary"));
  await withBrowserZoom(h, async (zoomed, setZoom) => {
    // A fresh browser has no remembered project; select the fixture explicitly.
    const navigation = zoomed.page.getByRole("button", { name: "Toggle navigation", exact: true });
    if (await navigation.getAttribute("aria-expanded") === "false") await navigation.click();
    await zoomed.page.getByRole("navigation", { name: "Projects", exact: true }).getByRole("button").filter({ hasText: fixture.envelope.content.name }).click();
    await zoomed.page.locator(`.react-flow__node[data-id="${fixture.decision.id}"]`).waitFor();
    await openUxPanels(zoomed, fixture);
    assert.equal(await setZoom(2), 2);
    await until(() => zoomed.page.evaluate(() => innerWidth === 640 && innerHeight === 400));
    for (const theme of ["light", "dark"]) {
      await setTheme(zoomed.page, theme);
      await capture(zoomed.page, `${theme}-browser-zoom-200`);
    }
    await zoomed.page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = zoomed.page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("button", { name: "Appearance", exact: true }).click();
    await settings.getByLabel("Text size", { exact: true }).selectOption("large");
    await zoomed.page.keyboard.press("Escape");
    await capture(zoomed.page, "dark-browser-zoom-200-large");
  });
  const after = await h.api(`/projects/${fixture.id}`);
  assert.deepEqual(after.content, before.content, "Inspecting grouped controls leaves the plan unchanged");
  assert.deepEqual(after.history, before.history, "Navigation and appearance changes do not add undo history");
  assert.equal(after.cursor, before.cursor);
  fs.writeFileSync(path.join(h.output, "declutter-measurements.json"), JSON.stringify(measurements, null, 2));
  console.log(`DECLUTTER_ARTIFACTS=${h.output}`);
});

test("compact Plan views leave Chat visibly and proposal review keeps project switching guarded", { timeout: 90000 }, async t => {
  const h = await setupBrowser(t, { name: "declutter-navigation", planningFixture: true, seed: { name: "Compact review" }, viewport: { width: 720, height: 700 } });
  const p = h.page;
  const chat = p.getByRole("complementary", { name: "Planning conversation", exact: true });
  const openChat = async () => {
    if (!(await chat.isVisible())) await p.getByRole("button", { name: "Toggle planning chat", exact: true }).click();
    await chat.getByRole("tab", { name: "Chat", exact: true }).click();
    await p.getByLabel("Message Codex", { exact: true }).waitFor();
  };
  await until(() => p.locator(".workspace").evaluate(el => el.classList.contains("compact-workspace")));
  await openChat();
  const draft = "Keep this writing while changing the visible plan view.";
  await p.getByLabel("Message Codex", { exact: true }).fill(draft);
  const before = await h.api(`/projects/${h.initial.id}`);
  await p.getByRole("group", { name: "Plan views", exact: true }).getByRole("button", { name: "Build", exact: true }).click();
  await p.getByRole("region", { name: "Build tasks", exact: true }).waitFor();
  assert.equal(await chat.isVisible(), false);
  await openChat();
  assert.equal(await p.getByLabel("Message Codex", { exact: true }).inputValue(), draft);
  await p.getByRole("group", { name: "Plan views", exact: true }).getByRole("button", { name: "Diagram", exact: true }).click();
  await p.getByTestId("diagram-canvas").waitFor();
  assert.equal(await chat.isVisible(), false);
  const after = await h.api(`/projects/${h.initial.id}`);
  assert.deepEqual(after.content, before.content);
  assert.deepEqual(after.history, before.history);
  await openChat();
  await p.getByLabel("Message Codex", { exact: true }).fill("Add a review step");
  await p.getByRole("button", { name: "Send", exact: true }).click();
  const proposed = p.getByRole("region", { name: "Proposed changes workspace", exact: true });
  await proposed.waitFor();
  assert.equal(await p.getByRole("group", { name: "Plan views", exact: true }).count(), 0, "Plan navigation cannot hide a live proposal draft");
  await openProjectMenu(p);
  for (const name of [/Import JSON$/, /Load example$/])
    assert.equal(await projectMenu(p).getByRole("button", { name, exact: true }).isDisabled(), true, "Project replacement remains guarded while reviewing a proposal");
  await p.keyboard.press("Escape");
  await focused(projectTrigger(p));
  assert.equal(await proposed.isVisible(), true);
  assert.deepEqual((await h.api(`/projects/${h.initial.id}`)).content, before.content, "Agent edits remain unapplied");
  await p.screenshot({ path: path.join(h.output, "compact-proposal-navigation.png") });
});
