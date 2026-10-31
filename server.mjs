import http from 'node:http';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, realpath, readFile, writeFile, appendFile, readdir, lstat, unlink, rm } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FEATURES, getFeature, publicFeatures } from './lib/features.mjs';
import { planColorway, newColorway, colorwayView, colorwayCreated } from './lib/colorway.mjs';
import { createYouCamClient, MAX_IMAGE_BYTES, YouCamError } from './lib/youcam.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const COOKIE = 'youcam_session';
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png' };
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function fail(status, message) { return Object.assign(new Error(message), { status }); }
function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function same(a, b) {
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

async function body(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fail(413, 'Request exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw fail(415, 'Use application/json.');
  try {
    const value = JSON.parse((await body(req, 16_384)).toString());
    if (!value || Array.isArray(value) || typeof value !== 'object') throw fail(400, 'Use a JSON object.');
    return value;
  } catch (error) { if (error.status) throw error; throw fail(400, 'Invalid JSON.'); }
}

function imageMatches(bytes, type) {
  return type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export async function createApplication(env = process.env, { fetchImpl, pollOptions } = {}) {
  const mode = env.MODE ?? 'mock';
  if (!['mock', 'live'].includes(mode)) throw new Error('MODE must be mock or live.');
  if (!env.APP_PASSCODE) throw new Error('APP_PASSCODE is required.');
  const retentionHours = Number(env.RETENTION_HOURS ?? 24);
  if (!Number.isFinite(retentionHours) || retentionHours <= 0) throw new Error('RETENTION_HOURS must be a positive number.');
  const retentionMs = retentionHours * 60 * 60 * 1000;
  const trustProxy = env.TRUST_PROXY === '1';
  if (!env.DATA_DIR || !isAbsolute(env.DATA_DIR)) throw new Error('DATA_DIR must be an absolute path outside the project.');
  const root = await realpath(ROOT);
  const requested = resolve(env.DATA_DIR);
  if (within(root, requested)) throw new Error('DATA_DIR must be outside the project.');
  // Resolve the nearest existing ancestor before mkdir, including symlinks.
  let ancestor = requested;
  const suffix = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('DATA_DIR cannot be resolved.');
      suffix.unshift(ancestor.slice(dirname(ancestor).length + 1));
      ancestor = dirname(ancestor);
    }
  }
  if (within(root, resolve(ancestor, ...suffix))) throw new Error('DATA_DIR must be outside the project.');
  const client = createYouCamClient({ mode, apiKey: env.YOUCAM_API_KEY, baseUrl: env.YOUCAM_BASE_URL,
    dataDir: requested, fetchImpl, pollOptions });
  await mkdir(join(requested, 'photos'), { recursive: true, mode: 0o700 });
  const dataDir = await realpath(requested);
  const photosDir = join(dataDir, 'photos'), resultsDir = join(dataDir, 'results');
  const secret = env.SESSION_SECRET || randomBytes(32).toString('hex');
  const uploads = new Map(), jobs = new Map(), colorways = new Map(), waiting = [], active = new Set();
  const usagePath = join(dataDir, 'usage.jsonl');
  const usage = [];
  try {
    for (const line of (await readFile(usagePath, 'utf8')).split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      if (!entry || !Object.hasOwn(FEATURES, entry.feature) || !['success', 'error', 'unknown'].includes(entry.status)
        || (entry.estimatedUnits !== null && (typeof entry.estimatedUnits !== 'number' || !Number.isFinite(entry.estimatedUnits) || entry.estimatedUnits < 0))) {
        throw new Error('Invalid usage record.');
      }
      usage.push(entry);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Unable to read usage.jsonl.'); }

  const sign = text => createHmac('sha256', secret).update(text).digest('base64url');
  function authenticated(req) {
    const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`));
    const [payload, signature, extra] = (cookie?.slice(COOKIE.length + 1) ?? '').split('.');
    if (!payload || !signature || extra || !same(sign(payload), signature)) return false;
    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return Number.isFinite(session.exp) && session.exp > Date.now();
    } catch { return false; }
  }
  function summary() {
    const successful = usage.filter(entry => entry.status === 'success');
    const unknown = usage.filter(entry => entry.status === 'unknown');
    const units = rows => rows.reduce((total, entry) => total + (entry.estimatedUnits ?? 0), 0);
    return { liveTasks: usage.length, successfulTasks: successful.length,
      failedTasks: usage.filter(entry => entry.status === 'error').length, unknownTasks: unknown.length,
      estimatedUnits: units(successful), unknownEstimatedUnits: units(unknown),
      tasksWithUnknownUnitCost: successful.filter(entry => entry.estimatedUnits === null).length };
  }
  function view(job) {
    return { id: job.id, feature: job.feature, status: job.status, progress: job.status,
      ...(job.error ? { error: job.error } : {}), results: job.results ?? [] };
  }
  async function execute(job) {
    const feature = FEATURES[job.feature];
    let attempted = false, providerSucceeded = false, finalStatus = 'unknown', errorMessage;
    try {
      job.status = 'uploading';
      const put = async id => {
        const photo = uploads.get(id);
        return (await client.uploadFile(feature, { bytes: await readFile(photo.path),
          contentType: photo.contentType, fileName: photo.fileName })).fileId;
      };
      const fileId = await put(job.uploadId);
      const refFileId = job.refUploadId ? await put(job.refUploadId) : undefined;
      const request = feature.buildRequest(fileId, refFileId ? { ...job.options, refFileId } : job.options);
      job.status = 'running';
      attempted = true;
      const { taskId } = await client.runTask(feature, request);
      const task = await client.pollTask(feature, taskId);
      providerSucceeded = true;
      finalStatus = 'success';
      job.status = 'saving';
      const saved = await client.saveResults(taskId, task.results);
      job.saved = saved;
      job.results = [...saved.files, { name: 'metadata.json', contentType: 'application/json' }].map(file => ({
        ...file, url: `/api/results/${job.id}/${file.name}`,
      }));
    } catch (error) {
      if (error.code === 'TASK_FAILED') finalStatus = 'error';
      if (error.savedResults?.directory) job.leftover = error.savedResults.directory;
      errorMessage = error instanceof YouCamError ? error.message : 'Task could not be completed.';
      if (providerSucceeded) errorMessage += ' Provider completed the task, so estimated units still apply.';
    } finally {
      if (mode === 'live' && attempted) {
        const entry = { time: new Date().toISOString(), feature: job.feature,
          estimatedUnits: feature.estimatedUnits, status: finalStatus };
        try {
          await appendFile(usagePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
          usage.push(entry);
        } catch {
          errorMessage = 'Usage log could not be saved. Check DATA_DIR permissions.';
        }
      }
    }
    // Publish a terminal state only after its usage record has been flushed.
    job.status = errorMessage ? 'error' : 'success';
    if (errorMessage) job.error = errorMessage;
  }
  function drain() {
    while (active.size < 4 && waiting.length) {
      const job = waiting.shift();
      const promise = execute(job).finally(() => { active.delete(promise); drain(); });
      active.add(promise);
    }
  }
  const running = job => !['success', 'error'].includes(job.status);
  async function removePhoto(path) {
    if (path === photosDir || !within(photosDir, path)) return false;
    try { await unlink(path); return true; } catch { return false; }
  }
  async function removeResults(directory) {
    try {
      const real = await realpath(directory); // saved paths may be spelled through a symlink such as /var -> /private/var
      if (real === resultsDir || !within(resultsDir, real)) return false;
      await rm(real, { recursive: true, force: true });
      return true;
    } catch { return false; }
  }
  // Removes expired uploads, jobs and ColorWays. Map entries are dropped before any await so
  // request handlers never see a half-removed record. Running jobs and their uploads are kept,
  // and so is any ColorWay (with its jobs) that still has a running job.
  async function sweep(now = Date.now()) {
    const limit = now - retentionMs;
    const counts = { uploads: 0, jobs: 0, colorways: 0, files: 0 };
    const goneColorways = [...colorways].filter(([, item]) => Date.parse(item.createdAt) < limit
      && !item.jobs.some(({ jobId }) => jobs.has(jobId) && running(jobs.get(jobId)))).map(([id]) => id);
    for (const id of goneColorways) colorways.delete(id);
    counts.colorways = goneColorways.length;
    const held = new Set([...colorways.values()].flatMap(item => item.jobs.map(({ jobId }) => jobId)));
    const directories = [], goneJobs = [];
    for (const [id, job] of jobs) {
      if (running(job) || held.has(id) || !(job.createdAt < limit)) continue;
      goneJobs.push(id);
      for (const directory of [job.saved?.directory, job.leftover]) if (directory) directories.push(directory);
    }
    for (const id of goneJobs) jobs.delete(id);
    counts.jobs = goneJobs.length;
    const busy = new Set();
    for (const job of jobs.values()) if (running(job)) { busy.add(job.uploadId); if (job.refUploadId) busy.add(job.refUploadId); }
    const photos = [];
    for (const [id, item] of uploads) {
      if (busy.has(id) || !(item.createdAt < limit)) continue;
      uploads.delete(id); photos.push(item.path);
    }
    counts.uploads = photos.length;
    for (const path of photos) if (await removePhoto(path)) counts.files++;
    for (const directory of directories) if (await removeResults(directory)) counts.files++;
    return counts;
  }
  // Files left by an earlier start have no Map entry, so they are judged by modification time.
  async function sweepStartup(now = Date.now()) {
    const limit = now - retentionMs;
    const old = async path => (await lstat(path)).mtimeMs < limit;
    for (const entry of await readdir(photosDir, { withFileTypes: true }).catch(() => [])) {
      const path = join(photosDir, entry.name);
      try { if (entry.isFile() && await old(path)) await removePhoto(path); } catch { /* skip unreadable entries */ }
    }
    for (const entry of await readdir(resultsDir, { withFileTypes: true }).catch(() => [])) {
      const path = join(resultsDir, entry.name);
      try { if (entry.isDirectory() && await old(path)) await removeResults(path); } catch { /* skip unreadable entries */ }
    }
  }
  await sweepStartup();
  let sweeping = Promise.resolve();
  const timer = setInterval(() => { sweeping = sweep().catch(() => {}); }, SWEEP_INTERVAL_MS);
  timer.unref();

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (path.startsWith('/api/') && !authenticated(req)) throw fail(401, 'Login required.');
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) {
        throw fail(403, 'Cross-origin requests are not allowed.');
      }
      if (req.method === 'POST' && path === '/login') {
        const input = await jsonBody(req);
        if (typeof input.passcode !== 'string' || !same(input.passcode, env.APP_PASSCODE)) throw fail(401, 'Incorrect passcode.');
        const secure = req.socket.encrypted || (trustProxy && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https');
        const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 24 * 60 * 60 * 1000, nonce: randomUUID() })).toString('base64url');
        res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure ? '; Secure' : ''}`);
        send(200, { ok: true }); return;
      }
      if (req.method === 'GET' && path === '/api/features') { send(200, { mode, features: publicFeatures() }); return; }
      if (req.method === 'GET' && path === '/api/usage') { send(200, summary()); return; }
      if (req.method === 'POST' && path === '/api/uploads') {
        const contentType = req.headers['content-type']?.split(';')[0];
        if (!IMAGE_TYPES[contentType]) throw fail(415, 'Use a JPEG or PNG photo.');
        const bytes = await body(req, MAX_IMAGE_BYTES);
        if (!imageMatches(bytes, contentType)) throw fail(400, 'Photo bytes do not match the image type.');
        const uploadId = randomUUID();
        const fileName = `${uploadId}${IMAGE_TYPES[contentType]}`;
        const photoPath = join(dataDir, 'photos', fileName);
        await writeFile(photoPath, bytes, { mode: 0o600 });
        uploads.set(uploadId, { path: photoPath, contentType, fileName, createdAt: Date.now() });
        send(201, { uploadId }); return;
      }
      if (req.method === 'POST' && path === '/api/tasks') {
        const input = await jsonBody(req);
        let feature;
        try { feature = getFeature(input.feature); } catch { throw fail(400, 'Unknown feature.'); }
        if (!uploads.has(input.uploadId)) throw fail(400, 'Upload a photo first.');
        if (mode === 'live' && !feature.liveSupported) throw fail(422, 'TODO: verify this feature before live use. See /api/features.');
        try { feature.buildRequest('validation-only', input.options ?? {}); } catch { throw fail(400, 'Invalid feature options. See the feature documentation.'); }
        const job = { id: randomUUID(), feature: input.feature, uploadId: input.uploadId, options: input.options ?? {}, status: 'queued', createdAt: Date.now() };
        jobs.set(job.id, job); waiting.push(job);
        send(202, view(job)); drain(); return;
      }
      if (req.method === 'POST' && path === '/api/colorways') {
        const input = await jsonBody(req);
        const plan = planColorway(input, { hasUpload: id => typeof id === 'string' && uploads.has(id), mode });
        const colorway = newColorway(randomUUID(), plan.color, plan.jobs);
        colorways.set(colorway.id, colorway);
        for (const job of plan.jobs) { job.createdAt = Date.now(); jobs.set(job.id, job); waiting.push(job); }
        send(202, colorwayCreated(colorway, jobs)); drain(); return;
      }
      const colorway = /^\/api\/colorways\/([\w-]+)$/.exec(path);
      if (req.method === 'GET' && colorway) {
        if (!colorways.has(colorway[1])) throw fail(404, 'ColorWay not found.');
        send(200, colorwayView(colorways.get(colorway[1]), jobs)); return;
      }
      const task = /^\/api\/tasks\/([\w-]+)$/.exec(path);
      if (req.method === 'GET' && task) {
        const job = jobs.get(task[1]); if (!job) throw fail(404, 'Task not found.');
        send(200, view(job)); return;
      }
      const result = /^\/api\/results\/([\w-]+)\/([\w.-]+)$/.exec(path);
      if (req.method === 'GET' && result) {
        const job = jobs.get(result[1]);
        const file = job?.results?.find(item => item.name === result[2]);
        if (!file) throw fail(404, 'Result not found.');
        const bytes = await readFile(join(job.saved.directory, file.name));
        res.writeHead(200, { 'Content-Type': file.contentType,
          ...(file.contentType.startsWith('image/') ? {} : { 'Content-Disposition': `attachment; filename="${file.name}"` }) });
        res.end(bytes); return;
      }
      const staticFiles = { '/': 'index.html', '/app': 'app.html', '/styles.css': 'styles.css', '/app.js': 'app.js',
        '/colorway': 'colorway.html', '/colorway.js': 'colorway.js', '/colorway.css': 'colorway.css', '/color.mjs': 'color.mjs' };
      if (req.method === 'GET' && staticFiles[path]) {
        if (['/app', '/colorway'].includes(path) && !authenticated(req)) { res.writeHead(302, { Location: '/' }); res.end(); return; }
        const name = staticFiles[path];
        const mime = name.endsWith('.css') ? 'text/css' : /\.m?js$/.test(name) ? 'text/javascript' : 'text/html';
        const content = await readFile(join(ROOT, 'public', name)).catch(error => { throw error.code === 'ENOENT' ? fail(404, 'Not found.') : error; });
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
        res.end(content); return;
      }
      throw fail(404, 'Not found.');
    } catch (error) {
      if (!res.headersSent) send(error.status ?? 500, { error: error.status ? error.message : 'Server request failed.' });
      else res.end();
    }
  });
  return { server, sweep, async close() {
    clearInterval(timer);
    await sweeping;
    while (active.size || waiting.length) await Promise.allSettled([...active]);
    server.closeIdleConnections();
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const port = Number(process.env.PORT ?? 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
    const app = await createApplication();
    const host = process.env.HOST || '127.0.0.1';
    app.server.listen(port, host, () => console.log(`YouCam foundation: http://${host}:${port} (${process.env.MODE ?? 'mock'})`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
