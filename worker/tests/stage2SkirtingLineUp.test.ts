jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import sharp from "sharp";
import { planSkirtingLineUp, applySkirtingLineUp, fitLineUpScale } from "../src/pipeline/stage2Masked/core";

// 100x100 photo. The bed's wall runs from x 15 to the corner at x 53 (floor
// line rising from 90% to 70% down), then the next wall (floor line falling).
const realLine = Array.from({ length: 100 }, (_, x) => (x < 15 ? -1 : x <= 53 ? 0.9 - ((x - 15) / 38) * 0.2 : 0.7 + ((x - 53) / 47) * 0.15));
function room(): Uint8Array {
  const m = new Uint8Array(100 * 100);
  for (let y = 45; y <= 85; y++) for (let x = 22; x <= 50; x++) m[y * 100 + x] = 1; // bed + bedside table
  for (let y = 50; y <= 68; y++) for (let x = 62; x <= 66; x++) m[y * 100 + x] = 1; // plant against the next wall
  for (let y = 86; y <= 99; y++) for (let x = 30; x <= 75; x++) m[y * 100 + x] = 1; // rug on the open floor
  return m;
}
const run = { x1Pct: 16, x2Pct: 21, widthPct: 5, dyPct: -4.9 };

describe("skirting beside furniture: pull forward (Bedroom 05, Oct 2026)", () => {
  it("pulls the furniture against that wall forward: lower and bigger", () => {
    const plan = planSkirtingLineUp([run], room(), 100, 100, realLine);
    expect(plan.ok).toBe(true);
    expect(plan.k!).toBeGreaterThan(1.05);
    expect(plan.k!).toBeLessThan(1.25);
    expect(plan.wallPct![1]).toBeGreaterThanOrEqual(50);
    expect(plan.wallPct![1]).toBeLessThanOrEqual(56);
  });

  it("moves the bed and the rug, but not the plant standing against the next wall", () => {
    const plan = planSkirtingLineUp([run], room(), 100, 100, realLine);
    expect(plan.select![60 * 100 + 30]).toBe(1); // bed
    expect(plan.select![95 * 100 + 70]).toBe(1); // rug beyond the corner, on the open floor
    expect(plan.select![55 * 100 + 64]).toBe(0); // plant
  });

  it("never moves or overwrites a piece that stays", async () => {
    const m = room();
    const plan = planSkirtingLineUp([run], m, 100, 100, realLine);
    const img = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#808080" } }).png().toBuffer();
    const out = await applySkirtingLineUp(img, { floor: m }, m, plan, 100, 100);
    for (let y = 50; y <= 68; y++) for (let x = 62; x <= 66; x++) expect(out.masks.floor![y * 100 + x]).toBe(1);
  });

  it("leaves wall art above the headboard exactly where it hangs (Nov 2026, Bedroom_02: black bar under the art)", async () => {
    const m = room();
    const plan = planSkirtingLineUp([run], m, 100, 100, realLine);
    expect(plan.ok).toBe(true);
    // Grey wall, a black picture frame just above the bed (inside the margin that moves with it).
    const px = Buffer.alloc(100 * 100 * 3, 128);
    const art = new Uint8Array(100 * 100);
    for (let y = 30; y <= 44; y++) for (let x = 28; x <= 44; x++) { art[y * 100 + x] = 1; px.fill(0, (y * 100 + x) * 3, (y * 100 + x) * 3 + 3); }
    const img = await sharp(px, { raw: { width: 100, height: 100, channels: 3 } }).png().toBuffer();
    const out = await applySkirtingLineUp(img, { floor: m, artRegion: art }, m, plan, 100, 100);
    const { data } = await sharp(out.staged).raw().toBuffer({ resolveWithObject: true });
    for (let y = 30; y <= 44; y++) for (let x = 28; x <= 44; x++) {
      expect(out.masks.artRegion![y * 100 + x]).toBe(1);
      expect(data[(y * 100 + x) * 3]).toBe(0);
    }
    // ...and no copy of the frame appears below it.
    let darkBelow = 0;
    for (let y = 45; y <= 60; y++) for (let x = 20; x <= 52; x++) if (data[(y * 100 + x) * 3] < 60) darkBelow++;
    expect(darkBelow).toBe(0);
  });

  it("refuses when offsets point both ways, an offset is too large, or nothing stands beside it", () => {
    expect(planSkirtingLineUp([run, { x1Pct: 70, x2Pct: 74, widthPct: 4, dyPct: 3 }], room(), 100, 100, realLine).ok).toBe(false);
    expect(planSkirtingLineUp([{ ...run, dyPct: -12 }], room(), 100, 100, realLine).ok).toBe(false);
    const empty = new Uint8Array(100 * 100);
    expect(planSkirtingLineUp([run], empty, 100, 100, realLine).ok).toBe(false);
  });

  it("moves a piece whole when it reaches past the end of the wall (Nov 2026 test run, Bedroom_05: no torn duvet)", () => {
    const m = room();
    // The foot of the bed carries on past the corner, above the next wall's floor line.
    for (let y = 45; y <= 60; y++) for (let x = 51; x <= 58; x++) m[y * 100 + x] = 1;
    const plan = planSkirtingLineUp([run], m, 100, 100, realLine);
    expect(plan.ok).toBe(true);
    expect(plan.select![50 * 100 + 57]).toBe(1); // part of the bed beyond the wall's end moves with it
    expect(plan.select![55 * 100 + 64]).toBe(0); // the plant still stays
  });

  it("refuses rather than tear a piece split between two walls", () => {
    const m = new Uint8Array(100 * 100);
    for (let y = 50; y <= 68; y++) for (let x = 40; x <= 66; x++) m[y * 100 + x] = 1; // sideboard across the corner
    const plan = planSkirtingLineUp([{ x1Pct: 36, x2Pct: 41, widthPct: 5, dyPct: -3 }], m, 100, 100, realLine);
    expect(plan.ok).toBe(false);
    expect(plan.why).toMatch(/across two walls/);
  });
});

describe("skirting line-up fitted along the whole wall (Nov 2026: steps beside lined-up furniture)", () => {
  // Gemini's floor line, made by scaling the real one about (vx, vy) by 1/k
  // (the plan scales about the selected furniture's centre, x 48.5, and the
  // horizon at 45%): a move by k lines it up everywhere along the wall.
  const gemOffsets = (k: number, tilt = 0, vx = 48.5, vy = 45) => {
    const off: Array<number | null> = realLine.map(() => null);
    for (let x = 15; x <= 53; x++) {
      const xg = Math.round(vx + (x - vx) / k);
      if (xg < 15 || xg > 53 || (xg >= 22 && xg <= 50)) continue; // hidden behind the bed (x 22-50)
      const yG = vy + (realLine[x] * 100 - vy) / k + tilt * (xg - 35);
      off[xg] = +(yG - realLine[xg] * 100).toFixed(3); // % of a 100 px height
    }
    return off;
  };

  it("uses columns on both sides of the furniture and finds the move that fits them all", () => {
    const m = room();
    const off = gemOffsets(1.06);
    const plan = planSkirtingLineUp([{ x1Pct: 16, x2Pct: 21, widthPct: 5, dyPct: off[17] ?? -4 }], m, 100, 100, realLine, off);
    expect(plan.ok).toBe(true);
    expect(plan.fit?.method).toBe("wall");
    expect(plan.fit?.sides).toBe("both sides");
    expect(plan.fit!.residualPct).toBeLessThanOrEqual(0.6);
  });

  it("refuses when Gemini's floor line runs at a different angle (no move can line it up everywhere)", () => {
    const m = room();
    const off = gemOffsets(1.06, 0.25);
    const plan = planSkirtingLineUp([{ x1Pct: 16, x2Pct: 21, widthPct: 5, dyPct: off[17] ?? -4 }], m, 100, 100, realLine, off);
    expect(plan.ok).toBe(false);
    expect(plan.why).toMatch(/different angle|isn't straight/);
  });

  it("without wall-wide measurements it still lines up on the one stretch (as before)", () => {
    const plan = planSkirtingLineUp([run], room(), 100, 100, realLine);
    expect(plan.ok).toBe(true);
    expect(plan.fit?.method).toBe("one stretch");
  });
});

describe("line-up fit at photo size (800 columns)", () => {
  // One wall across the photo; its real floor line slopes down to the right.
  const W = 800, H = 600, vx = 400, vy = 0.45 * H;
  const real = Array.from({ length: W }, (_, c) => 0.62 + (c / W) * 0.2);
  // Gemini's line seen left (x 120-220) and right (x 580-680) of a bed at x 240-560.
  const gemini = (k: number, tiltPerPx: number) => {
    const off: Array<number | null> = real.map(() => null);
    for (let x = 0; x < W; x++) {
      const xg = Math.round(vx + (x - vx) / k);
      if (!((xg >= 120 && xg <= 220) || (xg >= 580 && xg <= 680))) continue;
      const yG = vy + (real[x] * H - vy) / k + tiltPerPx * (xg - 400);
      off[xg] = ((yG - real[xg] * H) / H) * 100;
    }
    return off;
  };

  it("finds the move when Gemini's floor line is the real one, just nearer or further", () => {
    const f = fitLineUpScale(gemini(1.08, 0), real, [0, W - 1], [240, 560], W, H, vx, vy)!;
    expect(f.slantMeasured).toBe(true);
    expect(f.k).toBeCloseTo(1.08, 1);
    expect(f.residualPct).toBeLessThan(0.6);
  });

  it("corrects a small tilt of Gemini's floor line (Bedroom_02): the move also tilts the furniture", () => {
    const f = fitLineUpScale(gemini(1.08, 0.02), real, [0, W - 1], [240, 560], W, H, vx, vy)!;
    expect(f.slantMeasured).toBe(true);
    expect(Math.abs(f.s)).toBeGreaterThan(0.005);
    expect(Math.abs(f.s)).toBeLessThanOrEqual(0.035);
    expect(f.residualPct).toBeLessThan(0.6);
  });

  it("still reports a large leftover when the tilt is beyond the limit (about 2 deg)", () => {
    const f = fitLineUpScale(gemini(1.08, 0.12), real, [0, W - 1], [240, 560], W, H, vx, vy)!;
    expect(f.slantMeasured).toBe(true);
    expect(f.residualPct).toBeGreaterThan(0.6);
  });

  it("ignores stray readings (a door frame read as the floor)", () => {
    const off = gemini(1.08, 0);
    for (let c = 670; c <= 680; c++) off[c] = -9;
    const f = fitLineUpScale(off, real, [0, W - 1], [240, 560], W, H, vx, vy)!;
    expect(f.residualPct).toBeLessThan(0.6);
  });
});

describe("tilting furniture keeps upright lines upright", () => {
  it("a lamp stand (vertical bar) stays vertical; the bar's foot drops more on one side than the other", async () => {
    const W = 200, H = 200;
    const m = new Uint8Array(W * H);
    for (let y = 60; y <= 150; y++) for (let x = 60; x <= 140; x++) m[y * W + x] = 1; // the piece
    const px = Buffer.alloc(W * H * 3, 200);
    for (let y = 70; y <= 140; y++) for (let x = 98; x <= 102; x++) px.fill(0, (y * W + x) * 3, (y * W + x) * 3 + 3); // black upright
    const img = await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
    const plan: any = { ok: true, select: m, k: 1, vx: 60, vy: 90, s: 0.05 };
    const out = await applySkirtingLineUp(img, { floor: m }, m, plan, W, H);
    const { data } = await sharp(out.staged).raw().toBuffer({ resolveWithObject: true });
    const darkCols = (y: number) => { const c: number[] = []; for (let x = 0; x < W; x++) if (data[(y * W + x) * 3] < 60) c.push(x); return c; };
    // Same columns on every row: no lean.
    const top = darkCols(95), mid = darkCols(120);
    expect(top.length).toBeGreaterThan(0);
    expect(top).toEqual(mid);
    // Shifted down by tilt * (x - vx) = 0.05 * 40 = 2 px at x=100.
    let firstDark = -1;
    for (let y = 0; y < H; y++) if (data[(y * W + 100) * 3] < 60) { firstDark = y; break; }
    expect(firstDark).toBe(72);
  });
});
