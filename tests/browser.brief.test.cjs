const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setupBrowser, until } = require("./browser-harness.cjs");
const { withBrowserZoom } = require("./ux-fixture.cjs");
const workspace = (p) =>
  p.getByRole("region", { name: "Proposed changes workspace" });
const briefDialog = (p) =>
  p.getByRole("dialog", { name: "Project brief", exact: true });
const brief = {
  goal: "Help me choose and finish a small daily task.",
  audience: "One person using a terminal on their own computer.",
  requirements: "Add, list and complete tasks.\nShow the next unfinished task.",
  constraints: "Python and SQLite; keep ordinary use offline.",
  outOfScope: "Accounts, cloud sync and automatic scheduling.",
  decisions: "The user confirmed Python, SQLite and explicit completion.",
  assumptions: "One local database is enough; shared usage is not agreed.",
};
const fields = {
  goal: "Goal",
  audience: "Intended user",
  requirements: "Requirements",
  constraints: "Constraints",
  outOfScope: "Out of scope",
  decisions: "Agreed decisions",
  assumptions: "Assumptions",
};
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
async function openBrief(p) {
  await p.getByRole("button", { name: "Project brief", exact: true }).click();
  await briefDialog(p).waitFor();
}
async function noHorizontalDialogOverflow(p) {
  assert.equal(
    await briefDialog(p).evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    true,
    "Brief content fits its dialog without horizontal scrolling",
  );
  const bounds = await briefDialog(p).boundingBox();
  for (const label of Object.values(fields)) {
    const field = await briefDialog(p)
      .getByLabel(label, { exact: true })
      .boundingBox();
    assert.ok(
      field &&
        bounds &&
        field.x >= bounds.x &&
        field.x + field.width <= bounds.x + bounds.width,
      `${label} fits inside the dialog`,
    );
  }
}
async function draftSaved(p) {
  await until(async () =>
    /^Draft saved/.test(
      await workspace(p).getByTestId("proposal-draft-state").innerText(),
    ),
  );
}
async function makeProposal(h) {
  await openChat(h.page);
  const state = await send(h, "Propose project brief");
  await workspace(h.page).waitFor();
  return state.proposals.at(-1);
}
async function selectBrief(p) {
  await workspace(p)
    .getByRole("button", { name: "Brief", exact: true })
    .click();
}

test(
  "project brief is editable, invalidates approval, survives undo and restart, and exports portably",
  { timeout: 150000 },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "brief-manual",
        planningFixture: true,
        viewport: { width: 1440, height: 900 },
      }),
      p = h.page,
      url = `/projects/${h.initial.id}`;
    await openBrief(p);
    assert.equal(
      await briefDialog(p)
        .getByLabel("Goal", { exact: true })
        .evaluate((el) => document.activeElement === el),
      true,
    );
    for (const [key, label] of Object.entries(fields)) {
      await briefDialog(p).getByLabel(label, { exact: true }).fill(brief[key]);
      await briefDialog(p).getByLabel(label, { exact: true }).press("Tab");
    }
    await p.screenshot({ path: path.join(h.output, "brief-1440.png") });
    await noHorizontalDialogOverflow(p);
    await p.setViewportSize({ width: 1280, height: 800 });
    await p.screenshot({ path: path.join(h.output, "brief-1280.png") });
    await noHorizontalDialogOverflow(p);
    await briefDialog(p)
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await h.saved();
    assert.equal(
      await p
        .getByRole("button", { name: "Project brief", exact: true })
        .evaluate((el) => document.activeElement === el),
      true,
    );
    assert.deepEqual((await h.api(url)).content.brief, brief);
    await openChat(p);
    await p.getByRole("button", { name: "Approve plan", exact: true }).click();
    await until(
      async () => (await h.api(url + "/planning")).approval?.current === true,
    );
    await openBrief(p);
    await noHorizontalDialogOverflow(p);
    const changed =
      "Python and SQLite; no cloud services or execution without review.";
    await briefDialog(p)
      .getByLabel("Constraints", { exact: true })
      .fill(changed);
    await briefDialog(p)
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await h.saved();
    assert.equal((await h.api(url + "/planning")).approval.current, false);
    await p.getByRole("button", { name: "Undo", exact: true }).click();
    await h.saved();
    assert.deepEqual((await h.api(url)).content.brief, brief);
    await h.restart();
    await p.getByRole("button", { name: "Redo", exact: true }).click();
    await h.saved();
    const current = { ...brief, constraints: changed };
    assert.deepEqual((await h.api(url)).content.brief, current);
    await openBrief(p);
    for (const [key, label] of Object.entries(fields))
      assert.equal(
        await briefDialog(p).getByLabel(label, { exact: true }).inputValue(),
        current[key],
      );
    await p.keyboard.press("Escape");
    await briefDialog(p).waitFor({ state: "hidden" });
    await openChat(p);
    const context = await send(h, "Discuss brief context");
    assert.ok(
      context.messages.some(
        (m) =>
          m.role === "assistant" &&
          m.text.includes(current.goal) &&
          m.text.includes(current.decisions),
      ),
    );
    const portable = await h.api(url + "/export/json");
    assert.deepEqual(portable.content.brief, current);
    await p.locator(".export-menu summary").click();
    const downloadPromise = p.waitForEvent("download");
    await p
      .getByRole("button", { name: "Implementation brief", exact: true })
      .click();
    const download = await downloadPromise,
      markdownPath = path.join(h.output, "project-brief.md");
    await download.saveAs(markdownPath);
    const markdown = await fs.readFile(markdownPath, "utf8");
    for (const value of Object.values(current))
      for (const line of value.split("\n"))
        assert.ok(markdown.includes(line), `Markdown includes ${line}`);
    await p.locator('input[type="file"]').setInputFiles({
      name: "brief.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(portable)),
    });
    const imported = await until(async () =>
      (await h.api("/projects")).projects.find(
        (item) => item.id !== h.initial.id,
      ),
    );
    const importedProject = await h.api(`/projects/${imported.id}`);
    assert.deepEqual(importedProject.content.brief, current);
    assert.equal(importedProject.history.length, 1);
    const old = structuredClone(portable);
    old.version = 1;
    old.content.schemaVersion = 1;
    delete old.content.brief;
    old.content.name = "A legacy brief-free project";
    await p.locator('input[type="file"]').setInputFiles({
      name: "legacy.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(old)),
    });
    const legacy = await until(async () =>
      (await h.api("/projects")).projects.find(
        (item) => item.name === old.content.name,
      ),
    );
    assert.deepEqual(
      (await h.api(`/projects/${legacy.id}`)).content.brief,
      Object.fromEntries(Object.keys(brief).map((key) => [key, ""])),
    );
  },
);

test(
  "brief-only proposals remain separate, retain manual revisions across restart, and apply as one history action",
  { timeout: 150000 },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "brief-proposal",
        planningFixture: true,
        viewport: { width: 1440, height: 900 },
      }),
      p = h.page,
      url = `/projects/${h.initial.id}`;
    const original = await h.saveContent(h.initial.id, (content) => {
      content.brief = { ...brief };
      content.schemaVersion = 2;
    });
    await p.reload();
    const proposal = await makeProposal(h);
    const detail = await h.api(`${url}/planning/proposals/${proposal.id}`);
    assert.deepEqual(detail.proposal.editableSections, ["brief"]);
    assert.deepEqual((await h.api(url)).content, original.content);
    await selectBrief(p);
    await workspace(p)
      .getByRole("button", { name: "Before", exact: true })
      .click();
    await workspace(p).getByText(brief.goal, { exact: true }).waitFor();
    await workspace(p)
      .getByRole("button", { name: "Proposed", exact: true })
      .click();
    await workspace(p)
      .getByRole("button", { name: "Edit manually", exact: true })
      .click();
    const manual =
      "Keep task management local and explicitly review every suggested change.";
    await workspace(p).getByLabel("Goal", { exact: true }).fill(manual);
    await workspace(p).getByLabel("Goal", { exact: true }).press("Tab");
    await draftSaved(p);
    await h.restart();
    await openChat(p);
    await workspace(p).waitFor();
    await selectBrief(p);
    const edit = workspace(p).getByRole("button", {
      name: "Edit manually",
      exact: true,
    });
    if (await edit.isVisible()) await edit.click();
    assert.equal(
      await workspace(p).getByLabel("Goal", { exact: true }).inputValue(),
      manual,
    );
    assert.deepEqual((await h.api(url)).content, original.content);
    await workspace(p)
      .getByRole("button", { name: "Ask Codex", exact: true })
      .click();
    const revised = await send(h, "Revise the visible brief");
    const replacement = revised.proposals.find(
      (item) => item.id !== proposal.id,
    );
    const updated = await h.api(`${url}/planning/proposals/${replacement.id}`);
    assert.equal(updated.content.brief.goal, manual);
    assert.equal(updated.content.brief.decisions, brief.decisions);
    assert.match(
      updated.content.brief.assumptions,
      /Confirm whether task ordering should be manual/,
    );
    await workspace(p)
      .getByText("Refined project brief", { exact: true })
      .waitFor();
    await p.screenshot({ path: path.join(h.output, "brief-review-1440.png") });
    await workspace(p)
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await workspace(p).waitFor({ state: "hidden" });
    const applied = await h.api(url);
    assert.equal(applied.history.length, original.history.length + 1);
    assert.deepEqual(applied.content.diagrams, original.content.diagrams);
    assert.deepEqual(applied.content.brief, updated.content.brief);
    await p.getByRole("button", { name: "Undo", exact: true }).click();
    await h.saved();
    assert.deepEqual((await h.api(url)).content, original.content);
  },
);

test(
  "a conflicting brief update never overwrites saved decisions and keeps the candidate recoverable",
  { timeout: 120000 },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "brief-conflict",
        planningFixture: true,
        viewport: { width: 1280, height: 800 },
      }),
      p = h.page,
      url = `/projects/${h.initial.id}`;
    const proposal = await makeProposal(h);
    await selectBrief(p);
    await workspace(p)
      .getByRole("button", { name: "Edit manually", exact: true })
      .click();
    const manual = "Keep this manually reviewed assumption separate.";
    await workspace(p).getByLabel("Assumptions", { exact: true }).fill(manual);
    await workspace(p).getByLabel("Assumptions", { exact: true }).press("Tab");
    await draftSaved(p);
    const latest = await h.saveContent(h.initial.id, (content) => {
      content.brief = {
        ...content.brief,
        decisions: "A second window confirmed file-based backup.",
      };
    });
    await workspace(p)
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await workspace(p).getByRole("alert").waitFor();
    assert.deepEqual((await h.api(url)).content, latest.content);
    assert.equal(
      await workspace(p)
        .getByLabel("Assumptions", { exact: true })
        .inputValue(),
      manual,
    );
    await h.restart();
    await openChat(p);
    await p.getByRole("tab", { name: /^Changes/ }).click();
    await p
      .getByRole("button", { name: "Review on canvas", exact: true })
      .click();
    await workspace(p).waitFor();
    await selectBrief(p);
    assert.equal(
      await workspace(p)
        .getByRole("button", { name: "Apply changes", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await workspace(p)
        .getByRole("button", { name: "Ask Codex", exact: true })
        .isEnabled(),
      true,
    );
    const drafts = await h.api(
      `${url}/planning/proposals/${proposal.id}/drafts`,
    );
    const saved = await h.api(
      `${url}/planning/proposals/${proposal.id}/drafts/${drafts.defaultDraftId}`,
    );
    assert.equal(saved.draft.candidate.brief.assumptions, manual);
    assert.equal(saved.draft.stale, true);
    assert.deepEqual((await h.api(url)).content, latest.content);
  },
);

test(
  "project brief remains keyboard accessible in narrow and actual 200 percent zoom views",
  { timeout: 120000 },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "brief-responsive",
        planningFixture: true,
        viewport: { width: 720, height: 700 },
      }),
      p = h.page;
    const original = await h.api(`/projects/${h.initial.id}`);
    await openBrief(p);
    await noHorizontalDialogOverflow(p);
    await briefDialog(p)
      .getByLabel("Assumptions", { exact: true })
      .scrollIntoViewIfNeeded();
    assert.equal(
      await briefDialog(p)
        .getByLabel("Assumptions", { exact: true })
        .isVisible(),
      true,
    );
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await p.screenshot({ path: path.join(h.output, "brief-narrow.png") });
    await p.keyboard.press("Escape");
    await withBrowserZoom(h, async (zoomed, setZoom) => {
      const zp = zoomed.page;
      await zp.getByTestId("diagram-canvas").waitFor();
      await zp.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(await setZoom(2), 2);
      await until(async () =>
        zp.evaluate(() => innerWidth === 640 && innerHeight === 400),
      );
      const trigger = zp.getByRole("button", {
        name: "Project brief",
        exact: true,
      });
      await trigger.focus();
      await trigger.press("Enter");
      await noHorizontalDialogOverflow(zp);
      for (const label of Object.values(fields)) {
        const control = briefDialog(zp).getByLabel(label, { exact: true });
        await control.focus();
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        assert.ok(
          box && box.x >= 0 && box.x + box.width <= 640 && box.height > 0,
          `${label} remains readable without horizontal clipping`,
        );
        assert.equal(
          await control.evaluate((el) => document.activeElement === el),
          true,
        );
      }
      const done = briefDialog(zp).getByRole("button", {
        name: "Done",
        exact: true,
      });
      await done.focus();
      await done.scrollIntoViewIfNeeded();
      await zp.screenshot({ path: path.join(h.output, "brief-zoom-200.png") });
      await done.press("Enter");
      assert.equal(
        await trigger.evaluate((el) => document.activeElement === el),
        true,
      );
    });
    assert.deepEqual(
      (await h.api(`/projects/${h.initial.id}`)).content,
      original.content,
    );
  },
);
