/* Connection labels stay readable in the saved canvas, proposals, and full exports. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupBrowser, until } = require("./browser-harness.cjs");

function node(id, title, x, y) {
  return {
    id,
    type: "process",
    title,
    position: { x, y },
    description: "Read this title without a connection label over it.",
    notes: "",
    pseudocode: "",
    status: "not_started",
    checklist: [],
    targetFile: "",
    targetScope: "",
    why: "",
    alternatives: "",
    blocker: "",
  };
}
function edge(id, source, target, label) {
  return { id, source, target, sourceHandle: "out", targetHandle: "in", label };
}
function content() {
  return {
    schemaVersion: 1,
    name: "Readable connection labels",
    notes: "",
    diagrams: [
      {
        id: "diagram",
        name: "Horizontal flow",
        nodes: [
          node("start", "Launch application", 80, 300),
          node("database", "Open the database", 330, 300),
          node("commands", "Choose a command", 600, 300),
        ],
        edges: [
          edge("launch", "start", "database", "launch"),
          edge("ready", "database", "commands", "database ready"),
          edge(
            "retry",
            "commands",
            "start",
            "Try the command again\nKeep existing tasks intact\nReturn to the beginning",
          ),
        ],
      },
    ],
    variables: [],
    nodeLinks: [],
    matches: [],
  };
}

// Run inside the page or the temporary export root. A visible rectangle must clear
// every node, including nodes unrelated to that connection and proposal badges.
function measureLabels(root) {
  const rect = (el) => {
    const box = el.getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    };
  };
  const host = rect(root);
  const nodes = [
    ...root.querySelectorAll(".react-flow__node,.proposal-change-badge"),
  ]
    .map((el) => ({
      id: el.getAttribute("data-id") || el.textContent,
      ...rect(el),
    }))
    .filter((box) => box.width && box.height);
  const labels = [...root.querySelectorAll(".flow-edge-label")]
    .map((el) => ({ text: el.textContent, ...rect(el) }))
    .filter((box) => box.width && box.height);
  const collisions = labels.flatMap((label) =>
    nodes
      .filter(
        (node) =>
          Math.min(label.right, node.right) - Math.max(label.left, node.left) >
            0.5 &&
          Math.min(label.bottom, node.bottom) - Math.max(label.top, node.top) >
            0.5,
      )
      .map((node) => ({ label: label.text, node: node.id })),
  );
  return { host, nodes, labels, collisions };
}
async function assertClear(root, expectedLabels, label) {
  let snapshot;
  try {
    await until(async () => {
      snapshot = await root.evaluate(measureLabels);
      return (
        snapshot.labels.length === expectedLabels &&
        snapshot.collisions.length === 0
      );
    });
  } catch (error) {
    assert.equal(
      snapshot?.labels.length,
      expectedLabels,
      `${label}: every label is rendered`,
    );
    assert.deepEqual(
      snapshot?.collisions,
      [],
      `${label}: labels do not cover any nodes`,
    );
    throw error;
  }
  assert.equal(
    snapshot.labels.length,
    expectedLabels,
    `${label}: every label is rendered`,
  );
  assert.deepEqual(
    snapshot.collisions,
    [],
    `${label}: labels do not cover any nodes`,
  );
  return snapshot;
}

test(
  "connection labels avoid nodes through selection, movement, proposal review, and PNG export",
  { timeout: 90000 },
  async (t) => {
    const h = await setupBrowser(t, {
      name: "edge-labels",
      seed: { content: content() },
      planningFixture: true,
      viewport: { width: 1600, height: 1000 },
    });
    const p = h.page;
    const canvas = p.getByTestId("diagram-canvas");
    const url = `/projects/${h.initial.id}`;
    const [first, second, third] = h.initial.content.diagrams[0].nodes;
    const original = structuredClone(h.initial.content);
    const initial = await assertClear(canvas, 3, "Saved horizontal canvas");
    assert.ok(
      initial.labels.find((label) => label.text.includes("Keep existing tasks"))
        .height > 35,
      "A multiline label is measured at its full height",
    );

    const launch = canvas.getByRole("button", {
      name: "Edit connection launch",
      exact: true,
    });
    await launch.focus();
    await launch.press("Enter");
    assert.equal(
      await p.getByLabel("Branch label", { exact: true }).inputValue(),
      "launch",
      "Keyboard activation selects the connection",
    );
    await canvas
      .getByRole("button", {
        name: "Edit connection database ready",
        exact: true,
      })
      .click();
    assert.equal(
      await p.getByLabel("Branch label", { exact: true }).inputValue(),
      "database ready",
      "Pointer activation still selects the connection",
    );

    await canvas.locator(`.react-flow__node[data-id="${second.id}"]`).click();
    await canvas.locator(`.react-flow__node[data-id="${second.id}"]`).focus();
    for (let index = 0; index < 8; index++) await p.keyboard.press("ArrowDown");
    await until(
      async () =>
        (await h.api(url)).content.diagrams[0].nodes.find(
          (n) => n.id === second.id,
        ).position.y ===
        second.position.y + 80,
    );
    await h.saved();
    const afterMove = await assertClear(canvas, 3, "Moved node");
    assert.ok(
      afterMove.labels.some((after) => {
        const before = initial.labels.find(
          (label) => label.text === after.text,
        );
        return (
          Math.abs(after.left - before.left) > 1 ||
          Math.abs(after.top - before.top) > 1
        );
      }),
      "Connection-label placement updates after a node moves",
    );
    const moved = await h.api(url);
    assert.equal(
      moved.content.diagrams[0].nodes.find((n) => n.id === first.id).position.y,
      first.position.y,
    );
    assert.equal(
      moved.content.diagrams[0].nodes.find((n) => n.id === third.id).position.y,
      third.position.y,
    );
    assert.deepEqual(
      moved.content.diagrams[0].edges,
      original.diagrams[0].edges,
      "Label placement never rewrites the graph",
    );
    await p.screenshot({ path: path.join(h.output, "saved-labels.png") });

    if (
      !(await p
        .getByRole("complementary", { name: "Planning conversation" })
        .isVisible())
    )
      await p
        .getByRole("button", { name: "Toggle planning chat", exact: true })
        .click();
    await p.getByRole("tab", { name: "Chat", exact: true }).click();
    await p
      .getByLabel("Message Codex", { exact: true })
      .fill("Add a review step");
    await p.getByRole("button", { name: "Send", exact: true }).click();
    const proposal = p.getByRole("region", {
      name: "Proposed changes workspace",
    });
    await proposal.waitFor();
    await assertClear(proposal, 4, "Proposed diagram with a nearby new node");
    assert.equal(await proposal.locator(".react-flow__node").count(), 4);
    await p.screenshot({ path: path.join(h.output, "proposal-labels.png") });
    assert.deepEqual(
      (await h.api(url)).content,
      moved.content,
      "Reviewing label layout leaves the saved plan unchanged",
    );
    await proposal.getByRole("button", { name: "Before", exact: true }).click();
    await assertClear(proposal, 3, "Before diagram");
    await proposal
      .getByRole("button", { name: "Back to plan", exact: true })
      .click();
    await proposal.waitFor({ state: "hidden" });

    // Observe the real, offscreen export surface while it exists. Sampling ends
    // after cleanup and does not change layout or delay the export itself.
    await p.evaluate(`(() => {
      const measure = ${measureLabels.toString()};
      window.__edgeLabelExport = { seen: false, samples: [] };
      const inspect = () => {
        const state = window.__edgeLabelExport;
        const host = document.querySelector(".png-export");
        if (host) {
          state.seen = true;
          const snapshot = measure(host);
          if (snapshot.labels.length === 3 && snapshot.nodes.length === 3) {
            state.samples.push(snapshot);
            if (state.samples.length > 12) state.samples.shift();
          }
        }
        if (!state.seen || host) requestAnimationFrame(inspect);
      };
      requestAnimationFrame(inspect);
    })()`);
    await p.locator(".export-menu summary").click();
    const downloadPromise = p.waitForEvent("download", { timeout: 45000 });
    await p
      .getByRole("button", { name: "Full diagram PNG", exact: true })
      .click();
    const download = await downloadPromise;
    const filename = path.join(h.output, "edge-labels.png");
    await download.saveAs(filename);
    await until(async () => (await p.locator(".png-export").count()) === 0);
    const captured = await p.evaluate(() => window.__edgeLabelExport);
    assert.ok(
      captured.seen && captured.samples.length,
      "The temporary export surface was observed before cleanup",
    );
    const last = captured.samples.at(-1);
    assert.deepEqual(
      last.collisions,
      [],
      "Exported labels do not cover any nodes",
    );
    assert.equal(last.labels.length, 3);
    for (const part of [...last.labels, ...last.nodes]) {
      assert.ok(
        part.left >= last.host.left &&
          part.right <= last.host.right &&
          part.top >= last.host.top &&
          part.bottom <= last.host.bottom,
        "The complete label/node bounds fit inside the exported image",
      );
    }
    const bytes = fs.readFileSync(filename);
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert.ok(
      bytes.readUInt32BE(16) >= 900,
      "PNG includes all three horizontal nodes with padding",
    );
    assert.ok(
      bytes.readUInt32BE(20) >= 450,
      "PNG includes nodes and displaced multiline labels",
    );
    fs.writeFileSync(
      path.join(h.output, "export-layout.json"),
      JSON.stringify(last, null, 2),
    );
  },
);
