import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_RESULT_BYTES = 50 * 1024 * 1024;

export class YouCamError extends Error {
  constructor(message, code = 'UPSTREAM_ERROR') {
    super(message);
    this.code = code;
  }
}

function providerFailure(ctx, data, fallback, code = 'UPSTREAM_ERROR') {
  const clean = value => redact(String(value), ctx.apiKey)
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/\S+/gi, '[provider URL omitted]').slice(0, 500);
  const error = new YouCamError(fallback, code);
  const providerCode = data?.error_code ?? data?.error;
  const providerMessage = data?.error_message ?? (data?.error_code !== undefined ? data?.error : undefined);
  if (typeof providerCode === 'string' || typeof providerCode === 'number') error.providerCode = clean(providerCode);
  if (typeof providerMessage === 'string') error.providerMessage = clean(providerMessage);
  return error;
}

// Never log upstream bodies, signed URLs, or headers. This is also safe for debug use.
export function redact(value, secret = '') {
  if (typeof value === 'string') return secret ? value.split(secret).join('[REDACTED]') : value;
  if (Array.isArray(value)) return value.map(item => redact(item, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, /authorization/i.test(key) ? '[REDACTED]' : redact(item, secret),
    ]));
  }
  return value;
}

function assertNoSecret(ctx, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  if (ctx.apiKey && bytes.includes(Buffer.from(ctx.apiKey))) {
    throw new YouCamError('Provider response contained a credential; response discarded.');
  }
}

function httpURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new YouCamError('Invalid provider URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new YouCamError('Invalid provider URL.');
  }
  return url;
}

function sniffImage(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).equals(Buffer.from('89504e47', 'hex'))) return 'image/png';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
}

async function readLimited(response, limit) {
  const parts = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new YouCamError('Provider response exceeded the size limit.');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

export function createYouCamClient({ mode = 'mock', apiKey = '', baseUrl = 'https://yce-api-01.makeupar.com',
  dataDir, fetchImpl = globalThis.fetch, pollOptions = {} }) {
  const ctx = { mode, apiKey, baseUrl: httpURL(baseUrl), dataDir, fetchImpl, pollOptions,
    requestTimes: [], mockFiles: new Map(), mockTasks: new Map() };
  if (!['mock', 'live'].includes(mode) || (mode === 'live' && !apiKey)) {
    throw new Error('Live mode requires YOUCAM_API_KEY; MODE must be mock or live.');
  }
  return {
    uploadFile: (...args) => uploadFile(ctx, ...args),
    runTask: (...args) => runTask(ctx, ...args),
    getTask: (...args) => getTask(ctx, ...args),
    pollTask: (...args) => pollTask(ctx, ...args),
    saveResults: (...args) => saveResults(ctx, ...args),
  };
}

// Sliding window shared by all tasks: at most 250 API calls per 300 seconds.
async function apiRequest(ctx, path, { method = 'GET', body, signal } = {}) {
  while (true) {
    const now = Date.now();
    ctx.requestTimes = ctx.requestTimes.filter(time => time > now - 300_000);
    if (ctx.requestTimes.length < 250) { ctx.requestTimes.push(now); break; }
    await delay(Math.max(1, ctx.requestTimes[0] + 300_000 - now), undefined, { signal });
  }
  const url = new URL(path, ctx.baseUrl);
  if (url.origin !== ctx.baseUrl.origin || !path.startsWith('/s2s/v2.0/')) {
    throw new YouCamError('Invalid API path.');
  }
  try {
    const response = await ctx.fetchImpl(url, {
      method, redirect: 'error', signal: signal ?? AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${ctx.apiKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const bytes = await readLimited(response, 2 * 1024 * 1024);
    let data;
    try { data = JSON.parse(bytes.toString()); }
    catch { throw new YouCamError(`Provider API returned an invalid response (HTTP ${response.status}).`); }
    if (!response.ok) throw providerFailure(ctx, data, `Provider API returned HTTP ${response.status}.`);
    if (data.status !== undefined && data.status !== 200) throw providerFailure(ctx, data, 'Provider API rejected the request.');
    return data;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof YouCamError) throw error;
    throw new YouCamError('Provider API request failed.');
  }
}

export async function uploadFile(ctx, feature, { bytes, contentType, fileName }) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new YouCamError('Image must be at most 10 MB.');
  if (ctx.mode === 'mock') {
    const fileId = `mock-${randomUUID()}`;
    ctx.mockFiles.set(fileId, { bytes, contentType });
    return { fileId };
  }
  if (!feature.filePath) throw new YouCamError('TODO: verify this feature upload endpoint.');
  const response = await apiRequest(ctx, feature.filePath, { method: 'POST',
    body: { files: [{ content_type: contentType, file_name: fileName, file_size: bytes.length }] } });
  const file = response.data?.files?.[0];
  const request = file?.requests?.[0];
  if (!file?.file_id || !request?.url || !['PUT', 'POST'].includes(request.method?.toUpperCase())) {
    throw new YouCamError('Provider upload instructions were incomplete.');
  }
  assertNoSecret(ctx, file.file_id);
  try {
    // Only use the signed upload headers; never append our API Authorization header.
    const uploaded = await ctx.fetchImpl(httpURL(request.url), { method: request.method,
      headers: request.headers ?? {}, body: bytes, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!uploaded.ok) throw new YouCamError(`Provider upload returned HTTP ${uploaded.status}.`);
    await uploaded.body?.cancel();
  } catch (error) {
    if (error instanceof YouCamError) throw error;
    throw new YouCamError('Photo upload failed.');
  }
  return { fileId: file.file_id };
}

export async function runTask(ctx, feature, request) {
  if (ctx.mode === 'mock') {
    const taskId = `mock-${randomUUID()}`;
    const sourceId = request.src_file_id ?? request.src_file_ids?.[0];
    const file = ctx.mockFiles.get(sourceId);
    if (!file) throw new YouCamError('Mock source file not found.');
    ctx.mockTasks.set(taskId, { file, polls: 0 });
    ctx.mockFiles.delete(sourceId);
    return { taskId };
  }
  const response = await apiRequest(ctx, feature.taskPath, { method: 'POST', body: request });
  const taskId = response.data?.task_id;
  if (typeof taskId !== 'string' || !/^[\w-]{1,160}$/.test(taskId)) {
    throw new YouCamError('Provider returned an invalid task ID.');
  }
  assertNoSecret(ctx, taskId);
  return { taskId };
}

export async function getTask(ctx, feature, taskId, { signal } = {}) {
  if (ctx.mode === 'mock') {
    const task = ctx.mockTasks.get(taskId);
    if (!task) throw new YouCamError('Mock task not found.');
    return { task_status: ++task.polls < 2 ? 'running' : 'success', results: { url: `mock://${taskId}` } };
  }
  const response = await apiRequest(ctx, `${feature.taskPath}/${encodeURIComponent(taskId)}`, { signal });
  if (!['running', 'success', 'error'].includes(response.data?.task_status)) {
    throw new YouCamError('Provider returned an invalid task status.');
  }
  return response.data;
}

export async function pollTask(ctx, feature, taskId, options = {}) {
  const { timeoutMs = 180_000, initialDelayMs = ctx.mode === 'mock' ? 150 : 1000,
    maxDelayMs = 10_000, onStatus = () => {} } = { ...ctx.pollOptions, ...options };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let wait = initialDelayMs;
  try {
    while (true) {
      const task = await getTask(ctx, feature, taskId, { signal: controller.signal });
      onStatus(task.task_status);
      if (task.task_status === 'error') throw providerFailure(ctx, task, 'Provider task failed; no units consumed.', 'TASK_FAILED');
      if (task.task_status === 'success') return task;
      await delay(wait, undefined, { signal: controller.signal });
      wait = Math.min(maxDelayMs, Math.max(1, wait * 1.7));
    }
  } catch (error) {
    if (controller.signal.aborted) throw new YouCamError('Polling timed out; provider outcome is unknown.', 'TASK_TIMEOUT');
    throw error;
  } finally { clearTimeout(timer); }
}

export async function saveResults(ctx, taskId, results, options = {}) {
  if (!/^[\w-]{1,160}$/.test(taskId)) throw new YouCamError('Invalid result task ID.');
  assertNoSecret(ctx, results);
  const directory = options.directory ?? join(ctx.dataDir, 'results', taskId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = [], failures = [];
  const urls = new Map();
  async function persist(value) {
    if (typeof value === 'string' && /^(https?:\/\/|mock:\/\/)/.test(value)) {
      if (urls.has(value)) return urls.get(value);
      let bytes, contentType;
      try {
        if (ctx.mode === 'mock') {
          if (value !== `mock://${taskId}`) throw new YouCamError('Invalid mock result URL.');
          ({ bytes, contentType } = ctx.mockTasks.get(taskId).file);
        } else {
          const response = await ctx.fetchImpl(httpURL(value), { redirect: 'error', signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw new YouCamError(`Result download returned HTTP ${response.status}.`);
          contentType = response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream';
          bytes = await readLimited(response, MAX_RESULT_BYTES);
        }
        assertNoSecret(ctx, bytes);
        assertNoSecret(ctx, contentType);
        contentType = sniffImage(bytes) ?? contentType;
        if (!['image/jpeg', 'image/png', 'image/webp', 'application/json'].includes(contentType)) contentType = 'application/octet-stream';
        const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/json': '.json' }[contentType] ?? '.bin';
        const name = `result-${files.length + 1}${ext}`;
        await writeFile(join(directory, name), bytes, { mode: 0o600 });
        files.push({ name, contentType, bytes: bytes.length });
        urls.set(value, name);
        return name;
      } catch {
        // Attempt remaining URLs too: a failed download must not strand other expiring results.
        failures.push({ result: urls.size + 1, error: 'Result could not be downloaded or safely stored.' });
        urls.set(value, null);
        return null;
      }
    }
    if (Array.isArray(value)) { const out = []; for (const item of value) out.push(await persist(item)); return out; }
    if (value && typeof value === 'object') {
      const out = Object.create(null);
      for (const [key, item] of Object.entries(value)) out[key] = await persist(item);
      return out;
    }
    return value;
  }
  const data = await persist(results ?? {});
  const metadata = { taskId, savedAt: new Date().toISOString(), files, data, ...(failures.length ? { failures } : {}) };
  await writeFile(join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 });
  ctx.mockTasks.delete(taskId);
  if (failures.length) {
    const error = new YouCamError('Some results could not be downloaded or safely stored; check saved metadata.');
    error.savedResults = { directory, ...metadata };
    throw error;
  }
  return { directory, ...metadata };
}
