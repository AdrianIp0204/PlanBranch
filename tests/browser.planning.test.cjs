const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { setupBrowser, until, wait } = require("./browser-harness.cjs");
const planning = (p) =>
  p.getByRole("complementary", { name: "Planning conversation" });
const review = (p) => p.getByRole("tab", { name: /^(Review|Changes)/ });
const conversation = (p) =>
  p.getByRole("tab", { name: /^(Conversation|Chat)$/ });
async function open(p) {
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
  if (!(await planning(p).isVisible()))
    await p
      .getByRole("button", { name: "Toggle planning chat", exact: true })
      .click();
  await planning(p).waitFor();
  await until(
    async () =>
      (await p.getByLabel("Message Codex", { exact: true }).count()) &&
      !(await planning(p).getByText("Loading conversation…").count()),
  );
}
async function send(p, text) {
  await conversation(p).click();
  await p.getByLabel("Message Codex", { exact: true }).fill(text);
  await p.getByRole("button", { name: "Send", exact: true }).click();
}
async function settled(h) {
  return until(async () => {
    const s = await h.api(`/projects/${h.initial.id}/planning`);
    return s.request && s.request.status !== "running" ? s : false;
  });
}
async function proposal(p) {
  await review(p).click();
  const item = p.getByRole("article", { name: "Add a review step" }).first();
  await item.waitFor();
  return item;
}
async function save(h) {
  await h.page.getByRole("button", { name: "Save", exact: true }).click();
  await h.saved();
}

test(
  "planning conversation, node comments, explicit edit review, durable approval and undo",
  { timeout: 150000 },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "planning-review",
        planningFixture: true,
        viewport: { width: 1440, height: 900 },
      }),
      p = h.page;
    const url = `/projects/${h.initial.id}`;
    await open(p);
    const original = await h.api(url);
    await send(p, "Add a review step");
    await settled(h);
    const item = await proposal(p);
    assert.deepEqual(
      (await h.api(url)).content,
      original.content,
      "A reply never directly modifies the plan",
    );
    assert.ok(await item.getByText("Before", { exact: true }).count());
    assert.ok(await item.getByText("After", { exact: true }).count());
    await item.getByRole("button", { name: "Reject changes" }).click();
    await item.getByText("Rejected", { exact: true }).waitFor();
    assert.deepEqual((await h.api(url)).content, original.content);
    assert.equal(await p.evaluate(() => window.fixtureInjected), undefined);
    const node = original.content.diagrams[0].nodes.find(
      (n) => n.type === "process",
    );
    await p.locator(".react-flow__controls-fitview").click();
    await p.locator(`.react-flow__node[data-id="${node.id}"]`).click();
    await p.getByRole("tab", { name: /^Comments/ }).click();
    await p
      .getByLabel(/^Comment on:/)
      .fill("Clarify the expected result <img src=x onerror=alert(1)>");
    await p.getByRole("button", { name: "Add comment", exact: true }).click();
    await p
      .getByRole("button", { name: "Resolve comment", exact: true })
      .waitFor();
    assert.equal(
      await p
        .getByRole("button", { name: "Approve plan", exact: true })
        .isDisabled(),
      true,
    );
    await send(p, "Add a review step fail once");
    await p
      .getByRole("button", { name: "Retry agent reply", exact: true })
      .waitFor();
    await p
      .getByRole("button", { name: "Retry agent reply", exact: true })
      .click();
    await settled(h);
    await review(p).click();
    const next = p.getByRole("article", { name: "Add a review step" }).first();
    // Drop the first response after the backend has committed acceptance.
    let lost = false;
    const acceptRoute = "**/planning/proposals/*/accept";
    await p.route(acceptRoute, async (route) => {
      if (!lost) {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await next.getByRole("button", { name: "Accept changes" }).click();
    await planning(p).getByRole("alert").waitFor();
    await next.getByRole("button", { name: "Accept changes" }).click();
    await p.unroute(acceptRoute);
    await next.getByText("Accepted", { exact: true }).waitFor();
    await h.saved();
    const accepted = await h.api(url);
    assert.equal(
      accepted.content.diagrams[0].nodes.length,
      original.content.diagrams[0].nodes.length + 1,
    );
    assert.equal(accepted.history.length, original.history.length + 1);
    assert.equal(
      (await h.api(url + "/planning")).messages.filter(
        (m) => m.text === "Add a review step fail once",
      ).length,
      1,
    );
    await p.getByRole("tab", { name: /^Comments/ }).click();
    await p
      .getByRole("button", { name: "Resolve comment", exact: true })
      .click();
    await until(
      async () =>
        !(await p
          .getByRole("button", { name: "Approve plan", exact: true })
          .isDisabled()),
    );
    await p.getByRole("button", { name: "Approve plan", exact: true }).click();
    await p.getByText(/^(Plan approved|Approved)$/).waitFor();
    await h.restart();
    await open(p);
    await p.getByText(/^(Plan approved|Approved)$/).waitFor();
    assert.equal((await h.api(url + "/planning")).approval.current, true);
    await p.getByRole("button", { name: /^Undo/ }).click();
    await h.saved();
    await p.getByText(/^(Plan needs review|Needs review)$/).waitFor();
    assert.deepEqual((await h.api(url)).content, original.content);
    await h.restart();
    await open(p);
    await p.getByRole("button", { name: /^Redo/ }).click();
    await h.saved();
    assert.deepEqual((await h.api(url)).content, accepted.content);
    await p.getByRole("tab", { name: /^Comments/ }).click();
    await p.getByLabel("Include resolved").check();
    await p
      .getByText("Clarify the expected result <img src=x onerror=alert(1)>", {
        exact: true,
      })
      .waitFor();
    await p.screenshot({ path: path.join(h.output, "review-1440.png") });
  },
);

test(
  "outdated proposals and interrupted saves preserve current work",
  { timeout: 120000 },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "planning-stale",
        planningFixture: true,
      }),
      p = h.page;
    await open(p);
    await send(p, "Add a review step slow");
    await p.getByRole("button", { name: "Add Process", exact: true }).click();
    await save(h);
    const latest = await h.api(`/projects/${h.initial.id}`);
    await settled(h);
    const item = await proposal(p);
    await item.getByText("Plan changed", { exact: true }).waitFor();
    assert.equal(
      await item.getByRole("button", { name: "Accept changes" }).count(),
      0,
    );
    assert.deepEqual(
      (await h.api(`/projects/${h.initial.id}`)).content,
      latest.content,
    );
    await item
      .getByRole("button", { name: "Request updated proposal" })
      .click();
    assert.match(
      await p.getByLabel("Message Codex", { exact: true }).inputValue(),
      /update your proposal/,
    );
    await p.getByRole("button", { name: "Add Process", exact: true }).click();
    const fault = `**/api/projects/${h.initial.id}`;
    await p.route(fault, (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Disk temporarily unavailable" }),
          })
        : route.continue(),
    );
    await p.getByRole("button", { name: "Send", exact: true }).click();
    await p.getByRole("button", { name: "Retry save", exact: true }).waitFor();
    assert.match(
      await p.getByLabel("Message Codex", { exact: true }).inputValue(),
      /update your proposal/,
    );
    await p
      .getByRole("button", { name: "Close planning conversation", exact: true })
      .click();
    await p.unroute(fault);
    await p.getByRole("button", { name: "Retry save", exact: true }).click();
    await h.saved();
    await open(p);
    await p.getByRole("button", { name: "Send", exact: true }).click();
    await settled(h);
    const updated = await proposal(p);
    await updated.getByRole("button", { name: "Reject changes" }).click();
    await updated.getByText("Rejected", { exact: true }).waitFor();
  },
);

test(
  "planning pane resizing, keyboard focus and drafts survive navigation",
  { timeout: 120000 },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "planning-layout",
        planningFixture: true,
        viewport: { width: 1280, height: 800 },
      }),
      p = h.page;
    await open(p);
    await h.saved();
    const before = await h.api(`/projects/${h.initial.id}`);
    await p
      .getByLabel("Message Codex", { exact: true })
      .fill("Keep this unsent planning thought");
    const separator = p.getByRole("separator", {
      name: "Resize planning chat",
      exact: true,
    });
    await separator.focus();
    const old = Number(await separator.getAttribute("aria-valuenow"));
    await p.keyboard.press("ArrowLeft");
    assert.ok(Number(await separator.getAttribute("aria-valuenow")) > old);
    await p
      .getByRole("button", { name: "Close planning conversation", exact: true })
      .click();
    await until(async () =>
      p
        .getByRole("button", { name: "Toggle planning chat", exact: true })
        .evaluate((e) => document.activeElement === e),
    );
    await open(p);
    assert.equal(
      await p.getByLabel("Message Codex", { exact: true }).inputValue(),
      "Keep this unsent planning thought",
    );
    await conversation(p).focus();
    await p.keyboard.press("ArrowRight");
    await until(async () =>
      p
        .getByRole("tab", { name: /^Comments/ })
        .evaluate((e) => document.activeElement === e),
    );
    await p.keyboard.press("End");
    assert.equal(await review(p).getAttribute("aria-selected"), "true");
    await conversation(p).click();
    assert.deepEqual(
      (await h.api(`/projects/${h.initial.id}`)).content,
      before.content,
    );
    await p.locator("#open-catalogue").click();
    const sendButton = p.getByRole("button", { name: "Send", exact: true });
    assert.equal(
      await sendButton.evaluate((element) => {
        const control = element.getBoundingClientRect();
        const pane = element.closest(".planning-pane").getBoundingClientRect();
        return control.top >= pane.top && control.bottom <= pane.bottom + 1;
      }),
      true,
      "Send remains reachable while the catalogue is open",
    );
    await p.screenshot({
      path: path.join(h.output, "planning-catalogue-1280.png"),
    });
    await p
      .getByRole("button", { name: "Close variable panel", exact: true })
      .click();
    await p
      .getByRole("tab", { name: /^(Conversation|Chat)$/ })
      .scrollIntoViewIfNeeded();
    await p.screenshot({ path: path.join(h.output, "planning-1280.png") });
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.screenshot({ path: path.join(h.output, "planning-1440.png") });
    await p.emulateMedia({ reducedMotion: "reduce" });
    await p.setViewportSize({ width: 720, height: 700 });
    await open(p);
    await p
      .getByLabel("Message Codex", { exact: true })
      .scrollIntoViewIfNeeded();
    assert.equal(
      await p.getByLabel("Message Codex", { exact: true }).isVisible(),
      true,
    );
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await p.reload();
    await open(p);
    assert.equal(
      await p.getByLabel("Message Codex", { exact: true }).inputValue(),
      "Keep this unsent planning thought",
    );
  },
);
