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

test('external task return preserves provenance and recovers status polling without repeating authorized verification', {timeout:180000}, async t => {
  let resumeObservation = () => {};
  t.after(() => resumeObservation());
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

  await review.getByText('Verify returned candidate without editing',{exact:true}).click();
  assert.equal(await review.getByLabel('Local verification command',{exact:true}).inputValue(),'','Imported commands are never preselected');
  await review.getByLabel('Local verification command',{exact:true}).fill('fixture verification check');
  await review.getByRole('button',{name:'Preview verification without editing',exact:true}).click();
  await handoff.getByRole('alert').filter({hasText:'exact returned candidate'}).waitFor();
  assert.equal((await h.api(url+'/execution')).runs.length,0);
  git(repo,'checkout','--detach',candidate);
  await review.getByRole('button',{name:'Preview verification without editing',exact:true}).click();
  const verification = review.getByRole('region',{name:'Local verification preview',exact:true});
  await verification.waitFor();
  assert.match(await verification.innerText(),new RegExp(candidate));
  assert.equal(await verification.getByRole('button',{name:'Run verification without editing',exact:true}).isEnabled(),false);
  assert.equal((await h.api(url+'/execution')).runs.length,0,'Preview does not authorize execution');
  const starts = [], observations = [];
  let acknowledgedRun = null;
  const observationReady = new Promise(resolve => { resumeObservation = resolve; });
  t.after(async () => {
    resumeObservation();
    await fs.writeFile(path.join(h.output,'verification-polling.json'),JSON.stringify({
      starts, observations, acknowledgedRunId:acknowledgedRun?.id,
      actualStartState:acknowledgedRun?.state, deliveredStartState:'queued',
    },null,2));
  });
  await p.route(`**/api${url}/external-results/*/verification/start`, async route => {
    if(route.request().method()!=='POST') return route.continue();
    starts.push({url:route.request().url(),body:route.request().postDataJSON()});
    const response = await route.fetch(), value = await response.json();
    assert.equal(response.ok(),true);
    acknowledgedRun = value.run;
    // Deliver an earlier queued acknowledgement for this real run so even an
    // immediately completed fixture exercises observation recovery. Only the
    // transport snapshot changes; the server starts the check exactly once.
    await route.fulfill({response,json:{...value,run:{...value.run,state:'queued',
      commands:[],artifact:null,summary:'',error:null,progress:'Preparing isolated worktree'}}});
  });
  const observationFailure = 'Fixture verification status unavailable';
  await p.route(`**/api${url}/execution/runs/*`, async route => {
    const runId = new URL(route.request().url()).pathname.split('/').pop();
    if(route.request().method()!=='GET' || runId!==acknowledgedRun?.id) return route.continue();
    const observed = {runId};
    observations.push(observed);
    if(observations.length===1){
      observed.status = 503;
      return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:observationFailure})});
    }
    await observationReady;
    const response = await route.fetch();
    observed.status = response.status();
    await route.fulfill({response});
  });
  await verification.getByRole('checkbox',{name:'I authorize this check against this returned candidate without editing source.',exact:true}).check();
  await verification.getByRole('button',{name:'Run verification without editing',exact:true}).click();
  const transientError = review.getByRole('alert').filter({hasText:observationFailure});
  await transientError.waitFor();
  assert.equal(starts.length,1);
  const authorizedStart = structuredClone(starts[0].body);
  assert.match(authorizedStart.mutationId,/^[0-9a-f-]{36}$/);
  assert.equal(authorizedStart.confirmed,true);
  assert.equal(await review.getByRole('button',{name:'Retry verification start',exact:true}).count(),0);
  await p.screenshot({path:path.join(h.output,'verification-observation-interrupted.png'),fullPage:true});
  resumeObservation();
  const run = await until(async()=>{
    const runs=(await h.api(url+'/execution')).runs;
    if(!runs.length)return false;
    const current=(await h.api(url+'/execution/runs/'+runs[0].id)).run;
    return current.state==='succeeded' ? current : false;
  },45000);
  const localResult = review.getByRole('region',{name:'Local verification result',exact:true});
  await localResult.getByText('Browser fixture observation only; no Docker isolation exercised.',{exact:true}).waitFor();
  await transientError.waitFor({state:'detached'});
  assert.equal(starts.length,1,'Recovering observation must never send another start POST');
  assert.deepEqual(starts[0].body,authorizedStart,'The original authorization receipt remains unchanged');
  assert.equal(run.id,acknowledgedRun.id);
  assert.ok(observations.length>=2 && observations.slice(1).some(item=>item.status===200),'Status GET retries resume automatically');
  assert.ok(observations.every(item=>item.runId===run.id),'All observation retries stay bound to the authorized run');
  assert.deepEqual((await h.api(url+'/execution')).runs.map(item=>item.id),[run.id]);
  assert.equal(run.sourceCommit,candidate);
  assert.equal(run.executionMode,'immutable_verification');
  assert.equal(run.commands.length,1);
  assert.equal(run.commands[0].command,'fixture verification check');
  assert.equal(run.commands[0].verificationState,'not_verified','The deterministic fixture cannot claim Docker isolation');
  assert.deepEqual(run.artifact.files,[]);
  assert.equal(await fs.readFile(path.join(repo,'main.py'),'utf8'),'value = 2\n');
  assert.equal((await h.api(url+'/handoffs?taskId='+task.id)).results[0].origin,'external','New local observations never rewrite external provenance');
  assert.equal((await h.api(url)).content.buildTasks[0].status,'not_started');
  await h.restart();
  await handoff.getByText('Verify returned candidate without editing',{exact:true}).click();
  await handoff.getByRole('region',{name:'Saved local verification history',exact:true}).getByRole('button',{name:'Review local check',exact:true}).waitFor();
  assert.equal(starts.length,1,'Reloading saved verification history never replays execution');
  assert.deepEqual(starts[0].body,authorizedStart);
  await p.screenshot({path:path.join(h.output,'local-verification-history.png'),fullPage:true});
});
