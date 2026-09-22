const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { setupBrowser, until } = require("./browser-harness.cjs");
const { withBrowserZoom } = require("./ux-fixture.cjs");
const dock = (p) =>
  p.getByRole("complementary", { name: "Planning conversation" });
async function open(p) {
  await p
    .getByRole("button", { name: "Toggle planning chat", exact: true })
    .waitFor();
  await until(() =>
    p
      .locator(".workspace")
      .evaluate(
        (el) =>
          el.classList.contains("compact-workspace") ===
          (innerWidth <= 900 || innerHeight <= 650),
      ),
  );
  if (!(await dock(p).isVisible()))
    await p
      .getByRole("button", { name: "Toggle planning chat", exact: true })
      .click();
  await p.getByRole("tab", { name: "Chat", exact: true }).click();
}
async function localModel(p) {
  await open(p);
  await dock(p).getByLabel("Provider", { exact: true }).selectOption("ollama");
  await until(
    async () =>
      await dock(p)
        .getByLabel("Model", { exact: true })
        .locator('option[value="fixture-local:small"]')
        .count(),
  );
  assert.equal(
    await dock(p)
      .getByLabel("Model", { exact: true })
      .locator('option[value="embedding-only:latest"]')
      .count(),
    0,
  );
  await dock(p)
    .getByLabel("Model", { exact: true })
    .selectOption("fixture-local:small");
}
async function composerGeometry(p) {
  const result = await dock(p).evaluate((root) => ({
    width: innerWidth,
    height: innerHeight,
    pageWidth: document.documentElement.scrollWidth,
    controls: [
      ...root.querySelectorAll(
        "textarea#planning-message,.planning-model-controls select,.planning-model-controls input,.planning-composer button[type=submit]",
      ),
    ].map((el) => ({
      name: el.getAttribute("aria-label") || el.id || el.textContent.trim(),
      ...el.getBoundingClientRect().toJSON(),
    })),
  }));
  assert.ok(
    result.pageWidth <= result.width + 1,
    "Provider controls do not widen the page",
  );
  assert.ok(
    result.controls.length >= 4,
    "Composer exposes writing, provider, model, and Send",
  );
  for (const control of result.controls)
    assert.ok(
      control.width > 0 &&
        control.height >= 24 &&
        control.left >= 0 &&
        control.right <= result.width + 1 &&
        control.top >= 0 &&
        control.bottom <= result.height + 1,
      `${control.name} remains visibly reachable: ${JSON.stringify(control)}`,
    );
  const writing = result.controls.find(
    (control) => control.name === "planning-message",
  );
  assert.ok(writing && writing.height >= 40, "Writing area remains usable");
  return result;
}
async function send(h, text) {
  await h.page.getByLabel("Message Ollama", { exact: true }).fill(text);
  await dock(h.page).getByRole("button", { name: "Send", exact: true }).click();
  return until(async () => {
    const s = await h.api(`/projects/${h.initial.id}/planning`);
    if (s.request?.status === "failed") throw Error(s.request.error);
    return s.request?.status === "succeeded" && s.request.text === text
      ? s
      : false;
  }, 30000);
}

test(
  "Ollama-only native discovery, questions, visual proposal, apply and restart-safe undo",
  { timeout: 120000 },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "providers-local",
        providerFixture: true,
        seed: { name: "Ollama-only planning" },
        viewport: { width: 1280, height: 800 },
      }),
      p = h.page;
    const original = await h.api(`/projects/${h.initial.id}`);
    assert.equal(
      (await h.api("/agent/status?provider=codex")).agent.available,
      false,
    );
    await localModel(p);
    const state = await send(h, "Ask one question");
    await p.getByRole("radio", { name: /SQLite/ }).check();
    await dock(p)
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await until(async () => {
      const s = await h.api(`/projects/${h.initial.id}/planning`);
      return (
        s.questionSets[0].state === "answered" &&
        s.request.status === "succeeded"
      );
    });
    await send(h, "Make a proposal");
    const workspace = p.getByRole("region", {
      name: "Proposed changes workspace",
    });
    await workspace.waitFor();
    await workspace
      .getByText("Ollama proposed step", { exact: true })
      .first()
      .waitFor();
    assert.deepEqual(
      (await h.api(`/projects/${h.initial.id}`)).content,
      original.content,
    );
    await p.screenshot({
      path: path.join(h.output, "ollama-review-1280.png"),
      fullPage: true,
    });
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.screenshot({
      path: path.join(h.output, "ollama-review-1440.png"),
      fullPage: true,
    });
    await workspace
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await workspace.waitFor({ state: "hidden" });
    await h.saved();
    assert.equal(
      (await h.api(`/projects/${h.initial.id}`)).content.diagrams[0].nodes
        .length,
      1,
    );
    await h.restart();
    await open(p);
    assert.equal(
      await dock(p).getByLabel("Provider", { exact: true }).inputValue(),
      "ollama",
    );
    assert.equal(
      await dock(p).getByLabel("Model", { exact: true }).inputValue(),
      "fixture-local:small",
    );
    const restored = await h.api(`/projects/${h.initial.id}/planning`);
    assert.equal(
      restored.messages
        .filter((m) => m.role === "assistant")
        .every((m) => m.provider === "ollama"),
      true,
    );
    await p.getByRole("button", { name: "Undo", exact: true }).click();
    await h.saved();
    assert.deepEqual(
      (await h.api(`/projects/${h.initial.id}`)).content,
      original.content,
    );
  },
);

test(
  "provider settings and compact composer remain accessible in dark, narrow and 200% layouts",
  { timeout: 100000 },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "providers-layout",
        providerFixture: true,
        seed: { name: "Provider layouts" },
        viewport: { width: 1440, height: 900 },
      }),
      p = h.page;
    await localModel(p);
    await p
      .getByLabel("Message Ollama", { exact: true })
      .fill("Recover this unsent writing");
    await p.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = p.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.getByLabel("Theme", { exact: true }).selectOption("dark");
    await dialog.getByRole("button", { name: "Agent", exact: true }).click();
    await dialog
      .getByRole("region", { name: "Provider connections" })
      .waitFor();
    assert.equal(await dialog.locator("input[type=password]").count(), 0);
    await p.screenshot({
      path: path.join(h.output, "provider-settings-dark.png"),
      fullPage: true,
    });
    await p.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await p.getByLabel("Message Ollama", { exact: true }).inputValue(),
      "Recover this unsent writing",
    );
    await p.setViewportSize({ width: 700, height: 750 });
    await open(p);
    await dock(p).getByLabel("Provider", { exact: true }).focus();
    assert.equal(
      await dock(p)
        .getByLabel("Provider", { exact: true })
        .evaluate((e) => e === document.activeElement),
      true,
    );
    const measurements = [];
    measurements.push({ size: "narrow", ...(await composerGeometry(p)) });
    await p.screenshot({ path: path.join(h.output, "provider-narrow.png") });
    for (const [width, height] of [
      [1280, 800],
      [1440, 900],
    ]) {
      await p.setViewportSize({ width, height });
      await open(p);
      measurements.push({
        size: `${width}x${height}`,
        ...(await composerGeometry(p)),
      });
      await p.screenshot({
        path: path.join(h.output, `provider-chat-dark-${width}.png`),
      });
    }
    await withBrowserZoom(h, async (z, setZoom) => {
      assert.equal(await setZoom(2), 2);
      await localModel(z.page);
      await z.page.emulateMedia({ reducedMotion: "reduce" });
      await z.page
        .getByLabel("Message Ollama", { exact: true })
        .fill("Zoom draft");
      const send = dock(z.page).getByRole("button", {
        name: "Send",
        exact: true,
      });
      measurements.push({
        size: "zoom200",
        ...(await composerGeometry(z.page)),
      });
      await send.focus();
      assert.equal(
        await send.evaluate((e) => e === document.activeElement),
        true,
      );
      await z.page.screenshot({
        path: path.join(h.output, "provider-200-percent.png"),
      });
    });
    fs.writeFileSync(
      path.join(h.output, "provider-layout-measurements.json"),
      JSON.stringify(measurements, null, 2),
    );
  },
);
