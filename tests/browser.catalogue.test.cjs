const { addCanvasNode, projectAction } = require("./ux-fixture.cjs");
/* Real catalogue workflows: all source, databases, and exports are disposable. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupBrowser, until, wait } = require("./browser-harness.cjs");

const detail = (page) => page.locator(".variable-detail");
const row = (page, id) => page.locator(`tr[data-variable-id="${id}"]`);
async function save(h) {
  await projectAction(h.page, "Save");
  await h.saved();
}
async function catalogue(h) {
  if (
    !(await h.page.getByRole("region", { name: "Variable catalogue" }).count())
  )
    await h.page.getByRole("button", { name: /Open catalogue/ }).click();
}
async function selectVariable(h, id) {
  await catalogue(h);
  await row(h.page, id).getByRole("button").click();
}
async function planVariable(h, fields) {
  await catalogue(h);
  await h.page
    .getByRole("button", { name: "+ Plan variable", exact: true })
    .click();
  for (const [label, value] of Object.entries(fields))
    await detail(h.page).getByLabel(label, { exact: true }).fill(value);
  await save(h);
  const envelope = await h.api("/projects/" + h.initial.id);
  return envelope.content.variables.find((v) => v.name === fields.Name);
}
async function scanUi(h, projectId = h.initial.id, attach = false) {
  const before = (await h.api(`/projects/${projectId}/source`)).latestScan?.id;
  const sourceRoute = `**/projects/${projectId}/source`;
  if (attach)
    await h.page.route(sourceRoute, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      await wait(200);
      await route.fulfill({ response });
    });
  await projectAction(h.page, "Scan Python");
  const dialog = h.page.getByRole("dialog", { name: "Python source" });
  if (attach) {
    await dialog
      .getByLabel("Source directory", { exact: true })
      .fill(h.sourceDir);
    await wait(350);
    assert.equal(
      await dialog.getByLabel("Source directory", { exact: true }).inputValue(),
      h.sourceDir,
      "Late source refresh must preserve the typed attachment path",
    );
    await dialog.getByLabel("Allow read-only access to this directory").check();
    await dialog
      .getByRole("button", { name: "Attach directory", exact: true })
      .click();
    await until(
      async () => (await h.api(`/projects/${projectId}/source`)).attached,
    );
    await h.page.unrouteAll({ behavior: "wait" });
  }
  await dialog
    .getByRole("button", { name: /^(Re)?scan Python files$/i })
    .click();
  const result = await until(async () => {
    const run = (await h.api(`/projects/${projectId}/source`)).latestScan;
    return run &&
      run.id !== before &&
      !["queued", "running"].includes(run.status)
      ? run
      : false;
  }, 20000);
  await until(async () =>
    (await dialog.locator(".scan-results .section-heading").innerText())
      .toLowerCase()
      .includes(`scan ${result.status}`),
  );
  await dialog
    .getByRole("button", { name: "Open catalogue", exact: true })
    .click();
  return {
    run: result,
    symbols: (await h.api(`/projects/${projectId}/symbols`)).symbols,
  };
}
async function assertReview(h, projectId, planId, ui, backend) {
  await until(
    async () =>
      (await detail(h.page).locator(".review-state").innerText()) === ui,
  );
  await until(
    async () =>
      (await h.api(`/projects/${projectId}/reconciliation`)).reviews.find(
        (r) => r.plannedId === planId,
      )?.state === backend,
  );
}

test(
  "catalogue filters, cross-diagram links, bidirectional navigation, and deletion undo after server restart",
  { timeout: 180000 },
  async (t) => {
    const h = await setupBrowser(t, { name: "catalogue-links" }),
      p = h.page;
    const firstDiagram = h.initial.content.diagrams[0];
    const firstNode = firstDiagram.nodes.find(
      (n) => n.title === "Save & count",
    );
    const plan = await planVariable(h, {
      Name: "future_total",
      Purpose: "Count planned future work",
      "Intended type": "int",
      "Intended file": "future/pipeline.py",
      "Qualified function / class": "pipeline.stage",
      "Initial expression": "dangerous_call()",
      "Implementation notes": "Do not evaluate this expression.",
    });
    await detail(p)
      .getByLabel("Implementation status", { exact: true })
      .selectOption("blocked");
    await p.getByRole("button", { name: "New diagram", exact: true }).click();
    await p
      .getByRole("dialog", { name: "New diagram" })
      .getByLabel("Diagram name", { exact: true })
      .fill("Future stage");
    await p
      .getByRole("button", { name: "Create diagram", exact: true })
      .click();
    await addCanvasNode(p, "Process");
    await p
      .locator(".inspector")
      .getByLabel("Title", { exact: true })
      .fill("Process future records");
    await save(h);
    let envelope = await h.api("/projects/" + h.initial.id);
    const second = envelope.content.diagrams.find(
        (d) => d.name === "Future stage",
      ),
      secondNode = second.nodes[0];
    for (const id of [firstNode.id, secondNode.id]) {
      await detail(p)
        .getByLabel("Node to link", { exact: true })
        .selectOption(id);
      await detail(p)
        .getByRole("button", { name: "Link", exact: true })
        .click();
    }
    const firstLink = detail(p)
      .locator(".linked-variable")
      .filter({
        has: p.getByRole("button", { name: "Save & count", exact: true }),
      });
    await firstLink.getByLabel("Planned relationship").selectOption("creates");
    const secondLink = detail(p)
      .locator(".linked-variable")
      .filter({
        has: p.getByRole("button", {
          name: "Process future records",
          exact: true,
        }),
      });
    await secondLink.getByLabel("Planned relationship").selectOption("reads");
    await save(h);
    const search = p.getByLabel("Search variables", { exact: true });
    for (const text of [
      "FUTURE_TOTAL",
      "future/pipeline.py",
      "pipeline.stage",
    ]) {
      await search.fill(text);
      assert.equal(await p.locator(".variable-list tbody tr").count(), 1);
      assert.equal(await row(p, plan.id).count(), 1);
    }
    await search.fill("");
    await p
      .getByLabel("Variable origin", { exact: true })
      .selectOption("planned");
    assert.equal(await p.locator(".variable-list tbody tr").count(), 3);
    await p
      .getByLabel("Variable status", { exact: true })
      .selectOption("blocked");
    assert.equal(await p.locator(".variable-list tbody tr").count(), 1);
    await p.getByLabel("Variable status", { exact: true }).selectOption("all");
    await p
      .getByLabel("Diagram link filter", { exact: true })
      .selectOption(second.id);
    assert.equal(await p.locator(".variable-list tbody tr").count(), 1);
    await p
      .getByLabel("Variable origin", { exact: true })
      .selectOption("detected");
    assert.equal(await p.locator(".variable-list tbody tr").count(), 0);
    await p.getByLabel("Variable origin", { exact: true }).selectOption("all");
    await p
      .getByLabel("Diagram link filter", { exact: true })
      .selectOption("all");
    await firstLink
      .getByRole("button", { name: "Save & count", exact: true })
      .click();
    assert.equal(
      await p
        .locator(".inspector")
        .getByLabel("Title", { exact: true })
        .inputValue(),
      "Save & count",
    );
    assert.ok(
      (await p.locator(".diagram-list button.active").innerText()).includes(
        firstDiagram.name,
      ),
    );
    // Select another variable, then return from the node's link to the right plan.
    await selectVariable(
      h,
      h.initial.content.variables.find((v) => v.name === "record").id,
    );
    await p
      .locator('.inspector details[data-section="links"] > summary')
      .click();
    await p
      .locator(".inspector")
      .getByRole("button", { name: "future_total", exact: true })
      .click();
    assert.equal(
      await detail(p).getByLabel("Name", { exact: true }).inputValue(),
      "future_total",
    );
    await detail(p)
      .getByRole("button", { name: "Process future records", exact: true })
      .click();
    assert.equal(
      await p
        .locator(".inspector")
        .getByLabel("Title", { exact: true })
        .inputValue(),
      "Process future records",
    );
    await save(h);
    envelope = await h.api("/projects/" + h.initial.id);
    const links = envelope.content.nodeLinks.filter(
      (l) => l.variableId === plan.id,
    );
    assert.equal(links.length, 2);
    assert.deepEqual(links.map((l) => l.relationship).sort(), [
      "creates",
      "reads",
    ]);
    assert.equal(
      fs.existsSync(path.join(h.sourceDir, "future", "pipeline.py")),
      false,
    );
    await detail(p)
      .getByRole("button", { name: "Delete planned variable", exact: true })
      .click();
    await save(h);
    assert.equal(
      (await h.api("/projects/" + h.initial.id)).content.nodeLinks.filter(
        (l) => l.variableId === plan.id,
      ).length,
      0,
    );
    await h.restart();
    await p.getByRole("button", { name: "Undo", exact: true }).click();
    await save(h);
    envelope = await h.api("/projects/" + h.initial.id);
    assert.deepEqual(
      envelope.content.nodeLinks.filter((l) => l.variableId === plan.id),
      links,
    );
    assert.equal(
      envelope.content.variables.find((v) => v.id === plan.id)
        .initialExpression,
      "dangerous_call()",
    );
    await selectVariable(h, plan.id);
    assert.equal(await detail(p).locator(".linked-variable").count(), 2);
  },
);

test(
  "catalogue confirms, rejects, persists decisions, and explicitly relinks renamed and stale code",
  { timeout: 180000 },
  async (t) => {
    const h = await setupBrowser(t, { name: "catalogue-relink" }),
      p = h.page,
      id = h.initial.id;
    const source = path.join(h.sourceDir, "importer.py");
    const original =
      "def process_records(records):\n    count: int = 0\n    record: dict[str, str] = {}\n    return count\n";
    fs.writeFileSync(source, original);
    let { symbols } = await scanUi(h, id, true);
    const countPlan = h.initial.content.variables.find(
        (v) => v.name === "count",
      ),
      recordPlan = h.initial.content.variables.find((v) => v.name === "record");
    const count = symbols.find((s) => s.name === "count"),
      record = symbols.find((s) => s.name === "record");
    await p
      .getByLabel("Variable origin", { exact: true })
      .selectOption("detected");
    assert.equal(
      await p.locator(".variable-list tbody tr").count(),
      symbols.length,
    );
    await p
      .getByLabel("Search variables", { exact: true })
      .fill("process_records");
    assert.equal(await row(p, count.id).count(), 1);
    await p.getByLabel("Search variables", { exact: true }).fill("");
    await p.getByLabel("Variable origin", { exact: true }).selectOption("all");
    await selectVariable(h, countPlan.id);
    await detail(p)
      .locator(`[data-symbol-id="${count.id}"]`)
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await save(h);
    await assertReview(
      h,
      id,
      countPlan.id,
      "Linked and detected",
      "linked_detected",
    );
    await selectVariable(h, recordPlan.id);
    await detail(p)
      .locator(`[data-symbol-id="${record.id}"]`)
      .getByRole("button", { name: "Reject", exact: true })
      .click();
    await save(h);
    await h.restart();
    await selectVariable(h, recordPlan.id);
    assert.equal(
      await detail(p).locator(`[data-symbol-id="${record.id}"]`).count(),
      0,
    );
    assert.match(
      await detail(p).locator("[data-match-id]").innerText(),
      /rejected/,
    );
    await detail(p)
      .locator("[data-match-id]")
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await save(h);
    await detail(p)
      .locator(`[data-symbol-id="${record.id}"]`)
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await save(h);
    fs.writeFileSync(source, original.replaceAll("count", "total"));
    ({ symbols } = await scanUi(h));
    const renamed = symbols.find(
      (s) => s.name === "total" && s.state === "current",
    );
    await selectVariable(h, countPlan.id);
    await assertReview(
      h,
      id,
      countPlan.id,
      "Linked, not detected",
      "linked_not_detected",
    );
    await detail(p)
      .locator(`[data-symbol-id="${renamed.id}"]`)
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await save(h);
    let envelope = await h.api("/projects/" + id),
      old = envelope.content.matches.find(
        (m) => m.plannedId === countPlan.id && m.symbolId === count.id,
      );
    await detail(p)
      .locator(`[data-match-id="${old.id}"]`)
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await save(h);
    await assertReview(
      h,
      id,
      countPlan.id,
      "Linked and detected",
      "linked_detected",
    );
    await until(async () =>
      (await detail(p).locator(".review-note").allInnerTexts()).some((text) =>
        text.includes("planned count; detected total"),
      ),
    );
    fs.writeFileSync(source, "def broken(:\n");
    const failed = await scanUi(h);
    assert.equal(failed.run.summary.errors, 1);
    await selectVariable(h, countPlan.id);
    await assertReview(h, id, countPlan.id, "Stale scan", "stale_scan");
    fs.writeFileSync(source, "\n\n" + original.replaceAll("count", "total"));
    ({ symbols } = await scanUi(h));
    assert.equal(
      symbols.find((s) => s.name === "total" && s.state === "current").id,
      renamed.id,
    );
    await selectVariable(h, countPlan.id);
    await assertReview(
      h,
      id,
      countPlan.id,
      "Linked and detected",
      "linked_detected",
    );
    envelope = await h.api("/projects/" + id);
    assert.equal(
      envelope.content.variables.find((v) => v.id === countPlan.id).notes,
      countPlan.notes,
    );
    assert.equal(
      envelope.content.variables.find((v) => v.id === countPlan.id).status,
      countPlan.status,
    );
    // A delayed preview for a previous selection must not appear under another symbol.
    let release,
      received = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await p.route(`**/symbols/${renamed.id}/preview`, async (route) => {
      const response = await route.fetch();
      received = true;
      await gate;
      await route.fulfill({ response });
    });
    await selectVariable(h, renamed.id);
    await detail(p)
      .getByRole("button", { name: "Read source preview", exact: true })
      .click();
    await until(() => received);
    await selectVariable(h, record.id);
    release();
    await wait(300);
    assert.equal(await detail(p).locator(".source-preview").count(), 0);
    await p.unroute(`**/symbols/${renamed.id}/preview`);
  },
);

test(
  "ambiguous and imported evidence remains reviewable and relinks only through user decisions",
  { timeout: 180000 },
  async (t) => {
    const h = await setupBrowser(t, { name: "catalogue-trust" }),
      p = h.page,
      id = h.initial.id;
    fs.writeFileSync(
      path.join(h.sourceDir, "importer.py"),
      "def process_records():\n    count: int = 0\n    return count\n",
    );
    fs.writeFileSync(
      path.join(h.sourceDir, "ambiguous.py"),
      "def repeated():\n    amount: int = 1\ndef repeated():\n    amount: int = 2\n",
    );
    let { symbols } = await scanUi(h, id, true);
    const count = symbols.find((s) => s.name === "count"),
      countPlan = h.initial.content.variables.find((v) => v.name === "count");
    await selectVariable(h, countPlan.id);
    await detail(p)
      .locator(`[data-symbol-id="${count.id}"]`)
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await save(h);
    const plan = await planVariable(h, {
      Name: "amount",
      "Intended type": "int",
      "Intended file": "ambiguous.py",
      "Qualified function / class": "repeated",
    });
    const ambiguous = symbols.filter((s) => s.name === "amount");
    assert.equal(ambiguous.length, 2);
    for (const observation of ambiguous) {
      const proposal = detail(p).locator(
        `[data-symbol-id="${observation.id}"]`,
      );
      await proposal.waitFor();
      assert.match(
        await proposal.innerText(),
        new RegExp(`line ${observation.locations[0].line}`),
      );
    }
    await detail(p)
      .locator(`[data-symbol-id="${ambiguous[0].id}"]`)
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await save(h);
    await assertReview(h, id, plan.id, "Stale scan", "stale_scan");
    await selectVariable(h, ambiguous[0].id);
    assert.match(
      await detail(p).locator(".symbol-facts").innerText(),
      /identity needs review/,
    );
    assert.match(
      await detail(p).locator(".symbol-facts").innerText(),
      /Identity review/,
    );
    await save(h);
    const portable = await h.api(`/projects/${id}/export/json`);
    await p.locator('input[type="file"]').setInputFiles({
      name: "catalogue-portable.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(portable)),
    });
    let imported;
    await until(async () => {
      imported = (await h.api("/projects")).projects.find(
        (project) => project.id !== id,
      );
      return !!imported;
    });
    await p.getByTestId("diagram-canvas").waitFor();
    let importedEnvelope = await h.api("/projects/" + imported.id);
    let importedSymbols = (await h.api(`/projects/${imported.id}/symbols`))
      .symbols;
    assert.equal(
      (await h.api(`/projects/${imported.id}/source`)).attached,
      false,
    );
    assert.ok(importedSymbols.every((s) => s.state === "historical"));
    const importedCountPlan = importedEnvelope.content.variables.find(
        (v) => v.name === "count",
      ),
      importedCount = importedSymbols.find((s) => s.name === "count");
    await selectVariable(h, importedCountPlan.id);
    await assertReview(
      h,
      imported.id,
      importedCountPlan.id,
      "Stale scan",
      "stale_scan",
    );
    await p
      .getByLabel("Variable status", { exact: true })
      .selectOption("historical");
    assert.equal(
      await p.locator(".variable-list tbody tr").count(),
      importedSymbols.length,
    );
    assert.match(
      await row(p, importedCount.id).innerText(),
      /Historical \/ unverified/,
    );
    await p.getByLabel("Variable status", { exact: true }).selectOption("all");
    await selectVariable(h, importedCount.id);
    await detail(p)
      .getByRole("button", { name: "Read source preview", exact: true })
      .click();
    await until(async () =>
      /historical|another attachment/i.test(await detail(p).innerText()),
    );
    ({ symbols } = await scanUi(h, imported.id, true));
    const fresh = symbols.find(
      (s) => s.name === "count" && s.state === "current",
    );
    assert.notEqual(fresh.id, importedCount.id);
    await selectVariable(h, importedCountPlan.id);
    await detail(p)
      .getByLabel("Link a detected symbol", { exact: true })
      .selectOption(fresh.id);
    await detail(p)
      .getByRole("button", { name: "Confirm match", exact: true })
      .click();
    await save(h);
    importedEnvelope = await h.api("/projects/" + imported.id);
    const old = importedEnvelope.content.matches.find(
      (m) =>
        m.plannedId === importedCountPlan.id && m.symbolId === importedCount.id,
    );
    await detail(p)
      .locator(`[data-match-id="${old.id}"]`)
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await save(h);
    await assertReview(
      h,
      imported.id,
      importedCountPlan.id,
      "Linked and detected",
      "linked_detected",
    );
    await h.restart();
    await selectVariable(h, importedCountPlan.id);
    await assertReview(
      h,
      imported.id,
      importedCountPlan.id,
      "Linked and detected",
      "linked_detected",
    );
  },
);
