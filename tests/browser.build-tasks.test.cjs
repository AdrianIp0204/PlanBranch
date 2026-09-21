const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setupBrowser, until } = require("./browser-harness.cjs");
const { withBrowserZoom } = require("./ux-fixture.cjs");
const build = (p) =>
  p.getByRole("region", { name: "Build tasks", exact: true });
const editor = (p) =>
  p.getByRole("region", { name: "Build tasks editor", exact: true });
const workspace = (p) =>
  p.getByRole("region", { name: "Proposed changes workspace" });
async function showBuild(p) {
  await p
    .getByRole("group", { name: "Plan views", exact: true })
    .getByRole("button", { name: "Build", exact: true })
    .click();
  await build(p).waitFor();
}
async function disclose(p, name) {
  const detail = editor(p)
    .locator("details")
    .filter({ has: p.locator("summary", { hasText: name }) });
  if ((await detail.getAttribute("open")) === null)
    await detail.locator("summary").click();
  return detail;
}
async function fill(p, label, value) {
  await editor(p).getByLabel(label, { exact: true }).fill(value);
  await editor(p).getByLabel(label, { exact: true }).press("Tab");
}
async function select(p, title) {
  await editor(p)
    .getByRole("button", { name: `Task: ${title}`, exact: true })
    .click();
}
async function newTask(p, title) {
  await editor(p)
    .getByRole("button", { name: "New task", exact: true })
    .click();
  assert.equal(
    await editor(p)
      .getByLabel("Task title", { exact: true })
      .evaluate((el) => document.activeElement === el),
    true,
  );
  await fill(p, "Task title", title);
  await fill(p, "Deliverable", `${title} with an observable result.`);
  await editor(p)
    .getByRole("button", { name: "Add acceptance check", exact: true })
    .click();
  await fill(p, "Acceptance check 1", `${title} passes its focused test.`);
}
async function openChat(p) {
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
async function save(h) {
  await h.page.getByRole("button", { name: "Save", exact: true }).click();
  await h.saved();
  return h.api(`/projects/${h.initial.id}`);
}
async function draftSaved(p) {
  await until(async () =>
    /^Draft saved/.test(
      await workspace(p).getByTestId("proposal-draft-state").innerText(),
    ),
  );
}
function fixtureTask(node, diagram) {
  return {
    id: crypto.randomUUID(),
    title: "Implement record persistence",
    deliverable: "Store the validated record and update the count.",
    nodeLinks: [
      {
        nodeId: node.id,
        diagramId: diagram.id,
        title: node.title,
        missing: false,
      },
    ],
    prerequisiteIds: [],
    expectedFiles: ["storage.py"],
    acceptanceChecks: [
      {
        id: crypto.randomUUID(),
        text: "Persisting a record increases the count exactly once.",
      },
    ],
    status: "not_started",
  };
}

test(
  "build tasks create, reorder and link across diagrams while enforcing acyclic prerequisites and independent completion",
  { timeout: 150000 },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "build-authoring",
        planningFixture: true,
        viewport: { width: 1440, height: 900 },
      }),
      p = h.page,
      url = `/projects/${h.initial.id}`;
    const first = h.initial.content.diagrams[0],
      node = first.nodes.find((n) => n.type === "process");
    const other = {
      id: crypto.randomUUID(),
      name: "Command interface",
      nodes: [
        {
          ...structuredClone(node),
          id: crypto.randomUUID(),
          title: "Display command result",
          position: { x: 80, y: 80 },
          checklist: [],
        },
      ],
      edges: [],
    };
    const original = await h.saveContent(h.initial.id, (content) =>
      content.diagrams.push(other),
    );
    await fs.writeFile(
      path.join(h.sourceDir, "evidence.py"),
      "TASK_LIMIT = 8\n",
      "utf8",
    );
    await h.api(url + "/source", "POST", {
      root: h.sourceDir,
      ignores: [],
      confirmed: true,
    });
    await h.api(url + "/scans", "POST", {});
    await until(async () => {
      const scan = (await h.api(url + "/source")).latestScan;
      return scan && !["queued", "running"].includes(scan.status);
    });
    const evidence = await h.api(url + "/symbols");
    assert.equal(evidence.symbols.length, 1);
    await p.reload();
    await showBuild(p);
    await newTask(p, "Implement storage");
    await disclose(p, "Linked nodes");
    for (const id of [node.id, other.nodes[0].id]) {
      await editor(p).getByLabel("Link node", { exact: true }).selectOption(id);
      await editor(p)
        .getByRole("button", { name: "Link node", exact: true })
        .click();
    }
    await disclose(p, "Expected files");
    await editor(p)
      .getByRole("button", { name: "Add expected file", exact: true })
      .click();
    await fill(p, "Expected file 1", "storage.py");
    await newTask(p, "Implement command parsing");
    await disclose(p, "Prerequisites");
    await editor(p)
      .getByRole("checkbox", { name: "Implement storage", exact: true })
      .check();
    await editor(p)
      .getByRole("button", { name: "Move task up", exact: true })
      .click();
    const ordered = await save(h),
      [cli, storage] = ordered.content.buildTasks;
    assert.equal(cli.title, "Implement command parsing");
    assert.deepEqual(cli.prerequisiteIds, [storage.id]);
    await select(p, "Implement storage");
    await disclose(p, "Prerequisites");
    assert.equal(
      await editor(p)
        .getByRole("checkbox", {
          name: /Implement command parsing.*Would create a cycle/,
        })
        .isDisabled(),
      true,
    );
    await editor(p)
      .getByLabel("Task status", { exact: true })
      .selectOption("done");
    const complete = await save(h);
    assert.deepEqual(
      complete.content.diagrams,
      original.content.diagrams,
      "Program loops, node completion and graph metadata remain independent",
    );
    assert.deepEqual(
      await h.api(url + "/symbols"),
      evidence,
      "Explicit task completion never changes detected evidence",
    );
    assert.equal(complete.content.buildTasks[1].status, "done");
    assert.deepEqual(
      complete.content.buildTasks[1].nodeLinks.map((l) => l.nodeId),
      [node.id, other.nodes[0].id],
    );
    await disclose(p, "Linked nodes");
    await editor(p)
      .getByRole("button", { name: other.nodes[0].title, exact: true })
      .click();
    await until(
      async () =>
        (await p
          .locator(`.react-flow__node[data-id="${other.nodes[0].id}"].selected`)
          .count()) === 1,
    );
    await p
      .getByRole("button", { name: "Back to build task", exact: true })
      .click();
    assert.equal(
      await p
        .getByRole("complementary", { name: "Node details", exact: true })
        .isVisible(),
      false,
      "Node inspector is hidden while editing implementation tasks",
    );
    assert.equal(
      await editor(p).getByLabel("Task title", { exact: true }).inputValue(),
      "Implement storage",
    );
    await p.screenshot({ path: path.join(h.output, "build-1440.png") });
    await p.setViewportSize({ width: 1280, height: 800 });
    await p.screenshot({ path: path.join(h.output, "build-1280.png") });
    await h.restart();
    await showBuild(p);
    await p.getByRole("button", { name: "Undo", exact: true }).click();
    await h.saved();
    assert.equal(
      (await h.api(url)).content.buildTasks.find(
        (task) => task.id === storage.id,
      ).status,
      "not_started",
    );
    await p.getByRole("button", { name: "Redo", exact: true }).click();
    await h.saved();
    assert.deepEqual(
      (await h.api(url)).content.buildTasks,
      complete.content.buildTasks,
    );
    const portable = await h.api(url + "/export/json");
    await p.locator('input[type="file"]').setInputFiles({
      name: "build-tasks.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(portable)),
    });
    const imported = await until(async () =>
      (await h.api("/projects")).projects.find(
        (project) => project.id !== h.initial.id,
      ),
    );
    const copied = await h.api(`/projects/${imported.id}`),
      copiedStorage = copied.content.buildTasks.find(
        (task) => task.title === "Implement storage",
      ),
      copiedCli = copied.content.buildTasks.find(
        (task) => task.title === "Implement command parsing",
      );
    assert.notEqual(copiedStorage.id, storage.id);
    assert.deepEqual(copiedCli.prerequisiteIds, [copiedStorage.id]);
    assert.equal(copiedStorage.nodeLinks.length, 2);
    assert.ok(
      copiedStorage.nodeLinks.every((link) =>
        copied.content.diagrams.some(
          (d) =>
            d.id === link.diagramId &&
            d.nodes.some((n) => n.id === link.nodeId),
        ),
      ),
    );
    assert.equal(copiedStorage.status, "done");
    assert.equal(
      copiedStorage.acceptanceChecks[0].text,
      storage.acceptanceChecks[0].text,
    );
    assert.notEqual(
      copiedStorage.acceptanceChecks[0].id,
      storage.acceptanceChecks[0].id,
    );
  },
);

test(
  "deleting a linked node keeps implementation work with an explicit missing link, then permits relink or removal",
  { timeout: 120000 },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "build-missing-link",
        planningFixture: true,
        viewport: { width: 1440, height: 900 },
      }),
      p = h.page,
      url = `/projects/${h.initial.id}`;
    const diagram = h.initial.content.diagrams[0],
      node = diagram.nodes.find((n) => n.type === "process"),
      replacement = diagram.nodes.find((n) => n.type === "io");
    const task = fixtureTask(node, diagram);
    const original = await h.saveContent(h.initial.id, (content) => {
      content.buildTasks = [task];
      content.schemaVersion = 3;
    });
    const confirmations = [];
    p.on("dialog", (dialog) => confirmations.push(dialog.message()));
    await p.reload();
    await showBuild(p);
    await disclose(p, "Linked nodes");
    await editor(p)
      .getByRole("button", { name: node.title, exact: true })
      .click();
    await p.getByRole("button", { name: "Delete node", exact: true }).click();
    await h.saved();
    assert.ok(
      confirmations.some(
        (text) => text.includes(task.title) && /kept as missing/i.test(text),
      ),
    );
    await p
      .getByRole("button", { name: "Back to build task", exact: true })
      .click();
    await editor(p).getByText("Missing node", { exact: true }).waitFor();
    let current = await h.api(url);
    assert.equal(current.content.buildTasks[0].id, task.id);
    assert.equal(current.content.buildTasks[0].nodeLinks[0].missing, true);
    assert.equal(current.content.buildTasks[0].nodeLinks[0].title, node.title);
    await h.restart();
    await showBuild(p);
    await editor(p).getByText("Missing node", { exact: true }).waitFor();
    await p.getByRole("button", { name: "Undo", exact: true }).click();
    await h.saved();
    assert.deepEqual((await h.api(url)).content, original.content);
    await p.getByRole("button", { name: "Redo", exact: true }).click();
    await h.saved();
    await editor(p)
      .getByLabel(`Relink ${node.title}`, { exact: true })
      .selectOption(replacement.id);
    await h.saved();
    current = await h.api(url);
    assert.equal(
      current.content.buildTasks[0].nodeLinks[0].nodeId,
      replacement.id,
    );
    assert.equal(current.content.buildTasks[0].nodeLinks[0].missing, false);
    await disclose(p, "Linked nodes");
    await editor(p)
      .getByRole("button", {
        name: `Remove link to ${replacement.title}`,
        exact: true,
      })
      .click();
    await h.saved();
    current = await h.api(url);
    assert.equal(current.content.buildTasks.length, 1);
    assert.deepEqual(current.content.buildTasks[0].nodeLinks, []);
    assert.equal(current.content.buildTasks[0].deliverable, task.deliverable);
  },
);

test(
  "agent build tasks require review and preserve manual edits, task identities and prerequisites during revision",
  { timeout: 150000 },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "build-review",
        planningFixture: true,
        viewport: { width: 1440, height: 900 },
      }),
      p = h.page,
      url = `/projects/${h.initial.id}`,
      original = await h.api(url);
    await openChat(p);
    const state = await send(h, "Propose build tasks");
    await workspace(p).waitFor();
    const initial = state.proposals[0],
      detail = await h.api(`${url}/planning/proposals/${initial.id}`);
    assert.deepEqual(detail.proposal.editableSections, ["buildTasks"]);
    assert.deepEqual((await h.api(url)).content, original.content);
    await workspace(p)
      .getByRole("button", { name: "Build tasks", exact: true })
      .click();
    await workspace(p)
      .getByRole("button", { name: "Before", exact: true })
      .click();
    await workspace(p)
      .getByRole("heading", { name: "No build tasks", exact: true })
      .waitFor();
    await workspace(p)
      .getByRole("button", { name: "Proposed", exact: true })
      .click();
    await workspace(p)
      .getByRole("button", { name: "Edit manually", exact: true })
      .click();
    const title =
      "Implement storage with explicit rollback and a clear persisted result";
    await select(p, "Implement local task storage");
    await fill(p, "Task title", title);
    await draftSaved(p);
    await h.restart();
    await openChat(p);
    await workspace(p).waitFor();
    await workspace(p)
      .getByRole("button", { name: "Build tasks", exact: true })
      .click();
    const edit = workspace(p).getByRole("button", {
      name: "Edit manually",
      exact: true,
    });
    if (await edit.isVisible()) await edit.click();
    assert.equal(
      await editor(p).getByLabel("Task title", { exact: true }).inputValue(),
      title,
    );
    await workspace(p)
      .getByRole("button", { name: "Ask Codex", exact: true })
      .click();
    const revision = await send(h, "Revise the visible build tasks");
    const next = revision.proposals.find(
        (proposal) => proposal.id !== initial.id,
      ),
      revised = await h.api(`${url}/planning/proposals/${next.id}`);
    assert.equal(revised.content.buildTasks[0].title, title);
    assert.deepEqual(
      revised.content.buildTasks.map((task) => task.id),
      detail.content.buildTasks.map((task) => task.id),
    );
    assert.deepEqual(
      revised.content.buildTasks[1].prerequisiteIds,
      detail.content.buildTasks[1].prerequisiteIds,
    );
    await workspace(p)
      .getByText("Refined implementation steps", { exact: true })
      .waitFor();
    await p.screenshot({ path: path.join(h.output, "build-review-1440.png") });
    await workspace(p)
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await workspace(p).waitFor({ state: "hidden" });
    const applied = await h.api(url);
    assert.equal(applied.history.length, original.history.length + 1);
    assert.deepEqual(applied.content.buildTasks, revised.content.buildTasks);
    assert.deepEqual(applied.content.diagrams, original.content.diagrams);
    await p.getByRole("button", { name: "Undo", exact: true }).click();
    await h.saved();
    assert.deepEqual((await h.api(url)).content, original.content);
  },
);

test(
  "Build task controls and long titles remain keyboard accessible at narrow width and 200 percent zoom",
  { timeout: 120000 },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "build-responsive",
        planningFixture: true,
        viewport: { width: 720, height: 700 },
      }),
      p = h.page,
      url = `/projects/${h.initial.id}`;
    const diagram = h.initial.content.diagrams[0],
      task = fixtureTask(
        diagram.nodes.find((n) => n.type === "process"),
        diagram,
      );
    task.title =
      "Implement reliable persistence and error recovery without changing unrelated files or completion states";
    const original = await h.saveContent(h.initial.id, (content) => {
      content.buildTasks = [task];
      content.schemaVersion = 3;
    });
    await p.reload();
    await showBuild(p);
    await editor(p).getByLabel("Task title", { exact: true }).focus();
    assert.equal(
      await editor(p).getByLabel("Task title", { exact: true }).inputValue(),
      task.title,
    );
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await p.screenshot({ path: path.join(h.output, "build-narrow.png") });
    await withBrowserZoom(h, async (zoomed, setZoom) => {
      const zp = zoomed.page;
      await zp.getByTestId("diagram-canvas").waitFor();
      await zp.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(await setZoom(2), 2);
      await until(async () =>
        zp.evaluate(() => innerWidth === 640 && innerHeight === 400),
      );
      await showBuild(zp);
      for (const label of [
        "Task title",
        "Task status",
        "Deliverable",
        "Acceptance check 1",
      ]) {
        const field = editor(zp).getByLabel(label, { exact: true });
        await field.focus();
        await field.scrollIntoViewIfNeeded();
        const box = await field.boundingBox();
        assert.ok(
          box && box.x >= 0 && box.x + box.width <= 640,
          `${label} fits horizontally`,
        );
        assert.equal(
          await field.evaluate((el) => document.activeElement === el),
          true,
        );
      }
      await disclose(zp, "Prerequisites");
      await editor(zp)
        .getByRole("button", { name: "New task", exact: true })
        .scrollIntoViewIfNeeded();
      await zp.screenshot({ path: path.join(h.output, "build-zoom-200.png") });
      assert.ok(
        await zp.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
    });
    assert.deepEqual((await h.api(url)).content, original.content);
  },
);
