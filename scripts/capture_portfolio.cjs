/* Genuine UI captures using only a fresh offline project and the existing harness. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setupBrowser} = require('../tests/browser-harness.cjs');

test('capture the offline portfolio walkthrough without execution authority', {timeout:90000}, async t => {
  const h = await setupBrowser(t, {name:'portfolio-demo', seed:null, viewport:{width:1440,height:1000}});
  const p = h.page;
  const destination = path.join(h.root, 'docs', 'portfolio', 'images');
  fs.mkdirSync(destination, {recursive:true});
  let modelCalls = 0;
  await p.route('**/api/projects/*/planning/messages', route => {modelCalls++; return route.abort();});
  await p.getByRole('button', {name:'Guided offline example',exact:true}).click();
  const dialog = p.getByRole('dialog', {name:'Guided offline example',exact:true});
  await dialog.getByRole('heading', {name:'Feature request',exact:true}).waitFor();
  await dialog.getByRole('button', {name:'Next',exact:true}).click();
  await dialog.getByRole('button', {name:'Select this proposal',exact:true}).click();
  await p.screenshot({path:path.join(destination, '01-design-decision.png')});
  await dialog.getByRole('button', {name:'Next',exact:true}).click();
  await dialog.getByRole('heading', {name:'What depends on this task?',exact:true}).waitFor();
  await p.screenshot({path:path.join(destination, '02-dependent-task.png')});
  await dialog.getByRole('button', {name:'Next',exact:true}).click();
  await dialog.getByText('Illustrative pass (not observed)', {exact:true}).waitFor();
  await p.screenshot({path:path.join(destination, '03-illustrative-review.png')});
  await dialog.getByRole('button', {name:'Record sample review',exact:true}).click();
  await dialog.getByRole('button', {name:'Next',exact:true}).click();
  await dialog.getByRole('button', {name:'Open example project',exact:true}).click();
  await p.getByTestId('diagram-canvas').waitFor();
  const projects = (await h.api('/projects')).projects;
  assert.equal(projects.length, 1);
  const state = await h.api('/projects/' + projects[0].id + '/execution');
  assert.equal(state.repository, null);
  assert.deepEqual(state.runs, []);
  assert.equal(modelCalls, 0);
  await p.screenshot({path:path.join(destination, '04-example-diagram.png')});
});
