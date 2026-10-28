jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { checkWholeImageAnswer, pasteMarkedArea, lineUpAroundArea, buildWholeImageRemovePrompt } from "../src/pipeline/editWholeImage";
import sharp from "sharp";

// A plain "wall" with a gentle gradient and a dark "painting" in the middle.
const W = 200, H = 150;
function photo(): Buffer {
  const b = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3, v = 200 + Math.round((x / W) * 30) + ((x * 7 + y * 13) % 5);
    const art = x >= 80 && x < 120 && y >= 40 && y < 100;
    b[i] = art ? 40 : v; b[i + 1] = art ? 50 : v - 2; b[i + 2] = art ? 60 : v - 5;
  }
  return b;
}
function maskRect(x1: number, y1: number, x2: number, y2: number) {
  const m = new Uint8Array(W * H);
  for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) m[y * W + x] = 1;
  return m;
}
const mask = maskRect(76, 36, 124, 104);
function wallOnly(src: Buffer): Buffer {
  const b = Buffer.from(src);
  for (let y = 40; y < 100; y++) for (let x = 80; x < 120; x++) { const i = (y * W + x) * 3, v = 200 + Math.round((x / W) * 30); b[i] = v; b[i + 1] = v - 2; b[i + 2] = v - 5; }
  return b;
}

describe("whole-image remove", () => {
  it("accepts an answer that removed the item and kept the wall around it", () => {
    const chk = checkWholeImageAnswer(photo(), wallOnly(photo()), mask, W, H);
    expect(chk.ok).toBe(true);
  });

  it("rejects an answer where nothing was removed", () => {
    const chk = checkWholeImageAnswer(photo(), photo(), mask, W, H);
    expect(chk.ok).toBe(false);
    expect(chk.why).toMatch(/not removed/);
  });

  it("rejects an answer that redrew the scene around the item (demo job_39c3b786)", () => {
    const other = Buffer.alloc(W * H * 3);
    for (let i = 0; i < other.length; i += 3) { const y = Math.floor(i / 3 / W); other[i] = y > 90 ? 60 : 240; other[i + 1] = y > 90 ? 55 : 240; other[i + 2] = y > 90 ? 70 : 245; }
    expect(checkWholeImageAnswer(photo(), other, mask, W, H).ok).toBe(false);
  });

  it("pastes only the marked area (plus its soft edge); the rest of the photo is untouched", async () => {
    const p = photo();
    const answer = wallOnly(p);
    // Gemini changed something far from the item too: must not come through.
    for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) { const i = (y * W + x) * 3; answer[i] = 0; answer[i + 1] = 255; answer[i + 2] = 0; }
    const out = await sharp(await pasteMarkedArea(p, answer, mask, [1, 1, 1], W, H)).raw().toBuffer();
    for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) { const i = (y * W + x) * 3; expect([out[i], out[i + 1], out[i + 2]]).toEqual([p[i], p[i + 1], p[i + 2]]); }
    const c = (70 * W + 100) * 3; // centre of the painting -> wall now
    expect(out[c]).toBeGreaterThan(180);
  });

  it("lines up an answer shifted by a few pixels", () => {
    const p = photo();
    const shifted = Buffer.alloc(p.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = Math.max(0, Math.min(W - 1, x - 3)), d = (y * W + x) * 3, s = (y * W + sx) * 3;
      shifted[d] = p[s]; shifted[d + 1] = p[s + 1]; shifted[d + 2] = p[s + 2];
    }
    // strong vertical line in the wall so the shift is measurable
    for (const b of [p, shifted]) for (let y = 0; y < H; y++) { const x = b === p ? 70 : 73; const i = (y * W + x) * 3; b[i] = b[i + 1] = b[i + 2] = 0; }
    expect(lineUpAroundArea(p, shifted, mask, W, H).dx).toBe(3);
  });

  it("tells Gemini to return the whole photo and change only the marked area", () => {
    const t = buildWholeImageRemovePrompt("remove the painting");
    expect(t).toMatch(/Change nothing outside the red-marked area/);
    expect(t).toMatch(/Return the whole photo/);
    expect(t).toMatch(/remove the painting/);
  });
});
