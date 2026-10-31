// ColorWay: one color on nails, lips, hair and outfit, with a measured color match per surface.
// No inline scripts, styles or innerHTML: everything is built with createElement/textContent (CSP-safe).
import { hexToRgb, rgbToHex, measureColor, calibrateInput, recolorImage, matchSummary } from '/color.mjs';

const $ = (selector) => document.querySelector(selector);
const SURFACES = ['nail', 'lip', 'hair', 'outfit'];
const LABELS = { nail: 'Nails', lip: 'Lips', hair: 'Hair (ombre tips)', outfit: 'Outfit' };
const PHOTO_FOR = { nail: ['hand'], lip: ['face'], hair: ['face'], outfit: ['body', 'garment'] };
const PHOTO_LABEL = { face: 'face photo', hand: 'hand photo', body: 'full-body photo', garment: 'garment photo' };
const PRESETS = [
  { name: 'Game Day Red', hex: '#C8102E' },
  { name: 'Sage Wedding', hex: '#9CAF88' },
  { name: 'Concert Violet', hex: '#6A0DAD' },
  { name: 'Ocean Team', hex: '#0077B6' },
  { name: 'Sunset Coral', hex: '#FF6F61' },
];
const STATE_LABELS = {
  queued: 'Queued', uploading: 'Uploading photo…', running: 'Rendering…', saving: 'Saving result…',
  success: 'Done', error: 'Failed',
};
const MATCH_TARGET = 85;
const MAX_RENDERS = 3; // per surface, so Match better cannot spend units without improving
const PREVIEW_MAX_SIDE = 320;
const UPLOAD_MAX_SIDE = 1000;
const GARMENT_MAX_SIDE = 800; // recolor cost grows with pixel count; still within the 1000 px upload limit
const RESULT_MAX_SIDE = 640;
const POLL_MS = 1500;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

const state = {
  color: '#C8102E',
  mode: null,
  photos: { face: null, hand: null, body: null, garment: null },
  busy: false,
};
let board = null; // { color, surfaces: {name: record}, cards: {name: refs} }
let sessionUnits = 0; // estimated API units for this page load; a new board does not reset it
let garmentCache = null; // { hex, version, blob, uploadId }
let versionCounter = 0;
let garmentToken = 0;
let garmentTimer = 0;
let lastAnnounced = '';
const blobUrls = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function say(message, isError = false) {
  const status = $('#status');
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function trackUrl(url) { blobUrls.add(url); return url; }
function dropUrl(url) { if (url) { URL.revokeObjectURL(url); blobUrls.delete(url); } }
window.addEventListener('pagehide', () => { for (const url of blobUrls) URL.revokeObjectURL(url); blobUrls.clear(); });

// ---------------------------------------------------------------- API
async function api(url, { method = 'GET', json, body, contentType } = {}) {
  const headers = {};
  let payload = body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
  else if (contentType) headers['Content-Type'] = contentType;
  const response = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (response.status === 401) {
    location.assign('/');
    throw Object.assign(new Error('Your session has expired. Sign in again.'), { status: 401 });
  }
  if (!response.ok) {
    throw Object.assign(new Error(typeof data.error === 'string' ? data.error : `Request failed (${response.status}).`), { status: response.status });
  }
  return data;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))), type, quality);
  });
}

async function uploadBlob(blob) {
  const { uploadId } = await api('/api/uploads', { method: 'POST', body: blob, contentType: 'image/jpeg' });
  if (typeof uploadId !== 'string') throw new Error('The upload did not return an id.');
  return uploadId;
}

// ---------------------------------------------------------------- Theme
function luminance([r, g, b]) {
  const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
const mix = (rgb, other, t) => rgb.map((v, i) => v + (other[i] - v) * t);

function setTheme(hex) {
  const rgb = hexToRgb(hex);
  const lum = luminance(rgb);
  const inkLum = luminance([29, 27, 32]);
  const ink = contrast(lum, 1) >= contrast(lum, inkLum) ? '#ffffff' : '#1d1b20';
  let text = rgb;
  for (let t = 0; t <= 0.95 && contrast(luminance(text), 1) < 4.5; t += 0.05) text = mix(rgb, [0, 0, 0], t);
  const root = document.documentElement;
  root.style.setProperty('--accent', rgbToHex(rgb));
  root.style.setProperty('--accent-ink', ink);
  root.style.setProperty('--accent-text', rgbToHex(text));
  root.style.setProperty('--accent-soft', rgbToHex(mix(rgb, [255, 255, 255], 0.88)));
  root.style.setProperty('--accent-line', rgbToHex(mix(rgb, [255, 255, 255], 0.6)));
}

// ---------------------------------------------------------------- Step 1: color
const VALID_HEX = /^#[0-9a-f]{6}$/i;
const normalizeHex = (hex) => hex.trim().toUpperCase().replace(/^([0-9A-F]{6})$/, '#$1');

function setColor(hex) {
  const value = normalizeHex(hex);
  if (!VALID_HEX.test(value)) return false;
  state.color = value;
  $('#color-picker').value = value.toLowerCase();
  $('#hex-input').setAttribute('aria-invalid', 'false');
  $('#hex-help').textContent = 'Six digits, like #C8102E.';
  setTheme(value);
  const preset = PRESETS.find((p) => p.hex === value);
  $('#color-name').textContent = preset ? preset.name : `Custom color ${value}`;
  $('#color-swatch').setAttribute('aria-label', `Selected color ${value}`);
  for (const chip of document.querySelectorAll('.chip')) chip.setAttribute('aria-pressed', String(chip.dataset.hex === value));
  scheduleGarmentPreview();
  refreshPlan();
  return true;
}

function initColor() {
  const presets = $('#presets');
  for (const preset of PRESETS) {
    const chip = el('button', 'chip');
    chip.type = 'button';
    chip.dataset.hex = preset.hex;
    chip.setAttribute('aria-pressed', 'false');
    const dot = el('span', 'chip-dot');
    dot.style.setProperty('background-color', preset.hex);
    dot.setAttribute('aria-hidden', 'true');
    chip.append(dot, el('span', '', `${preset.name} ${preset.hex}`));
    chip.addEventListener('click', () => { setColor(preset.hex); $('#hex-input').value = preset.hex; say(`${preset.name} selected.`); });
    presets.append(chip);
  }
  $('#color-picker').addEventListener('input', (event) => {
    setColor(event.target.value);
    $('#hex-input').value = state.color;
  });
  const hexInput = $('#hex-input');
  hexInput.addEventListener('input', () => {
    const value = hexInput.value.trim();
    if (VALID_HEX.test(value) || /^[0-9a-f]{6}$/i.test(value)) { setColor(value); return; }
    hexInput.setAttribute('aria-invalid', value === '' ? 'false' : 'true');
    if (value !== '') $('#hex-help').textContent = 'Enter exactly six hex digits, like #C8102E.';
  });
  hexInput.addEventListener('blur', () => {
    if (hexInput.getAttribute('aria-invalid') === 'true' || hexInput.value.trim() === '') {
      hexInput.value = state.color;
      hexInput.setAttribute('aria-invalid', 'false');
      $('#hex-help').textContent = 'Six digits, like #C8102E.';
    } else hexInput.value = state.color;
  });
  initPhotoPicker();
}

// Pick from a photo: sample a 5x5 average at the clicked pixel.
function initPhotoPicker() {
  const input = $('#inspiration-input');
  const view = $('#pick-canvas');
  const source = document.createElement('canvas');
  const point = { x: 0, y: 0 };
  let loaded = false;

  function paint() {
    const ctx = view.getContext('2d');
    ctx.drawImage(source, 0, 0);
    const radius = Math.max(8, Math.round(view.width / 60));
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2); ctx.stroke();
  }

  function sample() {
    if (!loaded) return;
    const w = Math.min(5, source.width);
    const h = Math.min(5, source.height);
    const sx = clamp(Math.round(point.x) - 2, 0, source.width - w);
    const sy = clamp(Math.round(point.y) - 2, 0, source.height - h);
    const { data } = source.getContext('2d').getImageData(sx, sy, w, h);
    const sum = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) { sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; }
    const n = data.length / 4;
    const hex = rgbToHex(sum.map((s) => s / n)).toUpperCase();
    setColor(hex);
    $('#hex-input').value = hex;
    paint();
    say(`Sampled ${hex} from your photo (5×5 average).`);
  }

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    try {
      const canvas = await loadDownscaled(file, 900);
      source.width = view.width = canvas.width;
      source.height = view.height = canvas.height;
      source.getContext('2d').drawImage(canvas, 0, 0);
      point.x = Math.round(canvas.width / 2);
      point.y = Math.round(canvas.height / 2);
      loaded = true;
      view.hidden = false;
      $('#pick-keys').hidden = false;
      paint();
      say('Inspiration photo loaded. Tap or click a pixel to sample its color.');
    } catch (error) {
      say(`Could not read that image. ${error.message}`, true);
    }
  });

  view.addEventListener('pointerdown', (event) => {
    if (!loaded) return;
    const rect = view.getBoundingClientRect();
    point.x = clamp(((event.clientX - rect.left) * view.width) / rect.width, 0, view.width - 1);
    point.y = clamp(((event.clientY - rect.top) * view.height) / rect.height, 0, view.height - 1);
    sample();
  });
  view.addEventListener('keydown', (event) => {
    if (!loaded) return;
    const step = Math.max(2, Math.round(Math.min(view.width, view.height) / 40));
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key]) {
      event.preventDefault();
      point.x = clamp(point.x + moves[event.key][0], 0, view.width - 1);
      point.y = clamp(point.y + moves[event.key][1], 0, view.height - 1);
      paint();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      sample();
    }
  });
}

// ---------------------------------------------------------------- Step 2: photos
async function loadDownscaled(file, maxSide) {
  let image;
  let width;
  let height;
  let revoke;
  try {
    image = await createImageBitmap(file, { imageOrientation: 'from-image' });
    width = image.width; height = image.height;
  } catch {
    const url = URL.createObjectURL(file);
    revoke = url;
    image = new Image();
    image.src = url;
    try { await image.decode(); } catch { URL.revokeObjectURL(url); throw new Error('The file is not a readable image.'); }
    width = image.naturalWidth; height = image.naturalHeight;
  }
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  if (typeof image.close === 'function') image.close();
  if (revoke) URL.revokeObjectURL(revoke);
  return canvas;
}

async function onPhoto(key, file) {
  const note = $(`#note-${key}`);
  note.classList.remove('error');
  if (!['image/jpeg', 'image/png'].includes(file.type) || file.size === 0 || file.size > 30 * 1024 * 1024) {
    note.textContent = 'Use a nonempty JPEG or PNG photo.';
    note.classList.add('error');
    say('Choose a JPEG or PNG photo (up to 30 MB before resizing).', true);
    return;
  }
  note.textContent = 'Resizing…';
  try {
    const canvas = await loadDownscaled(file, key === 'garment' ? GARMENT_MAX_SIDE : UPLOAD_MAX_SIDE);
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    const previous = state.photos[key];
    if (previous) dropUrl(previous.url);
    const url = trackUrl(URL.createObjectURL(blob));
    state.photos[key] = { blob, url, canvas: key === 'garment' ? canvas : null, version: ++versionCounter, uploadId: null };
    const thumb = $(`#thumb-${key}`);
    thumb.src = url;
    thumb.hidden = false;
    $(`#empty-${key}`).hidden = true;
    note.textContent = `${canvas.width}×${canvas.height} px · ${Math.max(1, Math.round(blob.size / 1024))} KB JPEG`;
    say(`${PHOTO_LABEL[key][0].toUpperCase()}${PHOTO_LABEL[key].slice(1)} ready.`);
    if (key === 'garment') scheduleGarmentPreview(0);
    refreshPlan();
  } catch (error) {
    note.textContent = error.message;
    note.classList.add('error');
    say(`Could not prepare the ${PHOTO_LABEL[key]}: ${error.message}`, true);
  }
}

function initPhotos() {
  for (const key of ['face', 'hand', 'body', 'garment']) {
    $(`#${key}-input`).addEventListener('change', (event) => {
      const file = event.target.files[0];
      if (file) onPhoto(key, file);
      event.target.value = '';
    });
  }
  for (const id of ['#inc-lip', '#inc-hair', '#inc-nail', '#inc-outfit']) $(id).addEventListener('change', refreshPlan);
}

const included = (name) => $(`#inc-${name}`).checked;

function currentPlan() {
  const ready = [];
  const waiting = [];
  for (const name of SURFACES) {
    if (!included(name)) continue;
    const missing = PHOTO_FOR[name].filter((key) => !state.photos[key]);
    if (missing.length === 0) ready.push(name);
    else waiting.push(`${LABELS[name]} (needs ${missing.map((k) => PHOTO_LABEL[k]).join(' and ')})`);
  }
  return { ready, waiting };
}

function refreshPlan() {
  const { ready, waiting } = currentPlan();
  const parts = [];
  parts.push(ready.length ? `Ready: ${ready.map((n) => LABELS[n]).join(', ')} in ${state.color}.` : 'No surface is ready yet. Add a photo and keep its checkbox on.');
  if (waiting.length) parts.push(`Waiting on: ${waiting.join('; ')}.`);
  $('#plan-summary').textContent = parts.join(' ');
  updateControls();
  updateStepDone();
}

function updateControls() {
  const { ready } = currentPlan();
  $('#generate-button').disabled = state.busy || ready.length === 0;
  $('#generate-button').textContent = state.busy ? 'Working…' : 'Generate my ColorWay';
  updateMatchControls();
}

// ---------------------------------------------------------------- Step 3: garment recolor
function scaledCanvas(source, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function recolorGarment(photo, hex, maxSide = Infinity) {
  const source = maxSide < Infinity ? scaledCanvas(photo.canvas, maxSide) : photo.canvas;
  const ctx = source.getContext('2d', { willReadFrequently: true });
  const input = ctx.getImageData(0, 0, source.width, source.height);
  const out = recolorImage(input, hex);
  const canvas = document.createElement('canvas');
  canvas.width = out.width;
  canvas.height = out.height;
  canvas.getContext('2d').putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
  return canvas;
}

async function recolorToBlob(hex) {
  const photo = state.photos.garment;
  if (!photo?.canvas) throw new Error('Add a garment photo first.');
  const canvas = recolorGarment(photo, hex);
  return canvasToBlob(canvas, 'image/jpeg', 0.92);
}

function scheduleGarmentPreview(delay = 250) {
  clearTimeout(garmentTimer);
  garmentTimer = setTimeout(updateGarmentPreview, delay);
}

async function updateGarmentPreview() {
  const token = ++garmentToken;
  const photo = state.photos.garment;
  const note = $('#garment-note');
  if (!photo) {
    $('#garment-compare').hidden = true;
    garmentCache = null;
    note.textContent = 'Add a garment photo and a color to preview the recolored top. The recolored image is what gets uploaded.';
    updateStepDone();
    return;
  }
  const hex = state.color;
  note.textContent = `Recoloring the garment to ${hex}…`;
  $('#garment-compare').hidden = false;
  const before = $('#garment-before');
  before.width = photo.canvas.width;
  before.height = photo.canvas.height;
  before.getContext('2d').drawImage(photo.canvas, 0, 0);
  await sleep(40); // let the browser paint the status text before the heavy loop
  if (token !== garmentToken) return;
  try {
    const canvas = recolorGarment(photo, hex, PREVIEW_MAX_SIDE);
    if (token !== garmentToken) return;
    const after = $('#garment-after');
    after.width = canvas.width;
    after.height = canvas.height;
    after.getContext('2d').drawImage(canvas, 0, 0);
    garmentCache = { hex, version: photo.version, blob: null, uploadId: null };
    $('#garment-after-caption').textContent = `After · ${hex}`;
    note.textContent = `Recolored to ${hex}. The “After” image is what will be uploaded as your garment.`;
  } catch (error) {
    garmentCache = null;
    note.textContent = `Could not recolor the garment: ${error.message}`;
  }
  updateStepDone();
}

async function ensureGarmentUpload(hex) {
  const photo = state.photos.garment;
  if (!photo) throw new Error('Add a garment photo first.');
  let entry = garmentCache;
  if (!entry || entry.hex !== hex || entry.version !== photo.version) {
    entry = { hex, version: photo.version, blob: null, uploadId: null };
    garmentCache = entry;
  }
  entry.blob ??= await recolorToBlob(hex);
  entry.uploadId ??= await uploadBlob(entry.blob);
  return entry.uploadId;
}

async function ensurePhotoUpload(key) {
  const photo = state.photos[key];
  if (!photo.uploadId) photo.uploadId = await uploadBlob(photo.blob);
  return photo.uploadId;
}

// ---------------------------------------------------------------- Board + cards
function newRecord(name) {
  return {
    name, status: 'queued', error: '', uploadId: null, garmentUploadId: null,
    input: board.color, pending: { input: board.color, garmentUploadId: null },
    history: [], measured: null, measureNote: '', canvas: null, hasResult: false, unmeasured: false,
  };
}

function swatch(label) {
  const wrap = el('div', 'swatch');
  const chip = el('div', 'swatch-chip');
  chip.setAttribute('aria-hidden', 'true');
  const caption = el('div', 'swatch-label', label);
  wrap.append(chip, caption);
  return { wrap, chip, caption };
}

function buildCard(name) {
  const card = el('article', 'result-card');
  card.dataset.surface = name;
  const top = el('div', 'result-top');
  const title = el('h3', '', LABELS[name]);
  const stateText = el('span', 'result-state', 'Queued');
  top.append(title, stateText);
  const frame = el('div', 'result-frame');
  const placeholder = el('p', 'placeholder', 'Waiting for the result…');
  frame.append(placeholder);
  const target = swatch('Target');
  const measured = swatch('Measured —');
  const swatches = el('div', 'swatch-row');
  swatches.append(target.wrap, measured.wrap);
  const metrics = el('div', 'metrics');
  const score = el('div', 'score-big', '—');
  const meter = el('div', 'meter');
  meter.setAttribute('aria-hidden', 'true');
  const fill = el('div', 'meter-fill');
  meter.append(fill);
  metrics.append(score, meter);
  const deLine = el('p', 'de-line', 'ΔE —');
  const history = el('p', 'history');
  card.append(top, frame, swatches, metrics, deLine, history);
  return { card, stateText, frame, placeholder, target, measured, score, fill, deLine, history };
}

function renderCard(name) {
  const rec = board.surfaces[name];
  const ui = board.cards[name];
  ui.stateText.classList.toggle('error', rec.status === 'error');
  if (rec.status === 'error') ui.stateText.textContent = rec.error ? `Failed: ${rec.error}` : 'Failed';
  else if (rec.status === 'success') ui.stateText.textContent = rec.hasResult ? 'Done' : 'Saving result…';
  else ui.stateText.textContent = STATE_LABELS[rec.status] || rec.status;

  ui.target.chip.style.setProperty('background-color', board.color);
  ui.target.caption.textContent = `Target ${board.color}`;
  if (rec.hasResult) {
    ui.frame.replaceChildren(rec.canvas);
  } else {
    ui.placeholder.textContent = rec.status === 'error' ? 'No result.' : 'Waiting for the result…';
    ui.frame.replaceChildren(ui.placeholder);
  }
  const m = rec.measured;
  if (m) {
    ui.measured.chip.style.setProperty('background-color', m.hex);
    ui.measured.caption.textContent = `Measured ${m.hex.toUpperCase()}`;
    ui.score.replaceChildren(document.createTextNode(String(m.score)), el('small', '', ' / 100 match'));
    ui.fill.style.setProperty('--score', String(m.score));
    ui.fill.dataset.level = m.score >= MATCH_TARGET ? 'good' : m.score >= 60 ? 'mid' : 'low';
    ui.deLine.textContent = `ΔE ${m.deltaE.toFixed(1)} · ${m.pixels.toLocaleString()} px sampled`;
  } else {
    ui.measured.chip.style.removeProperty('background-color');
    ui.measured.caption.textContent = 'Measured —';
    ui.score.textContent = '—';
    ui.fill.style.setProperty('--score', '0');
    ui.fill.dataset.level = 'low';
    ui.deLine.textContent = !rec.hasResult ? 'ΔE —'
      : state.mode === 'mock' ? 'Demo mode returns your photo unchanged, so there is no painted area to measure.'
      : 'Could not find a clearly colored area to measure. Try a sharper, better-lit photo.';
  }
  ui.history.textContent = rec.history.length
    ? `History: ${rec.history.map((h) => `${h.input.toUpperCase()} → ${h.score == null ? 'n/a' : h.score}`).join(' · ')}`
    : '';
}

function buildBoard(names) {
  const grid = $('#board-grid');
  grid.replaceChildren();
  board.cards = {};
  for (const name of SURFACES) {
    if (!names.includes(name)) continue;
    board.cards[name] = buildCard(name);
    grid.append(board.cards[name].card);
    renderCard(name);
  }
  $('#board-empty').hidden = true;
  $('#board-legend').hidden = false;
  $('#board-actions').hidden = false;
  $('#demo-note').hidden = state.mode !== 'mock';
  updateMatchControls();
}

function renderProgress(names) {
  const list = $('#progress-list');
  list.replaceChildren();
  for (const name of names) {
    const item = el('li');
    item.dataset.surface = name;
    item.dataset.state = 'queued';
    const dot = el('span', 'dot');
    dot.setAttribute('aria-hidden', 'true');
    item.append(dot, el('span', 's-name', LABELS[name]), el('span', 's-state', STATE_LABELS.queued));
    list.append(item);
  }
}

function setSurfaceStatus(name, status, error = '') {
  const rec = board?.surfaces[name];
  if (!rec) return;
  rec.status = status;
  rec.error = status === 'error' ? error || 'This surface did not finish.' : '';
  const item = $(`#progress-list li[data-surface="${name}"]`);
  if (item) {
    item.dataset.state = status;
    item.querySelector('.s-state').textContent = status === 'error' ? `Failed: ${rec.error}` : STATE_LABELS[status] || status;
  }
  if (board.cards[name]) renderCard(name);
}

function announceProgress() {
  const summary = Object.values(board.surfaces).map((s) => `${LABELS[s.name]}: ${(STATE_LABELS[s.status] || s.status).replace('…', '')}`).join(' · ');
  if (summary !== lastAnnounced) { lastAnnounced = summary; say(summary); }
}

function safeResultUrl(result) {
  try {
    const url = new URL(result.url, location.origin);
    return url.origin === location.origin && url.pathname.startsWith('/api/') ? url.href : null;
  } catch { return null; }
}

function pickImageResult(surfaceView) {
  for (const result of surfaceView?.results ?? []) {
    if (typeof result?.contentType !== 'string' || !result.contentType.startsWith('image/')) continue;
    const url = safeResultUrl(result);
    if (url) return url;
  }
  return null;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The stored result image could not be loaded.'));
    image.src = url;
  });
}

async function loadSurfaceResult(name, surfaceView) {
  const rec = board.surfaces[name];
  const url = pickImageResult(surfaceView);
  if (!url) throw new Error('No result image was returned.');
  const image = await loadImage(url);
  const scale = Math.min(1, RESULT_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${LABELS[name]} result in ${board.color}`);
  let measured = null;
  try { measured = measureColor(ctx.getImageData(0, 0, canvas.width, canvas.height), board.color); } catch { measured = null; }
  rec.canvas = canvas;
  rec.hasResult = true;
  rec.measured = measured;
  rec.input = rec.pending.input;
  if (rec.pending.garmentUploadId) rec.garmentUploadId = rec.pending.garmentUploadId;
  rec.history.push({ input: rec.input, score: measured ? measured.score : null });
  setSurfaceStatus(name, 'success');
}

const isTerminal = (status) => ['success', 'partial', 'error'].includes(status);

async function runColorway(payload) {
  const names = Object.keys(payload);
  let view = await api('/api/colorways', { method: 'POST', json: { color: board.color, surfaces: payload } });
  const id = view.id;
  const started = Date.now();
  let failures = 0;
  // The server reports a surface as success only after its result is stored, so load that image
  // right away instead of waiting for the other surfaces. 'saving' now covers just the image load.
  const loads = new Map();
  const load = (name, s) => {
    if (!loads.has(name)) {
      setSurfaceStatus(name, 'saving');
      loads.set(name, loadSurfaceResult(name, s).catch((error) => setSurfaceStatus(name, 'error', error.message)));
    }
    return loads.get(name);
  };
  const apply = () => {
    for (const name of names) {
      const s = view.surfaces?.[name];
      if (!s || !s.status) continue;
      if (s.status === 'success') load(name, s);
      else setSurfaceStatus(name, s.status, s.error);
    }
    announceProgress();
  };
  apply();
  while (!isTerminal(view.status)) {
    await sleep(POLL_MS);
    if (Date.now() - started > POLL_TIMEOUT_MS) throw new Error('Timed out waiting for results. Check the app and try again.');
    try {
      view = await api(`/api/colorways/${encodeURIComponent(id)}`);
      failures = 0;
    } catch (error) {
      if (error.status === 401 || ++failures >= 4) throw error;
      continue;
    }
    apply();
  }
  await Promise.all(names.map(async (name) => {
    const s = view.surfaces?.[name];
    if (s?.status === 'success') {
      await load(name, s);
    } else {
      setSurfaceStatus(name, 'error', s?.error || (s ? 'This surface did not finish.' : 'The server did not report this surface.'));
    }
  }));
  const units = Number(view.estimatedUnits);
  const line = $('#units-line');
  line.hidden = false;
  if (state.mode === 'mock') {
    line.textContent = 'Demo mode: no API units used.';
  } else if (Number.isFinite(units)) {
    sessionUnits += units;
    line.textContent = `Estimated usage this run: ${units} API unit${units === 1 ? '' : 's'} · this session: ${sessionUnits}.`;
  } else {
    line.textContent = 'Estimated usage: unverified for this run.';
  }
  return view;
}

async function generate() {
  if (state.busy) return;
  const { ready } = currentPlan();
  if (!ready.length) { say('Add a photo for at least one selected surface first.', true); return; }
  state.busy = true;
  updateControls();
  lastAnnounced = '';
  board = { color: state.color, surfaces: {}, cards: {} };
  for (const name of ready) board.surfaces[name] = newRecord(name);
  buildBoard(ready);
  renderProgress(ready);
  $('#units-line').hidden = true;
  const payload = {};
  try {
    say('Preparing your photos…');
    for (const name of ready) {
      const rec = board.surfaces[name];
      setSurfaceStatus(name, 'uploading');
      try {
        if (name === 'outfit') {
          rec.uploadId = await ensurePhotoUpload('body');
          rec.pending.garmentUploadId = await ensureGarmentUpload(board.color);
          payload.outfit = { uploadId: rec.uploadId, garmentUploadId: rec.pending.garmentUploadId };
        } else {
          rec.uploadId = await ensurePhotoUpload(PHOTO_FOR[name][0]);
          payload[name] = { uploadId: rec.uploadId };
        }
        setSurfaceStatus(name, 'queued');
      } catch (error) {
        if (error.status === 401) throw error;
        setSurfaceStatus(name, 'error', `Upload failed. ${error.message}`);
      }
    }
    if (!Object.keys(payload).length) throw new Error('No photo could be uploaded, so nothing was sent.');
    say('Starting your ColorWay…');
    const view = await runColorway(payload);
    const done = Object.values(board.surfaces).filter((s) => s.hasResult).length;
    const total = Object.keys(board.surfaces).length;
    say(view.status === 'error' || done === 0
      ? 'No surface finished. See the messages on each card.'
      : `ColorWay ready: ${done} of ${total} surface${total === 1 ? '' : 's'} finished.${done < total ? ' Check the cards that failed.' : ''}`,
    done === 0);
    $('#step-board').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  } catch (error) {
    for (const rec of Object.values(board.surfaces)) {
      if (!['success', 'error'].includes(rec.status)) setSurfaceStatus(rec.name, 'error', error.message);
    }
    say(`${error.message} Nothing was retried automatically.`, true);
  } finally {
    state.busy = false;
    updateControls();
    updateStepDone();
  }
}

// ---------------------------------------------------------------- Match better
function matchCandidates() {
  if (!board) return [];
  const names = new Set(matchSummary(Object.values(board.surfaces), { target: MATCH_TARGET, maxRenders: MAX_RENDERS }).candidates);
  return Object.values(board.surfaces).filter((s) => names.has(s.name));
}

// Why Match better has nothing to do; names the below-target surfaces that only stopped.
function nothingToImproveNote() {
  const sum = matchSummary(Object.values(board.surfaces), { target: MATCH_TARGET, maxRenders: MAX_RENDERS });
  const list = (names) => names.map((n) => LABELS[n]).join(', ');
  const parts = [];
  if (sum.stalled.length) parts.push(`${list(sum.stalled)} stopped improving below ${MATCH_TARGET}`);
  if (sum.limit.length) parts.push(`${list(sum.limit)} reached the ${MAX_RENDERS}-render limit below ${MATCH_TARGET}`);
  if (sum.unmeasured.length) parts.push(`${list(sum.unmeasured)} could not be measured`);
  return parts.length ? `Match better has nothing more to try: ${parts.join('; ')}.`
    : `Every measured surface scores ${MATCH_TARGET} or higher.`;
}

function updateMatchControls() {
  const button = $('#match-button');
  const save = $('#save-button');
  if (!board) { button.disabled = true; save.disabled = true; return; }
  const candidates = matchCandidates();
  const anyResult = Object.values(board.surfaces).some((s) => s.hasResult);
  button.disabled = state.busy || candidates.length === 0;
  save.disabled = state.busy || !anyResult;
  const note = $('#match-note');
  if (!anyResult) note.textContent = 'Match better becomes available when a result has been measured.';
  else if (candidates.length) note.textContent = `${candidates.length} surface${candidates.length === 1 ? '' : 's'} below ${MATCH_TARGET}: ${candidates.map((s) => LABELS[s.name]).join(', ')}. Match better re-renders only those, with a corrected input color.`;
  else note.textContent = nothingToImproveNote();
}

async function matchBetter() {
  if (state.busy || !board) return;
  const candidates = matchCandidates();
  if (!candidates.length) { say(nothingToImproveNote()); return; }
  state.busy = true;
  updateControls();
  lastAnnounced = '';
  const payload = {};
  const requested = [];
  try {
    renderProgress(candidates.map((s) => s.name));
    $('#units-line').hidden = true;
    for (const rec of candidates) {
      const next = calibrateInput(board.color, rec.input, rec.measured.rgb);
      if (next.toLowerCase() === rec.input.toLowerCase()) continue; // calibration has nothing more to adjust
      rec.pending = { input: next.toUpperCase(), garmentUploadId: null };
      requested.push(rec.name);
      setSurfaceStatus(rec.name, 'uploading');
      try {
        if (rec.name === 'outfit') {
          rec.pending.garmentUploadId = await uploadBlob(await recolorToBlob(next));
          payload.outfit = { uploadId: rec.uploadId, garmentUploadId: rec.pending.garmentUploadId };
        } else {
          payload[rec.name] = { uploadId: rec.uploadId, color: next.toUpperCase() };
        }
      } catch (error) {
        if (error.status === 401) throw error;
        setSurfaceStatus(rec.name, 'error', `Upload failed. ${error.message}`);
      }
    }
    for (const item of $('#progress-list').querySelectorAll('li')) if (!requested.includes(item.dataset.surface)) item.remove();
    if (!requested.length) { say('The calibration found no further adjustment to try for these surfaces.'); return; }
    if (!Object.keys(payload).length) throw new Error('Nothing could be sent for re-rendering.');
    say(`Re-rendering ${Object.keys(payload).map((n) => LABELS[n]).join(', ')} with corrected input colors…`);
    await runColorway(payload);
    const summary = Object.keys(payload).map((n) => {
      const rec = board.surfaces[n];
      const last = rec.history[rec.history.length - 1];
      return `${LABELS[n]} ${last && last.score != null ? last.score : 'n/a'}`;
    }).join(' · ');
    say(`Match better finished. New scores: ${summary}.`);
  } catch (error) {
    for (const name of requested) {
      const rec = board.surfaces[name];
      if (rec.status !== 'success' && rec.status !== 'error') setSurfaceStatus(name, 'error', error.message);
    }
    say(`${error.message} Nothing was retried automatically.`, true);
  } finally {
    // A failed re-render keeps the earlier result on the card.
    for (const rec of Object.values(board.surfaces)) if (rec.hasResult && rec.status === 'error') renderCard(rec.name);
    state.busy = false;
    updateControls();
    updateStepDone();
  }
}

// ---------------------------------------------------------------- Save board
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

async function saveBoard() {
  if (!board) return;
  const W = 1200, pad = 48, gap = 24, labelH = 92;
  const cellW = (W - pad * 2 - gap) / 2;
  const cellH = cellW + labelH;
  const headH = 190;
  const H = headH + cellH * 2 + gap + pad;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
  ctx.fillStyle = '#f7f5f3';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = board.color;
  ctx.fillRect(0, 0, W, 14);
  roundRectPath(ctx, pad, 52, 96, 96, 20);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,.18)';
  ctx.stroke();
  ctx.fillStyle = '#1d1b20';
  ctx.font = `800 46px ${font}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`My ColorWay · ${board.color}`, pad + 124, 108);
  ctx.fillStyle = '#5d5a63';
  ctx.font = `500 24px ${font}`;
  ctx.fillText('One color. Your whole look.', pad + 124, 144);

  SURFACES.forEach((name, index) => {
    const x = pad + (index % 2) * (cellW + gap);
    const y = headH + Math.floor(index / 2) * (cellH + gap);
    const rec = board.surfaces[name];
    ctx.fillStyle = '#ffffff';
    roundRectPath(ctx, x, y, cellW, cellH, 20);
    ctx.fill();
    ctx.strokeStyle = '#e4e0e6';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.save();
    roundRectPath(ctx, x + 12, y + 12, cellW - 24, cellW - 24, 14);
    ctx.clip();
    ctx.fillStyle = '#f0edf1';
    ctx.fillRect(x + 12, y + 12, cellW - 24, cellW - 24);
    if (rec?.hasResult) {
      const box = cellW - 24;
      const scale = Math.min(box / rec.canvas.width, box / rec.canvas.height);
      const w = rec.canvas.width * scale, h = rec.canvas.height * scale;
      ctx.drawImage(rec.canvas, x + 12 + (box - w) / 2, y + 12 + (box - h) / 2, w, h);
    } else {
      ctx.fillStyle = '#8a8690';
      ctx.font = `600 26px ${font}`;
      ctx.textAlign = 'center';
      ctx.fillText(rec ? 'No result' : 'Not included', x + cellW / 2, y + cellW / 2);
      ctx.textAlign = 'left';
    }
    ctx.restore();
    const ty = y + cellW + 30;
    ctx.fillStyle = '#1d1b20';
    ctx.font = `750 28px ${font}`;
    ctx.fillText(LABELS[name], x + 24, ty);
    ctx.fillStyle = '#5d5a63';
    ctx.font = `500 22px ${font}`;
    const m = rec?.measured;
    ctx.fillText(m ? `ΔE ${m.deltaE.toFixed(1)} · match ${m.score} / 100` : 'No measurement', x + 24, ty + 34);
    // target and measured swatches
    roundRectPath(ctx, x + cellW - 140, ty - 24, 52, 52, 10);
    ctx.fillStyle = board.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.2)';
    ctx.lineWidth = 2;
    ctx.stroke();
    roundRectPath(ctx, x + cellW - 76, ty - 24, 52, 52, 10);
    ctx.fillStyle = m ? m.hex : '#f0edf1';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#8a8690';
    ctx.font = `500 15px ${font}`;
    ctx.fillText('target', x + cellW - 140, ty + 46);
    ctx.fillText('measured', x + cellW - 82, ty + 46);
  });

  try {
    const blob = await canvasToBlob(canvas, 'image/png');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `colorway-${board.color.slice(1).toLowerCase()}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    say('Board saved as a PNG download.');
  } catch (error) {
    say(`Could not save the board: ${error.message}`, true);
  }
}

// ---------------------------------------------------------------- Steps nav + mode
function updateStepDone() {
  const done = {
    'step-color': true,
    'step-photos': Object.values(state.photos).some(Boolean),
    'step-garment': Boolean(garmentCache),
    'step-generate': Boolean(board),
    'step-board': Boolean(board && Object.values(board.surfaces).some((s) => s.hasResult)),
  };
  for (const link of document.querySelectorAll('.steps a')) link.classList.toggle('done', Boolean(done[link.dataset.step]));
}

function initStepNav() {
  const links = [...document.querySelectorAll('.steps a')];
  const mark = (id) => { for (const link of links) { if (link.dataset.step === id) link.setAttribute('aria-current', 'step'); else link.removeAttribute('aria-current'); } };
  mark('step-color');
  if (!('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) mark(entry.target.id);
  }, { rootMargin: '-120px 0px -60% 0px', threshold: 0 });
  for (const link of links) { const section = document.getElementById(link.dataset.step); if (section) observer.observe(section); }
}

async function loadMode() {
  const badge = $('#mode-badge');
  try {
    const data = await api('/api/features');
    state.mode = data.mode;
    badge.textContent = data.mode === 'mock' ? 'Demo mode — no API calls' : 'Live mode — uses API units';
    badge.classList.toggle('live', data.mode !== 'mock');
    say(data.mode === 'mock'
      ? 'Demo mode: nothing is sent to YouCam. Pick a color to begin.'
      : 'Live mode: generating sends your photos to YouCam and uses API units. Pick a color to begin.');
  } catch (error) {
    badge.textContent = 'Mode unknown';
    say(`Could not load the app mode. ${error.message}`, true);
  }
}

// ---------------------------------------------------------------- Boot
initColor();
initPhotos();
initStepNav();
$('#generate-button').addEventListener('click', generate);
$('#match-button').addEventListener('click', matchBetter);
$('#save-button').addEventListener('click', saveBoard);
setColor(state.color);
refreshPlan();
loadMode();
