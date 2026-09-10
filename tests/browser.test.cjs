/* Browser acceptance against built assets and an isolated, disposable SQLite DB. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const {chromium} = createRequire(path.join(root, 'frontend', 'package.json'))('playwright');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch (e) { last = e; }
    await wait(100);
  }
  throw last || new Error('Timed out waiting for condition');
}
async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test('FlowDesk built application acceptance', {timeout: 240000}, async t => {
  const output = path.join(root, 'output', 'playwright');
  fs.mkdirSync(output, {recursive:true});
  const dataDir = fs.mkdtempSync(path.join(output, 'acceptance-'));
  const sourceDir = path.join(dataDir, 'source');
  const dbDir = path.join(dataDir, 'data');
  fs.mkdirSync(sourceDir);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const python = process.env.FLOWDESK_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let server, token, browser, page;
  let serverOutput = '';
  async function start() {
    server = spawn(python, ['-m','flowdesk','--port',String(port),'--data-dir',dbDir], {cwd:process.env.FLOWDESK_APP_ROOT || root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    server.stdout.on('data', b => {serverOutput += b;});
    server.stderr.on('data', b => {serverOutput += b;});
    await until(async () => {const r=await fetch(base+'/api/bootstrap');if(r.ok){token=(await r.json()).token;return true;}});
  }
  async function stop() {
    if (!server || server.exitCode !== null) return;
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  async function api(url, method='GET', body) {
    const r = await fetch(base+'/api'+url,{method,headers:{'X-FlowDesk-Token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const value = await r.json();
    assert.ok(r.ok, `${method} ${url}: ${r.status} ${JSON.stringify(value)}`);
    return value;
  }
  async function saved() {
    await until(async()=>{const text=await page.getByTestId('save-state').innerText();return /saved/i.test(text)&&!/unsaved/i.test(text);});
  }
  t.after(async()=>{
    if(page) await page.screenshot({path:path.join(output,'workspace.png'),fullPage:true}).catch(()=>{});
    await browser?.close();
    await stop();
    fs.writeFileSync(path.join(output,'server.log'),serverOutput);
  });
  await start();
  const initial = await api('/projects','POST',{sample:true});
  const projectId = initial.id;
  const diagramId = initial.content.diagrams[0].id;
  const nodeId = initial.content.diagrams[0].nodes.find(n=>n.type==='process').id;
  const browserOptions = {headless:true};
  if(process.env.FLOWDESK_BROWSER_CHANNEL) browserOptions.channel=process.env.FLOWDESK_BROWSER_CHANNEL;
  else if(!fs.existsSync(chromium.executablePath()) && process.platform==='win32') browserOptions.channel='msedge';
  browser = await chromium.launch(browserOptions);
  const context=await browser.newContext({viewport:{width:1600,height:1000},acceptDownloads:true});
  const externalRequests=[];
  await context.route('**/*',route=>{
    const url=route.request().url();
    if(/^https?:/.test(url) && new URL(url).origin!==base){
      externalRequests.push(url);
      return route.abort();
    }
    return route.continue();
  });
  page=await context.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',dialog=>dialog.accept());
  await page.goto(base);
  await page.getByTestId('diagram-canvas').waitFor();

  await t.test('diagram metadata, text safety, and durable history',async()=>{
    const node=page.locator(`.react-flow__node[data-id="${nodeId}"]`);
    await node.dblclick();
    await page.getByLabel('Title',{exact:true}).fill('Store record - tested');
    await page.getByLabel('Notes',{exact:true}).fill('<img src=x onerror=alert(1)> inert notes');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await saved();
    const restored=await api('/projects/'+projectId);
    const n=restored.content.diagrams[0].nodes.find(n=>n.id===nodeId);
    assert.equal(n.title,'Store record - tested');
    assert.match(n.notes,/inert notes/);
    assert.equal(await page.locator('.inspector img').count(),0);
    const beforeCount=await page.locator('.react-flow__node').count();
    await page.getByLabel('Title',{exact:true}).focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    assert.equal(await page.locator('.react-flow__node').count(),beforeCount);
    await page.getByLabel('Title',{exact:true}).fill('Store record - tested');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await saved();
    const before=await api('/projects/'+projectId);
    const box=await node.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+25);
    await page.mouse.down();
    await page.mouse.move(box.x+box.width/2+70,box.y+75,{steps:12});
    await page.mouse.up();
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await saved();
    const moved=await api('/projects/'+projectId);
    assert.equal(moved.history.length,before.history.length+1,'completed drag must be one history entry');
    assert.notDeepEqual(moved.content.diagrams[0].nodes.find(n=>n.id===nodeId).position,before.content.diagrams[0].nodes.find(n=>n.id===nodeId).position);
    await page.getByRole('button',{name:'Undo',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await saved();
    const undone=await api('/projects/'+projectId);
    assert.deepEqual(undone.content.diagrams[0].nodes.find(n=>n.id===nodeId).position,before.content.diagrams[0].nodes.find(n=>n.id===nodeId).position);
    await stop();await start();await page.reload();
    await page.getByTestId('diagram-canvas').waitFor();
    await page.getByRole('button',{name:'Redo',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await saved();
    assert.deepEqual((await api('/projects/'+projectId)).content.diagrams[0].nodes.find(n=>n.id===nodeId).position,moved.content.diagrams[0].nodes.find(n=>n.id===nodeId).position);
  });

  await t.test('a second diagram and independent checklist status survive restart',async()=>{
    await page.getByRole('button',{name:'New diagram',exact:true}).click();
    await page.getByLabel('Diagram name',{exact:true}).fill('Recovery path');
    await page.getByRole('button',{name:'Create diagram',exact:true}).click();
    await page.getByRole('button',{name:'Add Process',exact:true}).click();
    await page.getByLabel('Title',{exact:true}).fill('Retry safely');
    await page.getByRole('button',{name:'+ Add checklist item',exact:true}).click();
    await page.getByLabel('Checklist text',{exact:true}).fill('Preserve the original input');
    await page.getByLabel('Complete Preserve the original input',{exact:true}).check();
    await page.getByRole('button',{name:'Save',exact:true}).click();await saved();
    const savedProject=await api('/projects/'+projectId);
    const recovery=savedProject.content.diagrams.find(d=>d.name==='Recovery path');
    assert.equal(recovery.nodes[0].status,'not_started','checking every checklist item must not complete the task');
    assert.equal(recovery.nodes[0].checklist[0].checked,true);
    await stop();await start();await page.reload();await page.getByTestId('diagram-canvas').waitFor();
    await page.getByRole('navigation',{name:'Diagrams'}).getByRole('button',{name:/Recovery path/}).click();
    await page.locator(`.react-flow__node[data-id="${recovery.nodes[0].id}"]`).dblclick();
    assert.equal(await page.getByLabel('Title',{exact:true}).inputValue(),'Retry safely');
    assert.equal(await page.getByLabel('Complete Preserve the original input',{exact:true}).isChecked(),true);
    assert.deepEqual((await api('/projects/'+projectId)).content.diagrams,savedProject.content.diagrams);
    await page.getByRole('navigation',{name:'Diagrams'}).getByRole('button',{name:/Import records/}).click();
  });

  await t.test('manual variable for a nonexistent file and node link',async()=>{
    if(!await page.getByRole('button',{name:'+ Plan variable',exact:true}).isVisible()) await page.getByRole('button',{name:/Variable catalogue/}).click();
    await page.getByRole('button',{name:'+ Plan variable',exact:true}).click();
    await page.getByLabel('Name',{exact:true}).fill('future_result');
    await page.getByLabel(/^Intended file/).fill('future/not_created.py');
    await page.getByLabel('Intended type',{exact:true}).fill('list[str]');
    await page.getByLabel('Node to link',{exact:true}).selectOption(nodeId);
    await page.locator('.variable-detail').getByRole('button',{name:'Link',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();await saved();
    const restored=await api('/projects/'+projectId);
    const v=restored.content.variables.find(v=>v.name==='future_result');
    assert.equal(v.intendedFile,'future/not_created.py');
    assert.ok(restored.content.nodeLinks.some(l=>l.variableId===v.id&&l.nodeId===nodeId));
    assert.equal(fs.existsSync(path.join(sourceDir,'future','not_created.py')),false);
  });

  await t.test('read-only scans preserve identities and report stale evidence',async()=>{
    const source=path.join(sourceDir,'scopes.py');
    fs.writeFileSync(source,'def first():\n    count: int = 1\n    return count\n\ndef second():\n    count = 2\n    return count\n');
    const original=fs.readFileSync(source);
    await api(`/projects/${projectId}/source`,'POST',{root:sourceDir,ignores:[],confirmed:true});
    async function scan(){const run=await api(`/projects/${projectId}/scans`,'POST',{});return until(async()=>{const s=await api(`/projects/${projectId}/scans/${run.id}`);return ['queued','running'].includes(s.status)?false:s;},30000);}
    const run=await scan();assert.equal(run.summary.analysed,1);
    assert.deepEqual(fs.readFileSync(source),original);
    const first=(await api(`/projects/${projectId}/symbols`)).symbols.filter(s=>s.name==='count');
    assert.equal(first.length,2);assert.notEqual(first[0].scope,first[1].scope);
    fs.writeFileSync(source,'\n\n'+original);
    await scan();
    assert.deepEqual((await api(`/projects/${projectId}/symbols`)).symbols.filter(s=>s.name==='count').map(s=>s.id).sort(),first.map(s=>s.id).sort());
    fs.writeFileSync(source,'def broken(:\n');
    await scan();
    assert.ok((await api(`/projects/${projectId}/symbols`)).symbols.filter(s=>s.name==='count').every(s=>s.state==='stale'));
    await page.reload();await page.getByTestId('diagram-canvas').waitFor();
  });


  await t.test('delayed save responses cannot replace newer edits',async()=>{
    await page.reload();await page.getByTestId('diagram-canvas').waitFor();
    let release;const gate=new Promise(r=>{release=r;});let arrived;
    const seen=new Promise(r=>{arrived=r;});let intercepted=false;
    await page.route(`**/api/projects/${projectId}`,async route=>{
      if(route.request().method()!=='PUT'||intercepted)return route.continue();
      intercepted=true;const response=await route.fetch();arrived();await gate;await route.fulfill({response});
    });
    await page.getByLabel('Notes',{exact:true}).fill('First saved text');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await seen;
    await page.getByLabel('Notes',{exact:true}).fill('Newer text survives a late response');
    release();await saved();
    assert.equal(await page.getByLabel('Notes',{exact:true}).inputValue(),'Newer text survives a late response');
    assert.equal((await api('/projects/'+projectId)).content.notes,'Newer text survives a late response');
    await page.unroute(`**/api/projects/${projectId}`);
  });

  await t.test('conflicting tabs preserve the second draft',async()=>{
    const other=await context.newPage();other.on('dialog',d=>d.accept());
    await other.goto(base);await other.getByTestId('diagram-canvas').waitFor();
    await page.getByLabel('Notes',{exact:true}).fill('First tab wins');
    await page.getByRole('button',{name:'Save',exact:true}).click();await saved();
    await other.getByLabel('Notes',{exact:true}).fill('Second draft kept for recovery');
    await other.getByRole('button',{name:'Save',exact:true}).click();
    await other.getByRole('button',{name:'Keep draft as new project',exact:true}).waitFor();
    assert.equal(await other.getByLabel('Notes',{exact:true}).inputValue(),'Second draft kept for recovery');
    assert.equal((await api('/projects/'+projectId)).content.notes,'First tab wins');
    await other.getByRole('button',{name:'Discard and reload',exact:true}).click();
    await until(async()=>await other.getByLabel('Notes',{exact:true}).inputValue()==='First tab wins');
    await other.close();
  });

  await t.test('save failure retains edits and blocks project switching',async()=>{
    await page.route(`**/api/projects/${projectId}`,route=>route.request().method()==='PUT'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Injected disk failure'})}):route.continue());
    await page.getByLabel('Notes',{exact:true}).fill('Retained through save failure');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('button',{name:'Retry save',exact:true}).waitFor();
    await page.getByRole('button',{name:'New project',exact:true}).click();
    assert.equal(await page.getByRole('dialog').count(),0);
    assert.equal(await page.getByLabel('Notes',{exact:true}).inputValue(),'Retained through save failure');
    await page.unroute(`**/api/projects/${projectId}`);
    await page.getByRole('button',{name:'Retry save',exact:true}).click();await saved();
    assert.equal((await api('/projects/'+projectId)).content.notes,'Retained through save failure');
  });

  await t.test('PNG contains the full diagram beyond the viewport',async()=>{
    const e=await api('/projects/'+projectId);const content=structuredClone(e.content);
    const far=structuredClone(content.diagrams[0].nodes.find(n=>n.id===nodeId));
    far.id=crypto.randomUUID();far.title='Far outside viewport';far.position={x:4200,y:500};far.checklist=[];
    content.diagrams[0].nodes.push(far);
    content.diagrams[0].edges.push({id:crypto.randomUUID(),source:nodeId,target:far.id,sourceHandle:'out',targetHandle:'in',label:'Full export boundary'});
    const cp={id:crypto.randomUUID(),label:'Add offscreen export node',diagramId,content};
    await api('/projects/'+projectId,'PUT',{baseRevision:e.revision,mutationId:crypto.randomUUID(),anchorId:e.history.at(-1).id,append:[cp],cursor:cp.id,views:e.views});
    await page.reload();await page.getByTestId('diagram-canvas').waitFor();
    await page.locator('.export-menu summary').click();
    const downloadPromise=page.waitForEvent('download',{timeout:45000});
    await page.getByRole('button',{name:'Full diagram PNG',exact:true}).click();
    const image=await downloadPromise;
    const filename=path.join(output,'full-diagram.png');await image.saveAs(filename);
    const bytes=fs.readFileSync(filename);
    assert.equal(bytes.subarray(1,4).toString(),'PNG');
    assert.ok(bytes.readUInt32BE(16)>8500,'PNG must include the distant node, not just the viewport');
    assert.ok(bytes.readUInt32BE(20)>1000);
    const pixels = await page.evaluate(async dataUrl => {
      const picture = new Image();
      picture.src = dataUrl;
      await picture.decode();
      const canvas = document.createElement('canvas');
      canvas.width = picture.naturalWidth;
      canvas.height = picture.naturalHeight;
      const drawing = canvas.getContext('2d');
      drawing.drawImage(picture, 0, 0);
      const {data} = drawing.getImageData(0, 0, canvas.width, canvas.height);
      let dark = 0, distant = 0, middle = 0;
      let left = canvas.width, top = canvas.height, right = 0, bottom = 0;
      for (let y = 0; y < canvas.height; y += 2) {
        for (let x = 0; x < canvas.width; x += 2) {
          const offset = (y * canvas.width + x) * 4;
          if (data[offset] < 190 && data[offset+1] < 190 && data[offset+2] < 190 && data[offset+3] > 200) {
            dark++;
            if (x > canvas.width * .85) distant++;
            if (x > canvas.width * .4 && x < canvas.width * .6) middle++;
            left = Math.min(left, x); top = Math.min(top, y);
            right = Math.max(right, x); bottom = Math.max(bottom, y);
          }
        }
      }
      return {dark, distant, middle, left, top, right, bottom, width:canvas.width, height:canvas.height};
    }, `data:image/png;base64,${bytes.toString('base64')}`);
    assert.ok(pixels.dark > 1000, 'PNG must render diagram content, not only a blank background');
    assert.ok(pixels.distant > 100, 'The distant node must be visibly rendered');
    assert.ok(pixels.middle > 100, 'The connecting edge and label must cross the full export');
    assert.ok(pixels.left > 20 && pixels.top > 20 && pixels.right < pixels.width-20 && pixels.bottom < pixels.height-20, 'Visible content must have unclipped padding');
    assert.equal(await page.locator('.png-export').count(),0,'temporary export surface cleaned up');
  });

  await t.test('no runtime errors and full workspace screenshot',async()=>{
    assert.deepEqual(errors,[]);
    assert.deepEqual(externalRequests,[],'ordinary operation must not need external network resources');
    await page.screenshot({path:path.join(output,'workspace.png'),fullPage:true});
  });
});
