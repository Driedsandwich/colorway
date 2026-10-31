import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { FEATURES, getFeature, publicFeatures } from '../lib/features.mjs';
import { redact } from '../lib/youcam.mjs';

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const KEY = 'test-only-key-that-must-never-leak';
const PASSCODE = 'test-only-passcode';
const SECRET = 'test-only-session-secret';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYU4AAAAASUVORK5CYII=', 'base64');
const NAIL_OPTIONS = { colors: Object.fromEntries(['thumb', 'index', 'middle', 'ring', 'little'].map(finger => [finger, '#aa3344'])) };

async function listen(server) {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function bytes(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function fakeYouCam(t, mode = 'success') {
  const calls = [], tasks = new Map();
  let base, uploadCount = 0, pending = 0, maximumPending = 0;
  const state = { release: false };
  const server = http.createServer(async (req, res) => {
    const input = await bytes(req);
    const url = new URL(req.url, base);
    const call = { method: req.method, path: url.pathname, headers: req.headers, bytes: input };
    calls.push(call);
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'POST' && url.pathname === '/s2s/v2.0/file') {
      call.body = JSON.parse(input);
      json(200, { status: 200, data: { files: [{ file_id: `file-${++uploadCount}`, requests: [{
        url: `${base}/upload`, method: 'PUT', headers: { 'Content-Type': 'image/png', 'X-Signed-Upload': 'signed-upload-only' },
      }] }] } });
    } else if (req.method === 'PUT' && url.pathname === '/upload') {
      res.writeHead(200); res.end();
    } else if (req.method === 'POST' && url.pathname === '/s2s/v2.0/task/nail-vto') {
      call.body = JSON.parse(input);
      if (mode === 'post-error') {
        json(500, { error: `Authorization: Bearer ${KEY}`, Authorization: `Bearer ${KEY}` }); return;
      }
      const id = `fake-task-${tasks.size + 1}`;
      tasks.set(id, { polls: 0, finished: false });
      maximumPending = Math.max(maximumPending, ++pending);
      json(200, { status: 200, data: { task_id: id } });
    } else if (req.method === 'GET' && url.pathname.startsWith('/s2s/v2.0/task/nail-vto/')) {
      const id = url.pathname.split('/').at(-1), task = tasks.get(id);
      if (!task) { json(404, { error: 'Missing fake task' }); return; }
      task.polls++;
      const running = mode === 'running' || (mode === 'hold' ? !state.release : task.polls < 2);
      if (running) { json(200, { status: 200, data: { task_status: 'running' } }); return; }
      if (!task.finished) { task.finished = true; pending--; }
      json(200, { status: 200, data: mode === 'error' ? { task_status: 'error', error: `Bearer ${KEY}` } : {
        task_status: 'success', results: mode === 'secret-result'
          ? { url: `${base}/secret-result` }
          : { url: `${base}/result/first.png?signature=temporary-one`, variants: [{ url: `${base}/result/second.png?signature=temporary-two` }] },
      } });
    } else if (req.method === 'GET' && url.pathname.startsWith('/result/')) {
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG);
    } else if (req.method === 'GET' && url.pathname === '/secret-result') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(`Authorization: Bearer ${KEY}`);
    } else json(404, { error: 'Unexpected fake route' });
  });
  base = await listen(server);
  t.after(async () => {
    server.closeIdleConnections();
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  });
  return { base, calls, tasks, state, get maximumPending() { return maximumPending; } };
}

async function fixture(t) {
  const logs = [], original = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    original[method] = console[method];
    console[method] = (...values) => logs.push(values.map(String).join(' '));
  }
  t.after(() => {
    for (const [method, fn] of Object.entries(original)) console[method] = fn;
    assert.equal(logs.join('\n').includes(KEY), false, 'API key appeared in application console output');
  });
  // DATA_DIR is outside the executing app copy; every fixture write stays in cwd.
  const parent = join(PROJECT, '.test-work');
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, 'case-'));
  const appDir = join(workspace, 'app'), dataDir = join(workspace, 'data');
  await mkdir(appDir);
  await Promise.all(['server.mjs', 'lib', 'public'].map(name => cp(join(PROJECT, name), join(appDir, name), { recursive: true })));
  const { createApplication } = await import(pathToFileURL(join(appDir, 'server.mjs')).href);
  const applications = [], output = [];
  t.after(async () => {
    for (const app of applications.reverse()) if (app.server.listening) await app.close();
    await rm(workspace, { recursive: true, force: true });
  });
  const env = { MODE: 'mock', APP_PASSCODE: PASSCODE, SESSION_SECRET: SECRET, DATA_DIR: dataDir };
  async function start(overrides = {}, dependencies = {}) {
    const app = await createApplication({ ...env, ...overrides }, { pollOptions: { initialDelayMs: 5, maxDelayMs: 20, timeoutMs: 500 }, ...dependencies });
    applications.push(app);
    const base = await listen(app.server);
    async function request(path, { cookie, json, ...options } = {}) {
      const response = await fetch(`${base}${path}`, {
        ...options,
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
        ...(json ? { body: JSON.stringify(json) } : {}),
      });
      const body = Buffer.from(await response.arrayBuffer());
      output.push(body);
      assert.equal(body.includes(Buffer.from(KEY)), false, 'API key appeared in an app response');
      return { status: response.status, headers: response.headers, bytes: body, text: body.toString(),
        value: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(body.toString()) : null };
    }
    return { ...app, request, base };
  }
  return { workspace, appDir, dataDir, env, createApplication, start, output };
}

async function login(app) {
  const result = await app.request('/login', { method: 'POST', json: { passcode: PASSCODE } });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('set-cookie'), /HttpOnly/);
  assert.match(result.headers.get('set-cookie'), /SameSite=Lax/);
  return result.headers.get('set-cookie').split(';')[0];
}

async function upload(app, cookie) {
  const result = await app.request('/api/uploads', { method: 'POST', cookie, headers: { 'Content-Type': 'image/png' }, body: PNG });
  assert.equal(result.status, 201);
  return result.value.uploadId;
}

async function submit(app, cookie, uploadId, feature = 'nail', options = NAIL_OPTIONS) {
  const result = await app.request('/api/tasks', { method: 'POST', cookie, json: { feature, uploadId, options } });
  assert.equal(result.status, 202);
  return result.value.id;
}

async function waitFor(check, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(5); }
  assert.fail(message);
}

async function completed(app, cookie, id) {
  return waitFor(async () => {
    const result = await app.request(`/api/tasks/${id}`, { cookie });
    assert.equal(result.status, 200);
    return ['success', 'error'].includes(result.value.status) && result.value;
  }, 'Task did not finish within the local test deadline');
}

async function usageLines(dataDir) {
  return (await readFile(join(dataDir, 'usage.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function assertDiskSafe(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertDiskSafe(path);
    else assert.equal((await readFile(path)).includes(Buffer.from(KEY)), false, 'API key appeared in stored data or log');
  }
}

function localFetch(url, options) {
  assert.equal(new URL(url).hostname, '127.0.0.1', 'Only localhost requests are permitted in tests');
  return fetch(url, options);
}

test('feature builders and verification metadata preserve the documented constraints', () => {
  assert.equal(publicFeatures().length, 15);
  assert.throws(() => getFeature('__proto__'), /Unknown feature/);
  const hair = FEATURES['hair-color'].buildRequest('photo', { colors: ['#112233', '#445566'], ombreLineOffset: 0.25 });
  assert.equal(hair.pattern.name, 'ombre');
  assert.equal(hair.pattern.line_offset, 0.25);
  assert.deepEqual(hair.palettes.map(item => item.color), ['#112233', '#445566']);
  assert.throws(() => FEATURES['hair-color'].buildRequest('photo', { colors: ['#112233', '#445566'], ombreLineOffset: 1 }), /ombreLineOffset/);
  const nail = FEATURES.nail.buildRequest('photo', NAIL_OPTIONS);
  assert.equal(nail.src_file_id, 'photo');
  assert.deepEqual(nail.effects.map(effect => effect.finger), ['thumb', 'index', 'middle', 'ring', 'pinky']);
  assert.equal(nail.version, '1.0');
  assert.throws(() => FEATURES.nail.buildRequest('photo', { colors: {} }), /#RRGGBB/);
  assert.equal(FEATURES.nail.verification.estimatedUnits.verified, true);
  assert.equal(FEATURES['hair-color'].filePath, '/s2s/v2.0/file');
  assert.equal(FEATURES['hair-color'].liveSupported, true);
  assert.equal(FEATURES['clothes-v4'].estimatedUnits, null);
  assert.equal(FEATURES['clothes-v4'].verification.estimatedUnits.verified, false);
  assert.deepEqual(redact({ Authorization: `Bearer ${KEY}`, nested: { authorization: KEY }, text: KEY }, KEY), {
    Authorization: '[REDACTED]', nested: { authorization: '[REDACTED]' }, text: '[REDACTED]',
  });
});

test('configuration requires passcode, live key and an external DATA_DIR, including symlink resolution', async t => {
  const f = await fixture(t);
  await assert.rejects(f.createApplication({ ...f.env, APP_PASSCODE: '' }), /APP_PASSCODE/);
  await assert.rejects(f.createApplication({ ...f.env, DATA_DIR: '' }), /DATA_DIR/);
  await assert.rejects(f.createApplication({ ...f.env, DATA_DIR: 'relative-data' }), /absolute path/);
  await assert.rejects(f.createApplication({ ...f.env, DATA_DIR: join(f.appDir, 'data') }), /outside the project/);
  await assert.rejects(f.createApplication({ ...f.env, DATA_DIR: join(f.appDir, '..hidden') }), /outside the project/);
  const link = join(f.workspace, 'link-into-project');
  await symlink(join(f.appDir, 'public'), link);
  await assert.rejects(f.createApplication({ ...f.env, DATA_DIR: join(link, 'new-data') }), /outside the project/);
  await assert.rejects(f.createApplication({ ...f.env, MODE: 'live' }), /YOUCAM_API_KEY/);
});

test('every API route is gated; signed sessions reject tampering and expiry', async t => {
  const f = await fixture(t), app = await f.start();
  for (const path of ['/api/features', '/api/usage', '/api/tasks/missing', '/api/results/missing/file.png']) {
    assert.equal((await app.request(path)).status, 401);
  }
  assert.equal((await app.request('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG })).status, 401);
  assert.equal((await app.request('/api/tasks', { method: 'POST', json: {} })).status, 401);
  assert.equal((await app.request('/login', { method: 'POST', json: { passcode: 'incorrect' } })).status, 401);
  const cookie = await login(app);
  assert.equal((await app.request('/api/features', { cookie })).status, 200);
  assert.equal((await app.request('/api/features', { cookie: `${cookie}tampered` })).status, 401);
  const expired = Buffer.from(JSON.stringify({ exp: Date.now() - 1000 })).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(expired).digest('base64url');
  assert.equal((await app.request('/api/features', { cookie: `youcam_session=${expired}.${signature}` })).status, 401);
});

test('live nail flow sends Bearer only to API, saves all results immediately and reloads usage', async t => {
  const fake = await fakeYouCam(t), f = await fixture(t);
  const app = await f.start({ MODE: 'live', YOUCAM_API_KEY: KEY, YOUCAM_BASE_URL: fake.base }, { fetchImpl: localFetch });
  const cookie = await login(app), uploadId = await upload(app, cookie);
  const id = await submit(app, cookie, uploadId), job = await completed(app, cookie, id);
  assert.equal(job.status, 'success');
  assert.equal(job.results.length, 3, 'Two downloads and metadata must be exposed through authenticated routes');
  const task = fake.calls.find(call => call.method === 'POST' && call.path.includes('/task/'));
  assert.deepEqual(task.body, FEATURES.nail.buildRequest('file-1', NAIL_OPTIONS));
  const apiCalls = fake.calls.filter(call => call.path.startsWith('/s2s/'));
  assert.equal(apiCalls.length >= 4, true);
  for (const call of apiCalls) assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  const put = fake.calls.find(call => call.method === 'PUT');
  assert.equal(put.headers.authorization, undefined);
  assert.equal(put.headers['x-signed-upload'], 'signed-upload-only');
  assert.equal(put.headers['content-type'], 'image/png');
  assert.deepEqual(put.bytes, PNG);
  const prepare = fake.calls.find(call => call.path === '/s2s/v2.0/file');
  assert.deepEqual(Object.keys(prepare.body), ['files']);
  assert.equal(prepare.body.files[0].file_size, PNG.length);
  assert.equal(prepare.body.files[0].content_type, 'image/png');
  const downloads = fake.calls.filter(call => call.path.startsWith('/result/'));
  assert.equal(downloads.length, 2);
  for (const call of downloads) assert.equal(call.headers.authorization, undefined);
  const directory = join(f.dataDir, 'results', 'fake-task-1');
  assert.deepEqual((await readdir(directory)).sort(), ['metadata.json', 'result-1.png', 'result-2.png']);
  for (const name of ['result-1.png', 'result-2.png']) assert.deepEqual(await readFile(join(directory, name)), PNG);
  const metadata = await readFile(join(directory, 'metadata.json'), 'utf8');
  assert.equal(metadata.includes(fake.base), false);
  assert.equal(metadata.includes('signature='), false);
  const data = JSON.parse(metadata);
  assert.equal(data.data.url, 'result-1.png');
  assert.equal(data.data.variants[0].url, 'result-2.png');
  for (const result of job.results) {
    assert.equal(result.url.startsWith('/api/results/'), true);
    assert.equal((await app.request(result.url)).status, 401);
    assert.equal((await app.request(result.url, { cookie })).status, 200);
  }
  const usage = (await app.request('/api/usage', { cookie })).value;
  assert.equal(usage.liveTasks, 1);
  assert.equal(usage.successfulTasks, 1);
  assert.equal(usage.estimatedUnits, 1);
  const lines = await usageLines(f.dataDir);
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['estimatedUnits', 'feature', 'status', 'time']);
  assert.equal(lines[0].status, 'success');
  assert.equal(Number.isNaN(Date.parse(lines[0].time)), false);
  await assertDiskSafe(f.dataDir);
  await app.close();
  const restarted = await f.start({ MODE: 'live', YOUCAM_API_KEY: KEY, YOUCAM_BASE_URL: fake.base }, { fetchImpl: localFetch });
  const restartedCookie = await login(restarted);
  assert.deepEqual((await restarted.request('/api/usage', { cookie: restartedCookie })).value, usage);
});

test('mock hair and nail tasks use zero outbound requests and store the uploaded placeholder', async t => {
  const f = await fixture(t);
  let outbound = 0;
  const app = await f.start({}, { fetchImpl: async () => { outbound++; throw new Error('Mock must never fetch'); } });
  const cookie = await login(app), uploadId = await upload(app, cookie);
  for (const [feature, options] of [['hair-color', { colors: ['#112233', '#445566'], ombreLineOffset: 0 }], ['nail', NAIL_OPTIONS]]) {
    const id = await submit(app, cookie, uploadId, feature, options), job = await completed(app, cookie, id);
    assert.equal(job.status, 'success');
    assert.deepEqual((await app.request(job.results[0].url, { cookie })).bytes, PNG);
  }
  assert.equal(outbound, 0);
  assert.equal((await app.request('/api/usage', { cookie })).value.liveTasks, 0);
  await assert.rejects(readFile(join(f.dataDir, 'usage.jsonl')), { code: 'ENOENT' });
});

test('explicit provider failures log one task and consume no estimated units', async t => {
  const fake = await fakeYouCam(t, 'error'), f = await fixture(t);
  const app = await f.start({ MODE: 'live', YOUCAM_API_KEY: KEY, YOUCAM_BASE_URL: fake.base }, { fetchImpl: localFetch });
  const cookie = await login(app), id = await submit(app, cookie, await upload(app, cookie));
  const job = await completed(app, cookie, id);
  assert.equal(job.status, 'error');
  assert.match(job.error, /no units consumed/);
  const usage = (await app.request('/api/usage', { cookie })).value;
  assert.equal(usage.failedTasks, 1);
  assert.equal(usage.estimatedUnits, 0);
  assert.equal(usage.unknownEstimatedUnits, 0);
  assert.equal((await usageLines(f.dataDir)).length, 1);
  assert.equal((await usageLines(f.dataDir))[0].status, 'error');
  await assertDiskSafe(f.dataDir);
});

test('polling timeout is bounded and records unknown provider consumption', async t => {
  const fake = await fakeYouCam(t, 'running'), f = await fixture(t);
  const app = await f.start({ MODE: 'live', YOUCAM_API_KEY: KEY, YOUCAM_BASE_URL: fake.base }, {
    fetchImpl: localFetch, pollOptions: { initialDelayMs: 5, maxDelayMs: 10, timeoutMs: 60 },
  });
  const cookie = await login(app), started = Date.now();
  const id = await submit(app, cookie, await upload(app, cookie)), job = await completed(app, cookie, id);
  assert.equal(job.status, 'error');
  assert.match(job.error, /timed out.*unknown/);
  assert.equal(Date.now() - started < 1500, true);
  const usage = (await app.request('/api/usage', { cookie })).value;
  assert.equal(usage.unknownTasks, 1);
  assert.equal(usage.estimatedUnits, 0);
  assert.equal(usage.unknownEstimatedUnits, 1);
  assert.equal((await usageLines(f.dataDir))[0].status, 'unknown');
});

test('hostile upstream errors and downloaded credential echoes never reach app responses or disk', async t => {
  for (const mode of ['post-error', 'secret-result']) {
    await t.test(mode, async t => {
      const fake = await fakeYouCam(t, mode), f = await fixture(t);
      const app = await f.start({ MODE: 'live', YOUCAM_API_KEY: KEY, YOUCAM_BASE_URL: fake.base }, { fetchImpl: localFetch });
      const cookie = await login(app), id = await submit(app, cookie, await upload(app, cookie)), job = await completed(app, cookie, id);
      assert.equal(job.status, 'error');
      assert.equal(JSON.stringify(job).includes(KEY), false);
      assert.equal(JSON.stringify(job).includes('Authorization:'), false);
      if (mode === 'secret-result') {
        assert.match(job.error, /safely stored/);
        const directory = join(f.dataDir, 'results', 'fake-task-1');
        assert.deepEqual(await readdir(directory), ['metadata.json']);
        const metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
        assert.deepEqual(metadata.files, []);
        assert.equal(metadata.data.url, null);
        assert.equal(metadata.failures.length, 1);
      }
      const lines = await usageLines(f.dataDir);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].status, mode === 'secret-result' ? 'success' : 'unknown');
      await assertDiskSafe(f.dataDir);
    });
  }
});

test('seven tasks wait behind the four-task queue and all run without a usage cap', async t => {
  const fake = await fakeYouCam(t, 'hold'), f = await fixture(t);
  const app = await f.start({ MODE: 'live', YOUCAM_API_KEY: KEY, YOUCAM_BASE_URL: fake.base }, {
    fetchImpl: localFetch, pollOptions: { initialDelayMs: 5, maxDelayMs: 10, timeoutMs: 1500 },
  });
  const cookie = await login(app), uploadId = await upload(app, cookie);
  const ids = await Promise.all(Array.from({ length: 7 }, () => submit(app, cookie, uploadId)));
  await waitFor(() => fake.tasks.size === 4, 'Expected four provider tasks to be active');
  const waiting = await Promise.all(ids.map(id => app.request(`/api/tasks/${id}`, { cookie })));
  assert.equal(waiting.filter(result => result.value.status === 'queued').length, 3);
  assert.equal(fake.maximumPending, 4);
  fake.state.release = true;
  const jobs = await Promise.all(ids.map(id => completed(app, cookie, id)));
  assert.equal(jobs.every(job => job.status === 'success'), true);
  assert.equal(fake.tasks.size, 7);
  assert.equal(fake.maximumPending, 4);
  const usage = (await app.request('/api/usage', { cookie })).value;
  assert.equal(usage.liveTasks, 7);
  assert.equal(usage.estimatedUnits, 7);
  assert.equal((await usageLines(f.dataDir)).length, 7);
});
