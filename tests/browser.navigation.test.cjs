/* Quick jump and workspace layouts use only disposable fixtures and local preferences. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setupBrowser, until } = require('./browser-harness.cjs');
const { prepareUxFixture, withBrowserZoom } = require('./ux-fixture.cjs');

async function jump(p, query = '') {
  await p.getByRole('button', { name: 'Quick jump', exact: true }).click();
  const dialog = p.getByRole('dialog', { name: 'Quick jump', exact: true });
  await dialog.getByRole('combobox').fill(query);
  return dialog;
}
async function choose(p, query, group) {
  const dialog = await jump(p, query);
  const options = group ? dialog.getByRole('group', { name: group, exact: true }).getByRole('option') : dialog.getByRole('option');
  assert.equal(await options.count(), 1, `Unique result for ${query} in ${group || 'all groups'}`);
  await options.click();
  await dialog.waitFor({ state: 'hidden' });
}
async function layout(p, name) {
  await p.getByText('Layout', { exact: true }).click();
  await p.getByRole('button', { name, exact: true }).click();
}
async function graphState(p) {
  return p.getByTestId('diagram-canvas').evaluate(canvas => ({
    transform: canvas.querySelector('.react-flow__viewport')?.style.transform,
    selection: [...canvas.querySelectorAll('.react-flow__node.selected')].map(n => n.dataset.id).sort(),
  }));
}

test('Quick jump finds diagram items, Build tasks, and separate planned and detected variables', { timeout: 150000 }, async t => {
  const h = await setupBrowser(t, { name: 'navigation-search', planningFixture: true, viewport: { width: 1440, height: 900 } });
  const p = h.page;
  const fixture = await prepareUxFixture(h);
  const taskId = crypto.randomUUID();
  const prepared = await h.saveContent(fixture.id, content => {
    content.buildTasks = [{ id: taskId, title: 'Implement quarantine reporting', deliverable: 'Readable diagnostics', nodeLinks: [], prerequisiteIds: [], expectedFiles: ['reports/quarantine.py'], acceptanceChecks: [], status: 'not_started' }];
  });
  await p.reload();
  await p.getByTestId('diagram-canvas').waitFor();
  await choose(p, 'Review rejected records', 'Nodes');
  const node = prepared.content.diagrams[1].nodes[0];
  await until(async () => (await graphState(p)).selection.includes(node.id));
  await until(async () => p.locator('#canvas-title > span').innerText().then(text => text === prepared.content.diagrams[1].name));
  const rect = await p.locator(`.react-flow__node[data-id="${node.id}"]`).boundingBox();
  const canvas = await p.getByTestId('diagram-canvas').boundingBox();
  assert.ok(rect && canvas && rect.x >= canvas.x && rect.y >= canvas.y && rect.x + rect.width <= canvas.x + canvas.width + 1);
  await choose(p, 'quarantine', 'Build tasks');
  assert.equal(await p.getByRole('region', { name: 'Build tasks editor', exact: true }).getByLabel('Task title', { exact: true }).inputValue(), 'Implement quarantine reporting');
  await choose(p, 'future_validation_results', 'Planned variables');
  const catalogue = p.getByRole('region', { name: 'Variable catalogue', exact: true });
  await catalogue.getByRole('heading', { name: 'Variable plan', exact: true }).waitFor();
  assert.equal(await catalogue.getByLabel('Name', { exact: true }).inputValue(), 'future_validation_results_for_rejected_input_records');
  let dialog = await jump(p, 'count');
  assert.ok(await dialog.getByRole('group', { name: 'Planned variables', exact: true }).getByRole('option').count());
  const observations = dialog.getByRole('group', { name: 'Detected symbols', exact: true });
  assert.match(await observations.innerText(), /importer\.py:\d+/);
  await observations.getByRole('option').filter({ hasText: /importer\.py:.*current$/ }).click();
  await dialog.waitFor({ state: 'hidden' });
  await catalogue.getByRole('heading', { name: 'Code observation', exact: true }).waitFor();
  dialog = await jump(p, 'amount');
  const ambiguous = dialog.getByRole('group', { name: 'Detected symbols', exact: true }).getByRole('option');
  assert.ok(await ambiguous.count() >= 2);
  assert.match(await ambiguous.first().innerText(), /ambiguous\.py:\d+/);
  const labels = await ambiguous.allInnerTexts();
  assert.equal(new Set(labels).size, labels.length, 'Identical symbol names have visible distinguishing context, including retained stale observations');
  await p.screenshot({ path: path.join(h.output, 'quick-jump-context-1440x900.png') });
  await p.keyboard.press('Escape');
  const after = await h.api(`/projects/${fixture.id}`);
  assert.deepEqual(after.content, prepared.content);
  assert.deepEqual(after.history, prepared.history);
  assert.equal((await h.api(`/projects/${fixture.id}/planning`)).request, null);
});

test('Quick jump works by keyboard, restores input focus, and keeps failed writing in its project', { timeout: 100000 }, async t => {
  const h = await setupBrowser(t, { name: 'navigation-keyboard', planningFixture: true, viewport: { width: 1280, height: 800 } });
  const p = h.page;
  const other = await h.api('/projects', 'POST', { name: 'Palette other project' });
  await p.reload();
  await p.getByRole('button', { name: 'Toggle planning chat', exact: true }).click();
  const message = p.getByLabel('Message Codex', { exact: true });
  await until(async () => await message.isEditable());
  await message.fill('Keep native input editing and this unsent prompt.');
  await message.press('Control+k');
  let dialog = p.getByRole('dialog', { name: 'Quick jump', exact: true });
  await dialog.waitFor();
  const input = dialog.getByRole('combobox');
  assert.equal(await input.evaluate(el => document.activeElement === el), true);
  await input.fill('zzzz-no-result-zzzz');
  await dialog.getByText('No matching items.', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Clear search', exact: true }).click();
  assert.equal(await input.inputValue(), '');
  await input.press('End');
  const last = await input.getAttribute('aria-activedescendant');
  await input.press('Home');
  assert.notEqual(await input.getAttribute('aria-activedescendant'), last);
  await input.press('Escape');
  await until(async () => message.evaluate(el => document.activeElement === el));
  assert.equal(await message.inputValue(), 'Keep native input editing and this unsent prompt.');
  await until(async () => (await h.api(`/projects/${h.initial.id}/planning/writing`)).draft.payload.message.startsWith('Keep native'));
  await p.route('**/planning/writing', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture save unavailable' }) })
    : route.continue());
  const failed = p.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/planning/writing') && r.status() === 503);
  await message.fill('Do not leave or discard this writing when storage fails.');
  await failed;
  await until(async () => /Recover writing/.test(await p.getByTestId('writing-save-state').innerText()));
  dialog = await jump(p, other.content.name);
  await dialog.getByRole('combobox').press('Enter');
  await dialog.getByRole('alert').filter({ hasText: 'Writing has not saved. Open Chat to retry or recover it before navigating.' }).waitFor();
  assert.equal(await dialog.isVisible(), true);
  await p.screenshot({ path: path.join(h.output, 'quick-jump-recovery-1280x800.png') });
  await dialog.getByRole('combobox').press('Escape');
  assert.equal(await message.inputValue(), 'Do not leave or discard this writing when storage fails.');
  assert.equal((await h.api(`/projects/${h.initial.id}/planning`)).request, null);
  await p.unrouteAll({ behavior: 'wait' });
});

test('workspace presets and personal layout preserve graph positions, selection, viewport and manual history', { timeout: 100000 }, async t => {
  const h = await setupBrowser(t, { name: 'navigation-layouts', planningFixture: true, viewport: { width: 1440, height: 900 } });
  const p = h.page;
  const canvas = p.getByTestId('diagram-canvas');
  await canvas.locator('.react-flow__controls-fitview').click();
  const node = h.initial.content.diagrams[0].nodes[0];
  await canvas.locator(`.react-flow__node[data-id="${node.id}"]`).click();
  const original = await graphState(p);
  const before = await h.api(`/projects/${h.initial.id}`);
  await layout(p, 'Save personal layout');
  const personal = await p.evaluate(() => JSON.parse(localStorage.getItem('planbranch.personal-layout.v1')));
  assert.ok(personal?.layout);
  for (const name of ['Planning layout', 'Review layout', 'Build layout', 'Personal layout']) {
    await layout(p, name);
    if (name === 'Build layout') await p.getByRole('region', { name: 'Build tasks editor', exact: true }).waitFor();
    else await canvas.waitFor();
    if (name === 'Planning layout' || name === 'Review layout')
      await p.getByRole('complementary', { name: 'Planning conversation', exact: true }).waitFor();
    assert.deepEqual(await graphState(p), original, `${name} preserves canvas state`);
  }
  for (const viewport of [{ width: 1280, height: 800 }, { width: 720, height: 700 }]) {
    await p.setViewportSize(viewport);
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await layout(p, 'Review layout');
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const bounds = await p.getByRole('button', { name: 'Quick jump', exact: true }).boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1);
    await p.screenshot({ path: path.join(h.output, `review-layout-${viewport.width}x${viewport.height}.png`) });
  }
  await p.setViewportSize({ width: 1440, height: 900 });
  await layout(p, 'Personal layout');
  const after = await h.api(`/projects/${h.initial.id}`);
  assert.deepEqual(after.content, before.content);
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem('planbranch.personal-layout.v1'))), personal);
  await p.reload();
  await layout(p, 'Personal layout');
  assert.deepEqual(await p.evaluate(() => JSON.parse(localStorage.getItem('planbranch.personal-layout.v1'))), personal);
});

test('Quick jump remains usable at narrow width and 200 percent browser zoom without opening a second dialog', { timeout: 120000 }, async t => {
  const h = await setupBrowser(t, { name: 'navigation-access', planningFixture: true, viewport: { width: 720, height: 700 } });
  const p = h.page;
  await p.emulateMedia({ reducedMotion: 'reduce' });
  let dialog = await jump(p, 'Open settings');
  await dialog.getByRole('combobox').press('Enter');
  const settings = p.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.waitFor();
  await settings.getByLabel('Theme', { exact: true }).press('Control+k');
  assert.equal(await p.getByRole('dialog', { name: 'Quick jump', exact: true }).count(), 0, 'An open dialog owns its keyboard interaction');
  await p.keyboard.press('Escape');
  dialog = await jump(p, 'import');
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await p.screenshot({ path: path.join(h.output, 'quick-jump-narrow.png') });
  await p.keyboard.press('Escape');
  await withBrowserZoom(h, async (zoomed, setZoom) => {
    assert.equal(await setZoom(2), 2);
    await zoomed.page.emulateMedia({ reducedMotion: 'reduce' });
    const modal = await jump(zoomed.page, 'import');
    const box = await modal.boundingBox();
    const viewport = await zoomed.page.evaluate(() => ({ width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth }));
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
    assert.ok(viewport.scroll <= viewport.width + 1);
    await modal.getByRole('combobox').press('ArrowDown');
    assert.ok(await modal.getByRole('combobox').getAttribute('aria-activedescendant'));
    await zoomed.page.screenshot({ path: path.join(h.output, 'quick-jump-200-percent.png') });
    await zoomed.page.keyboard.press('Escape');
  });
});
