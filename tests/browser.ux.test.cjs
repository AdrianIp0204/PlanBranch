/* UX acceptance uses the same isolated installed-package harness as regressions. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupBrowser, until, wait } = require("./browser-harness.cjs");
const {
  prepareUxFixture,
  openUxPanels,
  measureWorkspace,
  measureContrast,
  withBrowserZoom,
} = require("./ux-fixture.cjs");

const section = (page, name) =>
  page.locator(`.inspector details[data-section="${name}"]`);
async function openSection(page, name) {
  const el = section(page, name);
  if (!(await el.getAttribute("open")) && (await el.evaluate((e) => !e.open)))
    await el.locator("summary").click();
}
async function restoreLayout(page) {
  await page.locator(".layout-menu > summary").click();
  await page
    .getByRole("button", { name: "Restore default layout", exact: true })
    .click();
}
async function save(h) {
  await h.page.getByRole("button", { name: "Save", exact: true }).click();
  await h.saved();
}
async function activeIs(locator) {
  return locator.evaluate((el) => document.activeElement === el);
}
async function expectFocus(locator) {
  // Panel layout and modal mount deliberately return focus after rendering.
  // Keep the destination strict without dispatching a later key before it lands.
  await until(async () => {
    assert.equal(
      await activeIs(locator),
      true,
      `Focus should reach ${locator}`,
    );
    return true;
  });
}

test(
  "resizable planning workspace, focused details, catalogue review, and constrained-window access",
  { timeout: 240000 },
  async (t) => {
    const h = await setupBrowser(t, {
        name: "ux-after",
        viewport: { width: 1440, height: 900 },
      }),
      p = h.page;
    const fixture = await prepareUxFixture(h);
    await openUxPanels(h, fixture);
    t.afterEach(async () => {
      // An assertion should not leave a modal or injected network fault blocking
      // the next independent UX scenario and obscuring its actual result.
      await p.unrouteAll({ behavior: "ignoreErrors" });
      while (await p.getByRole("dialog").count())
        await p.keyboard.press("Escape");
      const retry = p.getByRole("button", { name: "Retry save", exact: true });
      if (await retry.count()) {
        await retry.click();
        await h.saved();
      }
    });

    await t.test(
      "panel pointer and keyboard resizing preserves content, selection, viewport, and history",
      async () => {
        await h.saved();
        const before = await h.api("/projects/" + fixture.id);
        const transform = await p
          .locator(".react-flow__viewport")
          .getAttribute("style");
        const inspector = p.getByRole("separator", {
          name: "Resize inspector",
          exact: true,
        });
        const original = Number(await inspector.getAttribute("aria-valuenow"));
        await inspector.focus();
        await p.keyboard.press("ArrowLeft");
        assert.ok(
          Number(await inspector.getAttribute("aria-valuenow")) > original,
        );
        await p.keyboard.press("Home");
        assert.equal(
          await inspector.getAttribute("aria-valuenow"),
          await inspector.getAttribute("aria-valuemin"),
        );
        await p.keyboard.press("End");
        assert.equal(
          await inspector.getAttribute("aria-valuenow"),
          await inspector.getAttribute("aria-valuemax"),
        );
        const box = await inspector.boundingBox(),
          old = Number(await inspector.getAttribute("aria-valuenow"));
        await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await p.mouse.down();
        await p.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 8 });
        await p.mouse.up();
        assert.ok(Number(await inspector.getAttribute("aria-valuenow")) < old);
        const catalogue = p.getByRole("separator", {
          name: "Resize variable catalogue",
          exact: true,
        });
        const priorHeight = Number(
          await catalogue.getAttribute("aria-valuenow"),
        );
        await catalogue.focus();
        await p.keyboard.press("ArrowUp");
        assert.ok(
          Number(await catalogue.getAttribute("aria-valuenow")) > priorHeight,
        );
        await p.keyboard.press("Home");
        assert.equal(
          await catalogue.getAttribute("aria-valuenow"),
          await catalogue.getAttribute("aria-valuemin"),
        );
        await p.keyboard.press("End");
        assert.equal(
          await catalogue.getAttribute("aria-valuenow"),
          await catalogue.getAttribute("aria-valuemax"),
        );
        const catalogueBox = await catalogue.boundingBox(),
          maximumHeight = Number(await catalogue.getAttribute("aria-valuenow"));
        await p.mouse.move(
          catalogueBox.x + catalogueBox.width / 2,
          catalogueBox.y + catalogueBox.height / 2,
        );
        await p.mouse.down();
        await p.mouse.move(
          catalogueBox.x + catalogueBox.width / 2,
          catalogueBox.y + 50,
          { steps: 8 },
        );
        await p.mouse.up();
        assert.ok(
          Number(await catalogue.getAttribute("aria-valuenow")) < maximumHeight,
        );
        await p.keyboard.press("Enter");
        const open = p.getByRole("button", { name: /Open catalogue/ });
        await expectFocus(open);
        await p.keyboard.press("Enter");
        await expectFocus(p.getByLabel("Search variables", { exact: true }));
        await inspector.focus();
        await p.keyboard.press("Enter");
        await expectFocus(
          p.getByRole("button", { name: "Toggle inspector", exact: true }),
        );
        await p.keyboard.press("Enter");
        const nav = p.getByRole("button", {
          name: "Toggle navigation",
          exact: true,
        });
        await nav.click();
        assert.equal(await nav.getAttribute("aria-expanded"), "false");
        await nav.press("Enter");
        assert.equal(await nav.getAttribute("aria-expanded"), "true");
        assert.equal(
          await p
            .locator(".inspector")
            .getByLabel("Title", { exact: true })
            .inputValue(),
          fixture.decision.title,
        );
        assert.equal(
          await p.locator(".react-flow__viewport").getAttribute("style"),
          transform,
          "Layout changes do not move the diagram viewport",
        );
        const after = await h.api("/projects/" + fixture.id);
        assert.deepEqual(after.content, before.content);
        assert.deepEqual(after.history, before.history);
        assert.equal(after.cursor, before.cursor);
        const preferences = await p.evaluate(() =>
          localStorage.getItem("flowdesk.layout.v1"),
        );
        assert.ok(preferences);
        await p.reload();
        await p.getByTestId("diagram-canvas").waitFor();
        assert.equal(
          await p.evaluate(() => localStorage.getItem("flowdesk.layout.v1")),
          preferences,
        );
        await restoreLayout(p);
        await openUxPanels(h, fixture);
      },
    );

    await t.test(
      "inspector disclosure and dialog keyboard focus preserve native inputs",
      async () => {
        const notes = section(p, "notes"),
          checklist = section(p, "checklist");
        assert.equal(await notes.evaluate((el) => el.open), false);
        assert.match(await notes.locator("summary").innerText(), /content/i);
        assert.match(
          await checklist.locator("summary").innerText(),
          /1\s*\/\s*2/,
        );
        await notes.locator("summary").focus();
        await p.keyboard.press("Enter");
        assert.equal(await notes.evaluate((el) => el.open), true);
        const note = p
          .locator(".inspector")
          .getByLabel("Notes", { exact: true });
        assert.equal(await note.inputValue(), fixture.decision.notes);
        await note.focus();
        await note.press("Home");
        await note.press("ArrowRight");
        assert.equal(await note.evaluate((el) => el.selectionStart), 1);
        const beforeSpace = await p
          .locator(".react-flow__viewport")
          .getAttribute("style");
        await notes.locator("summary").focus();
        await p.keyboard.press("Space");
        await until(async () => !(await notes.evaluate((el) => el.open)));
        assert.equal(
          await p.locator(".react-flow__viewport").getAttribute("style"),
          beforeSpace,
          "Space disclosure activation does not pan the diagram",
        );
        await openSection(p, "checklist");
        const box = p.getByLabel("Complete Test empty identifiers", {
          exact: true,
        });
        await box.focus();
        await p.keyboard.press("Space");
        await save(h);
        const saved = await h.api("/projects/" + fixture.id);
        assert.equal(
          saved.content.diagrams[0].nodes.find(
            (n) => n.id === fixture.decision.id,
          ).status,
          "blocked",
        );
        await box.press("Space");
        await save(h);
        await openSection(p, "links");
        const variableLink = p
          .locator(".inspector")
          .getByRole("button", { name: "record", exact: true });
        await variableLink.focus();
        await variableLink.press("Enter");
        await expectFocus(p.locator("#variable-detail-heading"));
        assert.equal(
          await p
            .locator(".variable-detail")
            .getByLabel("Name", { exact: true })
            .inputValue(),
          "record",
        );
        const opener = p.getByRole("button", {
          name: "New diagram",
          exact: true,
        });
        await opener.focus();
        await opener.press("Enter");
        const dialog = p.getByRole("dialog", { name: "New diagram" });
        await dialog.waitFor();
        await expectFocus(dialog.getByLabel("Diagram name", { exact: true }));
        await p.keyboard.press("Escape");
        await until(async () => !(await dialog.count()));
        await expectFocus(opener);
        const menu = p.locator(".export-menu > summary");
        await menu.focus();
        await menu.press("Enter");
        await p.keyboard.press("Tab");
        await p.keyboard.press("Escape");
        assert.equal(
          await p.locator(".export-menu").evaluate((el) => el.open),
          false,
        );
        await expectFocus(menu);
      },
    );

    await t.test(
      "catalogue filters, keyboard selection, cross-diagram return, and explicit review form one flow",
      async () => {
        const panel = p.getByRole("region", { name: "Variable catalogue" }),
          detail = p.locator(".variable-detail");
        const search = p.getByLabel("Search variables", { exact: true });
        await search.fill("does-not-exist-in-this-project");
        assert.equal(await p.locator(".variable-list tbody tr").count(), 0);
        await panel
          .getByRole("button", { name: "Clear filters", exact: true })
          .click();
        await p
          .getByLabel("Variable origin", { exact: true })
          .selectOption("planned");
        await search.fill("future_validation");
        assert.equal(await p.locator(".variable-list tbody tr").count(), 1);
        const future = fixture.envelope.content.variables.find((v) =>
          v.name.startsWith("future_validation"),
        );
        await p
          .locator(`tr[data-variable-id="${future.id}"]`)
          .getByRole("button")
          .click();
        assert.equal(
          await detail.getByLabel("Name", { exact: true }).inputValue(),
          future.name,
        );
        await panel
          .getByRole("button", { name: "Clear filters", exact: true })
          .click();
        const count = p
          .locator(`tr[data-variable-id="${fixture.plan.id}"]`)
          .getByRole("button");
        await count.focus();
        await count.press("ArrowDown");
        assert.notEqual(
          await detail.getByLabel("Name", { exact: true }).inputValue(),
          "count",
        );
        await count.click();
        const linked = detail.getByRole("region", {
          name: "Linked nodes",
          exact: true,
        });
        await linked
          .getByRole("button", {
            name: "Review rejected records with enough context to retry safely",
            exact: true,
          })
          .click();
        assert.equal(
          await p
            .locator(".inspector")
            .getByLabel("Title", { exact: true })
            .inputValue(),
          "Review rejected records with enough context to retry safely",
        );
        await p.getByRole("button", { name: /Back to variable/ }).click();
        await expectFocus(p.locator("#variable-detail-heading"));
        const ambiguous = fixture.symbols.find(
          (s) => s.ambiguousIdentity && s.state === "current",
        );
        await search.fill(ambiguous.name);
        await p
          .getByLabel("Variable origin", { exact: true })
          .selectOption("detected");
        await p
          .locator(`tr[data-variable-id="${ambiguous.id}"]`)
          .getByRole("button")
          .click();
        assert.match(await detail.innerText(), /identity needs review/i);
        assert.match(await detail.innerText(), /Line \d+/);
        await panel
          .getByRole("button", { name: "Clear filters", exact: true })
          .click();
        await count.click();
        const select = detail.getByLabel("Link a detected symbol", {
          exact: true,
        });
        const target = fixture.symbols.find(
          (s) => s.name === "record" && s.state === "current",
        );
        const before = await h.api("/projects/" + fixture.id);
        await select.selectOption(target.id);
        await wait(700);
        assert.deepEqual(
          (await h.api("/projects/" + fixture.id)).content.matches,
          before.content.matches,
          "Choosing evidence alone does not confirm it",
        );
        await detail
          .getByRole("button", { name: "Confirm match", exact: true })
          .click();
        await save(h);
        const confirmed = (
          await h.api("/projects/" + fixture.id)
        ).content.matches.find(
          (m) => m.plannedId === fixture.plan.id && m.symbolId === target.id,
        );
        assert.equal(confirmed.decision, "confirmed");
        await detail
          .locator(`[data-match-id="${confirmed.id}"]`)
          .getByRole("button", { name: "Remove", exact: true })
          .click();
        await save(h);
        await p
          .getByRole("navigation", { name: "Diagrams" })
          .getByRole("button", {
            name: new RegExp(fixture.envelope.content.diagrams[0].name),
          })
          .click();
        await openUxPanels(h, fixture);
      },
    );

    await t.test(
      "failed saves remain recoverable while changing the layout",
      async () => {
        await p.setViewportSize({ width: 1280, height: 800 });
        const title = p
          .locator(".inspector")
          .getByLabel("Title", { exact: true });
        await p.route(`**/api/projects/${fixture.id}`, (route) =>
          route.request().method() === "PUT"
            ? route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({
                  error: "Disposable save recovery test",
                }),
              })
            : route.continue(),
        );
        await title.fill("An unsaved title must survive every panel change");
        await p.getByRole("button", { name: "Save", exact: true }).click();
        await p
          .getByRole("button", { name: "Retry save", exact: true })
          .waitFor();
        const resize = p.getByRole("separator", {
          name: "Resize variable catalogue",
          exact: true,
        });
        await resize.focus();
        await resize.press("End");
        const catalogueBounds = await p
          .getByRole("region", { name: "Variable catalogue" })
          .boundingBox();
        assert.ok(
          catalogueBounds.y + catalogueBounds.height <= 801,
          "Maximum catalogue height fits beneath save recovery feedback",
        );
        await p
          .getByRole("button", { name: "Toggle inspector", exact: true })
          .click();
        await p
          .getByRole("button", { name: "Toggle navigation", exact: true })
          .click();
        await restoreLayout(p);
        assert.equal(
          await p
            .locator(".inspector")
            .getByLabel("Title", { exact: true })
            .inputValue(),
          "An unsaved title must survive every panel change",
        );
        await p.unroute(`**/api/projects/${fixture.id}`);
        await p
          .getByRole("button", { name: "Retry save", exact: true })
          .click();
        await h.saved();
        assert.equal(
          (
            await h.api("/projects/" + fixture.id)
          ).content.diagrams[0].nodes.find((n) => n.id === fixture.decision.id)
            .title,
          "An unsaved title must survive every panel change",
        );
        await title.fill(fixture.decision.title);
        await save(h);
        await openUxPanels(h, fixture);
      },
    );

    await t.test(
      "target-size screenshots, readable controls, reduced motion, and real 200% browser zoom",
      async () => {
        await restoreLayout(p);
        await openUxPanels(h, fixture);
        const results = { sizes: {}, contrast: await measureContrast(p) };
        for (const sample of results.contrast)
          assert.ok(
            sample.ratio >= 4.5,
            `${sample.selector} text contrast ${sample.ratio.toFixed(2)}:1`,
          );
        for (const [width, height] of [
          [1440, 900],
          [1280, 800],
          [800, 700],
        ]) {
          await p.setViewportSize({ width, height });
          await wait(200);
          const size = await measureWorkspace(p);
          results.sizes[`${width}x${height}`] = size;
          assert.ok(
            size.document.width <= width + 1,
            "Supporting panels must not cause page-wide horizontal overflow",
          );
          for (const label of ["Save", "Undo", "Redo", "Scan Python"]) {
            const action = p.getByRole("button", { name: label, exact: true });
            await action.scrollIntoViewIfNeeded();
            const bounds = await action.boundingBox();
            assert.ok(
              bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
              `${label} stays horizontally reachable`,
            );
          }
          await p.screenshot({
            path: path.join(h.output, `after-${width}x${height}.png`),
            fullPage: true,
          });
        }
        await p.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(
          await p.evaluate(
            () => matchMedia("(prefers-reduced-motion: reduce)").matches,
          ),
          true,
        );
        assert.equal(
          await p
            .locator(".inspector")
            .evaluate((el) => getComputedStyle(el).animationName),
          "none",
        );
        await p.setViewportSize({ width: 1280, height: 800 });
        for (const locator of [
          p.getByRole("button", { name: "Save", exact: true }),
          p.locator(".inspector").getByLabel("Title", { exact: true }),
          p.getByLabel("Search variables", { exact: true }),
        ])
          assert.ok(
            (await locator.evaluate((el) =>
              parseFloat(getComputedStyle(el).fontSize),
            )) >= 13,
          );
        await withBrowserZoom(h, async (zoomed, setZoom) => {
          await openUxPanels(zoomed, fixture);
          const factor = await setZoom(2);
          assert.equal(factor, 2);
          const size = await measureWorkspace(zoomed.page);
          results.browserZoom200 = { factor, ...size };
          assert.equal(size.viewport.width, 640);
          assert.equal(size.viewport.devicePixelRatio, 2);
          assert.ok(
            size.document.width <= size.viewport.width + 1,
            "Real browser zoom must reflow without horizontal page overflow",
          );
          for (const label of [
            "Save",
            "Undo",
            "Redo",
            "Scan Python",
            "Toggle navigation",
            "Toggle inspector",
          ]) {
            const action = zoomed.page.getByRole("button", {
              name: label,
              exact: true,
            });
            await action.scrollIntoViewIfNeeded();
            const bounds = await action.boundingBox();
            assert.ok(
              bounds.x >= 0 &&
                bounds.x + bounds.width <= size.viewport.width + 1,
              `${label} reachable at real 200% zoom`,
            );
          }
          await zoomed.page.screenshot({
            path: path.join(h.output, "after-browser-zoom-200.png"),
            fullPage: true,
          });
        });
        fs.writeFileSync(
          path.join(h.output, "measurements.json"),
          JSON.stringify(results, null, 2),
        );
        console.log("UX_ARTIFACTS=" + h.output);
      },
    );

    await t.test(
      "empty planning actions and background scan feedback remain usable",
      async () => {
        await p.setViewportSize({ width: 1440, height: 900 });
        await restoreLayout(p);
        await openUxPanels(h, fixture);
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        const poll = `**/api/projects/${fixture.id}/scans/*`;
        await p.route(poll, async (route) => {
          if (route.request().method() !== "GET") return route.continue();
          const response = await route.fetch();
          await gate;
          return route.fulfill({ response });
        });
        await p
          .getByRole("button", { name: "Scan Python", exact: true })
          .click();
        const dialog = p.getByRole("dialog", { name: "Python source" });
        await dialog
          .getByRole("button", { name: "Rescan Python files", exact: true })
          .click();
        await p.keyboard.press("Escape");
        await p.locator(".scan-progress").waitFor();
        const title = p
          .locator(".inspector")
          .getByLabel("Title", { exact: true });
        await title.fill(
          "Planning remains editable while scan feedback is pending",
        );
        await save(h);
        assert.equal(
          (
            await h.api("/projects/" + fixture.id)
          ).content.diagrams[0].nodes.find((n) => n.id === fixture.decision.id)
            .title,
          "Planning remains editable while scan feedback is pending",
        );
        const cancellation = p.waitForResponse(
          (r) => r.request().method() === "POST" && r.url().endsWith("/cancel"),
        );
        await p
          .locator(".scan-progress")
          .getByRole("button", { name: "Cancel scan", exact: true })
          .click();
        assert.ok((await cancellation).ok());
        release();
        await p.unroute(poll);
        await until(async () => !(await p.locator(".scan-progress").count()));
        await title.fill(fixture.decision.title);
        await save(h);
        const empty = await h.api("/projects/" + fixture.emptyId);
        await h.api("/projects/" + fixture.emptyId, "PUT", {
          baseRevision: empty.revision,
          mutationId: crypto.randomUUID(),
          anchorId: empty.cursor,
          append: [],
          cursor: empty.cursor,
          views: { [empty.content.diagrams[0].id]: { x: 0, y: 0, zoom: 2.5 } },
        });
        await p
          .getByRole("navigation", { name: "Projects" })
          .getByRole("button", { name: "An empty project", exact: false })
          .click();
        await p
          .getByRole("button", { name: "Add a process", exact: true })
          .waitFor();
        const canvasBounds = await p
          .getByTestId("diagram-canvas")
          .boundingBox();
        await p
          .getByRole("button", { name: "Add a process", exact: true })
          .click();
        await p.locator(".react-flow__node").waitFor({ state: "visible" });
        const nodeBounds = await p.locator(".react-flow__node").boundingBox();
        assert.ok(
          Math.abs(
            nodeBounds.x +
              nodeBounds.width / 2 -
              (canvasBounds.x + canvasBounds.width / 2),
          ) <= 26,
          "New node is horizontally centered even at 250% diagram zoom",
        );
        assert.ok(
          Math.abs(
            nodeBounds.y +
              nodeBounds.height / 2 -
              (canvasBounds.y + canvasBounds.height / 2),
          ) <= 26,
          "New node is vertically centered even at 250% diagram zoom",
        );
        assert.equal(
          await p
            .locator(".inspector")
            .getByLabel("Title", { exact: true })
            .inputValue(),
          "Process",
        );
        await save(h);
        assert.equal(
          (await h.api("/projects/" + fixture.emptyId)).content.diagrams[0]
            .nodes.length,
          1,
        );
        if (
          !(await p.getByRole("region", { name: "Variable catalogue" }).count())
        )
          await p.getByRole("button", { name: /Open catalogue/ }).click();
        await p
          .getByRole("button", { name: "+ Plan variable", exact: true })
          .click();
        await p
          .locator(".variable-detail")
          .getByLabel("Name", { exact: true })
          .fill("first_planned_value");
        await save(h);
        assert.equal(
          (await h.api("/projects/" + fixture.emptyId)).content.variables[0]
            .name,
          "first_planned_value",
        );
      },
    );
  },
);
