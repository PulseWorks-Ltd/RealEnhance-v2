import assert from "node:assert/strict";
import test from "node:test";

import { autoTone, buildLumaMask, estimateStraighten } from "./auto";
import { adjustPixel, computeUniforms, coverScale, outputToSource, planGeometry } from "./colour";
import { canRedo, canUndo, currentStep, pushStep, redo, startHistory, undo } from "./history";
import { DEFAULT_ADJUST_PARAMS, isIdentityAdjust, rotateClockwise, sanitizeAdjustParams, type AdjustParams } from "./params";
import { renderCpuPixels } from "./renderer";

const P = (over: Partial<AdjustParams>): AdjustParams => ({ ...DEFAULT_ADJUST_PARAMS, ...over });
const luma = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function solidImage(w: number, h: number, rgb: [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return out;
}

test("sanitize: clamps, rounds, defaults and normalises quarter turns", () => {
  const p = sanitizeAdjustParams({ brightness: 250, contrast: "-12.6", warmth: Number.NaN, straighten: -0.66, rotate: -90, junk: 4 });
  assert.equal(p.brightness, 100);
  assert.equal(p.contrast, -13);
  assert.equal(p.warmth, 0);
  assert.equal(p.straighten, -0.7);
  assert.equal(p.rotate, 270);
  assert.equal((p as any).junk, undefined);
  assert.ok(isIdentityAdjust(sanitizeAdjustParams(null)));
  assert.equal(rotateClockwise(270), 0);
});

test("identity: default values leave every colour unchanged", () => {
  const u = computeUniforms(DEFAULT_ADJUST_PARAMS);
  for (let i = 0; i < 200; i++) {
    const c: [number, number, number] = [Math.random(), Math.random(), Math.random()];
    const out = adjustPixel(c[0], c[1], c[2], Math.random(), u);
    out.forEach((v, k) => assert.ok(Math.abs(v - c[k]) < 1e-9, `channel ${k}: ${v} vs ${c[k]}`));
  }
});

test("brightness raises and lowers luminance monotonically", () => {
  const c = [0.4, 0.35, 0.3];
  let prev = -1;
  for (const brightness of [-100, -50, 0, 50, 100]) {
    const y = luma(adjustPixel(c[0], c[1], c[2], 0.4, computeUniforms(P({ brightness }))));
    assert.ok(y > prev, `brightness ${brightness}`);
    prev = y;
  }
});

test("highlights −: darkens bright windows much more than mid-tones", () => {
  const u = computeUniforms(P({ highlights: -80 }));
  const window = adjustPixel(0.95, 0.95, 0.95, 0.95, u);
  const wall = adjustPixel(0.35, 0.35, 0.35, 0.35, u);
  assert.ok(0.95 - window[0] > 0.1, `window ${window[0]}`);
  assert.ok(Math.abs(0.35 - wall[0]) < 0.02, `wall ${wall[0]}`);
});

test("shadows +: lifts dark corners, leaves highlights alone", () => {
  const u = computeUniforms(P({ shadows: 80 }));
  const corner = adjustPixel(0.1, 0.1, 0.1, 0.1, u);
  const sky = adjustPixel(0.9, 0.9, 0.9, 0.9, u);
  assert.ok(corner[0] - 0.1 > 0.08, `corner ${corner[0]}`);
  assert.ok(Math.abs(sky[0] - 0.9) < 0.01, `sky ${sky[0]}`);
});

test("warmth and tint move colour, not brightness", () => {
  const grey = 0.5;
  const warm = adjustPixel(grey, grey, grey, grey, computeUniforms(P({ warmth: 60 })));
  assert.ok(warm[0] > warm[2]);
  const cool = adjustPixel(grey, grey, grey, grey, computeUniforms(P({ warmth: -60 })));
  assert.ok(cool[2] > cool[0]);
  const magenta = adjustPixel(grey, grey, grey, grey, computeUniforms(P({ tint: 60 })));
  assert.ok(magenta[1] < magenta[0] && magenta[1] < magenta[2]);
  // White balance gains are luminance-neutral in linear light.
  const u = computeUniforms(P({ warmth: 70, tint: -40 }));
  assert.ok(Math.abs(0.2126 * u.wb[0] + 0.7152 * u.wb[1] + 0.0722 * u.wb[2] - 1) < 1e-9);
});

test("contrast spreads tones apart; negative contrast pulls them together", () => {
  const up = computeUniforms(P({ contrast: 60 }));
  const down = computeUniforms(P({ contrast: -60 }));
  const dark = 0.25;
  const light = 0.75;
  const spread = (u: ReturnType<typeof computeUniforms>) =>
    adjustPixel(light, light, light, light, u)[0] - adjustPixel(dark, dark, dark, dark, u)[0];
  assert.ok(spread(up) > 0.5);
  assert.ok(spread(down) < 0.5);
});

test("saturation −100 makes greys; vibrance boosts dull colours more than strong ones", () => {
  const g = adjustPixel(0.8, 0.3, 0.2, 0.4, computeUniforms(P({ saturation: -100 })));
  assert.ok(Math.abs(g[0] - g[1]) < 1e-9 && Math.abs(g[1] - g[2]) < 1e-9);
  const u = computeUniforms(P({ vibrance: 60 }));
  const dull = adjustPixel(0.55, 0.5, 0.45, 0.5, u);
  const strong = adjustPixel(0.9, 0.2, 0.1, 0.4, u);
  const gain = (before: number[], after: number[]) => (after[0] - after[2]) / (before[0] - before[2]);
  assert.ok(gain([0.55, 0.5, 0.45], dull) > gain([0.9, 0.2, 0.1], strong));
});

test("geometry: no straighten needs no zoom; any tilt zooms just enough to fill", () => {
  assert.equal(coverScale(2528, 1696, 0), 1);
  const g = planGeometry(2528, 1696, { rotate: 0, straighten: 3 });
  assert.ok(g.scale > 1 && g.scale < 1.15);
  // Every output corner must land inside the source (no empty corners).
  for (const [x, y] of [[0, 0], [g.outW, 0], [0, g.outH], [g.outW, g.outH]]) {
    const [sx, sy] = outputToSource(x, y, 2528, 1696, g);
    assert.ok(sx >= -1e-6 && sx <= 2528 + 1e-6 && sy >= -1e-6 && sy <= 1696 + 1e-6, `${x},${y} -> ${sx},${sy}`);
  }
});

test("geometry: rotate 90° clockwise swaps the size and maps output top-left to source bottom-left", () => {
  const g = planGeometry(40, 20, { rotate: 90, straighten: 0 });
  assert.deepEqual([g.outW, g.outH], [20, 40]);
  const [sx, sy] = outputToSource(0.5, 0.5, 40, 20, g);
  assert.ok(Math.abs(sx - 0.5) < 1e-9 && Math.abs(sy - 19.5) < 1e-9, `${sx},${sy}`);
});

test("CPU render at defaults reproduces the photo exactly", () => {
  const w = 24;
  const h = 16;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < src.length; i++) src[i] = i % 4 === 3 ? 255 : (i * 37) % 256;
  const mask = buildLumaMask(src, w, h);
  const out = renderCpuPixels(src, w, h, mask, w, h, DEFAULT_ADJUST_PARAMS, w, h);
  let maxDiff = 0;
  for (let i = 0; i < src.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - src[i]));
  assert.ok(maxDiff <= 1, `max diff ${maxDiff}`);
});

test("Auto brightens a dark room, leaves a balanced one nearly alone, and warms a blue cast", () => {
  const dark = autoTone(solidImage(32, 32, [40, 38, 36]), 32, 32);
  assert.ok((dark.brightness || 0) > 20, `dark brightness ${dark.brightness}`);
  const ok = autoTone(solidImage(32, 32, [134, 132, 130]), 32, 32);
  assert.ok(Math.abs(ok.brightness || 0) <= 10, `balanced brightness ${ok.brightness}`);
  const blue = autoTone(solidImage(32, 32, [110, 128, 170]), 32, 32);
  assert.ok((blue.warmth || 0) > 0, `blue warmth ${blue.warmth}`);
});

test("Straighten Auto: the suggested angle actually straightens a tilted photo", () => {
  // Vertical stripes, then tilted 2.5° clockwise with the renderer itself.
  const w = 200;
  const h = 160;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.floor(x / 20) % 2 ? 230 : 40;
      src.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  const mask = buildLumaMask(src, w, h);
  const tilted = renderCpuPixels(src, w, h, mask, w, h, P({ straighten: 2.5 }), w, h);
  const suggested = estimateStraighten(tilted, w, h);
  assert.ok(Math.abs(suggested + 2.5) < 0.6, `suggested ${suggested}`);
  const fixed = renderCpuPixels(tilted, w, h, mask, w, h, P({ straighten: suggested }), w, h);
  assert.equal(estimateStraighten(fixed, w, h), 0);
  assert.equal(estimateStraighten(src, w, h), 0);
});

test("history: undo/redo, and a new change drops the redo branch", () => {
  let h = startHistory(DEFAULT_ADJUST_PARAMS);
  assert.equal(canUndo(h), false);
  h = pushStep(h, P({ brightness: 10 }));
  h = pushStep(h, P({ brightness: 20 }));
  assert.equal(pushStep(h, P({ brightness: 20 })), h, "no-op change is not recorded");
  h = undo(h);
  assert.equal(currentStep(h).brightness, 10);
  assert.ok(canRedo(h));
  h = pushStep(h, P({ contrast: 5 }));
  assert.equal(canRedo(h), false);
  h = redo(undo(undo(h)));
  assert.equal(currentStep(h).brightness, 10);
});
