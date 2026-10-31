import { randomUUID } from 'node:crypto';
import { getFeature } from './features.mjs';

const HEX = /^#[0-9a-fA-F]{6}$/;
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];

// Option shapes were verified against the live API (2026-10-21 and 2026-10-28).
export const SURFACES = Object.freeze({
  nail: { feature: 'nail', options: color => ({ colors: Object.fromEntries(FINGERS.map(finger => [finger, color])) }) },
  lip: { feature: 'makeup', options: color => ({ lipColor: color }) },
  hair: { feature: 'hair-color', options: color => ({ colors: ['#3B2416', color], ombreLineOffset: 0.2, blendStrength: 50 }) },
  outfit: { feature: 'clothes-v3', options: () => ({ garmentCategory: 'upper_body' }) },
});

function fail(status, message) { return Object.assign(new Error(message), { status }); }
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

function hex(value, name) {
  if (typeof value !== 'string' || !HEX.test(value)) throw fail(400, `${name} must be #RRGGBB.`);
  return value;
}

// Validates a request body and returns one job description per surface; throws errors carrying an HTTP status.
export function planColorway(input, { hasUpload, mode }) {
  const color = hex(input.color, 'color');
  if (!plain(input.surfaces)) throw fail(400, 'surfaces must be an object.');
  const names = Object.keys(input.surfaces);
  if (!names.length) throw fail(400, 'Choose at least one surface.');
  return { color, jobs: names.map(name => {
    if (!Object.hasOwn(SURFACES, name)) throw fail(400, `Unknown surface: ${name}.`);
    const spec = input.surfaces[name], surface = SURFACES[name];
    if (!plain(spec)) throw fail(400, `surfaces.${name} must be an object.`);
    if (!hasUpload(spec.uploadId)) throw fail(400, `Upload a photo for ${name} first.`);
    const refUploadId = name === 'outfit' ? spec.garmentUploadId : undefined;
    if (name === 'outfit' && !hasUpload(refUploadId)) throw fail(400, 'Upload a garment photo for outfit first.');
    const surfaceColor = spec.color === undefined ? color : hex(spec.color, `surfaces.${name}.color`);
    const feature = getFeature(surface.feature);
    if (mode === 'live' && !feature.liveSupported) throw fail(422, `TODO: verify ${surface.feature} before live use. See /api/features.`);
    const options = surface.options(surfaceColor);
    try { feature.buildRequest('validation-only', { ...options, ...(refUploadId ? { refFileId: 'validation-only' } : {}) }); }
    catch { throw fail(400, `Invalid options for ${name}.`); }
    return { id: randomUUID(), name, feature: surface.feature, color: surfaceColor, uploadId: spec.uploadId,
      ...(refUploadId ? { refUploadId } : {}), options, status: 'queued' };
  }) };
}

export function newColorway(id, color, jobs) {
  return { id, color, createdAt: new Date().toISOString(), jobs: jobs.map(job => ({ name: job.name, jobId: job.id, color: job.color })) };
}

export function colorwayStatus(statuses) {
  if (statuses.some(status => !['success', 'error'].includes(status))) return 'running';
  if (statuses.every(status => status === 'success')) return 'success';
  return statuses.every(status => status === 'error') ? 'error' : 'partial';
}

export function colorwayView(colorway, jobs) {
  const surfaces = {};
  let estimatedUnits = 0;
  for (const { name, jobId, color } of colorway.jobs) {
    const job = jobs.get(jobId);
    estimatedUnits += getFeature(job.feature).estimatedUnits;
    surfaces[name] = { taskId: job.id, feature: job.feature, color, status: job.status,
      ...(job.error ? { error: job.error } : {}),
      results: (job.results ?? []).filter(file => file.contentType.startsWith('image/'))
        .map(({ name: file, contentType, url }) => ({ name: file, contentType, url })) };
  }
  return { id: colorway.id, color: colorway.color, createdAt: colorway.createdAt,
    status: colorwayStatus(Object.values(surfaces).map(surface => surface.status)), estimatedUnits, surfaces };
}

export function colorwayCreated(colorway, jobs) {
  const { id, color, status, surfaces } = colorwayView(colorway, jobs);
  return { id, color, status, surfaces: Object.fromEntries(Object.entries(surfaces).map(([name, surface]) => [name, { taskId: surface.taskId, status: surface.status }])) };
}
