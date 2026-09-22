/* Durable unsent writing: owned disposable servers, deterministic planner, no external requests. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setupBrowser, until } = require('./browser-harness.cjs');

const panel = p => p.getByRole('complementary', { name: 'Planning conversation' });
const message = p => p.getByLabel('Message Codex', { exact: true });
const writingPath = h => `/projects/${h.initial.id}/planning/writing`;
async function openChat(p) {
  await p.getByRole('group', { name: 'Plan views', exact: true }).waitFor();
  if (!(await panel(p).isVisible())) await p.getByRole('button', { name: 'Toggle planning chat', exact: true }).click();
  await p.getByRole('tab', { name: 'Chat', exact: true }).click();
  await until(async () => (await message(p).count()) && await message(p).isEditable() &&
    !/^Loading/.test(await p.getByTestId('writing-save-state').innerText()));
}
async function stored(h, check) {
  return until(async () => { const state = await h.api(writingPath(h)); return check(state) ? state : false; });
}
async function writingSettled(p) {
  await until(async () => !/^(Loading|Saving|Writing not saved)/.test(await p.getByTestId('writing-save-state').innerText()));
}
async function recovery(p) {
  await p.getByTestId('writing-save-state').click();
  const dialog = p.getByRole('dialog', { name: 'Unsent writing', exact: true });
  await dialog.waitFor();
  return dialog;
}
async function noPlanChange(h, before) {
  const after = await h.api(`/projects/${h.initial.id}`);
  assert.deepEqual(after.content, before.content);
  assert.deepEqual(after.history, before.history);
  assert.equal(after.cursor, before.cursor);
  // Fit-view and responsive viewport saves may advance storage revision; they
  // must not create manual history or change approval content identity.
}
async function freshPage(h) {
  const p = await h.context.newPage();
  await p.goto(h.base);
  await openChat(p);
  return p;
}

test('unsent prompts and node comments recover from SQLite after server restart without sending', { timeout: 90000 }, async t => {
  const h = await setupBrowser(t, { name: 'writing-restart', planningFixture: true, viewport: { width: 1440, height: 900 } });
  const p = h.page;
  await h.saved();
  const before = await h.api(`/projects/${h.initial.id}`);
  await h.api(`/projects/${h.initial.id}/planning/approve`, 'POST', { baseRevision: before.revision, mutationId: crypto.randomUUID() });
  const node = before.content.diagrams[0].nodes.find(n => n.type === 'process') || before.content.diagrams[0].nodes[0];
  await p.getByTestId('diagram-canvas').locator('.react-flow__controls-fitview').click();
  await p.locator(`.react-flow__node[data-id="${node.id}"]`).click();
  await openChat(p);
  await message(p).fill('Do not send yet: refine the CLI scope after reviewing my notes.');
  await p.getByRole('tab', { name: /^Comments/ }).click();
  await p.getByLabel(/^Comment on:/).fill('Keep this local comment until I explicitly post it.');
  await stored(h, s => s.draft.payload.message.startsWith('Do not send yet:') && s.draft.payload.comments[node.id]?.startsWith('Keep this local'));
  await writingSettled(p);
  await p.close();
  await h.restart({ reload: false });
  const reopened = await freshPage(h); // New tab has no previous sessionStorage cache.
  assert.equal(await message(reopened).inputValue(), 'Do not send yet: refine the CLI scope after reviewing my notes.');
  await reopened.getByTestId('diagram-canvas').locator('.react-flow__controls-fitview').click();
  await reopened.locator(`.react-flow__node[data-id="${node.id}"]`).click();
  await reopened.getByRole('tab', { name: /^Comments/ }).click();
  assert.equal(await reopened.getByLabel(/^Comment on:/).inputValue(), 'Keep this local comment until I explicitly post it.');
  await reopened.screenshot({ path: path.join(h.output, 'recovered-writing-1440x900.png') });
  const planning = await h.api(`/projects/${h.initial.id}/planning`);
  assert.equal(planning.messages.length, 0);
  assert.equal(planning.comments.length, 0);
  assert.equal(planning.request, null);
  assert.equal(planning.approval.current, true);
  await noPlanChange(h, before);
});

test('unsent clarification choices and custom answers recover without continuing the agent', { timeout: 90000 }, async t => {
  const h = await setupBrowser(t, { name: 'writing-questions', planningFixture: true, viewport: { width: 1280, height: 800 } });
  const p = h.page;
  await openChat(p);
  const before = await h.api(`/projects/${h.initial.id}`);
  await message(p).fill('Clarify requirements');
  const posted = p.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/planning/messages'));
  await p.getByRole('button', { name: 'Send', exact: true }).click();
  assert.equal((await posted).ok(), true);
  const open = await until(async () => (await h.api(`/projects/${h.initial.id}/planning`)).questionSets.find(s => s.state === 'open'));
  const card = p.getByRole('region', { name: 'Clarification questions', exact: true }).last();
  await card.getByRole('radio', { name: /SQLite/ }).check();
  await card.getByRole('button', { name: 'Next', exact: true }).click();
  await card.getByRole('radio', { name: 'Something else', exact: true }).check();
  await card.getByRole('textbox', { name: 'Your answer', exact: true }).fill('Personal use, without sharing a database.');
  await stored(h, s => s.draft.payload.questionDrafts[open.id]?.storage?.choice === 'sqlite' && s.draft.payload.questionDrafts[open.id]?.audience?.text === 'Personal use, without sharing a database.');
  await writingSettled(p);
  await p.close();
  await h.restart({ reload: false });
  const reopened = await freshPage(h);
  const restored = reopened.getByRole('region', { name: 'Clarification questions', exact: true }).last();
  assert.equal(await restored.getByRole('radio', { name: /SQLite/ }).isChecked(), true);
  await restored.getByRole('button', { name: 'Next', exact: true }).click();
  assert.equal(await restored.getByRole('radio', { name: 'Something else', exact: true }).isChecked(), true);
  assert.equal(await restored.getByRole('textbox', { name: 'Your answer', exact: true }).inputValue(), 'Personal use, without sharing a database.');
  const planning = await h.api(`/projects/${h.initial.id}/planning`);
  const set = planning.questionSets.find(s => s.id === open.id);
  assert.equal(set.state, 'open');
  assert.equal(set.continuationRequestId, null);
  await noPlanChange(h, before);
  await reopened.screenshot({ path: path.join(h.output, 'recovered-answers-1280x800.png') });
});

test('late writing acknowledgements preserve newer text and failed draft saves block project navigation', { timeout: 120000 }, async t => {
  const h = await setupBrowser(t, { name: 'writing-ordering', planningFixture: true });
  const p = h.page;
  await openChat(p);
  const before = await h.api(`/projects/${h.initial.id}`);
  const other = await h.api('/projects', 'POST', { name: 'Other writing destination' });
  await p.reload();
  await openChat(p);
  let release, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const routePath = '**/planning/writing';
  await p.route(routePath, async route => {
    if (route.request().method() !== 'PUT' || held) return route.continue();
    const response = await route.fetch();
    held = true;
    await gate;
    await route.fulfill({ response });
  });
  await message(p).fill('First immutable writing batch');
  await until(() => held);
  await message(p).fill('Newer text typed while the first save is still awaiting its acknowledgement');
  release();
  await stored(h, s => s.draft.payload.message.startsWith('Newer text typed'));
  assert.match(await message(p).inputValue(), /^Newer text typed/);
  await writingSettled(p);
  await p.unrouteAll({ behavior: 'wait' });
  await p.route(routePath, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture writing storage unavailable' }) });
  });
  const failedSave = p.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/planning/writing') && r.status() === 503);
  await message(p).fill('Keep me in this project until this writing is safely saved.');
  await failedSave; // Drain the debounce before testing the separate navigation flush.
  await until(async () => /Recover writing/.test(await p.getByTestId('writing-save-state').innerText()));
  const failedNavigationSave = p.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/planning/writing') && r.status() === 503);
  await p.getByRole('navigation', { name: 'Projects' }).getByRole('button').filter({ hasText: other.content.name }).click();
  await failedNavigationSave;
  await p.getByRole('alert').filter({ hasText: 'Your writing has not saved. Open Chat to retry or recover the draft before leaving.' }).waitFor();
  assert.equal(await message(p).inputValue(), 'Keep me in this project until this writing is safely saved.');
  const dialog = await recovery(p);
  await dialog.getByRole('button', { name: 'Retry writing save', exact: true }).waitFor();
  await p.unrouteAll({ behavior: 'wait' });
  await dialog.getByRole('button', { name: 'Retry writing save', exact: true }).click();
  await stored(h, s => s.draft.payload.message === 'Keep me in this project until this writing is safely saved.');
  await p.keyboard.press('Escape');
  await p.getByRole('navigation', { name: 'Projects' }).getByRole('button').filter({ hasText: other.content.name }).click();
  await p.getByRole('button', { name: `Project details: ${other.content.name}`, exact: true }).waitFor();
  await until(async () => (await message(p).inputValue()) === '');
  await noPlanChange(h, before);
});

test('conflicting tabs keep both writing copies and an explicitly discarded copy stays discarded', { timeout: 100000 }, async t => {
  const h = await setupBrowser(t, { name: 'writing-conflict', planningFixture: true });
  const first = h.page;
  await openChat(first);
  const second = await freshPage(h);
  const before = await h.api(`/projects/${h.initial.id}`);
  await message(first).fill('Canonical writing from the first tab');
  await stored(h, s => s.draft.payload.message === 'Canonical writing from the first tab');
  await writingSettled(first);
  await message(second).fill('Independent writing from the second tab');
  const conflict = await stored(h, s => s.copies.some(c => c.payload.message === 'Independent writing from the second tab'));
  assert.equal(conflict.draft.payload.message, 'Canonical writing from the first tab');
  assert.equal(await message(second).inputValue(), 'Independent writing from the second tab');
  let dialog = await recovery(second);
  await dialog.getByRole('button', { name: 'Use my writing', exact: true }).click();
  const resolved = await stored(h, s => s.draft.payload.message === 'Independent writing from the second tab' && s.copies.some(c => c.payload.message === 'Canonical writing from the first tab'));
  const preserved = resolved.copies.find(c => c.payload.message === 'Canonical writing from the first tab');
  const savedCopy = dialog.getByRole('region', { name: `Saved writing copy ${preserved.id}`, exact: true });
  assert.equal(await savedCopy.getByLabel('Saved writing copy', { exact: true }).inputValue(), 'Canonical writing from the first tab');
  await savedCopy.getByRole('button', { name: 'Discard copy', exact: true }).click();
  await stored(h, s => !s.copies.some(c => c.id === preserved.id));
  await writingSettled(second);
  await first.close();
  await second.close();
  await h.restart({ reload: false });
  const reopened = await freshPage(h);
  assert.equal(await message(reopened).inputValue(), 'Independent writing from the second tab');
  assert.equal((await h.api(writingPath(h))).copies.some(c => c.id === preserved.id), false);
  assert.equal((await h.api(`/projects/${h.initial.id}/planning`)).messages.length, 0);
  await noPlanChange(h, before);
});

test('a committed message with a lost response never retires newer unsent writing or sends it on recovery', { timeout: 100000 }, async t => {
  const h = await setupBrowser(t, { name: 'writing-lost-send', planningFixture: true });
  const p = h.page;
  await openChat(p);
  let release, postedBody;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  await p.route('**/planning/messages', async route => {
    postedBody = route.request().postDataJSON();
    await route.fetch();
    await gate;
    await route.abort('failed');
  });
  await message(p).fill('Discuss the already submitted goal');
  await p.getByRole('button', { name: 'Send', exact: true }).click();
  await until(async () => postedBody && (await h.api(`/projects/${h.initial.id}/planning`)).request?.id === postedBody.mutationId);
  await message(p).fill('This newer thought is still unsent. Preserve it after the interrupted response.');
  await stored(h, s => s.draft.payload.message.startsWith('This newer thought'));
  release();
  await p.unrouteAll({ behavior: 'wait' });
  await writingSettled(p);
  await p.close();
  await h.restart({ reload: false });
  const reopened = await freshPage(h);
  assert.equal(await message(reopened).inputValue(), 'This newer thought is still unsent. Preserve it after the interrupted response.');
  const state = await h.api(`/projects/${h.initial.id}/planning`);
  assert.equal(state.request.id, postedBody.mutationId);
  assert.equal(state.messages.filter(m => m.role === 'user').length, 1);
  const writing = await h.api(writingPath(h));
  assert.equal(writing.draft.payload.failedPrompt, null);
  assert.equal(writing.draft.payload.message.startsWith('This newer thought'), true);
});


test('project navigation drains writing typed while an earlier project save is awaiting acknowledgement', { timeout: 120000 }, async t => {
  const h = await setupBrowser(t, { name: 'writing-navigation-race', planningFixture: true, viewport: { width: 1440, height: 900 } });
  const p = h.page;
  const other = await h.api('/projects', 'POST', { name: 'Navigation race destination' });
  await p.reload();
  await openChat(p);
  await h.saved();
  await message(p).fill('Original saved writing');
  await stored(h, s => s.draft.payload.message === 'Original saved writing');
  await writingSettled(p);
  const before = await h.api(`/projects/${h.initial.id}`);
  let releasePlan, releaseWriting, planHeld = false, writingHeld = false;
  const planGate = new Promise(resolve => { releasePlan = resolve; });
  const writingGate = new Promise(resolve => { releaseWriting = resolve; });
  t.after(() => { releasePlan(); releaseWriting(); });
  await p.route(`**/api/projects/${h.initial.id}`, async route => {
    if (route.request().method() !== 'PUT' || planHeld) return route.continue();
    const response = await route.fetch();
    planHeld = true;
    await planGate;
    await route.fulfill({ response });
  });
  const newest = 'New writing entered after navigation began; it must be durable before leaving.';
  await p.route('**/planning/writing', async route => {
    if (route.request().method() !== 'PUT' || route.request().postDataJSON().payload.message !== newest) return route.continue();
    writingHeld = true;
    await writingGate;
    await route.continue();
  });
  await p.getByRole('button', { name: 'Add Process', exact: true }).click();
  await until(() => planHeld);
  await p.getByRole('navigation', { name: 'Projects' }).getByRole('button').filter({ hasText: other.content.name }).click();
  // The UI remains editable while the original plan save is pending.
  await message(p).fill(newest);
  releasePlan();
  await until(() => writingHeld);
  assert.equal(await p.getByRole('button', { name: `Project details: ${h.initial.content.name}`, exact: true }).isVisible(), true);
  assert.equal(await message(p).inputValue(), newest);
  assert.equal((await h.api(writingPath(h))).draft.payload.message, 'Original saved writing');
  releaseWriting();
  await p.getByRole('button', { name: `Project details: ${other.content.name}`, exact: true }).waitFor();
  assert.equal((await h.api(writingPath(h))).draft.payload.message, newest);
  await p.unrouteAll({ behavior: 'wait' });
  await p.close();
  const reopened = await freshPage(h);
  await reopened.getByRole('navigation', { name: 'Projects' }).getByRole('button').filter({ hasText: h.initial.content.name }).click();
  await reopened.getByRole('button', { name: `Project details: ${h.initial.content.name}`, exact: true }).waitFor();
  await openChat(reopened);
  assert.equal(await message(reopened).inputValue(), newest);
  const after = await h.api(`/projects/${h.initial.id}`);
  assert.equal(after.content.diagrams[0].nodes.length, before.content.diagrams[0].nodes.length + 1);
  assert.equal((await h.api(`/projects/${h.initial.id}/planning`)).messages.length, 0);
});
