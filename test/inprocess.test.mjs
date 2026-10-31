// These tests exercise real HTTP request handlers through an in-process transport.
// They do not replace foundation.test.mjs, which requires real loopback sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KEY = 'in-process-test-key-never-exposed';
const SECRET = 'in-process-session-secret';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYU4AAAAASUVORK5CYII=', 'base64');
const OPTIONS = { colors: Object.fromEntries(['thumb', 'index', 'middle', 'ring', 'little'].map(finger => [finger, '#112233'])) };

class MemoryResponse extends Writable {
  constructor() { super(); this.headers = new Map(); this.chunks = []; this.statusCode = 200; this.headersSent = false; }
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  writeHead(status, headers = {}) {
    this.statusCode = status; this.headersSent = true;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    return this;
  }
  _write(chunk, encoding, done) { this.chunks.push(Buffer.from(chunk)); done(); }
}

async function dispatch(server, value, options = {}) {
  const url = new URL(value);
  assert.equal(url.hostname, '127.0.0.1', 'In-process transport accepts localhost URLs only');
  options.signal?.throwIfAborted();
  const req = Readable.from(options.body === undefined ? [] : [Buffer.from(options.body)]);
  req.method = options.method ?? 'GET';
  req.url = `${url.pathname}${url.search}`;
  req.headers = { host: url.host, ...Object.fromEntries(new Headers(options.headers)) };
  req.socket = { encrypted: false };
  const res = new MemoryResponse();
  const finished = new Promise((done, reject) => { res.once('finish', done); res.once('error', reject); });
  server.emit('request', req, res);
  await finished;
  return new Response(Buffer.concat(res.chunks), { status: res.statusCode, headers: Object.fromEntries(res.headers) });
}

function provider(mode = 'success') {
  const base = 'http://127.0.0.1:12345', calls = [], tasks = new Map();
  let pending = 0, maximumPending = 0, fileCount = 0;
  const state = { release: false };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), path = new URL(req.url, base).pathname;
    const call = { method: req.method, path, headers: req.headers, bytes };
    calls.push(call);
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'POST' && path === '/s2s/v2.0/file') {
      call.body = JSON.parse(bytes);
      json(200, { status: 200, data: { files: [{ file_id: `file-${++fileCount}`, requests: [{
        url: `${base}/upload`, method: 'PUT', headers: { 'Content-Type': 'image/png', 'X-Signed': 'only-upload-header' },
      }] }] } });
    } else if (req.method === 'PUT' && path === '/upload') {
      res.writeHead(200); res.end();
    } else if (req.method === 'POST' && path === '/s2s/v2.0/task/nail-vto') {
      call.body = JSON.parse(bytes);
      if (mode === 'post-error') { json(500, { error: `Authorization: Bearer ${KEY}` }); return; }
      const id = `task-${tasks.size + 1}`;
      tasks.set(id, { polls: 0, finished: false });
      maximumPending = Math.max(maximumPending, ++pending);
      json(200, { status: 200, data: { task_id: id } });
    } else if (req.method === 'GET' && path.startsWith('/s2s/v2.0/task/nail-vto/')) {
      const id = path.split('/').at(-1), task = tasks.get(id);
      task.polls++;
      if (mode === 'running' || (mode === 'hold' ? !state.release : task.polls < 2)) {
        json(200, { status: 200, data: { task_status: 'running' } }); return;
      }
      if (!task.finished) { task.finished = true; pending--; }
      const results = mode === 'secret-result' ? { url: `${base}/secret` }
        : { url: `${base}/${mode === 'partial-error' ? 'broken' : 'first'}?signature=one`, nested: [{ url: `${base}/second?signature=two` }] };
      json(200, { status: 200, data: mode === 'error'
        ? { task_status: 'error', error: `Authorization: Bearer ${KEY}` }
        : { task_status: 'success', results } });
    } else if (req.method === 'GET' && ['/first', '/second'].includes(path)) {
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG);
    } else if (path === '/secret') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(`Authorization: Bearer ${KEY}`);
    } else json(500, { Authorization: `Bearer ${KEY}` });
  });
  return { base, calls, tasks, state, fetch: (url, options) => dispatch(server, url, options), get maximumPending() { return maximumPending; } };
}

async function fixture(t, { mode = 'mock', fake, pollOptions = {} } = {}) {
  const logs = [], original = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    original[method] = console[method];
    console[method] = (...values) => logs.push(values.map(String).join(' '));
  }
  t.after(() => {
    for (const [method, fn] of Object.entries(original)) console[method] = fn;
    assert.equal(logs.join('\n').includes(KEY), false, 'A console log contained the API key');
  });
  const base = join(ROOT, '.test-work');
  await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(join(base, 'inprocess-'));
  const appDir = join(workspace, 'app'), dataDir = join(workspace, 'data');
  await mkdir(appDir);
  await Promise.all(['server.mjs', 'lib', 'public'].map(name => cp(join(ROOT, name), join(appDir, name), { recursive: true })));
  const { createApplication } = await import(pathToFileURL(join(appDir, 'server.mjs')).href);
  const apps = [];
  const env = { MODE: mode, APP_PASSCODE: 'passcode', SESSION_SECRET: SECRET, DATA_DIR: dataDir,
    YOUCAM_API_KEY: KEY, YOUCAM_BASE_URL: fake?.base ?? 'http://127.0.0.1:12345' };
  let outbound = 0;
  async function start() {
    const app = await createApplication(env, { fetchImpl: async (url, options) => {
      outbound++;
      if (!fake) throw new Error('Mock mode must not perform outbound requests');
      return fake.fetch(url, options);
    }, pollOptions: { initialDelayMs: 5, maxDelayMs: 10, timeoutMs: 500, ...pollOptions } });
    apps.push(app);
    async function request(path, { cookie, json, ...options } = {}) {
      const response = await dispatch(app.server, `http://127.0.0.1:23456${path}`, {
        ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
        ...(json ? { body: JSON.stringify(json) } : {}),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.includes(Buffer.from(KEY)), false, 'An application response contained the API key');
      return { status: response.status, headers: response.headers, bytes, value: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString()) : null };
    }
    return { ...app, request };
  }
  t.after(async () => {
    for (const app of apps) await app.close().catch(error => { if (error.code !== 'ERR_SERVER_NOT_RUNNING') throw error; });
    await rm(workspace, { recursive: true, force: true });
  });
  return { app: await start(), start, dataDir, get outbound() { return outbound; } };
}

async function login(app) {
  const response = await app.request('/login', { method: 'POST', json: { passcode: 'passcode' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly.*SameSite=Lax/);
  return response.headers.get('set-cookie').split(';')[0];
}

async function upload(app, cookie) {
  const response = await app.request('/api/uploads', { method: 'POST', cookie, headers: { 'Content-Type': 'image/png' }, body: PNG });
  assert.equal(response.status, 201);
  return response.value.uploadId;
}

async function submit(app, cookie, uploadId, feature = 'nail', options = OPTIONS) {
  const response = await app.request('/api/tasks', { method: 'POST', cookie, json: { feature, uploadId, options } });
  assert.equal(response.status, 202);
  return response.value.id;
}

async function waitFor(check, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(5); }
  assert.fail(message);
}

async function completed(app, cookie, id) {
  return waitFor(async () => {
    const result = await app.request(`/api/tasks/${id}`, { cookie });
    assert.equal(result.status, 200);
    return ['success', 'error'].includes(result.value.status) && result.value;
  }, 'In-process task failed to reach a terminal state');
}

async function diskSafe(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await diskSafe(path);
    else assert.equal((await readFile(path)).includes(Buffer.from(KEY)), false, 'Stored file or usage log contained the API key');
  }
}

test('in-process transport: gate rejects missing, tampered and expired sessions', async t => {
  const { app } = await fixture(t);
  for (const path of ['/api/features', '/api/usage', '/api/tasks/unknown', '/api/results/unknown/file']) {
    assert.equal((await app.request(path)).status, 401);
  }
  assert.equal((await app.request('/api/tasks', { method: 'POST', json: {} })).status, 401);
  const cookie = await login(app);
  assert.equal((await app.request('/api/features', { cookie })).status, 200);
  assert.equal((await app.request('/api/usage', { cookie: `${cookie}invalid` })).status, 401);
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() - 10 })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  assert.equal((await app.request('/api/usage', { cookie: `youcam_session=${payload}.${sig}` })).status, 401);
  assert.equal((await app.request('/api/uploads', { cookie, method: 'POST', headers: { 'Content-Type': 'image/png' }, body: 'invalid' })).status, 400);
});

test('in-process transport: full live upload, task, poll, two downloads and usage reload', async t => {
  const fake = provider(), f = await fixture(t, { mode: 'live', fake });
  const app = f.app, cookie = await login(app), id = await submit(app, cookie, await upload(app, cookie));
  const job = await completed(app, cookie, id);
  assert.equal(job.status, 'success');
  assert.equal(job.results.length, 3);
  for (const call of fake.calls.filter(call => call.path.startsWith('/s2s/'))) assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  const put = fake.calls.find(call => call.method === 'PUT');
  assert.equal(put.headers.authorization, undefined);
  assert.equal(put.headers['x-signed'], 'only-upload-header');
  assert.deepEqual(put.bytes, PNG);
  for (const call of fake.calls.filter(call => ['/first', '/second'].includes(call.path))) assert.equal(call.headers.authorization, undefined);
  const prepare = fake.calls.find(call => call.path === '/s2s/v2.0/file');
  assert.equal(prepare.body.files[0].file_size, PNG.length);
  const post = fake.calls.find(call => call.method === 'POST' && call.path.endsWith('nail-vto'));
  assert.equal(post.body.effects.at(-1).finger, 'pinky');
  assert.equal(post.body.src_file_id, 'file-1');
  for (const result of job.results) {
    assert.equal((await app.request(result.url)).status, 401);
    const response = await app.request(result.url, { cookie });
    assert.equal(response.status, 200);
    if (result.contentType.startsWith('image/')) assert.deepEqual(response.bytes, PNG);
  }
  const directory = join(f.dataDir, 'results', 'task-1');
  assert.deepEqual((await readdir(directory)).sort(), ['metadata.json', 'result-1.png', 'result-2.png']);
  const text = await readFile(join(directory, 'metadata.json'), 'utf8');
  assert.equal(text.includes('signature='), false);
  assert.equal(text.includes(fake.base), false);
  const metadata = JSON.parse(text);
  assert.equal(metadata.data.url, 'result-1.png');
  assert.equal(metadata.data.nested[0].url, 'result-2.png');
  const usage = (await app.request('/api/usage', { cookie })).value;
  assert.equal(usage.liveTasks, 1);
  assert.equal(usage.estimatedUnits, 1);
  assert.equal((await readFile(join(f.dataDir, 'usage.jsonl'), 'utf8')).trim().split('\n').length, 1);
  await diskSafe(f.dataDir);
  const restarted = await f.start(), nextCookie = await login(restarted);
  assert.deepEqual((await restarted.request('/api/usage', { cookie: nextCookie })).value, usage);
});

test('in-process transport: mock hair and nail store placeholders without any fetch', async t => {
  const f = await fixture(t), app = f.app, cookie = await login(app), uploaded = await upload(app, cookie);
  for (const [feature, options] of [['hair-color', { colors: ['#112233', '#445566'], ombreLineOffset: 0 }], ['nail', OPTIONS]]) {
    const id = await submit(app, cookie, uploaded, feature, options), job = await completed(app, cookie, id);
    assert.equal(job.status, 'success');
    assert.deepEqual((await app.request(job.results[0].url, { cookie })).bytes, PNG);
  }
  assert.equal(f.outbound, 0);
  assert.equal((await app.request('/api/usage', { cookie })).value.liveTasks, 0);
});

test('in-process transport: failed, timed-out and hostile provider outcomes remain safe', async t => {
  for (const mode of ['error', 'running', 'post-error', 'secret-result']) {
    await t.test(mode, async t => {
      const fake = provider(mode), f = await fixture(t, { mode: 'live', fake, pollOptions: { timeoutMs: 60 } });
      const app = f.app, cookie = await login(app), started = Date.now();
      const id = await submit(app, cookie, await upload(app, cookie)), job = await completed(app, cookie, id);
      assert.equal(job.status, 'error');
      const usage = (await app.request('/api/usage', { cookie })).value;
      assert.equal(usage.liveTasks, 1);
      if (mode === 'error') { assert.equal(usage.failedTasks, 1); assert.equal(usage.estimatedUnits, 0); }
      if (mode === 'running') {
        assert.match(job.error, /timed out/);
        assert.equal(Date.now() - started < 1500, true);
        assert.equal(usage.unknownTasks, 1);
        assert.equal(usage.unknownEstimatedUnits, 1);
      }
      if (mode === 'post-error') { assert.equal(usage.unknownTasks, 1); assert.match(job.error, /HTTP 500/); }
      if (mode === 'secret-result') {
        assert.equal(usage.estimatedUnits, 1);
        const directory = join(f.dataDir, 'results', 'task-1');
        assert.deepEqual(await readdir(directory), ['metadata.json']);
        const metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
        assert.deepEqual(metadata.files, []);
        assert.equal(metadata.data.url, null);
        assert.equal(metadata.failures.length, 1);
      }
      await diskSafe(f.dataDir);
    });
  }
});

test('in-process transport: a failed result download does not strand another expiring result', async t => {
  const fake = provider('partial-error'), f = await fixture(t, { mode: 'live', fake });
  const app = f.app, cookie = await login(app), id = await submit(app, cookie, await upload(app, cookie));
  assert.equal((await completed(app, cookie, id)).status, 'error');
  assert.equal(fake.calls.some(call => call.path === '/broken'), true);
  assert.equal(fake.calls.some(call => call.path === '/second'), true);
  const directory = join(f.dataDir, 'results', 'task-1');
  assert.deepEqual(await readFile(join(directory, 'result-1.png')), PNG);
  const metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
  assert.equal(metadata.data.url, null);
  assert.equal(metadata.data.nested[0].url, 'result-1.png');
  assert.equal(metadata.failures.length, 1);
  await diskSafe(f.dataDir);
});

test('in-process transport: queue runs at most four tasks and accepts all seven', async t => {
  const fake = provider('hold'), f = await fixture(t, { mode: 'live', fake, pollOptions: { timeoutMs: 1500 } });
  const app = f.app, cookie = await login(app), uploadId = await upload(app, cookie);
  const ids = await Promise.all(Array.from({ length: 7 }, () => submit(app, cookie, uploadId)));
  await waitFor(() => fake.tasks.size === 4, 'Expected four active in-process provider tasks');
  const states = await Promise.all(ids.map(id => app.request(`/api/tasks/${id}`, { cookie })));
  assert.equal(states.filter(response => response.value.status === 'queued').length, 3);
  assert.equal(fake.maximumPending, 4);
  fake.state.release = true;
  const jobs = await Promise.all(ids.map(id => completed(app, cookie, id)));
  assert.equal(jobs.every(job => job.status === 'success'), true);
  assert.equal(fake.maximumPending, 4);
  assert.equal(fake.tasks.size, 7);
  const usage = (await app.request('/api/usage', { cookie })).value;
  assert.equal(usage.liveTasks, 7);
  assert.equal(usage.estimatedUnits, 7);
});
