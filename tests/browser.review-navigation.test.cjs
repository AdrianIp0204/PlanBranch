const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { setupBrowser, until } = require("./browser-harness.cjs");
const { withBrowserZoom, measureContrast } = require("./ux-fixture.cjs");

const workspace = (p) =>
  p.getByRole("region", { name: "Proposed changes workspace" });
const navigator = (p) => workspace(p).locator("[data-current-change]");
const node = (id, type, title, x, y) => ({
  id,
  type,
  title,
  position: { x, y },
  status: "not_started",
  description: title,
  checklist: ["start", "end", "note"].includes(type)
    ? []
    : [
        {
          id: `${id}-check`,
          text: `${title} has an observable result`,
          checked: false,
        },
      ],
  notes: "",
  pseudocode: "",
  targetFile: "",
  targetScope: "",
  why: "",
  alternatives: "",
  blocker: "",
});
const edge = (id, source, target, label, sourceHandle = "out") => ({
  id,
  source,
  target,
  label,
  sourceHandle,
  targetHandle: "in",
});

async function openChat(p) {
  await p.getByTestId("diagram-canvas").waitFor();
  if (
    !(await p
      .getByRole("complementary", { name: "Planning conversation" })
      .isVisible())
  )
    await p
      .getByRole("button", { name: "Toggle planning chat", exact: true })
      .click();
  await p.getByRole("tab", { name: "Chat", exact: true }).click();
}

async function fixture(t, name) {
  const h = await setupBrowser(t, {
    name,
    seed: { name: "Guided review" },
    planningFixture: true,
    viewport: { width: 1440, height: 900 },
  });
  const original = await h.saveContent(h.initial.id, (content) => {
    const d = content.diagrams[0];
    d.nodes = [
      node("review-start", "start", "Open task menu", 80, 80),
      node("review-choice", "decision", "Choose action", 80, 300),
      node("review-store", "process", "Store task", 450, 550),
      node("review-old", "process", "Deprecated export", 2300, 700),
      node("review-end", "end", "Finish command", 450, 900),
      node("review-note", "note", "A note outside program flow", -900, 700),
      node("review-island", "process", "Future reporting", 1700, -400),
    ];
    d.nodes[1].why = "Returning to this menu after an action is intentional.";
    d.edges = [
      edge("review-entry", "review-start", "review-choice", "Open"),
      edge("review-add", "review-choice", "review-store", "Add", "yes"),
      edge("review-retired", "review-choice", "review-old", "Export", "no"),
      edge("review-finish", "review-store", "review-end", "Done"),
    ];
  });
  await h.page.reload();
  await openChat(h.page);
  await h.page
    .getByLabel("Message Codex", { exact: true })
    .fill("Review navigation fixture");
  await h.page.getByRole("button", { name: "Send", exact: true }).click();
  await workspace(h.page).waitFor();
  await h.page.getByTestId("review-change-position").waitFor();
  const planning = await until(async () => {
    const state = await h.api(`/projects/${h.initial.id}/planning`);
    return state.request?.status === "succeeded" && state.proposals.length
      ? state
      : false;
  });
  const proposal = planning.proposals.at(-1);
  const detail = await h.api(
    `/projects/${h.initial.id}/planning/proposals/${proposal.id}`,
  );
  const added = detail.content.diagrams[0].nodes.find(
    (n) => n.title === "Display confirmation",
  );
  return { ...h, original, proposal, added };
}

async function selectedInView(p) {
  return until(async () => {
    const key = await navigator(p).getAttribute("data-current-change");
    if (!key) return false;
    const split = key.indexOf(":"),
      kind = key.slice(0, split),
      id = key.slice(split + 1);
    const selected = workspace(p).locator(
      `.react-flow__${kind}[data-id="${id}"].selected`,
    );
    if (!(await selected.count())) return false;
    const item = await selected.boundingBox();
    const canvas = await workspace(p).locator(".react-flow").boundingBox();
    return item &&
      canvas &&
      item.x >= canvas.x - 3 &&
      item.y >= canvas.y - 3 &&
      item.x + item.width <= canvas.x + canvas.width + 3 &&
      item.y + item.height <= canvas.y + canvas.height + 3
      ? key
      : false;
  });
}

async function choose(p, key) {
  await workspace(p)
    .getByLabel("Review change", { exact: true })
    .selectOption(key);
  await until(
    async () =>
      (await navigator(p).getAttribute("data-current-change")) === key,
  );
  await selectedInView(p);
}

async function manualDetails(p) {
  const edit = workspace(p).getByRole("button", {
    name: "Edit manually",
    exact: true,
  });
  if (await edit.isVisible()) await edit.click();
  const details = workspace(p).getByRole("button", {
    name: "Details",
    exact: true,
  });
  if (await details.isVisible()) await details.click();
}

test("dark proposal highlights distinguish added, changed and removed nodes at both target sizes", { timeout: 100000 }, async t => {
  const h = await fixture(t, "guided-review-dark"), p = h.page;
  await p.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await until(() => p.locator("html").getAttribute("data-theme").then(value => value === "dark"));
  const contrast = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
    await p.setViewportSize(viewport);
    for (const [state, id] of [["added", h.added.id], ["changed", "review-store"], ["removed", "review-old"]]) {
      await choose(p, `node:${id}`);
      const badge = workspace(p).locator(`.react-flow__node[data-id="${id}"] .proposal-change-badge`);
      assert.match(await badge.innerText(), new RegExp(state, "i"));
      const sampled = (await measureContrast(p)).filter(item => item.selector.includes("proposal-change-badge"));
      assert.ok(sampled.length && sampled.every(item => item.ratio >= 4.45));
      contrast.push({ viewport, selectedState: state, samples: sampled });
      await p.screenshot({ path: path.join(h.output, `proposal-dark-${state}-${viewport.width}x${viewport.height}.png`) });
    }
  }
  fs.writeFileSync(path.join(h.output, "proposal-dark-contrast.json"), JSON.stringify(contrast, null, 2));
  assert.deepEqual((await h.api(`/projects/${h.initial.id}`)).content, h.original.content);
});

test(
  "keyboard review visits added, changed and removed nodes and connections without losing the current edit",
  { timeout: 120000 },
  async (t) => {
    const h = await fixture(t, "guided-review-navigation");
    const p = h.page;
    assert.match(
      await p.getByTestId("review-change-position").innerText(),
      /^0 of 7$/,
    );
    const counts = await p.getByTestId("review-change-counts").innerText();
    assert.match(counts, /3 added/i);
    assert.match(counts, /2 changed/i);
    assert.match(counts, /2 removed/i);
    const next = workspace(p).getByRole("button", {
      name: "Next change",
      exact: true,
    });
    const previous = workspace(p).getByRole("button", {
      name: "Previous change",
      exact: true,
    });
    const seen = new Set();
    for (let i = 1; i <= 7; i++) {
      await next.focus();
      await next.press("Enter");
      await until(
        async () =>
          (await p.getByTestId("review-change-position").innerText()).trim() ===
          `${i} of 7`,
      );
      const key = await selectedInView(p);
      assert.equal(
        seen.has(key),
        false,
        "Each next action reaches a different change",
      );
      seen.add(key);
      const removed = ["node:review-old", "edge:review-retired"].includes(key);
      assert.equal(
        await workspace(p)
          .getByRole("button", { name: "Before", exact: true })
          .getAttribute("aria-pressed"),
        String(removed),
      );
      assert.equal(
        await next.evaluate((el) => document.activeElement === el),
        true,
        "Review navigation retains keyboard focus",
      );
    }
    assert.ok(
      seen.has("node:review-old") &&
        seen.has("node:review-store") &&
        seen.has(`node:${h.added.id}`),
    );
    assert.ok(seen.has("edge:review-retired") && seen.has("edge:review-add"));
    await previous.focus();
    await previous.press("ArrowLeft");
    assert.equal(
      (await p.getByTestId("review-change-position").innerText()).trim(),
      "6 of 7",
    );
    await previous.press("Home");
    assert.equal(
      (await p.getByTestId("review-change-position").innerText()).trim(),
      "1 of 7",
    );
    await next.focus();
    await next.press("End");
    assert.equal(
      (await p.getByTestId("review-change-position").innerText()).trim(),
      "7 of 7",
    );

    await choose(p, "node:review-store");
    const position = await p.getByTestId("review-change-position").innerText();
    await manualDetails(p);
    const title = workspace(p).getByLabel("Title", { exact: true });
    await title.fill(
      "Store task and retain a clear confirmation of its identifier",
    );
    await title.press("Home");
    await title.press("ArrowRight");
    assert.equal(
      await title.evaluate((el) => document.activeElement === el),
      true,
    );
    assert.equal(
      await navigator(p).getAttribute("data-current-change"),
      "node:review-store",
    );
    assert.equal(
      await p.getByTestId("review-change-position").innerText(),
      position,
    );
    assert.equal(
      await p.getByTestId("review-change-counts").innerText(),
      counts,
    );
    assert.equal(
      await workspace(p)
        .locator('.react-flow__node[data-id="review-store"]')
        .count(),
      1,
    );
    assert.deepEqual(
      (await h.api(`/projects/${h.initial.id}`)).content,
      h.original.content,
    );
    await p.screenshot({
      path: path.join(h.output, "review-editing-1440.png"),
    });
    await p.setViewportSize({ width: 1280, height: 800 });
    await p.screenshot({
      path: path.join(h.output, "review-editing-1280.png"),
    });
  },
);

test(
  "review hints navigate actionable omissions, exempt notes and intentional loops, and permit accepting an exception",
  { timeout: 120000 },
  async (t) => {
    const h = await fixture(t, "guided-review-hints");
    const p = h.page;
    const hints = workspace(p)
      .locator("details")
      .filter({ has: p.locator("summary", { hasText: "Review hints" }) });
    await hints.locator("summary").click();
    const criteria = hints.getByRole("button", {
      name: "Add acceptance criteria: Display confirmation",
      exact: true,
    });
    const branch = hints.getByRole("button", {
      name: "Label decision branch: Choose action → Store task",
      exact: true,
    });
    const separate = hints.getByRole("button", {
      name: "Check separate flow: Future reporting",
      exact: true,
    });
    const openHints = async () => {
      if ((await hints.getAttribute("open")) === null)
        await hints.locator("summary").click();
    };
    assert.equal(
      await hints.locator("button").count(),
      3,
      "Only the missing check, branch label and separate process are advisory issues",
    );
    for (const [button, target] of [
      [criteria, `node:${h.added.id}`],
      [branch, "edge:review-add"],
      [separate, "node:review-island"],
    ]) {
      await workspace(p)
        .getByRole("button", { name: "Before", exact: true })
        .click();
      await openHints();
      await button.click();
      assert.equal(
        await workspace(p)
          .getByRole("button", { name: "Before", exact: true })
          .getAttribute("aria-pressed"),
        "false",
      );
      const id = target.slice(target.indexOf(":") + 1),
        kind = target.startsWith("node:") ? "node" : "edge";
      await until(
        async () =>
          (await workspace(p)
            .locator(`.react-flow__${kind}[data-id="${id}"].selected`)
            .count()) === 1,
      );
      assert.equal(
        await workspace(p)
          .getByRole("button", { name: "Apply changes", exact: true })
          .isEnabled(),
        true,
      );
      assert.equal(
        await hints
          .locator("summary")
          .evaluate((el) => document.activeElement === el),
        true,
        "Choosing a hint restores focus to its disclosure",
      );
    }
    await openHints();
    await branch.click();
    await manualDetails(p);
    await workspace(p).getByLabel("Branch label", { exact: true }).fill("Add");
    await workspace(p).getByLabel("Branch label", { exact: true }).press("Tab");
    await until(async () => (await hints.locator("button").count()) === 2);
    await openHints();
    await criteria.click();
    const checklist = workspace(p).locator('details[data-section="checklist"]');
    if ((await checklist.getAttribute("open")) === null)
      await checklist.locator("summary").click();
    await checklist
      .getByRole("button", { name: "Add checklist item", exact: false })
      .click();
    await checklist
      .getByLabel("Checklist text", { exact: true })
      .fill("The saved task identifier is displayed exactly once.");
    await checklist.getByLabel("Checklist text", { exact: true }).press("Tab");
    await until(async () => (await hints.locator("button").count()) === 1);
    await openHints();
    await separate.waitFor();
    assert.equal(
      await workspace(p).getByLabel("Status", { exact: true }).inputValue(),
      "not_started",
    );
    await workspace(p)
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await workspace(p).waitFor({ state: "hidden" });
    const applied = await h.api(`/projects/${h.initial.id}`);
    assert.equal(applied.history.length, h.original.history.length + 1);
    const diagram = applied.content.diagrams[0];
    assert.equal(
      diagram.nodes.find((n) => n.id === h.added.id).checklist[0].checked,
      false,
    );
    assert.ok(
      diagram.edges.some(
        (e) => e.source === "review-store" && e.target === "review-choice",
      ),
      "An intentional program loop remains valid",
    );
    assert.ok(
      diagram.nodes.some((n) => n.id === "review-island"),
      "A user can accept a deliberate separate flow",
    );
  },
);

test(
  "review controls remain reachable in narrow and actual 200 percent zoom views with reduced motion",
  { timeout: 150000 },
  async (t) => {
    const h = await fixture(t, "guided-review-responsive");
    const p = h.page;
    await choose(p, `node:${h.added.id}`);
    await p.screenshot({ path: path.join(h.output, "review-1440.png") });
    await p.setViewportSize({ width: 1280, height: 800 });
    await p.screenshot({ path: path.join(h.output, "review-1280.png") });
    await p.setViewportSize({ width: 720, height: 700 });
    await until(async () =>
      p
        .locator(".workspace")
        .evaluate((el) => el.classList.contains("compact-workspace")),
    );
    await p.getByRole("button", { name: "Canvas", exact: true }).click();
    await workspace(p)
      .getByRole("button", { name: "Next change", exact: true })
      .click();
    await selectedInView(p);
    await p.screenshot({ path: path.join(h.output, "review-narrow.png") });
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
        "Back to plan",
        "Next change",
        "Previous change",
      ]) {
        const control = workspace(zp).getByRole("button", {
          name,
          exact: true,
        });
        const box = await control.boundingBox();
        assert.ok(
          box &&
            box.x >= 0 &&
            box.y >= 0 &&
            box.x + box.width <= 640 &&
            box.y + box.height <= 400,
          `${name} stays on screen at 200% zoom`,
        );
      }
      const next = workspace(zp).getByRole("button", {
        name: "Next change",
        exact: true,
      });
      await next.focus();
      await next.press("Enter");
      assert.equal(
        await next.evaluate((el) => document.activeElement === el),
        true,
      );
      assert.equal(
        await zp.evaluate(
          () => matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
        true,
      );
      await zp.screenshot({ path: path.join(h.output, "review-zoom-200.png") });
    });
    assert.deepEqual(
      (await h.api(`/projects/${h.initial.id}`)).content,
      h.original.content,
    );
  },
);
