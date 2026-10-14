const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { setupBrowser, until } = require("./browser-harness.cjs");

function task(title, status = "not_started", prerequisites = []) {
  return { id: crypto.randomUUID(), title, deliverable: "A reviewed implementation", nodeLinks: [],
    prerequisiteIds: prerequisites, expectedFiles: ["main.py"], status,
    acceptanceChecks: [{ id: crypto.randomUUID(), text: "The intended behavior is reviewed." }] };
}

test("prerequisite guidance agrees with preview and opens the corrective task without execution", { timeout: 90000 }, async t => {
  const h = await setupBrowser(t, { name: "readiness-correction", planningFixture: true, viewport: { width: 760, height: 800 } });
  const p = h.page, first = task("Reviewed storage", "done"), next = task("Dependent importer", "not_started", [first.id]);
  const project = await h.saveContent(h.initial.id, content => { content.buildTasks = [first, next]; });
  await h.api(`/projects/${project.id}/planning/approve`, "POST", { baseRevision: project.revision, mutationId: crypto.randomUUID() });
  await p.reload();
  await p.getByRole("group", { name: "Plan views", exact: true }).getByRole("button", { name: "Build", exact: true }).click();
  await p.getByRole("button", { name: "Task: Dependent importer", exact: true }).click();
  const guidance = p.getByRole("region", { name: "Task workflow", exact: true });
  await guidance.getByRole("heading", { name: "Prerequisites need attention", exact: true }).waitFor();
  assert.match(await guidance.innerText(), /marked done without a reviewed execution result/);
  assert.equal(await guidance.getByRole("button", { name: "Review run authorization", exact: true }).count(), 0);
  const preview = await h.api(`/projects/${project.id}/execution/preview`, "POST", { taskId: next.id });
  const workflow = await h.api(`/projects/${project.id}/tasks/${next.id}/workflow`);
  assert.equal(preview.ready, false);
  assert.deepEqual(workflow.prerequisiteIssues, preview.prerequisiteIssues);
  assert.equal(workflow.prerequisiteIssues[0].code, "prerequisite_no_result");
  await guidance.getByRole("button", { name: "Open prerequisite task", exact: true }).click();
  assert.equal(await p.getByLabel("Task title", { exact: true }).inputValue(), "Reviewed storage");
  assert.equal(await p.getByLabel("Task status", { exact: true }).inputValue(), "done");
  await p.getByLabel("Task status", { exact: true }).selectOption("not_started");
  await h.saved();
  await until(async () => (await h.api(`/projects/${project.id}`)).content.buildTasks[0].status === "not_started");
  await guidance.getByRole("heading", { name: "Ready to preview", exact: true }).waitFor();
  assert.equal((await h.api(`/projects/${project.id}/execution`)).runs.length, 0);
  await p.screenshot({ path: path.join(h.output, "corrective-task-opened.png"), fullPage: true });
});

test("semantic comparison shows name and blocker fields with the same meaning as approval", { timeout: 90000 }, async t => {
  const h = await setupBrowser(t, { name: "semantic-field-comparison", planningFixture: true, viewport: { width: 760, height: 800 } });
  const p = h.page, project = h.initial;
  await h.api(`/projects/${project.id}/planning/approve`, "POST", { baseRevision: project.revision, mutationId: crypto.randomUUID() });
  await h.api(`/projects/${project.id}/plans/checkpoint`, "POST", { baseRevision: project.revision, mutationId: crypto.randomUUID(), name: "Approved original" });
  await h.saveContent(project.id, content => {
    content.name = "Private offline importer";
    content.diagrams[0].nodes[0].blocker = "Privacy requires local-only storage.";
    content.diagrams[0].nodes[0].position.x += 200;
    content.diagrams[0].nodes[0].status = "done";
  });
  assert.equal((await h.api(`/projects/${project.id}/planning`)).approval.current, false);
  await p.reload();
  await p.getByLabel("Project actions", { exact: true }).click();
  await p.getByRole("button", { name: "Checkpoints and alternatives", exact: true }).click();
  const dialog = p.getByRole("dialog", { name: "Checkpoints and alternative plans", exact: true });
  await dialog.getByRole("button", { name: "Compare", exact: true }).click();
  const comparison = dialog.getByRole("region", { name: "Semantic plan comparison", exact: true });
  await comparison.getByText("Private offline importer", { exact: true }).waitFor();
  await comparison.getByText("Privacy requires local-only storage.", { exact: true }).waitFor();
  assert.equal(await comparison.locator(".plan-field-change").count(), 2, "Layout and progress do not appear as semantic changes");
  assert.equal(await comparison.locator("pre:visible").count(), 0, "Raw JSON stays collapsed until requested");
  const raw = comparison.locator("details").filter({ has: p.getByText("Raw comparison data: Project name and notes", { exact: true }) });
  await raw.locator("summary").click();
  assert.match(await raw.locator("pre").last().innerText(), /"name": "Private offline importer"/);
  await raw.locator("summary").click();
  await comparison.scrollIntoViewIfNeeded();
  await p.screenshot({ path: path.join(h.output, "readable-field-comparison.png"), fullPage: true });
  await comparison.getByRole("button", { name: "Open node: Begin import", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await p.locator(`.react-flow__node[data-id="${project.content.diagrams[0].nodes[0].id}"].selected`).waitFor();
  assert.equal((await h.api(`/projects/${project.id}/execution`)).runs.length, 0);
});
