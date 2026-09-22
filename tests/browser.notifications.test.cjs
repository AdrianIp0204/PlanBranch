/* Notification delivery is deterministic; all servers, source files and responses are disposable. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupBrowser, until } = require("./browser-harness.cjs");
const { withBrowserZoom } = require("./ux-fixture.cjs");

const notices = p => p.getByRole("complementary", { name: "Activity notifications", exact: true });
const planning = p => p.getByRole("complementary", { name: "Planning conversation", exact: true });
async function openChat(p) {
  if (!(await planning(p).isVisible())) await p.getByRole("button", { name: "Toggle planning chat", exact: true }).click();
  await planning(p).getByRole("tab", { name: "Chat", exact: true }).click();
  await p.getByLabel("Message Codex", { exact: true }).waitFor();
}
async function feedFixture(h) {
  let operations = [], polls = 0;
  await h.page.route(`**/api/projects/${h.initial.id}/operations`, async route => {
    polls++;
    await route.fulfill({ json: { operations } });
  });
  return { set(value) { operations = value; }, polls: () => polls };
}
function operation(kind, state, extra = {}) {
  return { kind, id: crypto.randomUUID(), state, createdAt: new Date().toISOString(), ...extra };
}
async function assertNoticeClearOfControls(p) {
  await until(async () => await notices(p).getAttribute("data-placement") === "chat");
  const geometry = await p.evaluate(() => {
    const notification = document.querySelector(".activity-notices").getBoundingClientRect();
    const controls = [...document.querySelectorAll('.topbar, .planning-heading, .planning-tabs, #planning-compose, [aria-label="Resize message composer"]')]
      .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
      .map(el => ({ label: el.getAttribute("aria-label") || el.className, rect: el.getBoundingClientRect().toJSON() }));
    return { notification: notification.toJSON(), controls, width: innerWidth, height: innerHeight };
  });
  const n = geometry.notification;
  assert.ok(n.left >= 0 && n.top >= 0 && n.right <= geometry.width + 1 && n.bottom <= geometry.height + 1, "Notices stay within the visible window");
  for (const { label, rect } of geometry.controls) {
    const overlap = Math.min(n.right, rect.right) - Math.max(n.left, rect.left) > 1 && Math.min(n.bottom, rect.bottom) - Math.max(n.top, rect.top) > 1;
    assert.equal(overlap, false, `Notification must not cover ${label}`);
  }
  const dismiss = notices(p).getByRole("button", { name: /^Dismiss / }).first();
  await dismiss.focus();
  const clickable = button => button.evaluate(el => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  assert.equal(await clickable(dismiss), true, "Dismiss remains reachable in the bounded scroll area");
  await p.keyboard.press("Tab");
  const open = notices(p).getByRole("button", { name: /^Open / }).first();
  assert.equal(await open.evaluate(el => el === document.activeElement), true, "Keyboard reaches Open from Dismiss");
  assert.equal(await clickable(open), true, "Open remains reachable in the bounded scroll area");
}
async function request(h, text) {
  const envelope = await h.api(`/projects/${h.initial.id}`);
  const started = await h.api(`/projects/${h.initial.id}/planning/messages`, "POST", {
    mutationId: crypto.randomUUID(), text, diagramId: envelope.content.diagrams[0].id, nodeId: null,
  });
  return until(async () => {
    const state = await h.api(`/projects/${h.initial.id}/planning`);
    return state.request?.id === started.request.id && !["queued", "running"].includes(state.request.status) ? state : false;
  });
}

test("completion notices stay quiet while typing, distinguish outcomes, and do not replay after reload", { timeout: 120000 }, async t => {
  const h = await setupBrowser(t, { name: "qol-notifications", planningFixture: true, viewport: { width: 1280, height: 800 } });
  const p = h.page, feed = await feedFixture(h);
  await p.addInitScript(() => {
    window.notificationProbe = { permissions: 0, desktop: 0, audio: 0 };
    class QuietNotification {
      static permission = "default";
      static async requestPermission() { window.notificationProbe.permissions++; return "denied"; }
      constructor() { window.notificationProbe.desktop++; }
    }
    class QuietAudio { constructor() { window.notificationProbe.audio++; this.state = "running"; } }
    Object.defineProperty(window, "Notification", { configurable: true, value: QuietNotification });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: QuietAudio });
  });
  await p.reload();
  await p.getByTestId("diagram-canvas").waitFor();
  await until(() => feed.polls() >= 1);
  await openChat(p);
  const composer = p.getByLabel("Message Codex", { exact: true });
  await composer.fill("Keep this unsent draft while results arrive.");
  await composer.focus();
  const success = operation("planning", "succeeded", { needsReview: true });
  feed.set([success]);
  await notices(p).getByRole("button", { name: "Open Plan changes ready for review", exact: true }).waitFor();
  assert.equal(await composer.evaluate(el => document.activeElement === el), true, "Arrival preserves typing focus");
  assert.equal(await composer.inputValue(), "Keep this unsent draft while results arrive.");
  await notices(p).getByRole("button", { name: "Dismiss Plan changes ready for review", exact: true }).click();
  assert.equal(await composer.evaluate(el => document.activeElement === el), true, "Dismiss returns focus to the writing field");
  const failed = operation("planning", "failed"), cancelled = operation("planning", "cancelled");
  feed.set([failed, cancelled, success]);
  await notices(p).getByRole("button", { name: "Open Planning failed", exact: true }).waitFor();
  await notices(p).getByRole("button", { name: "Open Planning cancelled", exact: true }).waitFor();
  const text = await notices(p).innerText();
  assert.doesNotMatch(text, /tests? passed|task complete|successfully/i);
  assert.equal(await composer.evaluate(el => document.activeElement === el), true);
  const count = feed.polls();
  await until(() => feed.polls() >= count + 2);
  assert.equal(await notices(p).locator("article").count(), 2, "Repeated polling does not duplicate notices");
  assert.deepEqual(await p.evaluate(() => window.notificationProbe), { permissions: 0, desktop: 0, audio: 0 });
  await p.screenshot({ path: path.join(h.output, "notifications-1280x800.png") });
  await p.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = p.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Agent", exact: true }).click();
  assert.equal(await settings.getByLabel("Play a short sound", { exact: true }).isChecked(), false);
  assert.deepEqual(await p.evaluate(() => window.notificationProbe), { permissions: 0, desktop: 0, audio: 0 }, "Opening Agent settings never requests permission");
  await p.keyboard.press("Escape");
  const beforeReload = feed.polls();
  await p.reload();
  await p.getByTestId("diagram-canvas").waitFor();
  await until(() => feed.polls() >= beforeReload + 2);
  assert.equal(await notices(p).count(), 0, "Historical results stay silent after reload");
  await openChat(p);
  await until(async () => await composer.inputValue() === "Keep this unsent draft while results arrive.");
  assert.equal((await h.api(`/projects/${h.initial.id}/planning`)).request, null, "Recovered writing never sends a request");
});

test("a planning notification opens and focuses its earlier response even after a newer reply", { timeout: 120000 }, async t => {
  const h = await setupBrowser(t, { name: "qol-notification-planning", planningFixture: true });
  const p = h.page;
  const first = await request(h, "Clarify requirements");
  assert.equal(first.request.status, "succeeded");
  const message = first.messages.find(item => item.id === first.questionSets.at(-1).messageId);
  assert.ok(message);
  await notices(p).getByRole("button", { name: "Open Codex needs your answer", exact: true }).waitFor();
  const newer = await request(h, "Discuss a later message");
  await notices(p).getByRole("button", { name: "Open Codex replied", exact: true }).waitFor();
  if (await planning(p).isVisible()) await planning(p).getByRole("button", { name: "Close planning conversation", exact: true }).click();
  await notices(p).getByRole("button", { name: "Open Codex needs your answer", exact: true }).click();
  const target = p.locator(`[data-message-id="${message.id}"]`);
  await target.waitFor();
  await until(() => target.evaluate(el => document.activeElement === el));
  assert.ok(await target.getByText("Choose the requirements for this plan.", { exact: true }).count());
  assert.equal(await notices(p).getByRole("button", { name: "Open Codex needs your answer", exact: true }).count(), 0);
  assert.equal((await h.api(`/projects/${h.initial.id}/planning`)).questionSets.at(-1).state, newer.questionSets.at(-1).state, "Opening a result never answers or changes earlier questions");
});

test("scan notifications open the named historical scan rather than a newer successful scan", { timeout: 120000 }, async t => {
  const h = await setupBrowser(t, { name: "qol-notification-scan", planningFixture: true });
  const p = h.page, base = `/projects/${h.initial.id}`;
  fs.writeFileSync(path.join(h.sourceDir, "broken.py"), "def invalid(:\n", "utf8");
  await h.api(base + "/source", "POST", { root: h.sourceDir, ignores: [], confirmed: true });
  const scan = async () => {
    const start = await h.api(base + "/scans", "POST", {});
    return until(async () => {
      const result = await h.api(base + `/scans/${start.id}`);
      return ["queued", "running"].includes(result.status) ? false : result;
    });
  };
  const first = await scan();
  assert.ok(first.summary.errors > 0);
  await notices(p).getByRole("button", { name: "Open Python scan finished with issues", exact: true }).waitFor();
  fs.writeFileSync(path.join(h.sourceDir, "broken.py"), "valid_result = 1\n", "utf8");
  const latest = await scan();
  assert.equal(latest.summary.errors, 0);
  await notices(p).getByRole("button", { name: "Open Python scan finished", exact: true }).waitFor();
  const opened = p.waitForResponse(response => response.url().endsWith(`/scans/${first.id}`));
  await notices(p).getByRole("button", { name: "Open Python scan finished with issues", exact: true }).click();
  assert.equal((await opened).ok(), true);
  const dialog = p.getByRole("dialog", { name: "Python source", exact: true });
  await dialog.waitFor();
  assert.match(await dialog.locator(".scan-file-list").innerText(), /broken\.py[\s\S]*(error|invalid syntax)/i);
  assert.equal((await h.api(base + "/source")).latestScan.id, latest.id, "Inspecting a historical scan does not start another scan");
});

test("execution notification opens its exact historical run and exposes recorded failures without accepting work", { timeout: 120000 }, async t => {
  const h = await setupBrowser(t, { name: "qol-notification-execution", planningFixture: true });
  const p = h.page, feed = await feedFixture(h), task = { id: crypto.randomUUID(), title: "Fixture implementation", deliverable: "A disposable result", nodeLinks: [], prerequisiteIds: [], expectedFiles: ["fixture.py"], acceptanceChecks: [], status: "not_started" };
  const makeRun = (id, state, summary) => ({
    id, previewId: crypto.randomUUID(), taskId: task.id, taskTitle: task.title, state, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sourceCommit: "fixture-baseline", summary, error: state === "failed" ? "Newer fixture failure" : null, progress: "Finished fixture", acceptedDigest: null, completedCursor: null, applied: false,
    repository: { id: "fixture-repository", path: path.join(h.output, "read-only-fixture-response") },
    context: { task, brief: h.initial.content.brief, linkedNodes: [], sourceCommit: "fixture-baseline", generation: null },
    worktreePath: null, commands: [{ id: "observed-check", command: "fixture check", status: "completed", exitCode: 1, output: "Recorded check failed." }], events: [], artifact: null,
    planStale: false, sourceStale: false, applyPlanStale: false, applyRequest: null, applyState: null,
  });
  const old = makeRun(crypto.randomUUID(), "succeeded", "Historical fixture result"), latest = makeRun(crypto.randomUUID(), "failed", "Newer fixture result");
  const executionWrites = [];
  await p.route(`**/api/projects/${h.initial.id}/execution**`, async route => {
    const req = route.request(), pathname = new URL(req.url()).pathname;
    if (req.method() !== "GET") { executionWrites.push(pathname); return route.fulfill({ status: 400, json: { error: "This test never authorizes execution." } }); }
    if (pathname.endsWith("/execution")) return route.fulfill({ json: { repository: old.repository, runs: [latest, old], agent: { available: true, label: "Fixture" }, ownership: { available: true } } });
    const run = [old, latest].find(item => pathname.endsWith(`/runs/${item.id}`));
    return run ? route.fulfill({ json: { run } }) : route.continue();
  });
  await until(() => feed.polls() >= 1);
  feed.set([operation("execution", "succeeded", { id: old.id, taskId: task.id, taskTitle: task.title })]);
  await notices(p).getByRole("button", { name: "Open Coding step ready for review", exact: true }).waitFor();
  feed.set([operation("execution", "failed", { id: latest.id, taskId: task.id }), operation("execution", "succeeded", { id: old.id, taskId: task.id })]);
  await notices(p).getByRole("button", { name: "Open Coding step failed", exact: true }).waitFor();
  await notices(p).getByRole("button", { name: "Open Coding step ready for review", exact: true }).click();
  const dialog = p.getByRole("dialog", { name: "Run step", exact: true });
  await dialog.waitFor();
  await until(async () => await dialog.getByLabel("Execution history", { exact: true }).inputValue() === old.id);
  await dialog.getByText("Historical fixture result", { exact: true }).waitFor();
  assert.match(await dialog.getByRole("region", { name: "Observed commands", exact: true }).innerText(), /Exit 1/);
  assert.equal(await dialog.getByText("Newer fixture result", { exact: true }).count(), 0);
  assert.deepEqual(executionWrites, [], "Opening a result never runs, accepts, completes, or applies work");
});

test("notification placement leaves chat controls accessible at wide, narrow and actual 200 percent zoom", { timeout: 150000 }, async t => {
  const h = await setupBrowser(t, { name: "qol-notification-placement", planningFixture: true, viewport: { width: 1440, height: 900 } });
  const p = h.page, feed = await feedFixture(h);
  await until(() => feed.polls() >= 1);
  await openChat(p);
  feed.set([operation("planning", "succeeded"), operation("scan", "failed")]);
  await notices(p).getByRole("button", { name: "Open Codex replied", exact: true }).waitFor();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 720, height: 700 }]) {
    await p.setViewportSize(viewport);
    await openChat(p);
    await assertNoticeClearOfControls(p);
    const resizer = p.getByRole("separator", { name: "Resize message composer", exact: true });
    await resizer.focus(); await resizer.press("End");
    await assertNoticeClearOfControls(p);
    await p.screenshot({ path: path.join(h.output, `placement-${viewport.width}x${viewport.height}.png`) });
  }
  await withBrowserZoom(h, async (zoomed, setZoom) => {
    const zoomFeed = await feedFixture(zoomed);
    assert.equal(await setZoom(2), 2);
    await until(() => zoomFeed.polls() >= 1);
    await openChat(zoomed.page);
    zoomFeed.set([operation("planning", "succeeded"), operation("scan", "failed")]);
    await notices(zoomed.page).getByRole("button", { name: "Open Codex replied", exact: true }).waitFor();
    const resizer = zoomed.page.getByRole("separator", { name: "Resize message composer", exact: true });
    await resizer.focus(); await resizer.press("End");
    await assertNoticeClearOfControls(zoomed.page);
    await zoomed.page.screenshot({ path: path.join(h.output, "placement-200-percent.png") });
  });
});
