/* Shared real-browser fixture. Every run owns its server, database and source root. */
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
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await wait(100);
  }
  throw last || new Error('Timed out waiting for condition');
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {socket.once('error', reject);socket.listen(0, '127.0.0.1', resolve);});
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function setupBrowser(t, {name = 'acceptance', seed = {sample:true}, viewport = {width:1600,height:1000}, planningFixture = false, providerFixture = false} = {}) {
  const artifacts = path.join(root, 'output', 'playwright');
  fs.mkdirSync(artifacts, {recursive:true});
  const output = fs.mkdtempSync(path.join(artifacts, name.replace(/[^a-z0-9-]/gi, '-') + '-'));
  const dataDir = output;
  const sourceDir = path.join(output, 'source');
  const dbDir = path.join(output, 'data');
  fs.mkdirSync(sourceDir);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const python = process.env.FLOWDESK_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let server, token, browser, page, spawnError;
  let serverOutput = '';
  const errors = [], externalRequests = [];
  async function start() {
    assert.ok(!server || server.exitCode !== null || server.signalCode !== null, 'Previous fixture server must stop before restart');
    spawnError = null;
    const launcher = providerFixture
      ? ['-c', 'import runpy,sys; runpy.run_path(sys.argv.pop(1), run_name="__main__")', path.join(root, 'tests', 'provider-fixture-server.py')]
      : planningFixture
      ? ['-c', 'import runpy,sys; runpy.run_path(sys.argv.pop(1), run_name="__main__")', path.join(root, 'tests', 'planning-fixture-server.py')]
      : ['-m', 'flowdesk'];
    server = spawn(python, [...launcher,'--port',String(port),'--data-dir',dbDir], {
      cwd:process.env.FLOWDESK_APP_ROOT || root, windowsHide:true, stdio:['ignore','pipe','pipe'],
    });
    server.once('error', error => {spawnError = error;});
    server.stdout.on('data', chunk => {serverOutput += chunk;});
    server.stderr.on('data', chunk => {serverOutput += chunk;});
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (spawnError || server.exitCode !== null || server.signalCode !== null)
        throw new Error(`Fixture server failed to start: ${spawnError?.message || serverOutput}`);
      try {
        const response = await fetch(base+'/api/bootstrap');
        if (response.ok) {token = (await response.json()).token;return;}
      } catch { /* The owned server may still be starting. */ }
      await wait(100);
    }
    throw new Error(`Fixture server did not become ready. ${serverOutput}`);
  }
  async function stop() {
    if (!server || server.exitCode !== null || server.signalCode !== null || spawnError) return;
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  async function api(url, method = 'GET', body) {
    const response = await fetch(base+'/api'+url, {
      method, headers:{'X-FlowDesk-Token':token,'Content-Type':'application/json'},
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert.ok(response.ok, `${method} ${url}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  async function saved(target = page) {
    await until(async () => {
      const text = await target.getByTestId('save-state').innerText();
      // The readable timestamp also contains "Last saved" while a new save is
      // pending. Only the leading status acknowledges current durability.
      return /^saved\b/i.test(text.trim());
    });
  }
  async function restart({reload = true} = {}) {
    await stop();await start();
    // A restored Build workspace intentionally has no diagram canvas.
    if (reload) {await page.reload();await page.getByRole('group',{name:'Plan views',exact:true}).waitFor();}
  }
  async function saveContent(projectId, mutate, label = 'Prepare test fixture', diagramId) {
    const envelope = await api('/projects/'+projectId);
    const content = structuredClone(envelope.content);
    mutate(content);
    const cp = {id:crypto.randomUUID(),label,content,...(diagramId ? {diagramId} : {})};
    await api('/projects/'+projectId,'PUT',{
      baseRevision:envelope.revision,mutationId:crypto.randomUUID(),anchorId:envelope.cursor,
      append:[cp],cursor:cp.id,views:envelope.views,
    });
    return api('/projects/'+projectId);
  }
  t.after(async () => {
    try {
      if (page && !page.isClosed()) await page.screenshot({path:path.join(output,'workspace.png'),fullPage:true}).catch(()=>{});
    } finally {
      await browser?.close();
      await stop();
      fs.writeFileSync(path.join(output,'server.log'),serverOutput);
      fs.writeFileSync(path.join(output,'browser.json'),JSON.stringify({
        platform:process.platform,node:process.version,browser:browser?.version(),
        appRoot:process.env.FLOWDESK_APP_ROOT || root,errors,externalRequests,
      },null,2));
    }
    assert.deepEqual(externalRequests, [], 'Ordinary operation must not request external network resources');
    assert.deepEqual(errors, [], 'Browser runtime errors');
  });
  await start();
  const initial = seed === null ? null : await api('/projects','POST',seed);
  const options = {headless:true};
  if (process.env.FLOWDESK_BROWSER_CHANNEL) options.channel = process.env.FLOWDESK_BROWSER_CHANNEL;
  else if (!fs.existsSync(chromium.executablePath()) && process.platform === 'win32') options.channel = 'msedge';
  browser = await chromium.launch(options);
  const context = await browser.newContext({viewport,acceptDownloads:true});
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== base) {externalRequests.push(url);return route.abort();}
    return route.continue();
  });
  context.on('page', opened => {
    opened.on('pageerror', error => errors.push(error.message));
    opened.on('dialog', dialog => dialog.accept());
  });
  page = await context.newPage();
  await page.goto(base);
  if (initial) await page.getByTestId('diagram-canvas').waitFor();
  return {root,output,dataDir,sourceDir,dbDir,base,python,page,context,api,initial,start,stop,restart,saved,saveContent,errors,externalRequests};
}

// Manual proposal editing mounts a separate React Flow instance. Wait for its
// nodes to be measured and its scheduled initial fit to settle before clicking.
async function settledCanvas(canvas) {
  await canvas.waitFor();
  await until(() => canvas.evaluate(root => new Promise(resolve => {
    let previous = '', stable = 0, frames = 0;
    const sample = () => {
      const viewport = root.querySelector('.react-flow__viewport');
      const nodes = [...root.querySelectorAll('.react-flow__node')];
      if (!root.isConnected || !viewport || !nodes.length || nodes.some(node =>
        node.offsetWidth === 0 || node.offsetHeight === 0 || getComputedStyle(node).visibility === 'hidden')) return resolve(false);
      const bounds = root.getBoundingClientRect();
      const signature = [viewport.style.transform, bounds.width, bounds.height, ...nodes.flatMap(node => {
        const box = node.getBoundingClientRect();
        return [node.dataset.id, box.x, box.y, box.width, box.height];
      })].join('|');
      stable = signature === previous ? stable + 1 : 0;
      previous = signature;
      if (stable >= 3) return resolve(true);
      if (++frames >= 30) return resolve(false);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })));
  return canvas;
}

module.exports = {setupBrowser,until,wait,settledCanvas};
