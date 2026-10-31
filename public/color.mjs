// ColorWay colour utilities: sRGB (D65) <-> CIELAB, CIEDE2000, measuring and recolouring.
// Pure functions on plain { data: RGBA bytes, width, height } objects; runs in browsers and Node.

const WHITE = [0.95047, 1.0, 1.08883];
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;
const RAD = Math.PI / 180;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Parse '#rrggbb' or '#rgb' into [r,g,b] (0..255). */
export function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`invalid hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** Format [r,g,b] as lowercase '#rrggbb' (rounded and clamped). */
export function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
}

const toLinear = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (l) => 255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);
const labF = (t) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
const labFInv = (f) => (f ** 3 > EPS ? f ** 3 : (116 * f - 16) / KAPPA);

/** Convert sRGB [r,g,b] (0..255) to CIELAB [L,a,b] under D65. */
export function rgbToLab([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map(toLinear);
  const x = 0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = 0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb;
  const fx = labF(x / WHITE[0]);
  const fy = labF(y / WHITE[1]);
  const fz = labF(z / WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Convert CIELAB [L,a,b] to sRGB [r,g,b] (0..255 floats, clamped to gamut). */
export function labToRgb([L, a, b]) {
  const fy = (L + 16) / 116;
  const x = labFInv(fy + a / 500) * WHITE[0];
  const y = labFInv(fy) * WHITE[1];
  const z = labFInv(fy - b / 200) * WHITE[2];
  const lr = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const lg = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const lb = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [lr, lg, lb].map((v) => clamp(fromLinear(clamp(v, 0, 1)), 0, 255));
}

const hueDeg = (b, a) => {
  if (a === 0 && b === 0) return 0;
  const h = Math.atan2(b, a) / RAD;
  return h < 0 ? h + 360 : h;
};

/** CIEDE2000 colour difference between two Lab triples (kL=kC=kH=1). */
export function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = hueDeg(b1, a1p);
  const h2p = hueDeg(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * RAD) / 2);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbarp += h1p + h2p < 360 ? 360 : -360;
    hbarp /= 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * RAD) +
    0.24 * Math.cos(2 * hbarp * RAD) +
    0.32 * Math.cos((3 * hbarp + 6) * RAD) -
    0.2 * Math.cos((4 * hbarp - 63) * RAD);
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * RAD) * Rc;

  const l = dLp / Sl;
  const c = dCp / Sc;
  const h = dHp / Sh;
  return Math.sqrt(l * l + c * c + h * h + Rt * c * h);
}

/** Our own presentation scale (not a standard): 100 at ΔE 0, linear down to 0 at ΔE 30, integer. */
export function matchScore(deltaE) {
  return Math.round(clamp(100 * (1 - deltaE / 30), 0, 100));
}

const hueDistance = (h1, h2) => {
  const d = Math.abs(h1 - h2) % 360;
  return d > 180 ? 360 - d : d;
};

/** Average the pixels whose Lab hue/chroma match the target (the painted surface) and score it against the target. */
export function measureColor(image, targetHex, { box, maxHueDistance = 20, minChroma } = {}) {
  const { data, width, height } = image;
  const [x0, y0, x1, y1] = box ?? [0, 0, width, height];
  const targetLab = rgbToLab(hexToRgb(targetHex));
  const targetHue = hueDeg(targetLab[2], targetLab[1]);
  // Skin sits close to warm hues, so the chroma floor scales with the target (live results 2026-10-21).
  minChroma ??= Math.max(20, 0.5 * Math.hypot(targetLab[1], targetLab[2]));
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      const lab = rgbToLab([data[i], data[i + 1], data[i + 2]]);
      if (Math.hypot(lab[1], lab[2]) < minChroma) continue;
      if (hueDistance(hueDeg(lab[2], lab[1]), targetHue) > maxHueDistance) continue;
      sum[0] += data[i];
      sum[1] += data[i + 1];
      sum[2] += data[i + 2];
      n++;
    }
  }
  if (n === 0) return null;
  const rgb = sum.map((s) => Math.round(s / n));
  const lab = rgbToLab(rgb);
  const deltaE = deltaE2000(lab, targetLab);
  return { rgb, hex: rgbToHex(rgb), lab, pixels: n, deltaE, score: matchScore(deltaE) };
}

/** Next input colour: nudge the input in Lab by gain*(target - measured), each channel limited to ±maxStep. */
export function calibrateInput(targetHex, inputHex, measuredRgb, { gain = 0.8, maxStep = 25 } = {}) {
  const target = rgbToLab(hexToRgb(targetHex));
  const input = rgbToLab(hexToRgb(inputHex));
  const measured = rgbToLab(measuredRgb);
  const next = input.map((v, k) => v + clamp(gain * (target[k] - measured[k]), -maxStep, maxStep));
  if (next.every((v, k) => v === input[k])) return rgbToHex(hexToRgb(inputHex));
  return rgbToHex(labToRgb(next));
}

const pixelLab = (data, i) => rgbToLab([data[i], data[i + 1], data[i + 2]]);

/** Mean Lab of the four corner 8x8 patches (patch size shrinks for tiny images). */
function estimateBackgroundLab({ data, width, height }) {
  const pw = Math.min(8, width);
  const ph = Math.min(8, height);
  const xs = [0, width - pw];
  const ys = [0, height - ph];
  const sum = [0, 0, 0];
  let n = 0;
  for (const oy of ys) {
    for (const ox of xs) {
      for (let y = oy; y < oy + ph; y++) {
        for (let x = ox; x < ox + pw; x++) {
          const lab = pixelLab(data, (y * width + x) * 4);
          sum[0] += lab[0];
          sum[1] += lab[1];
          sum[2] += lab[2];
          n++;
        }
      }
    }
  }
  return sum.map((s) => s / n);
}

/** Build a recolour mask (1 = garment) by flood-filling the border-connected background and excluding it. */
function buildMask(image, tolerance) {
  const { data, width, height } = image;
  const bg = estimateBackgroundLab(image);
  const near = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const lab = pixelLab(data, p * 4);
    near[p] = Math.hypot(lab[0] - bg[0], lab[1] - bg[1], lab[2] - bg[2]) <= tolerance ? 1 : 0;
  }
  const isBg = new Uint8Array(width * height);
  const stack = [];
  const push = (x, y) => {
    const p = y * width + x;
    if (near[p] && !isBg[p]) {
      isBg[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  return isBg.map((v) => 1 - v);
}

/** Return a new RGBA image with the garment recoloured to the target hue/chroma, keeping its lightness detail and alpha. */
export function recolorImage(image, targetHex, { mask, backgroundTolerance = 12 } = {}) {
  const { data, width, height } = image;
  const out = { data: new Uint8ClampedArray(data), width, height };
  const m = mask ?? buildMask(image, backgroundTolerance);
  const [tL, tA, tB] = rgbToLab(hexToRgb(targetHex));
  const labs = new Map();
  let sumL = 0;
  let n = 0;
  for (let p = 0; p < width * height; p++) {
    if (!m[p]) continue;
    const L = pixelLab(data, p * 4)[0];
    labs.set(p, L);
    sumL += L;
    n++;
  }
  if (n === 0) return out;
  const meanL = sumL / n;
  for (const [p, L] of labs) {
    const rgb = labToRgb([clamp(tL + (L - meanL), 0, 100), tA, tB]);
    const i = p * 4;
    out.data[i] = Math.round(rgb[0]);
    out.data[i + 1] = Math.round(rgb[1]);
    out.data[i + 2] = Math.round(rgb[2]);
  }
  return out;
}

/**
 * Sort board surfaces for Match better. A surface is a candidate when it has a measured result below the target,
 * renders left, and its last render improved (or it has only one render). The other below-target surfaces are
 * reported by reason, so the page never claims every surface matched when some only stopped.
 */
export function matchSummary(surfaces, { target = 85, maxRenders = 3 } = {}) {
  const out = { candidates: [], matched: [], stalled: [], limit: [], unmeasured: [] };
  for (const s of surfaces) {
    if (!s.hasResult) continue;
    if (!s.measured) { out.unmeasured.push(s.name); continue; }
    if (s.measured.score >= target) { out.matched.push(s.name); continue; }
    const h = s.history ?? [];
    if (h.length >= maxRenders) { out.limit.push(s.name); continue; }
    const improving = h.length < 2 || (h.at(-1).score ?? -1) > (h.at(-2).score ?? -1);
    (improving ? out.candidates : out.stalled).push(s.name);
  }
  return out;
}
