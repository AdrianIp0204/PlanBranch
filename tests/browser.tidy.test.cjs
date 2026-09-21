const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setupBrowser, until, wait } = require("./browser-harness.cjs");

function task(title, type, x, y) {
  return {
    id: crypto.randomUUID(),
    type,
    title,
    position: { x, y },
    description: `Purpose of ${title}`,
    notes: "Preserve the authored plan while arranging it.",
    pseudocode: "validate(record)",
    status: type === "decision" ? "blocked" : "not_started",
    checklist: [
      { id: crypto.randomUUID(), text: "Keep this checklist", checked: true },
    ],
    targetFile: "not_created.py",
    targetScope: "main",
    why: type === "decision" ? "Review invalid input before retrying." : "",
    alternatives: "Manual review",
    blocker: type === "decision" ? "Choose a policy" : "",
  };
}
function fixture() {
  const nodes = [
    task("Start import", "start", 650, 60),
    task("Validate record", "decision", 80, 240),
    task("Accept record", "process", 690, 440),
    task("Review and retry", "process", 350, 60),
    task("Merge results", "io", 70, 470),
    task("Finish import", "end", 390, 450),
    task("Planning context", "note", 1020, 260),
  ];
  const edge = (source, target, label, sourceHandle = "out") => ({
    id: crypto.randomUUID(),
    source: nodes[source].id,
    target: nodes[target].id,
    sourceHandle,
    targetHandle: "in",
    label,
  });
  const variable = {
    id: crypto.randomUUID(),
    name: "record",
    description: "Human-authored intent",
    intendedType: "dict",
    intendedFile: "not_created.py",
    scopeKind: "function",
    scope: "main",
    initialExpression: "{}",
    notes: "Keep this variable plan",
    status: "not_started",
  };
  return {
    schemaVersion: 1,
    name: "Tidy acceptance",
    notes: "Keep project notes",
    diagrams: [
      {
        id: crypto.randomUUID(),
        name: "Branch, merge, and loop",
        nodes,
        edges: [
          edge(0, 1, "Read"),
          edge(1, 2, "Valid", "yes"),
          edge(1, 3, "Needs review", "no"),
          edge(3, 1, "Retry"),
          edge(2, 4, "Accepted"),
          edge(3, 4, "Skip"),
          edge(4, 5, "Complete"),
        ],
      },
      {
        id: crypto.randomUUID(),
        name: "Unrelated diagram",
        nodes: [task("Leave this step", "process", 130, 210)],
        edges: [],
      },
    ],
    variables: [variable],
    nodeLinks: [
      {
        id: crypto.randomUUID(),
        nodeId: nodes[1].id,
        variableId: variable.id,
        origin: "planned",
        relationship: "reads",
      },
    ],
    matches: [],
  };
}
const positions = (envelope) =>
  Object.fromEntries(
    envelope.content.diagrams[0].nodes.map((node) => [node.id, node.position]),
  );
function withoutPositions(content) {
  const result = structuredClone(content);
  for (const node of result.diagrams[0].nodes) delete node.position;
  return result;
}
async function environment(t, name) {
  const h = await setupBrowser(t, {
    name,
    viewport: { width: 1600, height: 1000 },
    seed: { content: fixture() },
  });
  const p = h.page;
  const read = () => h.api(`/projects/${h.initial.id}`);
  const node = (id) =>
    p
      .getByTestId("diagram-canvas")
      .locator(`.react-flow__node[data-id="${id}"]`);
  await p.locator(".react-flow__controls-fitview").click();
  await h.saved();
  const save = async () => {
    await p.getByRole("button", { name: "Save", exact: true }).click();
    await h.saved();
    return read();
  };
  const selectedIds = () =>
    p
      .getByTestId("diagram-canvas")
      .locator(".react-flow__node.selected")
      .evaluateAll((elements) =>
        elements.map((element) => element.dataset.id).sort(),
      );
  const renderedPositions = () =>
    p
      .getByTestId("diagram-canvas")
      .locator(".react-flow__node")
      .evaluateAll((elements) =>
        Object.fromEntries(
          elements.map((element) => [
            element.dataset.id,
            element.style.transform,
          ]),
        ),
      );
  const open = async (direction, scope = "all") => {
    await p.getByRole("button", { name: "Tidy diagram", exact: true }).click();
    const dialog = p.getByRole("dialog", { name: "Tidy diagram", exact: true });
    await dialog.getByTestId("tidy-preview").waitFor();
    await dialog
      .getByLabel("Direction", { exact: true })
      .selectOption(direction);
    await dialog.getByLabel("Scope", { exact: true }).selectOption(scope);
    return dialog;
  };
  const apply = async (dialog, before) => {
    await dialog
      .getByRole("button", { name: "Apply arrangement", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await until(async () => {
      const next = await read();
      return (
        next.history.length === before.history.length + 1 &&
        JSON.stringify(positions(next)) !== JSON.stringify(positions(before))
      );
    });
    await h.saved();
    const next = await read();
    assert.equal(
      next.history.length,
      before.history.length + 1,
      "Applying Tidy records exactly one action",
    );
    assert.deepEqual(
      withoutPositions(next.content),
      withoutPositions(before.content),
      "Only positions change; graph, IDs, links, fields, and unrelated diagrams remain intact",
    );
    assert.deepEqual(
      next.views,
      before.views,
      "Arranging does not reset the saved canvas viewport",
    );
    return next;
  };
  return {
    h,
    p,
    read,
    node,
    save,
    selectedIds,
    renderedPositions,
    open,
    apply,
  };
}

for (const direction of ["horizontal", "vertical"]) {
  test(
    `Tidy ${direction} previews a branch, merge, and cycle without edits; apply is one durable undoable action`,
    { timeout: 120000 },
    async (t) => {
      const {
        h,
        p,
        read,
        node,
        save,
        selectedIds,
        renderedPositions,
        open,
        apply,
      } = await environment(t, `tidy-${direction}`);
      const chosen = h.initial.content.diagrams[0].nodes[1].id;
      await node(chosen).locator(".task-title").click();
      await save();
      const before = await read();
      const selected = await selectedIds();
      const rendered = await renderedPositions();
      const viewport = await p
        .getByTestId("diagram-canvas")
        .locator(".react-flow__viewport")
        .getAttribute("style");
      let dialog = await open(direction);
      // Exercise preview recomputation in both directions without committing either.
      await dialog
        .getByLabel("Direction", { exact: true })
        .selectOption(direction === "horizontal" ? "vertical" : "horizontal");
      await dialog
        .getByLabel("Direction", { exact: true })
        .selectOption(direction);
      assert.deepEqual(
        await renderedPositions(),
        rendered,
        "Preview must not move live canvas nodes",
      );
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      // Give the ordinary autosave window a chance to expose an accidental preview edit.
      await wait(750);
      const cancelled = await read();
      for (const field of ["content", "history", "cursor", "views", "revision"])
        assert.deepEqual(
          cancelled[field],
          before[field],
          `Cancel leaves ${field} unchanged`,
        );
      assert.deepEqual(
        await selectedIds(),
        selected,
        "Opening and cancelling preview retains selection",
      );
      assert.equal(
        await p
          .getByTestId("diagram-canvas")
          .locator(".react-flow__viewport")
          .getAttribute("style"),
        viewport,
      );
      dialog = await open(direction);
      const arranged = await apply(dialog, before);
      assert.deepEqual(
        await selectedIds(),
        selected,
        "Applying arrangement retains selection",
      );
      await h.restart();
      assert.deepEqual(
        positions(await read()),
        positions(arranged),
        "Arranged positions survive a service restart",
      );
      await p.getByRole("button", { name: "Undo", exact: true }).click();
      const undone = await save();
      assert.deepEqual(
        undone.content,
        before.content,
        "One undo restores every original position and all metadata",
      );
      assert.deepEqual(undone.views, before.views);
      await h.restart();
      await p.getByRole("button", { name: "Redo", exact: true }).click();
      const redone = await save();
      assert.deepEqual(
        redone.content,
        arranged.content,
        "Redo remains available across restart",
      );
    },
  );
}

test(
  "Tidy selected nodes keeps pinned and unselected positions fixed and persists pins",
  { timeout: 120000 },
  async (t) => {
    const { h, p, read, node, save, selectedIds, open, apply } =
      await environment(t, "tidy-selected-pinned");
    const [pinned, decision, accepted] =
      h.initial.content.diagrams[0].nodes.map((item) => item.id);
    await node(pinned).locator(".task-title").click();
    await p.getByLabel("Pin position for Tidy", { exact: true }).check();
    const withPin = await save();
    assert.equal(
      withPin.content.diagrams[0].nodes.find((item) => item.id === pinned)
        .pinned,
      true,
    );
    await node(pinned).locator(".task-title").click();
    await node(decision)
      .locator(".task-title")
      .click({ modifiers: ["Control"] });
    await node(accepted)
      .locator(".task-title")
      .click({ modifiers: ["Control"] });
    const selected = [pinned, decision, accepted].sort();
    await until(
      async () =>
        JSON.stringify(await selectedIds()) === JSON.stringify(selected),
    );
    const before = await read();
    const dialog = await open("horizontal", "selected");
    const arranged = await apply(dialog, before);
    const originalPositions = positions(before);
    const arrangedPositions = positions(arranged);
    for (const item of before.content.diagrams[0].nodes) {
      if (item.id === pinned || !selected.includes(item.id))
        assert.deepEqual(
          arrangedPositions[item.id],
          originalPositions[item.id],
          "Pinned and unselected nodes remain fixed",
        );
    }
    assert.ok(
      [decision, accepted].some(
        (id) =>
          JSON.stringify(arrangedPositions[id]) !==
          JSON.stringify(originalPositions[id]),
      ),
      "At least one selected unpinned node moves",
    );
    assert.deepEqual(
      await selectedIds(),
      selected,
      "Multi-selection is preserved by apply and autosave",
    );
    await h.restart();
    assert.deepEqual(
      (await read()).content,
      arranged.content,
      "Positions, pins, graph metadata and links survive restart",
    );
    await node(pinned).locator(".task-title").click();
    assert.equal(
      await p.getByLabel("Pin position for Tidy", { exact: true }).isChecked(),
      true,
    );
    await p.getByRole("button", { name: "Undo", exact: true }).click();
    assert.deepEqual(
      (await save()).content,
      before.content,
      "Undo restores the selected arrangement while retaining the earlier pin edit",
    );
  },
);
const path = require("node:path");
const fs = require("node:fs");

test(
  "Tidy previews are read-only and remain visible at both review sizes",
  { timeout: 120000 },
  async (t) => {
    const { h, p, read, save, open } = await environment(
      t,
      "tidy-preview-sizes",
    );
    for (const size of [
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await p.setViewportSize(size);
      for (const direction of ["horizontal", "vertical"]) {
        await save();
        const before = await read();
        const dialog = await open(direction);
        const preview = dialog.getByTestId("tidy-preview");
        const previewNodes = preview.locator(".react-flow__node");
        try {
          await until(async () => {
            const bounds = await preview.boundingBox();
            const nodes = await previewNodes.evaluateAll((items) =>
              items.map((item) => {
                const box = item.getBoundingClientRect();
                return {
                  x: box.x,
                  y: box.y,
                  right: box.right,
                  bottom: box.bottom,
                };
              }),
            );
            return (
              nodes.length === before.content.diagrams[0].nodes.length &&
              nodes.every(
                (box) =>
                  box.x >= bounds.x - 1 &&
                  box.y >= bounds.y - 1 &&
                  box.right <= bounds.x + bounds.width + 1 &&
                  box.bottom <= bounds.y + bounds.height + 1,
              )
            );
          });
        } catch (error) {
          fs.writeFileSync(
            path.join(
              h.output,
              `geometry-${direction}-${size.width}x${size.height}.json`,
            ),
            JSON.stringify(
              await preview.evaluate((element) => ({
                viewport: element
                  .querySelector(".react-flow__viewport")
                  ?.getAttribute("style"),
                preview: element.getBoundingClientRect().toJSON(),
                nodes: [...element.querySelectorAll(".react-flow__node")].map(
                  (node) => ({
                    id: node.dataset.id,
                    style: node.getAttribute("style"),
                    bounds: node.getBoundingClientRect().toJSON(),
                  }),
                ),
              })),
              null,
              2,
            ),
          );
          throw error;
        }
        const action = await dialog
          .getByRole("button", { name: "Apply arrangement", exact: true })
          .boundingBox();
        assert.ok(
          action.y >= 0 && action.y + action.height <= size.height,
          "Apply remains inside the review window",
        );
        await p.screenshot({
          path: path.join(
            h.output,
            `tidy-${direction}-${size.width}x${size.height}.png`,
          ),
          fullPage: true,
        });
        const nodePositions = () =>
          previewNodes.evaluateAll((items) =>
            Object.fromEntries(
              items.map((item) => [item.dataset.id, item.style.transform]),
            ),
          );
        const originalPreview = await nodePositions();
        const first = previewNodes.first();
        const box = await first.boundingBox();
        await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await p.mouse.down();
        await p.mouse.move(
          box.x + box.width / 2 + 35,
          box.y + box.height / 2 + 20,
          { steps: 4 },
        );
        await p.mouse.up();
        await first.focus();
        await first.press("ArrowRight");
        await first.press("Delete");
        assert.deepEqual(
          await nodePositions(),
          originalPreview,
          "Preview interaction cannot move or remove planned nodes",
        );
        for (const control of await preview.getByRole("checkbox").all())
          assert.equal(
            await control.isDisabled(),
            true,
            "Preview completion controls are read-only",
          );
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await dialog.waitFor({ state: "hidden" });
        const after = await read();
        for (const field of [
          "content",
          "history",
          "cursor",
          "views",
          "revision",
        ])
          assert.deepEqual(
            after[field],
            before[field],
            `Preview pointer/keyboard interaction preserves ${field}`,
          );
      }
    }
  },
);
