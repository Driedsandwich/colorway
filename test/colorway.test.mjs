// ColorWay tests use the same in-process transport as inprocess.test.mjs: real request handlers, no sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KEY = 'colorway-test-key-never-exposed';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYU4AAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const PATHS = { nail: 'nail-vto', makeup: 'makeup-vto', 'hair-color': 'hair-color', 'clothes-v3': 'cloth-v3' };

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
  assert.equal(url.hostname, '127.0.0.1');
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

function provider({ failFeature } = {}) {
  const base = 'http://127.0.0.1:12345', files = [], tasks = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), path = new URL(req.url, base).pathname;
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const submitted = /^\/s2s\/v2\.0\/task\/([\w-]+)$/.exec(path), polled = /^\/s2s\/v2\.0\/task\/([\w-]+)\/([\w-]+)$/.exec(path);
    if (req.method === 'POST' && path === '/s2s/v2.0/file') {
      const id = `file-${files.length + 1}`;
      files.push(id);
      json(200, { status: 200, data: { files: [{ file_id: id, requests: [{ url: `${base}/upload`, method: 'PUT', headers: {} }] }] } });
    } else if (req.method === 'PUT' && path === '/upload') { res.writeHead(200); res.end(); }
    else if (req.method === 'POST' && submitted) {
      const id = `task-${tasks.size + 1}`;
      tasks.set(id, { path: submitted[1], body: JSON.parse(bytes), polls: 0 });
      json(200, { status: 200, data: { task_id: id } });
    } else if (req.method === 'GET' && polled) {
      const task = tasks.get(polled[2]);
      if (++task.polls < 2) json(200, { status: 200, data: { task_status: 'running' } });
      else if (failFeature && PATHS[failFeature] === task.path) json(200, { status: 200, data: { task_status: 'error', error: 'failed' } });
      else json(200, { status: 200, data: { task_status: 'success', results: { url: `${base}/img/${polled[2]}` } } });
    } else if (req.method === 'GET' && path.startsWith('/img/')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(PNG);
    } else json(500, { error: 'unexpected' });
  });
  return { base, files, tasks, fetch: (url, options) => dispatch(server, url, options) };
}

async function fixture(t, { mode = 'mock', fake } = {}) {
  const base = join(ROOT, '.test-work');
  await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(join(base, 'colorway-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const appDir = join(workspace, 'app'), dataDir = join(workspace, 'data');
  await mkdir(appDir);
  await Promise.all(['server.mjs', 'lib', 'public'].map(name => cp(join(ROOT, name), join(appDir, name), { recursive: true })));
  await Promise.all([rm(join(appDir, 'public', 'colorway.css'), { force: true }), rm(join(appDir, 'public', 'colorway.js'), { force: true }),
    writeFile(join(appDir, 'public', 'colorway.html'), '<p>stub</p>'), writeFile(join(appDir, 'public', 'color.mjs'), 'export {};')]);
  const { createApplication } = await import(pathToFileURL(join(appDir, 'server.mjs')).href);
  let outbound = 0;
  const app = await createApplication({ MODE: mode, APP_PASSCODE: 'passcode', SESSION_SECRET: 'colorway-secret', DATA_DIR: dataDir,
    YOUCAM_API_KEY: KEY, YOUCAM_BASE_URL: fake?.base ?? 'http://127.0.0.1:12345' }, {
    fetchImpl: async (url, options) => { outbound++; if (!fake) throw new Error('Mock mode must not perform outbound requests'); return fake.fetch(url, options); },
    pollOptions: { initialDelayMs: 5, maxDelayMs: 10, timeoutMs: 1000 } });
  t.after(() => app.close().catch(() => {}));
  async function request(path, { cookie, json, ...options } = {}) {
    const response = await dispatch(app.server, `http://127.0.0.1:23456${path}`, {
      ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      ...(json ? { body: JSON.stringify(json) } : {}) });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.includes(Buffer.from(KEY)), false);
    return { status: response.status, headers: response.headers, bytes, value: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString()) : null };
  }
  const login = await request('/login', { method: 'POST', json: { passcode: 'passcode' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const upload = async () => (await request('/api/uploads', { method: 'POST', cookie, headers: { 'Content-Type': 'image/png' }, body: PNG })).value.uploadId;
  const create = json => request('/api/colorways', { method: 'POST', cookie, json });
  const finished = async id => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { value } = await request(`/api/colorways/${id}`, { cookie });
      if (value.status !== 'running') return value;
      await delay(5);
    }
    assert.fail('ColorWay did not finish');
  };
  return { request, cookie, upload, create, finished, dataDir, get outbound() { return outbound; } };
}

async function everything(f, color = '#C8102E') {
  const [nail, lip, hair, body, garment] = await Promise.all([f.upload(), f.upload(), f.upload(), f.upload(), f.upload()]);
  return f.create({ color, surfaces: { nail: { uploadId: nail }, lip: { uploadId: lip }, hair: { uploadId: hair },
    outfit: { uploadId: body, garmentUploadId: garment } } });
}

test('colorway: mock mode runs all four surfaces and serves results without any outbound request', async t => {
  const f = await fixture(t), created = await everything(f);
  assert.equal(created.status, 202);
  assert.deepEqual(Object.keys(created.value.surfaces).sort(), ['hair', 'lip', 'nail', 'outfit']);
  assert.equal(created.value.color, '#C8102E');
  assert.equal(Object.values(created.value.surfaces).every(surface => typeof surface.taskId === 'string' && surface.status), true);
  const view = await f.finished(created.value.id);
  assert.equal(view.status, 'success');
  assert.equal(view.estimatedUnits, 5);
  assert.equal(typeof view.createdAt, 'string');
  assert.deepEqual(Object.fromEntries(Object.entries(view.surfaces).map(([name, surface]) => [name, surface.feature])),
    { nail: 'nail', lip: 'makeup', hair: 'hair-color', outfit: 'clothes-v3' });
  for (const surface of Object.values(view.surfaces)) {
    assert.equal(surface.status, 'success');
    assert.equal(surface.color, '#C8102E');
    assert.equal(surface.results.length, 1);
    assert.equal(surface.results[0].contentType, 'image/png');
    assert.match(surface.results[0].url, /^\/api\/results\/[\w-]+\/result-1\.png$/);
    assert.deepEqual((await f.request(surface.results[0].url, { cookie: f.cookie })).bytes, PNG);
    assert.equal((await f.request(`/api/tasks/${surface.taskId}`, { cookie: f.cookie })).value.status, 'success');
  }
  assert.equal(f.outbound, 0);
});

test('colorway: a subset works and estimatedUnits sums the requested features', async t => {
  const f = await fixture(t), [photo, garment] = [await f.upload(), await f.upload()];
  const created = await f.create({ color: '#00ff00', surfaces: { lip: { uploadId: photo }, outfit: { uploadId: photo, garmentUploadId: garment } } });
  assert.equal(created.status, 202);
  const view = await f.finished(created.value.id);
  assert.deepEqual(Object.keys(view.surfaces).sort(), ['lip', 'outfit']);
  assert.equal(view.estimatedUnits, 3);
  assert.equal(view.status, 'success');
});

test('colorway: live requests use the verified option shapes and outfit uploads two files', async t => {
  const fake = provider(), f = await fixture(t, { mode: 'live', fake });
  const [nail, lip, hair, body, garment] = [await f.upload(), await f.upload(), await f.upload(), await f.upload(), await f.upload()];
  const created = await f.create({ color: '#C8102E', surfaces: { nail: { uploadId: nail, color: '#112233' }, lip: { uploadId: lip },
    hair: { uploadId: hair }, outfit: { uploadId: body, garmentUploadId: garment } } });
  assert.equal(created.status, 202);
  const view = await f.finished(created.value.id);
  assert.equal(view.status, 'success');
  assert.equal(fake.files.length, 5);
  const bodies = Object.fromEntries([...fake.tasks.values()].map(task => [task.path, task.body]));
  assert.deepEqual(Object.keys(bodies).sort(), ['cloth-v3', 'hair-color', 'makeup-vto', 'nail-vto']);
  assert.equal(bodies['nail-vto'].effects.length, 5);
  assert.equal(bodies['nail-vto'].effects.every(effect => effect.color === '#112233'), true);
  assert.equal(bodies['makeup-vto'].effects[0].palettes[0].color, '#C8102E');
  assert.deepEqual(bodies['hair-color'].palettes.map(palette => palette.color), ['#3B2416', '#C8102E']);
  assert.equal(bodies['hair-color'].pattern.line_offset, 0.2);
  assert.equal(bodies['hair-color'].pattern.blend_strength, 50);
  const cloth = bodies['cloth-v3'];
  assert.match(cloth.src_file_id, /^file-\d+$/);
  assert.match(cloth.ref_file_id, /^file-\d+$/);
  assert.notEqual(cloth.src_file_id, cloth.ref_file_id);
  assert.equal(cloth.garment_category, 'upper_body');
  assert.equal(view.surfaces.nail.color, '#112233');
  assert.equal(view.surfaces.lip.color, '#C8102E');
  for (const surface of Object.values(view.surfaces)) {
    assert.equal(surface.results[0].name, 'result-1.png');
    assert.equal(surface.results[0].contentType, 'image/png');
  }
  assert.equal((await f.request('/api/usage', { cookie: f.cookie })).value.estimatedUnits, 5);
});

test('colorway: status is partial when one surface fails and error when all fail', async t => {
  const fake = provider({ failFeature: 'hair-color' }), f = await fixture(t, { mode: 'live', fake });
  const created = await everything(f), view = await f.finished(created.value.id);
  assert.equal(view.status, 'partial');
  assert.equal(view.surfaces.hair.status, 'error');
  assert.equal(typeof view.surfaces.hair.error, 'string');
  assert.deepEqual(view.surfaces.hair.results, []);
  assert.equal(view.surfaces.nail.status, 'success');
  const only = await f.create({ color: '#C8102E', surfaces: { hair: { uploadId: await f.upload() } } });
  assert.equal((await f.finished(only.value.id)).status, 'error');
});

test('colorway: validation errors, unknown ids and the login gate', async t => {
  const f = await fixture(t), photo = await f.upload(), garment = await f.upload();
  const bad = [
    { color: 'red', surfaces: { nail: { uploadId: photo } } },
    { color: '#12345', surfaces: { nail: { uploadId: photo } } },
    { surfaces: { nail: { uploadId: photo } } },
    { color: '#C8102E', surfaces: { nail: { uploadId: photo, color: 'blue' } } },
    { color: '#C8102E', surfaces: { shoes: { uploadId: photo } } },
    { color: '#C8102E', surfaces: { __proto__: null, constructor: { uploadId: photo } } },
    { color: '#C8102E', surfaces: {} },
    { color: '#C8102E', surfaces: [] },
    { color: '#C8102E' },
    { color: '#C8102E', surfaces: { nail: { uploadId: 'missing' } } },
    { color: '#C8102E', surfaces: { nail: {} } },
    { color: '#C8102E', surfaces: { nail: photo } },
    { color: '#C8102E', surfaces: { nail: { uploadId: photo }, lip: { uploadId: 'missing' } } },
    { color: '#C8102E', surfaces: { outfit: { uploadId: photo } } },
    { color: '#C8102E', surfaces: { outfit: { uploadId: photo, garmentUploadId: 'missing' } } },
    { color: '#C8102E', surfaces: { outfit: { garmentUploadId: garment } } },
  ];
  for (const json of bad) assert.equal((await f.create(json)).status, 400, JSON.stringify(json));
  assert.equal((await f.request('/api/colorways/unknown', { cookie: f.cookie })).status, 404);
  assert.equal((await f.request('/api/colorways', { method: 'POST', cookie: f.cookie, headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await f.request('/api/colorways', { method: 'POST', json: { color: '#C8102E', surfaces: { nail: { uploadId: photo } } } })).status, 401);
  assert.equal((await f.request('/api/colorways/unknown')).status, 401);
  const crossSite = await f.request('/api/colorways', { method: 'POST', cookie: f.cookie, headers: { Origin: 'https://evil.example' },
    json: { color: '#C8102E', surfaces: { nail: { uploadId: photo } } } });
  assert.equal(crossSite.status, 403);
});

test('colorway: static front-end routes are gated, typed, and 404 when a file is missing', async t => {
  const f = await fixture(t);
  const anonymous = await f.request('/colorway');
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get('location'), '/');
  const page = await f.request('/colorway', { cookie: f.cookie });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const module = await f.request('/color.mjs');
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /^text\/javascript/);
  assert.equal((await f.request('/colorway.css')).status, 404);
  assert.equal((await f.request('/colorway.js')).status, 404);
});

test('saveResults names files by magic bytes even when the provider says octet-stream', async t => {
  const { createYouCamClient } = await import(pathToFileURL(join(ROOT, 'lib', 'youcam.mjs')).href);
  await mkdir(join(ROOT, '.test-work'), { recursive: true });
  const dataDir = await mkdtemp(join(ROOT, '.test-work', 'magic-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const bodies = { '/png': [PNG, 'application/octet-stream'], '/jpg': [JPEG, 'application/octet-stream'], '/webp': [WEBP, 'binary/octet-stream'],
    '/typed': [PNG, 'image/png'], '/text': [Buffer.from('not an image'), 'application/octet-stream'] };
  const client = createYouCamClient({ mode: 'live', apiKey: KEY, baseUrl: 'http://127.0.0.1:12345', dataDir,
    fetchImpl: async url => { const [bytes, type] = bodies[new URL(url).pathname]; return new Response(bytes, { headers: { 'Content-Type': type } }); } });
  const urls = Object.keys(bodies).map(path => `http://127.0.0.1:12345${path}`);
  const saved = await client.saveResults('magic-task', { urls });
  assert.deepEqual(saved.files.map(file => [file.name, file.contentType]), [
    ['result-1.png', 'image/png'], ['result-2.jpg', 'image/jpeg'], ['result-3.webp', 'image/webp'],
    ['result-4.png', 'image/png'], ['result-5.bin', 'application/octet-stream']]);
  assert.deepEqual(await readFile(join(saved.directory, 'result-2.jpg')), JPEG);
  assert.deepEqual((await readdir(saved.directory)).sort(), ['metadata.json', 'result-1.png', 'result-2.jpg', 'result-3.webp', 'result-4.png', 'result-5.bin']);
});
