jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import sharp from "sharp";
import { findBandLegs } from "../src/pipeline/stage2Masked/core";

// A 400x300 "timber" image with stripes; the whole frame is traced (solid),
// nothing is core, so everything is edge band.
async function scene(draw: (px: Buffer, w: number, h: number) => void) {
  const w = 400, h = 300;
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { px[i * 3] = 120; px[i * 3 + 1] = 70; px[i * 3 + 2] = 52; }
  draw(px, w, h);
  const img = await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  return { img, w, h, solid: new Uint8Array(w * h).fill(1), core: new Uint8Array(w * h) };
}
const paint = (px: Buffer, w: number, x1: number, y1: number, x2: number, y2: number, v: number[]) => {
  for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) { const i = (y * w + x) * 3; px[i] = v[0]; px[i + 1] = v[1]; px[i + 2] = v[2]; }
};

describe("legs in the edge band", () => {
  it("keeps a long upright dark stripe (a chair leg over timber)", async () => {
    const s = await scene((px, w) => paint(px, w, 200, 60, 204, 220, [70, 40, 28]));
    const r = await findBandLegs(s.img, s.solid, s.core, s.w, s.h);
    let onLeg = 0;
    for (let y = 80; y < 200; y++) onLeg += r.legs[y * s.w + 202];
    expect(onLeg).toBeGreaterThan(100);
    expect(r.legs[150 * s.w + 100]).toBe(0); // plain floor is not a leg
  });

  it("ignores stripes running across (floorboard joins)", async () => {
    const s = await scene((px, w) => { for (const y of [80, 120, 160, 200]) paint(px, w, 20, y, 380, y + 3, [70, 40, 28]); });
    const r = await findBandLegs(s.img, s.solid, s.core, s.w, s.h);
    expect(r.pctOfImage).toBe(0);
  });

  it("only looks in the band, never outside the traced shape", async () => {
    const s = await scene((px, w) => paint(px, w, 200, 60, 204, 220, [70, 40, 28]));
    s.solid.fill(0);
    const r = await findBandLegs(s.img, s.solid, s.core, s.w, s.h);
    expect(r.pctOfImage).toBe(0);
  });
});
