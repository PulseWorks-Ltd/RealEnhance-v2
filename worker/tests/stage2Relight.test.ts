jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import sharp from "sharp";
import { compositeRelight } from "../src/pipeline/stage2Masked/relight";
jest.setTimeout(20000); // image work: ~4 s per test on a slow machine

// 400x300 room: wall (light) on top, carpet (mid, textured) below y=200, a
// dark wall corner edge at x=100. Furniture: a box at x 180-260, y 140-210.
const W = 400, H = 300;
const rnd = (x: number, y: number) => ((x * 73856093) ^ (y * 19349663)) % 7; // fixed "carpet grain"
function room(): Buffer {
  const b = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = y < 200 ? (x < 100 ? 150 : 215) : 120 + rnd(x, y) * 3;
    if (x >= 180 && x <= 260 && y >= 140 && y <= 210) v = 90; // furniture
    b.set([v, v, v], (y * W + x) * 3);
  }
  return b;
}
const png = (buf: Buffer) => sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
async function mask(fn: (x: number, y: number) => boolean) {
  const m = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = fn(x, y) ? 255 : 0;
  return sharp(m, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
}
const inFurn = (x: number, y: number) => x >= 180 && x <= 260 && y >= 140 && y <= 210;
const inCore = (x: number, y: number) => x >= 184 && x <= 256 && y >= 144 && y <= 206;
const inZone = (x: number, y: number) => !inFurn(x, y) && x >= 120 && x <= 330 && y >= 90 && y <= 260;
async function run(blend: Buffer) {
  const safe = room();
  const out = await compositeRelight(await png(safe), await png(blend), await mask(inFurn), await mask(inCore), await mask(inZone), null);
  const raw = await sharp(out.buffer).removeAlpha().raw().toBuffer();
  const lum = (b: Buffer, x: number, y: number) => b[(y * W + x) * 3];
  return { safe, raw, lum, out };
}

describe("relit final: the blend's lighting on the real room", () => {
  it("carries a soft shadow next to the furniture", async () => {
    const blend = room();
    for (let y = 205; y < 245; y++) for (let x = 170; x < 280; x++) for (let c = 0; c < 3; c++) blend[(y * W + x) * 3 + c] = Math.round(blend[(y * W + x) * 3 + c] * 0.7);
    const { safe, raw, lum } = await run(blend);
    expect(lum(raw, 220, 225)).toBeLessThan(lum(safe, 220, 225) * 0.9);
  });

  it("keeps the real room's edges even where Gemini moved them", async () => {
    const blend = room();
    // Gemini moved the wall corner edge 12 px to the right and lit the wall.
    for (let y = 0; y < 200; y++) for (let x = 100; x < 112; x++) blend.set([150, 150, 150], (y * W + x) * 3);
    const { safe, raw, lum } = await run(blend);
    for (const y of [110, 150]) {
      expect(Math.abs(lum(raw, 98, y) - lum(safe, 98, y))).toBeLessThan(12);
      // Just right of the real corner it is still the light wall, not Gemini's moved dark strip.
      expect(lum(raw, 106, y)).toBeGreaterThan(190);
    }
  });

  it("does not bring in an object Gemini invented", async () => {
    const blend = room();
    // A textured dark "bedside table" that isn't in the real room.
    for (let y = 150; y < 205; y++) for (let x = 280; x < 320; x++) { const v = (x + y) % 6 < 3 ? 40 : 110; blend.set([v, v - 10, v - 20], (y * W + x) * 3); }
    const { safe, raw, lum } = await run(blend);
    let d = 0, k = 0;
    for (let y = 155; y < 200; y += 3) for (let x = 284; x < 316; x += 3) { d += Math.abs(lum(raw, x, y) - lum(safe, x, y)); k++; }
    expect(d / k).toBeLessThan(8);
  });

  it("changes nothing away from the furniture", async () => {
    const blend = room();
    for (let i = 0; i < blend.length; i++) blend[i] = Math.round(blend[i] * 0.85); // whole-room relight
    const { safe, raw, lum } = await run(blend);
    for (const [x, y] of [[20, 20], [380, 20], [20, 290], [390, 290]]) expect(Math.abs(lum(raw, x, y) - lum(safe, x, y))).toBeLessThanOrEqual(2);
  });
});

describe("relit final: no-borrow area beside the furniture (Nov 2026, Bedroom_02)", () => {
  it("carries the surrounding shadow across it instead of leaving a bright block", async () => {
    const safe = room();
    // The blend: a soft shadow on the wall right of the furniture (x 262-320),
    // and Gemini's dark floor drawn over the real wall in part of it.
    const blend = room();
    for (let y = 120; y < 200; y++) for (let x = 262; x < 320; x++) {
      const i = (y * W + x) * 3;
      const v = x >= 280 && x < 300 && y >= 170 ? 110 : Math.round(blend[i] * 0.75);
      blend.set([v, v, v], i);
    }
    const noBorrow = await mask((x, y) => x >= 278 && x < 302 && y >= 165 && y < 200);
    const out = await compositeRelight(await png(safe), await png(blend), await mask(inFurn), await mask(inCore), await mask(inZone), noBorrow);
    const raw = await sharp(out.buffer).removeAlpha().raw().toBuffer();
    const at = (x: number, y: number) => raw[(y * W + x) * 3];
    // Inside the no-borrow area: shaded like its surroundings (not the bright
    // real wall, and not Gemini's dark floor).
    expect(at(290, 185)).toBeLessThan(205);
    expect(at(290, 185)).toBeGreaterThan(130);
    expect(Math.abs(at(290, 185) - at(270, 185))).toBeLessThan(25);
  }, 20000);
});
