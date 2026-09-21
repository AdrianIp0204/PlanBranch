const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {setupBrowser,until}=require('./browser-harness.cjs');
const {withBrowserZoom}=require('./ux-fixture.cjs');
const dialog=p=>p.getByRole('dialog',{name:'Run step',exact:true});
function git(root,...args){return execFileSync('git',['-c',`safe.directory=${root}`,'-c','core.autocrlf=false','-C',root,...args],{windowsHide:true,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'}}).toString().trim();}
async function fixture(t,title='Implement one observable result'){
  const h=await setupBrowser(t,{name:'execution',planningFixture:true,viewport:{width:1440,height:900}});
  h.url=`/projects/${h.initial.id}`;h.repo=path.join(h.output,'execution repository');
  await fs.mkdir(h.repo);
  await fs.writeFile(path.join(h.repo,'main.py'),'value = 1\n');
  await fs.writeFile(path.join(h.repo,'unrelated.txt'),'original\n');
  await fs.writeFile(path.join(h.repo,'fixture-only.marker'),'Disposable browser execution fixture\n');
  git(h.repo,'init','--initial-branch=main');git(h.repo,'config','user.name','PlanBranch fixture');git(h.repo,'config','user.email','fixture@example.invalid');git(h.repo,'add','.');git(h.repo,'commit','-m','Disposable baseline');
  h.head=git(h.repo,'rev-parse','HEAD');
  await fs.writeFile(path.join(h.repo,'unrelated.txt'),'user local draft\n');
  git(h.repo,'add','unrelated.txt');h.index=await fs.readFile(path.join(h.repo,'.git','index'));
  h.task={id:crypto.randomUUID(),title,deliverable:'Update the fixture value and verify it.',nodeLinks:[],prerequisiteIds:[],expectedFiles:['main.py'],acceptanceChecks:[{id:crypto.randomUUID(),text:'The fixture check observes value 2.'}],status:'not_started'};
  await h.saveContent(h.initial.id,c=>{c.buildTasks=[h.task];c.brief.goal='An explicit, reviewable coding step.';});
  await approve(h);await h.page.reload();await showBuild(h);
  return h;
}
async function approve(h){const e=await h.api(h.url);await h.api(h.url+'/planning/approve','POST',{baseRevision:e.revision,mutationId:crypto.randomUUID()});}
async function showBuild(h){await h.page.getByRole('group',{name:'Plan views',exact:true}).getByRole('button',{name:'Build',exact:true}).click();}
async function open(h,history=false){await h.page.getByRole('region',{name:'Build tasks',exact:true}).getByRole('button',{name:history?'Execution history':'Run step',exact:true}).click();await dialog(h.page).waitFor();}
async function prepare(h){
  await open(h);const d=dialog(h.page);
  if(await d.getByLabel('Repository folder',{exact:true}).isVisible()){
    await d.getByLabel('Repository folder',{exact:true}).fill(h.repo);await d.getByRole('button',{name:'Use repository',exact:true}).click();
    await d.getByRole('button',{name:'Change repository',exact:true}).waitFor();
  }
  await d.getByRole('button',{name:'Preview run',exact:true}).click();
  await until(()=>d.getByRole('button',{name:'Run step',exact:true}).isEnabled());
  assert.equal((await h.api(h.url+'/execution')).runs.length,0,'Preview never starts execution');
  assert.match(await d.innerText(),/Uncommitted checkout changes are excluded/);
  return d;
}
async function runUntil(h,predicate){return until(async()=>{const state=await h.api(h.url+'/execution');if(!state.runs[0])return false;const {run}=await h.api(h.url+'/execution/runs/'+state.runs[0].id);return predicate(run)?run:false;},45000);}
async function untouched(h){assert.equal(await fs.readFile(path.join(h.repo,'main.py'),'utf8'),'value = 1\n');assert.equal(await fs.readFile(path.join(h.repo,'unrelated.txt'),'utf8'),'user local draft\n');assert.deepEqual(await fs.readFile(path.join(h.repo,'.git','index')),h.index);assert.equal(git(h.repo,'rev-parse','HEAD'),h.head);}

test('explicit run, review, acceptance, completion and checkout apply remain separate and durable',{timeout:180000},async t=>{
  const h=await fixture(t),p=h.page,d=await prepare(h);
  await d.getByRole('button',{name:'Run step',exact:true}).click();
  let run=await runUntil(h,r=>r.state==='succeeded');await untouched(h);
  assert.notEqual(path.resolve(run.worktreePath),path.resolve(h.repo));
  assert.equal((await h.api(h.url)).content.buildTasks[0].status,'not_started');
  await until(()=>d.getByRole('button',{name:'Accept changes',exact:true}).isEnabled());
  assert.equal(await d.getByRole('button',{name:'Complete task',exact:true}).isEnabled(),false);
  assert.equal(await d.getByRole('button',{name:'Apply to checkout',exact:true}).isEnabled(),false);
  assert.match(await d.getByRole('region',{name:'Observed commands'}).innerText(),/Exit 0/);
  assert.match(await d.locator('[aria-label="Diff for main.py"]').innerText(),/\+value = 2/);
  await p.screenshot({path:path.join(h.output,'execution-review-1440.png'),fullPage:true});
  await d.getByRole('button',{name:'Accept changes',exact:true}).click();
  await until(()=>d.getByRole('button',{name:'Complete task',exact:true}).isEnabled());await untouched(h);
  await h.restart();await showBuild(h);await open(h,true);
  await dialog(p).getByRole('button',{name:'Changes accepted',exact:true}).waitFor();
  await dialog(p).getByRole('button',{name:'Complete task',exact:true}).click();
  await until(async()=> (await h.api(h.url)).content.buildTasks[0].status==='done');
  assert.equal((await h.api(h.url+'/planning')).approval.current,false);
  await untouched(h);
  await until(()=>dialog(p).getByRole('button',{name:'Apply to checkout',exact:true}).isEnabled());
  await fs.writeFile(path.join(h.repo,'main.py'),'user conflicting edit\n');
  await dialog(p).getByRole('button',{name:'Apply to checkout',exact:true}).click();
  await until(async()=>/uncommitted change conflicts/i.test(await dialog(p).innerText()));
  assert.equal(await fs.readFile(path.join(h.repo,'main.py'),'utf8'),'user conflicting edit\n');
  assert.equal(await dialog(p).getByRole('button',{name:'Retry apply',exact:true}).count(),0,'A definite preflight refusal releases the old receipt');
  await fs.writeFile(path.join(h.repo,'main.py'),'value = 1\n');
  await dialog(p).getByRole('button',{name:'Apply to checkout',exact:true}).click();
  await dialog(p).getByRole('button',{name:'Applied to checkout',exact:true}).waitFor();
  assert.equal(await fs.readFile(path.join(h.repo,'main.py'),'utf8'),'value = 2\n');
  assert.equal(await fs.readFile(path.join(h.repo,'unrelated.txt'),'utf8'),'user local draft\n');assert.deepEqual(await fs.readFile(path.join(h.repo,'.git','index')),h.index);
  await p.setViewportSize({width:1280,height:800});await p.screenshot({path:path.join(h.output,'execution-review-1280.png'),fullPage:true});
  await p.keyboard.press('Escape');await until(()=>p.getByRole('region',{name:'Build tasks',exact:true}).getByRole('button',{name:'Execution history',exact:true}).evaluate(el=>document.activeElement===el));
  await p.getByRole('button',{name:/^Undo/}).click();await h.saved();assert.equal((await h.api(h.url)).content.buildTasks[0].status,'not_started');
});

test('cancellation and server restart preserve work without silently starting another run',{timeout:180000},async t=>{
  const h=await fixture(t,'Slow implementation fixture'),p=h.page,d=await prepare(h);
  await d.getByRole('button',{name:'Run step',exact:true}).click();
  let run=await runUntil(h,r=>r.state==='running'&&r.progress.includes('Fixture worktree updated'));
  await h.restart();await showBuild(h);await open(h,true);
  await runUntil(h,r=>r.state==='interrupted');
  await dialog(p).getByRole('button',{name:'Refresh results',exact:true}).click();
  await until(async()=> (await h.api(h.url+'/execution/runs/'+run.id)).run.artifact?.files.length===1);
  assert.equal((await h.api(h.url+'/execution')).runs.length,1);await untouched(h);
  await dialog(p).getByLabel('Execution history',{exact:true}).selectOption('');
  await dialog(p).getByRole('button',{name:'Preview run',exact:true}).click();await until(()=>dialog(p).getByRole('button',{name:'Run step',exact:true}).isEnabled());
  await dialog(p).getByRole('button',{name:'Run step',exact:true}).click();await runUntil(h,r=>r.state==='running'&&r.progress.includes('Fixture worktree updated'));
  await dialog(p).getByRole('button',{name:'Cancel run',exact:true}).click();await runUntil(h,r=>r.state==='cancelled');
  await untouched(h);assert.equal((await h.api(h.url+'/execution')).runs.length,2);
});

test('observed failed checks and stale approval remain visible with keyboard and zoom access',{timeout:150000},async t=>{
  const h=await fixture(t,'Fail the observable check'),p=h.page,d=await prepare(h);
  await d.getByRole('button',{name:'Run step',exact:true}).click();const run=await runUntil(h,r=>r.state==='succeeded');
  await until(async()=> /Exit 1/.test(await d.getByRole('region',{name:'Observed commands'}).innerText()));
  await d.getByRole('region',{name:'Observed commands'}).locator('summary').click();assert.match(await d.innerText(),/fixture check failed/);
  await h.saveContent(h.initial.id,c=>{c.brief.constraints='A changed requirement requires another review.';});
  await d.getByRole('button',{name:'Check run status',exact:true}).click();
  await until(async()=> !(await d.getByRole('button',{name:'Accept changes',exact:true}).isEnabled()));
  assert.equal((await h.api(h.url+'/execution/runs/'+run.id)).run.planStale,true);
  await p.emulateMedia({reducedMotion:'reduce'});
  await p.setViewportSize({width:720,height:800});
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await p.screenshot({path:path.join(h.output,'execution-narrow.png'),fullPage:true});
  await withBrowserZoom(h,async()=>{assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await dialog(p).getByRole('button',{name:'Check run status',exact:true}).focus();assert.equal(await dialog(p).getByRole('button',{name:'Check run status',exact:true}).evaluate(el=>document.activeElement===el),true);await p.screenshot({path:path.join(h.output,'execution-200-percent.png'),fullPage:true});});
  await untouched(h);
});
