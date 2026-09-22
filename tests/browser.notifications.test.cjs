/* Notification delivery is deterministic; all servers, source files and responses are disposable. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupBrowser, until, settledCanvas } = require("./browser-harness.cjs");
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
  await until(async () => await notices(p).getAttribute("data-placement") === "rail");
  const geometry = await p.evaluate(() => {
    const notification = document.querySelector(".activity-notices").getBoundingClientRect();
    const controls = [...document.querySelectorAll('.topbar, .planning-heading, .planning-tabs, .planning-body, .planning-composer, #planning-compose, [aria-label="Resize message composer"], .proposal-review-bar, .proposal-tools')]
      .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
      .map(el => {
        // A constrained tab intentionally scrolls; only its visible portion can
        // be obstructed. Retain overlap checks against all clipping ancestors.
        const rect = el.getBoundingClientRect().toJSON();
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
          if (/auto|scroll|hidden|clip/.test(style.overflowX)) { rect.left = Math.max(rect.left, bounds.left); rect.right = Math.min(rect.right, bounds.right); }
          if (/auto|scroll|hidden|clip/.test(style.overflowY)) { rect.top = Math.max(rect.top, bounds.top); rect.bottom = Math.min(rect.bottom, bounds.bottom); }
        }
        return { label: el.getAttribute("aria-label") || el.className, rect };
      });
    return { notification: notification.toJSON(), controls, width: innerWidth, height: innerHeight };
  });
  const n = geometry.notification;
  assert.ok(n.left >= 0 && n.top >= 0 && n.right <= geometry.width + 1 && n.bottom <= geometry.height + 1, "Notices stay within the visible window");
  for (const { label, rect } of geometry.controls) {
    const overlap = Math.min(n.right, rect.right) - Math.max(n.left, rect.left) > 1 && Math.min(n.bottom, rect.bottom) - Math.max(n.top, rect.top) > 1;
    assert.equal(overlap, false, `Notification must not cover ${label}`);
  }
  const clickable = button => button.evaluate(el => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  const dismissButtons = notices(p).getByRole("button", { name: /^Dismiss / });
  const count = await dismissButtons.count();
  for (let index = 0; index < count; index++) {
    const dismiss = dismissButtons.nth(index);
    await dismiss.focus();
    assert.equal(await clickable(dismiss), true, "Every Dismiss remains reachable in the bounded scroll area");
    await p.keyboard.press("Tab");
    const open = notices(p).getByRole("button", { name: /^Open / }).nth(index);
    assert.equal(await open.evaluate(el => el === document.activeElement), true, "Keyboard reaches each Open from its Dismiss");
    assert.equal(await clickable(open), true, "Every Open remains reachable in the bounded scroll area");
  }
  if (await notices(p).locator(".activity-results").evaluate(el => el.scrollWidth > el.clientWidth + 1)) {
    const endPosition = await notices(p).locator(".activity-results").evaluate(el => el.scrollLeft);
    await notices(p).getByRole("button", { name: "Scroll to earlier activity", exact: true }).click();
    await until(() => notices(p).locator(".activity-results").evaluate((el, before) => el.scrollLeft < before, endPosition));
    const earlierPosition = await notices(p).locator(".activity-results").evaluate(el => el.scrollLeft);
    await notices(p).getByRole("button", { name: "Scroll to later activity", exact: true }).click();
    await until(() => notices(p).locator(".activity-results").evaluate((el, before) => el.scrollLeft > before, earlierPosition));
  }
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
  feed.set([operation("planning", "succeeded"), operation("scan", "failed"), operation("execution", "cancelled")]);
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
    const canvas = await settledCanvas(zoomed.page.getByTestId("diagram-canvas"));
    await canvas.locator(".react-flow__node").first().click();
    assert.equal(await setZoom(2), 2);
    await until(() => zoomFeed.polls() >= 1);
    await openChat(zoomed.page);
    zoomFeed.set([operation("planning", "succeeded"), operation("scan", "failed"), operation("execution", "cancelled")]);
    await notices(zoomed.page).getByRole("button", { name: "Open Codex replied", exact: true }).waitFor();
    const resizer = zoomed.page.getByRole("separator", { name: "Resize message composer", exact: true });
    const composer = zoomed.page.getByLabel("Message Codex", { exact: true });
    await composer.fill("Keep this next question while reviewing.");
    for (const key of ["Home", "End"]) {
      await resizer.focus(); await resizer.press(key);
      await assertNoticeClearOfControls(zoomed.page);
      await composer.focus();
      const textArea = await composer.evaluate(el => {
        const style = getComputedStyle(el);
        return { height: el.getBoundingClientRect().height, contentHeight: el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom), lineHeight: parseFloat(style.lineHeight) };
      });
      assert.ok(textArea.height >= 44, `${key} keeps a useful writing surface at 200%: ${JSON.stringify(textArea)}`);
      assert.ok(textArea.contentHeight >= textArea.lineHeight, `${key} leaves at least one complete, unclipped text line`);
      assert.equal(await composer.inputValue(), "Keep this next question while reviewing.");
      const send = zoomed.page.getByRole("button", { name: "Send", exact: true });
      await send.focus();
      assert.equal(await send.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, "Scrolling reaches Send at 200%");
    }
    const history = zoomed.page.locator("#planning-view-conversation .planning-scroll");
    await history.focus();
    assert.ok(await history.evaluate(el => el.clientHeight >= 56), "Constrained chat keeps a readable history area");
    await composer.focus();
    await zoomed.page.screenshot({ path: path.join(h.output, "placement-200-percent.png") });
    await planning(zoomed.page).getByRole("tab", { name: /^Comments/ }).click();
    const comment = zoomed.page.getByLabel(/^Comment on:/);
    await comment.fill("Keep this comment readable at 200 percent.");
    await assertNoticeClearOfControls(zoomed.page);
    await comment.focus();
    const commentText = await comment.evaluate(el => {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      return { contentHeight: el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom), lineHeight: parseFloat(style.lineHeight), reachable: el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
    });
    assert.ok(commentText.contentHeight >= commentText.lineHeight, `The Comments input keeps a complete text line at 200%: ${JSON.stringify(commentText)}`);
    assert.equal(commentText.reachable, true, "Comments remain editable above the rail");
    await comment.focus(); await zoomed.page.keyboard.press("Tab");
    const addComment = zoomed.page.getByRole("button", { name: "Add comment", exact: true });
    assert.equal(await addComment.evaluate(el => document.activeElement === el), true);
    assert.equal(await addComment.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, "Comment submission stays reachable");
    const commentHistory = zoomed.page.getByLabel("Comment history", { exact: true });
    await commentHistory.focus();
    assert.ok(await commentHistory.evaluate(el => el.clientHeight >= 56), "Constrained Comments keeps a readable list area");
    await comment.focus();
    await zoomed.page.screenshot({ path: path.join(h.output, "placement-comments-200-percent.png") });

    // Stress the measured minimum with real revision UI, a selected node,
    // a long title and larger text. Only fixture response wording is varied.
    await zoomed.page.route("**/planning/proposals/*", async route => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch(), value = await response.json();
      if (value.proposal) value.proposal.title = "Review the deliberately long implementation requirements and keep each existing constraint explicit for the next coding step";
      await route.fulfill({ response, json: value });
    });
    const revisionResponse = await request(h, "Add a review step");
    // This request was admitted through the fixture API. Reopen the already-idle
    // panel to load that new backend state, as a normal user visit would.
    await planning(zoomed.page).getByRole("button", { name: "Close planning conversation", exact: true }).click();
    await zoomed.page.getByRole("button", { name: "Toggle planning chat", exact: true }).click();
    const proposal = zoomed.page.locator(`#proposal-${revisionResponse.proposals.at(-1).id}`);
    await proposal.waitFor({ state: "attached" });
    // The incoming preview now loads and focuses Canvas. Await that completed
    // transition before starting revision, instead of racing its temporary dock.
    const proposalWorkspace = zoomed.page.getByRole("region", { name: "Proposed changes workspace", exact: true });
    await proposalWorkspace.getByRole("button", { name: "Ask Codex", exact: true }).click();
    await planning(zoomed.page).getByText("Revising:", { exact: false }).waitFor();
    assert.match(await planning(zoomed.page).locator(".planning-revision-context").innerText(), /deliberately long/);
    await planning(zoomed.page).getByRole("button", { name: /^Show selected node:/ }).waitFor();
    await zoomed.page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = zoomed.page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByLabel("Text size", { exact: true }).selectOption("large");
    await zoomed.page.keyboard.press("Escape");
    await composer.fill("Clarify this requirement without changing my other constraints.");
    await composer.focus();
    const stressed = await composer.evaluate(el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { height: r.height, contentHeight: el.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom), lineHeight: parseFloat(s.lineHeight), reachable: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; });
    assert.ok(stressed.height >= 44 && stressed.contentHeight >= stressed.lineHeight, `Long revision and larger text retain readable writing: ${JSON.stringify(stressed)}`);
    assert.equal(stressed.reachable, true);
    await history.focus();
    assert.ok(await history.evaluate(el => el.clientHeight >= 56));
    assert.equal(await history.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, "Keyboard reaches history despite the tall composer");
    const send = zoomed.page.getByRole("button", { name: "Send", exact: true });
    await send.focus();
    assert.equal(await send.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, "Keyboard reaches Send despite the tall composer");
    await assertNoticeClearOfControls(zoomed.page);
    await composer.focus();
    await zoomed.page.screenshot({ path: path.join(h.output, "placement-revision-large-200-percent.png") });
    const cancelRevision = planning(zoomed.page).getByRole("button", { name: "Cancel proposal revision", exact: true });
    await cancelRevision.focus();
    assert.equal(await cancelRevision.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, "Keyboard reaches revision context controls");
    await send.focus();
    await zoomed.page.screenshot({ path: path.join(h.output, "placement-revision-large-actions-200-percent.png") });
  });
});


test("three activity notices preserve canvas state and leave proposal review directly usable", { timeout: 120000 }, async t => {
  const h = await setupBrowser(t, { name: "qol-notification-review", planningFixture: true, viewport: { width: 1440, height: 900 } });
  const p = h.page, feed = await feedFixture(h);
  await until(() => feed.polls() >= 1);
  const response = await request(h, "Add a review step");
  const proposalId = response.proposals.at(-1).id;
  await openChat(p);
  await planning(p).getByRole("tab", { name: /^Changes/ }).click();
  const reviewButton = p.locator(`#proposal-${proposalId}`).getByRole("button", { name: "Review on canvas", exact: true });
  await reviewButton.waitFor();
  // A fresh agent proposal opens its preview automatically; return to the saved
  // canvas before measuring whether activity changes its viewport or history.
  await p.getByRole("region", { name: "Proposed changes workspace", exact: true }).waitFor();
  await p.getByRole("button", { name: "Back to plan", exact: true }).click();
  await settledCanvas(p.getByTestId("diagram-canvas"));
  await h.saved();
  const before = await h.api(`/projects/${h.initial.id}`);
  const viewport = () => p.getByTestId("diagram-canvas").locator(".react-flow__viewport").evaluate(el => el.style.transform);
  const originalViewport = await viewport();
  const cases = [operation("planning", "failed"), operation("planning", "succeeded", { needsReview: true }), operation("scan", "failed")];
  feed.set(cases);
  await until(async () => await notices(p).locator("article").count() === 3);
  await assertNoticeClearOfControls(p);
  assert.equal(await viewport(), originalViewport, "A reserved activity row does not refit or pan the diagram");
  const withNotices = await h.api(`/projects/${h.initial.id}`);
  assert.deepEqual(withNotices.content, before.content);
  assert.deepEqual(withNotices.history, before.history);
  assert.equal(withNotices.cursor, before.cursor);
  // The former floating stack intercepted this exact control in both platform suites.
  await reviewButton.click();
  await p.getByRole("region", { name: "Proposed changes workspace", exact: true }).waitFor();
  assert.equal(await notices(p).locator("article").count(), 3);
  await p.screenshot({ path: path.join(h.output, "three-notices-proposal-review.png") });
  // Return without applying a proposal; appearance and dismissal remain non-project work.
  await p.getByRole("button", { name: "Back to plan", exact: true }).click();
  await settledCanvas(p.getByTestId("diagram-canvas"));
  const beforeDismissViewport = await viewport();
  while (await notices(p).locator("article").count()) await notices(p).getByRole("button", { name: /^Dismiss / }).first().click();
  await until(async () => await notices(p).count() === 0);
  assert.equal(await viewport(), beforeDismissViewport, "Dismissing the rail does not refit or pan the diagram");
  const after = await h.api(`/projects/${h.initial.id}`);
  assert.deepEqual(after.content, before.content);
  assert.deepEqual(after.history, before.history);
  assert.equal(after.cursor, before.cursor);
});
