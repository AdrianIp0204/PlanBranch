const { projectAction } = require("./ux-fixture.cjs");
/* Real keyboard/pointer movement against an isolated local service and SQLite DB. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupBrowser, until, wait } = require("./browser-harness.cjs");

function node(id, title, x, y) {
  return {
    id,
    type: "process",
    title,
    position: { x, y },
    description: "Keep this description",
    notes: "Movement must preserve metadata",
    pseudocode: "count += 1",
    status: "not_started",
    checklist: [
      { id: crypto.randomUUID(), text: "Movement invariant", checked: false },
    ],
    targetFile: "future.py",
    targetScope: "main",
    why: "",
    alternatives: "",
    blocker: "",
  };
}
const positions = (envelope) =>
  Object.fromEntries(
    envelope.content.diagrams[0].nodes.map((n) => [n.id, n.position]),
  );

test(
  "durable keyboard and mouse node movement",
  { timeout: 180000 },
  async (t) => {
    const a = crypto.randomUUID(),
      b = crypto.randomUUID(),
      c = crypto.randomUUID(),
      diagramId = crypto.randomUUID(),
      variableId = crypto.randomUUID();
    const content = {
      schemaVersion: 1,
      name: "Movement regression",
      notes: "",
      diagrams: [
        {
          id: diagramId,
          name: "Movement",
          nodes: [
            node(a, "Alpha", 100, 100),
            node(b, "Beta", 480, 100),
            node(c, "Gamma", 290, 380),
          ],
          edges: [
            {
              id: crypto.randomUUID(),
              source: a,
              target: b,
              sourceHandle: "out",
              targetHandle: "in",
              label: "Next",
            },
          ],
        },
      ],
      variables: [
        {
          id: variableId,
          name: "count",
          description: "Manual plan",
          intendedType: "int",
          intendedFile: "future.py",
          scopeKind: "function",
          scope: "main",
          initialExpression: "0",
          notes: "Keep this plan",
          status: "not_started",
        },
      ],
      nodeLinks: [
        {
          id: crypto.randomUUID(),
          nodeId: a,
          variableId,
          origin: "planned",
          relationship: "writes",
        },
      ],
      matches: [],
    };
    const h = await setupBrowser(t, { name: "movement", seed: { content } });
    const { page } = h;
    const projectId = h.initial.id;
    // Store.create remaps IDs for copied content, so use the actual persisted IDs.
    const [first, second, third] = h.initial.content.diagrams[0].nodes.map(
      (n) => n.id,
    );
    const original = structuredClone(h.initial.content);
    const sourceFile = path.join(h.sourceDir, "unchanged.py");
    const sourceBytes = Buffer.from(
      "def main():\n    count = 0\n    return count\n",
    );
    fs.writeFileSync(sourceFile, sourceBytes);
    await h.api(`/projects/${projectId}/source`, "POST", {
      root: h.sourceDir,
      ignores: [],
      confirmed: true,
    });
    t.after(() =>
      assert.deepEqual(
        fs.readFileSync(sourceFile),
        sourceBytes,
        "Movement must never change attached source files",
      ),
    );
    const element = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
    const read = () => h.api(`/projects/${projectId}`);
    async function durable(expected) {
      await until(async () => {
        const state = await read();
        return JSON.stringify(positions(state)) === JSON.stringify(expected);
      });
      await h.saved();
      return read();
    }
    async function save() {
      await projectAction(page, "Save");
      await h.saved();
    }
    async function assertRendered(expected) {
      await until(async () => {
        for (const [id, p] of Object.entries(expected)) {
          const style = await element(id).getAttribute("style");
          if (!style.includes(`translate(${p.x}px, ${p.y}px)`)) return false;
        }
        return true;
      });
    }
    function assertMetadata(state) {
      const strip = (content) => ({
        variables: content.variables,
        nodeLinks: content.nodeLinks,
        edges: content.diagrams[0].edges,
        nodes: content.diagrams[0].nodes.map(({ position, ...rest }) => rest),
      });
      assert.deepEqual(strip(state.content), strip(original));
    }

    await t.test(
      "continuous arrow-key nudges autosave as one action and survive restart/undo/redo",
      async () => {
        const before = await read();
        const expected = positions(before);
        await element(first).click();
        await element(first).focus();
        for (let i = 0; i < 12; i++) {
          await page.keyboard.down("ArrowRight");
          await wait(80);
        }
        await page.keyboard.up("ArrowRight");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Shift+ArrowRight");
        expected[first] = {
          x: expected[first].x + 160,
          y: expected[first].y + 30,
        };
        const moved = await durable(expected);
        assert.equal(
          moved.history.length,
          before.history.length + 1,
          "Continuous keyboard movement must be one checkpoint",
        );
        assertMetadata(moved);
        await h.restart();
        await assertRendered(expected);
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await save();
        assert.deepEqual(positions(await read()), positions(before));
        await h.restart();
        await page.getByRole("button", { name: "Redo", exact: true }).click();
        await save();
        assert.deepEqual(positions(await read()), expected);
        assertMetadata(await read());
      },
    );

    await t.test(
      "multi-selected nodes remain selected and move together with keyboard and mouse",
      async () => {
        const before = await read();
        const expected = positions(before);
        await element(first).click();
        await element(second).click({ modifiers: ["Control"] });
        await until(
          async () =>
            (await page.locator(".react-flow__node.selected").count()) === 2,
        );
        await element(first).focus();
        for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
        expected[first] = { x: expected[first].x - 50, y: expected[first].y };
        expected[second] = {
          x: expected[second].x - 50,
          y: expected[second].y,
        };
        const keyed = await durable(expected);
        assert.equal(keyed.history.length, before.history.length + 1);
        assert.equal(
          await page.locator(".react-flow__node.selected").count(),
          2,
          "Canonical saves must preserve multi-selection",
        );
        const box = await element(first).boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + 45);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 20, box.y + 65, {
          steps: 4,
        });
        await wait(750);
        assert.deepEqual(
          positions(await read()),
          expected,
          "In-progress pointer movement is not a finished action",
        );
        await page.mouse.move(box.x + box.width / 2 + 40, box.y + 75, {
          steps: 4,
        });
        await page.mouse.up();
        expected[first] = {
          x: expected[first].x + 40,
          y: expected[first].y + 30,
        };
        expected[second] = {
          x: expected[second].x + 40,
          y: expected[second].y + 30,
        };
        const dragged = await durable(expected);
        assert.equal(
          dragged.history.length,
          keyed.history.length + 1,
          "A completed multi-node mouse drag is one action",
        );
        assert.deepEqual(
          dragged.content.diagrams[0].nodes.find((n) => n.id === third)
            .position,
          before.content.diagrams[0].nodes.find((n) => n.id === third).position,
        );
        assertMetadata(dragged);
        await h.restart();
        await assertRendered(expected);
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await save();
        assert.deepEqual(positions(await read()), positions(keyed));
        await page.getByRole("button", { name: "Redo", exact: true }).click();
        await save();
        assert.deepEqual(positions(await read()), expected);
      },
    );

    await t.test(
      "selection-box dragging persists both positions as one undoable action",
      async () => {
        const before = await read();
        const expected = positions(before);
        const canvas = await page.getByTestId("diagram-canvas").boundingBox();
        await page.mouse.click(canvas.x + 20, canvas.y + 20);
        const firstBox = await element(first).boundingBox(),
          secondBox = await element(second).boundingBox();
        const left = Math.min(firstBox.x, secondBox.x) - 12,
          top = Math.min(firstBox.y, secondBox.y) - 12;
        const right =
            Math.max(
              firstBox.x + firstBox.width,
              secondBox.x + secondBox.width,
            ) + 12,
          bottom =
            Math.max(
              firstBox.y + firstBox.height,
              secondBox.y + secondBox.height,
            ) + 12;
        await page.keyboard.down("Shift");
        await page.mouse.move(left, top);
        await page.mouse.down();
        await page.mouse.move(right, bottom, { steps: 10 });
        await page.mouse.up();
        await page.keyboard.up("Shift");
        const selection = page.locator(".react-flow__nodesselection-rect");
        await selection.waitFor();
        assert.equal(
          await page.locator(".react-flow__node.selected").count(),
          2,
        );
        const group = await selection.boundingBox();
        const x = group.x + group.width / 2,
          y = group.y + 10;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 30, y + 20, { steps: 8 });
        await wait(700);
        await page.mouse.up();
        expected[first] = {
          x: expected[first].x + 30,
          y: expected[first].y + 20,
        };
        expected[second] = {
          x: expected[second].x + 30,
          y: expected[second].y + 20,
        };
        const after = await durable(expected);
        assert.equal(after.history.length, before.history.length + 1);
        assertMetadata(after);
        await h.restart();
        await assertRendered(expected);
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await save();
        assert.deepEqual(positions(await read()), positions(before));
        await page.getByRole("button", { name: "Redo", exact: true }).click();
        await save();
        assert.deepEqual(positions(await read()), expected);
      },
    );

    await t.test(
      "native text and embedded checkbox keys never move or delete nodes",
      async () => {
        const before = await read(),
          expected = positions(before);
        await element(first).dblclick();
        const title = page.getByLabel("Title", { exact: true });
        const initialTitle = await title.inputValue();
        await title.focus();
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowRight");
        assert.equal(
          await title.evaluate((el) => el.selectionStart),
          1,
          "Arrow keys keep native caret behavior",
        );
        await page.keyboard.press("Backspace");
        assert.equal(await title.inputValue(), initialTitle.slice(1));
        await page.keyboard.press("Control+z");
        assert.equal(
          await title.inputValue(),
          initialTitle,
          "Text undo must remain native",
        );
        await title.fill(initialTitle);
        await title.press("End");
        await page.keyboard.type("X");
        await page.keyboard.press("Control+z");
        assert.equal(await title.inputValue(), initialTitle);
        const checkbox = element(first).getByRole("checkbox");
        await checkbox.focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowDown");
        await save();
        assert.deepEqual(positions(await read()), expected);
        assert.equal(await page.locator(".react-flow__node").count(), 3);
        assertMetadata(await read());
      },
    );
  },
);
