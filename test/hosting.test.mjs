// Hosting behavior: retention sweep, RETENTION_HOURS validation, and the Secure cookie behind a TLS-terminating proxy.
// Mock mode only; the application directory is used as-is and DATA_DIR lives under os.tmpdir().
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { createApplication } = await import(pathToFileURL(join(ROOT, 'server.mjs')).href);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYU4AAAAASUVORK5CYII=', 'base64');
const OPTIONS = { colors: Object.fromEntries(['thumb', 'index', 'middle', 'ring', 'little'].map(finger => [finger, '#112233'])) };
const HOUR = 60 * 60 * 1000;

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

async function dispatch(server, path, { method = 'GET', headers = {}, body, json } = {}) {
  const payload = json === undefined ? body : JSON.stringify(json);
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(payload)]);
  req.method = method;
  req.url = path;
  req.headers = { host: '127.0.0.1:23456', ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
  req.socket = { encrypted: false };
  const res = new MemoryResponse();
  const finished = new Promise((done, reject) => { res.once('finish', done); res.once('error', reject); });
  server.emit('request', req, res);
  await finished;
  const bytes = Buffer.concat(res.chunks);
  let value = null;
  try { value = JSON.parse(bytes.toString()); } catch { /* not JSON */ }
  return { status: res.statusCode, headers: res.headers, value };
}

async function fixture(t, extraEnv = {}, options = {}) {
  const dataDir = join(await mkdtemp(join(tmpdir(), 'hosting-test-')), 'data');
  const env = { MODE: 'mock', APP_PASSCODE: 'passcode', SESSION_SECRET: 'hosting-secret', DATA_DIR: dataDir, ...extraEnv };
  const app = await createApplication(env, { fetchImpl: async () => { throw new Error('Mock mode must not fetch'); },
    pollOptions: { initialDelayMs: 5, maxDelayMs: 10, timeoutMs: 5000, ...options.pollOptions } });
  t.after(async () => {
    await app.close().catch(error => { if (error.code !== 'ERR_SERVER_NOT_RUNNING') throw error; });
    await rm(dirname(dataDir), { recursive: true, force: true });
  });
  const request = (path, init = {}) => dispatch(app.server, path, init);
  const login = async headers => request('/login', { method: 'POST', json: { passcode: 'passcode' }, headers });
  const cookieOf = response => response.headers.get('set-cookie').split(';')[0];
  return { app, dataDir, request, login, cookieOf };
}

async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function waitFor(check, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(done => setTimeout(done, 10)); }
  assert.fail(message);
}
async function upload(f, cookie) {
  const response = await f.request('/api/uploads', { method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: PNG });
  assert.equal(response.status, 201);
  return response.value.uploadId;
}
async function submit(f, cookie, uploadId) {
  const response = await f.request('/api/tasks', { method: 'POST', headers: { cookie }, json: { feature: 'nail', uploadId, options: OPTIONS } });
  assert.equal(response.status, 202);
  return response.value.id;
}
async function finished(f, cookie, id) {
  return waitFor(async () => {
    const response = await f.request(`/api/tasks/${id}`, { headers: { cookie } });
    return ['success', 'error'].includes(response.value?.status) && response.value;
  }, 'task did not reach a terminal state');
}

test('RETENTION_HOURS must be a positive number', async t => {
  const dataDir = join(await mkdtemp(join(tmpdir(), 'hosting-test-')), 'data');
  t.after(() => rm(dirname(dataDir), { recursive: true, force: true }));
  for (const value of ['0', '-1', 'abc', '', 'Infinity', 'NaN']) {
    await assert.rejects(createApplication({ MODE: 'mock', APP_PASSCODE: 'p', DATA_DIR: dataDir, RETENTION_HOURS: value }),
      /RETENTION_HOURS/, `RETENTION_HOURS=${JSON.stringify(value)} should be refused`);
  }
  assert.equal(await exists(dataDir), false, 'a refused start must not create DATA_DIR');
  const app = await createApplication({ MODE: 'mock', APP_PASSCODE: 'p', DATA_DIR: dataDir, RETENTION_HOURS: '0.5' });
  await app.close().catch(error => { if (error.code !== 'ERR_SERVER_NOT_RUNNING') throw error; });
});

test('sweep removes an expired upload (file and record) but not one inside the period', async t => {
  const f = await fixture(t, { RETENTION_HOURS: '2' });
  const cookie = f.cookieOf(await f.login());
  const uploadId = await upload(f, cookie);
  const photos = join(f.dataDir, 'photos');
  assert.equal((await readdir(photos)).length, 1);

  assert.deepEqual(await f.app.sweep(Date.now() + HOUR), { uploads: 0, jobs: 0, colorways: 0, files: 0 });
  assert.equal((await readdir(photos)).length, 1);
  const kept = await f.request('/api/tasks', { method: 'POST', headers: { cookie }, json: { feature: 'nail', uploadId, options: OPTIONS } });
  assert.equal(kept.status, 202, 'upload inside the period must stay usable');
  await finished(f, cookie, kept.value.id);

  const counts = await f.app.sweep(Date.now() + 3 * HOUR);
  assert.equal(counts.uploads, 1);
  assert.equal((await readdir(photos)).length, 0);
  const gone = await f.request('/api/tasks', { method: 'POST', headers: { cookie }, json: { feature: 'nail', uploadId, options: OPTIONS } });
  assert.equal(gone.status, 400, 'expired upload must be refused');
});

test('sweep removes an expired finished job, its result folder and its ColorWay; usage.jsonl stays', async t => {
  const f = await fixture(t, { RETENTION_HOURS: '1' });
  const cookie = f.cookieOf(await f.login());
  const uploadId = await upload(f, cookie);
  const taskId = await submit(f, cookie, uploadId);
  const job = await finished(f, cookie, taskId);
  assert.equal(job.status, 'success');
  const colorway = await f.request('/api/colorways', { method: 'POST', headers: { cookie }, json: { color: '#112233', surfaces: { nail: { uploadId } } } });
  assert.equal(colorway.status, 202);
  await finished(f, cookie, colorway.value.surfaces.nail.taskId);
  const resultsDir = join(f.dataDir, 'results');
  assert.equal((await readdir(resultsDir)).length, 2);
  await writeFile(join(f.dataDir, 'usage.jsonl'), '');
  const download = job.results[0].url;
  assert.equal((await f.request(download, { headers: { cookie } })).status, 200);

  assert.equal((await f.app.sweep(Date.now() + HOUR / 2)).jobs, 0);
  assert.equal((await readdir(resultsDir)).length, 2);

  const counts = await f.app.sweep(Date.now() + 2 * HOUR);
  assert.deepEqual(counts, { uploads: 1, jobs: 2, colorways: 1, files: 3 });
  assert.deepEqual(await readdir(resultsDir), []);
  assert.deepEqual(await readdir(join(f.dataDir, 'photos')), []);
  assert.equal(await exists(join(f.dataDir, 'usage.jsonl')), true);
  assert.equal((await f.request(`/api/tasks/${taskId}`, { headers: { cookie } })).status, 404);
  assert.equal((await f.request(download, { headers: { cookie } })).status, 404);
  assert.equal((await f.request(`/api/colorways/${colorway.value.id}`, { headers: { cookie } })).status, 404);
});

test('sweep keeps a running job and its upload, then removes them once the job has finished', async t => {
  const f = await fixture(t, { RETENTION_HOURS: '1' }, { pollOptions: { initialDelayMs: 800 } });
  const cookie = f.cookieOf(await f.login());
  const uploadId = await upload(f, cookie);
  const taskId = await submit(f, cookie, uploadId);
  const before = await f.request(`/api/tasks/${taskId}`, { headers: { cookie } });
  assert.ok(!['success', 'error'].includes(before.value.status), `job should still be running, was ${before.value.status}`);

  const counts = await f.app.sweep(Date.now() + 5 * HOUR);
  assert.deepEqual(counts, { uploads: 0, jobs: 0, colorways: 0, files: 0 });
  const during = await f.request(`/api/tasks/${taskId}`, { headers: { cookie } });
  assert.equal(during.status, 200);
  assert.ok(!['success', 'error'].includes(during.value.status), 'job must not have finished before the sweep check');
  const reuse = await f.request('/api/tasks', { method: 'POST', headers: { cookie }, json: { feature: 'nail', uploadId, options: OPTIONS } });
  assert.equal(reuse.status, 202, 'upload of a running job must stay usable');

  assert.equal((await finished(f, cookie, taskId)).status, 'success');
  await finished(f, cookie, reuse.value.id);
  const after = await f.app.sweep(Date.now() + 5 * HOUR);
  assert.deepEqual(after, { uploads: 1, jobs: 2, colorways: 0, files: 3 });
});

test('startup sweep removes old leftovers by mtime and keeps fresh ones', async t => {
  const dataDir = join(await mkdtemp(join(tmpdir(), 'hosting-test-')), 'data');
  t.after(() => rm(dirname(dataDir), { recursive: true, force: true }));
  const old = new Date(Date.now() - 48 * HOUR);
  await mkdir(join(dataDir, 'photos'), { recursive: true });
  await mkdir(join(dataDir, 'results', 'old-task'), { recursive: true });
  await mkdir(join(dataDir, 'results', 'new-task'), { recursive: true });
  await writeFile(join(dataDir, 'photos', 'old.png'), PNG);
  await writeFile(join(dataDir, 'photos', 'new.png'), PNG);
  await writeFile(join(dataDir, 'results', 'old-task', 'metadata.json'), '{}');
  await writeFile(join(dataDir, 'usage.jsonl'), '');
  await utimes(join(dataDir, 'photos', 'old.png'), old, old);
  await utimes(join(dataDir, 'results', 'old-task'), old, old);
  const app = await createApplication({ MODE: 'mock', APP_PASSCODE: 'p', DATA_DIR: dataDir, RETENTION_HOURS: '24' });
  t.after(() => app.close().catch(() => {}));
  assert.deepEqual(await readdir(join(dataDir, 'photos')), ['new.png']);
  assert.deepEqual(await readdir(join(dataDir, 'results')), ['new-task']);
  assert.equal(await exists(join(dataDir, 'usage.jsonl')), true);
});

test('login cookie gets Secure behind a trusted proxy only when x-forwarded-proto is https', async t => {
  const trusted = await fixture(t, { TRUST_PROXY: '1' });
  const secure = await trusted.login({ 'x-forwarded-proto': 'https' });
  assert.equal(secure.status, 200);
  assert.match(secure.headers.get('set-cookie'), /; Secure$/);
  const plain = await trusted.login({ 'x-forwarded-proto': 'http' });
  assert.doesNotMatch(plain.headers.get('set-cookie'), /Secure/);
  assert.doesNotMatch((await trusted.login()).headers.get('set-cookie'), /Secure/);

  const untrusted = await fixture(t, {});
  assert.doesNotMatch((await untrusted.login({ 'x-forwarded-proto': 'https' })).headers.get('set-cookie'), /Secure/);
  const wrongValue = await fixture(t, { TRUST_PROXY: 'true' });
  assert.doesNotMatch((await wrongValue.login({ 'x-forwarded-proto': 'https' })).headers.get('set-cookie'), /Secure/);
});
