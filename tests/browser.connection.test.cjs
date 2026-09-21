const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {setupBrowser,until}=require('./browser-harness.cjs');

test('first-run connection retry is read-only and manual planning remains available',{timeout:65000},async t=>{
 const h=await setupBrowser(t,{name:'first-run-connection',seed:null,planningFixture:true,viewport:{width:1280,height:800}}),p=h.page;
 const calls=[];
 await p.route('**/api/connection*',async route=>{calls.push(route.request().url());const available=new URL(route.request().url()).searchParams.get('refresh')==='1';await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({agent:{available,label:'Codex CLI',...(!available?{reason:'Sign in with codex login.'}:{})}})});});
 await p.reload();const check=p.getByRole('region',{name:'Codex connection',exact:true});
 await check.getByRole('status').filter({hasText:'Codex unavailable'}).waitFor();
 assert.equal(await p.getByRole('button',{name:'New project',exact:true}).isEnabled(),true);
 assert.equal((await h.api('/projects')).projects.length,0);
 await check.getByRole('button',{name:'Retry connection',exact:true}).click();await check.getByRole('status').filter({hasText:'Codex ready'}).waitFor();
 assert.equal(calls.length,2);assert.equal((await h.api('/projects')).projects.length,0);
 await p.screenshot({path:path.join(h.output,'first-run-1280.png'),fullPage:true});
 await p.unroute('**/api/connection*');
 let unavailableCalls=0;
 await p.route('**/api/connection*',route=>{unavailableCalls++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({agent:{available:false,label:'Codex CLI',reason:'Codex is unavailable in this disposable test.'}})});});
 await p.reload();await check.getByRole('status').filter({hasText:'Codex unavailable'}).waitFor();
 await p.getByRole('button',{name:'New project',exact:true}).click();await p.getByLabel('Project name',{exact:true}).fill('Manual planning without Codex');await p.getByRole('button',{name:'Create project',exact:true}).click();await p.getByTestId('diagram-canvas').waitFor();
 assert.equal((await h.api('/projects')).projects.length,1);
 await p.getByText('Layout',{exact:true}).click();await p.getByRole('button',{name:'Codex connection',exact:true}).click();
 const d=p.getByRole('dialog',{name:'Codex connection',exact:true});await d.getByRole('status').filter({hasText:'Codex unavailable'}).waitFor();
 const beforeRetry=unavailableCalls;
 await d.getByRole('button',{name:'Retry connection',exact:true}).focus();await p.keyboard.press('Enter');await until(()=>unavailableCalls===beforeRetry+1); // read-only retry stays in the dialog
 await p.keyboard.press('Escape');await d.waitFor({state:'hidden'});
 assert.equal(await p.evaluate(()=>document.activeElement!==document.body),true,'Closing setup restores meaningful focus');
 assert.equal((await h.api('/projects')).projects.length,1);
});
