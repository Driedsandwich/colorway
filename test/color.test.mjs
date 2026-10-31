import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hexToRgb, rgbToHex, rgbToLab, labToRgb, deltaE2000, matchScore,
  measureColor, calibrateInput, recolorImage, matchSummary,
} from '../public/color.mjs';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = fn(x, y);
      data.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}
const hueOf = ([, a, b]) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
const std = (xs) => Math.sqrt(mean(xs.map((v) => (v - mean(xs)) ** 2)));
function lcg(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

test('hex <-> rgb', () => {
  assert.deepEqual(hexToRgb('#C8102E'), [200, 16, 46]);
  assert.deepEqual(hexToRgb('fff'), [255, 255, 255]);
  assert.equal(rgbToHex([200, 16, 46]), '#c8102e');
  assert.equal(rgbToHex([-5, 300.4, 127.6]), '#00ff80');
  assert.equal(rgbToHex(hexToRgb('#2A6FDB')), '#2a6fdb');
  assert.throws(() => hexToRgb('#12345'));
});

test('rgb <-> lab round trips within 1 unit', () => {
  for (const hex of ['#C8102E', '#ffffff', '#000000', '#2a6fdb', '#808080', '#e6bea9', '#00ff00']) {
    const rgb = hexToRgb(hex);
    const back = labToRgb(rgbToLab(rgb));
    rgb.forEach((v, i) => near(back[i], v, 1, `${hex}[${i}]`));
  }
});

test('known Lab values', () => {
  const [L, a, b] = rgbToLab([255, 255, 255]);
  near(L, 100, 0.01); near(a, 0, 0.01); near(b, 0, 0.01);
  const red = rgbToLab([255, 0, 0]);
  near(red[0], 53.24, 0.05); near(red[1], 80.09, 0.05); near(red[2], 67.2, 0.05);
  assert.deepEqual(labToRgb([200, 0, 0]).map(Math.round), [255, 255, 255]);
  assert.deepEqual(labToRgb([50, 200, 200]).every((v) => v >= 0 && v <= 255), true);
});

test('CIEDE2000 matches Sharma/Wu/Dalal (2005) pairs', () => {
  const pairs = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.903],
    [[50, 2.5, 0], [58, 24, 15], 19.4535],
  ];
  for (const [l1, l2, expected] of pairs) {
    near(deltaE2000(l1, l2), expected, 1e-4, `${l1} / ${l2}`);
    near(deltaE2000(l2, l1), expected, 1e-4, 'symmetry');
    assert.equal(deltaE2000(l1, l1), 0);
  }
});

test('matchScore scale', () => {
  assert.equal(matchScore(0), 100);
  assert.equal(matchScore(15), 50);
  assert.equal(matchScore(30), 0);
  assert.equal(matchScore(99), 0);
  assert.equal(matchScore(-3), 100);
  assert.ok(Number.isInteger(matchScore(7.3)));
});

test('measureColor isolates the painted surface from skin', () => {
  const img = makeImage(20, 10, (x) => (x < 10 ? [200, 16, 46] : [230, 190, 170]));
  const m = measureColor(img, '#C8102E');
  assert.deepEqual(m.rgb, [200, 16, 46]);
  assert.equal(m.hex, '#c8102e');
  assert.equal(m.pixels, 100);
  near(m.deltaE, 0, 1e-6);
  assert.equal(m.score, 100);
  const box = measureColor(img, '#C8102E', { box: [0, 0, 5, 10] });
  assert.equal(box.pixels, 50);
  assert.equal(measureColor(img, '#C8102E', { box: [10, 0, 20, 10] }), null);
  const skin = makeImage(8, 8, () => [230, 190, 170]);
  assert.equal(measureColor(skin, '#C8102E'), null);
});

test('measureColor reports darker render with a lower score', () => {
  const img = makeImage(4, 4, () => [155, 33, 46]);
  const m = measureColor(img, '#C8102E');
  assert.ok(m.deltaE > 5 && m.score < 100);
});

test('calibrateInput', () => {
  const target = '#C8102E';
  const input = '#C8102E';
  const measured = [155, 33, 46]; // darker than target
  const next = calibrateInput(target, input, measured);
  assert.ok(rgbToLab(hexToRgb(next))[0] > rgbToLab(hexToRgb(input))[0], 'lighter');
  const a = rgbToLab(hexToRgb(input));
  const b = rgbToLab(hexToRgb(calibrateInput(target, input, [0, 200, 0], { maxStep: 10 })));
  [0, 1, 2].forEach((k) => assert.ok(Math.abs(b[k] - a[k]) <= 10 + 1.5, `step ch${k}`)); // +rounding to 8 bit
  assert.equal(calibrateInput(target, '#abcdef', hexToRgb(target)), '#abcdef');
  assert.equal(calibrateInput(target, '#ABCDEF', hexToRgb(target)), '#abcdef');
});

test('recolorImage recolors garment, keeps lightness detail and background', () => {
  const rnd = lcg(42);
  const size = 64;
  const inSquare = (x, y) => x >= 16 && x < 48 && y >= 16 && y < 48;
  const img = makeImage(size, size, (x, y) => {
    if (!inSquare(x, y)) return [255, 255, 255, 255];
    const v = 128 + Math.round((rnd() * 2 - 1) * 10);
    return [v, v, v, 255];
  });
  const out = recolorImage(img, '#2a6fdb');
  assert.notEqual(out.data, img.data);
  assert.equal(out.width, size);
  const labs = (image, pred) => {
    const r = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!pred(x, y)) continue;
      const i = (y * size + x) * 4;
      r.push(rgbToLab([image.data[i], image.data[i + 1], image.data[i + 2]]));
    }
    return r;
  };
  const before = labs(img, inSquare);
  const after = labs(out, inSquare);
  const targetHue = hueOf(rgbToLab(hexToRgb('#2a6fdb')));
  const meanHue = hueOf([0, mean(after.map((l) => l[1])), mean(after.map((l) => l[2]))]);
  near(meanHue, targetHue, 5, 'hue');
  const sb = std(before.map((l) => l[0]));
  const sa = std(after.map((l) => l[0]));
  assert.ok(Math.abs(sa - sb) <= 0.3 * sb, `L std ${sb} -> ${sa}`);
  near(mean(after.map((l) => l[0])), rgbToLab(hexToRgb('#2a6fdb'))[0], 2, 'mean L');
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (inSquare(x, y)) continue;
    const i = (y * size + x) * 4;
    assert.deepEqual([...out.data.slice(i, i + 4)], [255, 255, 255, 255]);
  }
});

test('recolorImage: enclosed background-like pixels are recolored, alpha preserved, explicit mask honoured', () => {
  const size = 48; // corner 8x8 patches must stay clear of the garment
  // garment ring with a white "hole" inside; hole is not connected to the border
  const img = makeImage(size, size, (x, y) => {
    const ring = x >= 12 && x < 36 && y >= 12 && y < 36;
    const hole = x >= 20 && x < 28 && y >= 20 && y < 28;
    if (hole) return [255, 255, 255, 255];
    return ring ? [120, 120, 120, 200] : [255, 255, 255, 255];
  });
  const out = recolorImage(img, '#2a6fdb');
  const at = (image, x, y) => [...image.data.slice((y * size + x) * 4, (y * size + x) * 4 + 4)];
  assert.equal(at(out, 14, 14)[3], 200);
  assert.notDeepEqual(at(out, 14, 14).slice(0, 3), [120, 120, 120]);
  assert.notDeepEqual(at(out, 24, 24).slice(0, 3), [255, 255, 255]); // hole is enclosed -> recolored
  assert.deepEqual(at(out, 0, 0), [255, 255, 255, 255]);
  const mask = new Uint8Array(size * size);
  mask[14 * size + 14] = 1;
  const only = recolorImage(img, '#2a6fdb', { mask });
  assert.notDeepEqual(at(only, 14, 14).slice(0, 3), [120, 120, 120]);
  assert.deepEqual(at(only, 15, 15), at(img, 15, 15));
});

test('measureColor ignores real skin tones next to a warm red target', () => {
  const skin = [[166, 121, 101], [186, 117, 103], [205, 150, 130], [150, 95, 80]];
  const img = { data: new Uint8ClampedArray(skin.length * 4), width: skin.length, height: 1 };
  skin.forEach((c, i) => img.data.set([...c, 255], i * 4));
  assert.equal(measureColor(img, '#C8102E'), null);
});

test('matchSummary: below-target surfaces that only stopped are not reported as matched', () => {
  const s = (name, score, scores) => ({ name, hasResult: true, measured: score === null ? null : { score },
    history: scores.map((v) => ({ score: v })) });
  const sum = matchSummary([
    s('nail', 88, [88]),            // matched
    s('lip', 70, [70]),             // one render: candidate
    s('hair', 72, [70, 72]),        // improved: candidate
    s('outfit', 69, [71, 69]),      // got worse: stalled
    s('extra', 74, [60, 70, 74]),   // three renders: limit
    s('none', null, [null]),        // nothing measured
    { name: 'waiting', hasResult: false, measured: null, history: [] },
  ], { target: 85, maxRenders: 3 });
  assert.deepEqual(sum.candidates, ['lip', 'hair']);
  assert.deepEqual(sum.matched, ['nail']);
  assert.deepEqual(sum.stalled, ['outfit']);
  assert.deepEqual(sum.limit, ['extra']);
  assert.deepEqual(sum.unmeasured, ['none']);
  assert.deepEqual(matchSummary([s('hair', 73, [73, 73])]).stalled, ['hair']); // equal score is not an improvement
});
