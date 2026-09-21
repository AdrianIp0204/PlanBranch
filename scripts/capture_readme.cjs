const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupBrowser, until } = require("../tests/browser-harness.cjs");
test("capture PlanBranch sample workspace", { timeout: 60000 }, async (t) => {
  const h = await setupBrowser(t, {
    name: "planbranch-readme",
    seed: { name: "Task CLI" },
    planningFixture: true,
    viewport: { width: 1440, height: 900 },
  });
  const p = h.page;
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
  const gotIt = p.getByRole("button", { name: "Got it", exact: true });
  if (await gotIt.isVisible()) await gotIt.click();
  await p
    .getByLabel("Message Codex", { exact: true })
    .fill(
      "Plan a Python task CLI with SQLite. Keep the first version to adding and listing tasks.",
    );
  await p.getByRole("button", { name: "Send", exact: true }).click();
  const work = p.getByRole("region", { name: "Proposed changes workspace" });
  await work.waitFor();
  await until(
    async () => (await work.locator(".react-flow__node").count()) === 5,
  );
  await p.getByRole("tab", { name: "Chat", exact: true }).click();
  await p.getByLabel("Message Codex", { exact: true }).fill("");

  await p.waitForTimeout(500);
  fs.mkdirSync(path.join(h.root, "docs/images"), { recursive: true });
  await p.screenshot({
    path: path.join(h.root, "docs/images/planbranch-workspace.png"),
  });
  assert.equal(h.errors.length, 0);
  assert.equal(h.externalRequests.length, 0);
});
