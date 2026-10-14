const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {setupBrowser, until} = require('./browser-harness.cjs');

function git(root, ...args) {
  return execFileSync('git', ['-c', `safe.directory=${root}`, '-c', 'core.autocrlf=false', '-C', root, ...args], {
    windowsHide: true,
    env: {...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:process.platform === 'win32' ? 'NUL' : '/dev/null'},
  }).toString().trim();
}

test('external task export and commit return preserve provenance through review and explicit local execution', {timeout:180000}, async t => {
  const h = await setupBrowser(t, {name:'handoff-roundtrip', planningFixture:true, viewport:{width:1280,height:900}});
  const p = h.page, url = '/projects/' + h.initial.id;
  const repo = path.join(h.output, 'external coding repository');
  await fs.mkdir(repo);
  await fs.writeFile(path.join(repo, 'main.py'), 'value = 1\n');
  await fs.writeFile(path.join(repo, 'fixture-only.marker'), 'Disposable browser handoff fixture\n');
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'PlanBranch fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Handoff baseline');
  const base = git(repo, 'rev-parse', 'HEAD');
  const task = {id:crypto.randomUUID(), title:'Implement a reviewable external result', deliverable:'Update the fixture value and check it.', nodeLinks:[], prerequisiteIds:[], expectedFiles:['main.py'], acceptanceChecks:[{id:crypto.randomUUID(),text:'The fixture check observes value 2.'}],status:'not_started'};
  const project = await h.saveContent(h.initial.id, content => { content.buildTasks = [task]; content.brief.requirements = 'Update the value while keeping execution explicit.'; });
  await h.api(url + '/planning/approve', 'POST', {baseRevision:project.revision,mutationId:crypto.randomUUID()});
  await h.api(url + '/execution/repository', 'POST', {mutationId:crypto.randomUUID(),path:repo,confirmed:true});
  await p.reload();
  await p.getByRole('group',{name:'Plan views',exact:true}).getByRole('button',{name:'Build',exact:true}).click();
  const handoff = p.getByRole('region',{name:'External agent handoff and review',exact:true});
  await handoff.getByText('Use an external coding agent',{exact:true}).click();
  await handoff.getByRole('button',{name:'Preview implementation handoff',exact:true}).click();
  await handoff.getByRole('region',{name:'Handoff export preview',exact:true}).waitFor();
  const download = p.waitForEvent('download');
  await handoff.getByRole('button',{name:'Export handoff JSON',exact:true}).click();
  const exported = await download;
  const exportedPath = path.join(h.output,'handoff.json');
  await exported.saveAs(exportedPath);
  const manifest = JSON.parse(await fs.readFile(exportedPath,'utf8'));
  assert.equal(manifest.taskId,task.id);
  assert.equal(manifest.baseCommit,base);
  assert.equal(manifest.sourceIncluded,false);
  assert.equal(manifest.supportingContext,'');
  assert.equal(JSON.stringify(manifest).includes(repo),false,'Machine paths are not exported');
  assert.equal(JSON.stringify(manifest).includes('value = 1'),false,'Source is excluded by default');
  assert.equal((await h.api(url+'/execution')).runs.length,0);

  // The external editor owns this change and commit, not an imported command.
  await fs.writeFile(path.join(repo,'main.py'),'value = 2\n');
  git(repo,'add','main.py'); git(repo,'commit','-m','External candidate');
  const candidate = git(repo,'rev-parse','HEAD');
  git(repo,'checkout','--detach',base);
  await handoff.getByRole('button',{name:'Use return template',exact:true}).click();
  const returned = JSON.parse(await handoff.getByLabel('Returned result JSON',{exact:true}).inputValue());
  returned.candidateCommit = candidate;
  returned.report = {origin:'host',status:'passed',html:'<script>window.forgedReportRan=true</script>',checks:[{command:'pytest',status:'passed'}]};
  await handoff.getByLabel('Returned result JSON',{exact:true}).fill(JSON.stringify(returned));
  await handoff.getByRole('button',{name:'Import for review',exact:true}).click();
  const review = handoff.getByRole('article',{name:'External result review',exact:true});
  await review.getByRole('heading',{name:'External result reported',exact:true}).waitFor();
  await review.getByText('main.py',{exact:true}).click();
  assert.match(await review.innerText(),/\+value = 2/);
  await review.getByText('External test report · untrusted content',{exact:true}).click();
  assert.match(await review.innerText(),/<script>/);
  assert.equal(await p.evaluate(()=>window.forgedReportRan),undefined);
  assert.equal(await fs.readFile(path.join(repo,'main.py'),'utf8'),'value = 1\n');
  assert.equal((await h.api(url+'/execution')).runs.length,0);
  await review.getByLabel('Human review note',{exact:true}).fill('Reviewed this exact candidate diff; imported test claims remain external.');
  await review.getByRole('button',{name:'Record accepted review',exact:true}).click();
  await review.getByText(/Human review recorded: accepted, not applied/).waitFor();
  const state = await h.api(url+'/handoffs?taskId='+task.id);
  assert.equal(state.results[0].origin,'external');
  assert.equal(state.results[0].report.origin,'host','Forged provenance is retained only inside untrusted report data');
  assert.equal((await h.api(url)).content.buildTasks[0].status,'not_started');
  const reviewDownload = p.waitForEvent('download');
  await review.getByRole('button',{name:'Export external review JSON',exact:true}).click();
  const reviewPath = path.join(h.output,'external-review.json');
  await (await reviewDownload).saveAs(reviewPath);
  assert.equal(JSON.parse(await fs.readFile(reviewPath,'utf8')).origin,'external');
  await p.screenshot({path:path.join(h.output,'external-review.png'),fullPage:true});

  await review.getByRole('button',{name:'Preview authorized local execution',exact:true}).click();
  await handoff.getByRole('alert').filter({hasText:'exact returned candidate'}).waitFor();
  assert.equal((await h.api(url+'/execution')).runs.length,0);
  git(repo,'checkout','--detach',candidate);
  await review.getByRole('button',{name:'Preview authorized local execution',exact:true}).click();
  const execution = p.getByRole('dialog',{name:'Run step',exact:true});
  await execution.waitFor();
  await execution.getByRole('button',{name:'Preview run',exact:true}).click();
  await until(()=>execution.getByRole('button',{name:'Run step',exact:true}).isEnabled());
  assert.equal((await h.api(url+'/execution')).runs.length,0,'External preflight and ordinary preview do not authorize execution');
  await execution.getByRole('button',{name:'Run step',exact:true}).click();
  const run = await until(async()=>{
    const runs=(await h.api(url+'/execution')).runs;
    if(!runs.length)return false;
    const current=(await h.api(url+'/execution/runs/'+runs[0].id)).run;
    return current.state==='succeeded' ? current : false;
  },45000);
  assert.equal(run.sourceCommit,candidate);
  assert.equal(run.commands.length,1);
  assert.equal((await h.api(url+'/handoffs?taskId='+task.id)).results[0].origin,'external','New local observations never rewrite external provenance');
});
