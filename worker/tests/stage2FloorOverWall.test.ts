jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "3:2" }));
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { floorOverRealWall, checkFloorMoved } from "../src/pipeline/stage2Masked/core";

// job_609fbe6a (Oct 2026): Gemini pushed the right-hand wall back. Attempt 1
// stood a bedside table on that floor; attempt 2's blend showed floor (and a
// shaded "corner" wall) over the real wall, which was copied as a blurred
// grey panel.
const DIR = path.join(__dirname, "../../Test Images/Floor Over Wall Fixtures/job_609fbe6a");
const FLOAT = path.join(__dirname, "../../Test Images/Floating Check Fixtures");
const maybe = fs.existsSync(DIR) ? it : it.skip;

async function maskOf(file: string, w: number, h: number) {
  const data = await sharp(file).resize(w, h, { fit: "fill" }).greyscale().raw().toBuffer();
  return Uint8Array.from(data, (v) => (v > 127 ? 1 : 0));
}
const share = (mask: Uint8Array, w: number, h: number, x1: number, x2: number, y1: number, y2: number) => {
  let n = 0, t = 0;
  for (let y = Math.round(y1 * h); y < Math.round(y2 * h); y++) for (let x = Math.round(x1 * w); x < Math.round(x2 * w); x++) { t++; if (mask[y * w + x]) n++; }
  return n / t;
};

describe("floor over the real wall", () => {
  maybe("finds Gemini's floor over the real wall at the right edge (staging and blend)", async () => {
    const original = fs.readFileSync(path.join(DIR, "1_original.jpg"));
    const { width: w = 0, height: h = 0 } = await sharp(original).metadata();
    const staged = await floorOverRealWall(original, fs.readFileSync(path.join(DIR, "2_staged_raw_attempt1.jpg")), await maskOf(path.join(DIR, "3_mask_final_attempt1.png"), w, h), w, h);
    expect(staged.maxRisePct).toBeGreaterThan(8);
    expect(share(staged.mask, w, h, 0, 0.8, 0, 1)).toBe(0);
    const blend = await floorOverRealWall(original, fs.readFileSync(path.join(DIR, "9_harmonise_raw_attempt2.jpg")), await maskOf(path.join(DIR, "3_mask_tight_attempt2.png"), w, h), w, h, { fullColumns: true });
    // The strip right of the bed, full height; nothing on the left.
    expect(share(blend.mask, w, h, 0.9, 0.97, 0.6, 0.85)).toBeGreaterThan(0.8);
    expect(share(blend.mask, w, h, 0, 0.8, 0, 1)).toBe(0);
  }, 60000);

  maybe("finds nothing when the picture is the real photo", async () => {
    const original = fs.readFileSync(path.join(DIR, "1_original.jpg"));
    const { width: w = 0, height: h = 0 } = await sharp(original).metadata();
    const r = await floorOverRealWall(original, original, null, w, h, { fullColumns: true });
    expect(r.pctOfImage).toBe(0);
  }, 60000);

  // Bedroom_14: same view, floor line where it belongs.
  const goodDirs = ["Bedroom_14"].filter((d) => fs.existsSync(path.join(FLOAT, d, "2_staged_raw.webp")));
  for (const d of goodDirs) {
    it(`finds nothing on ${d} (floor line where it belongs)`, async () => {
      const original = fs.readFileSync(path.join(FLOAT, d, "1_original.jpg"));
      const { width: w = 0, height: h = 0 } = await sharp(original).metadata();
      const r = await floorOverRealWall(original, fs.readFileSync(path.join(FLOAT, d, "2_staged_raw.webp")), await maskOf(path.join(FLOAT, d, "3_mask_traced.png"), w, h), w, h);
      expect(r.pctOfImage).toBe(0);
    }, 60000);
  }

  // Oct 2026 demo, Bedroom_14: a lit lamp's warm glow on the white wall looked
  // like the beige carpet, and both attempts failed as "floor moved", though
  // Gemini's skirting was exactly where the real one is.
  const LAMP = path.join(__dirname, "../../Test Images/Floor Over Wall Fixtures/Bedroom_14_lamp");
  (fs.existsSync(LAMP) ? it : it.skip)("does not mistake a lamp's glow on the wall for floor (demo Bedroom_14)", async () => {
    const original = fs.readFileSync(path.join(LAMP, "1_original.jpg"));
    const staged = fs.readFileSync(path.join(LAMP, "2_staged_raw.jpg"));
    const { width: w = 0, height: h = 0 } = await sharp(original).metadata();
    const mask = await maskOf(path.join(LAMP, "3_mask_final.png"), w, h);
    expect((await checkFloorMoved(original, staged, mask, w, h)).moved).toBe(false);
    expect((await floorOverRealWall(original, staged, mask, w, h)).pctOfImage).toBe(0);
  }, 60000);
});
