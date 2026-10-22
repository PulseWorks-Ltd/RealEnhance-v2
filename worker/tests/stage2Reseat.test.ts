jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { checkFloatingFurniture } from "../src/pipeline/stage2Masked/core";
import { shiftMaskDown, shiftPictureDown } from "../src/pipeline/stage2Masked/pipeline";

const DIR = path.join(__dirname, "../../Test Images/Floating Check Fixtures/Bedroom_BedsideOverBeigeWall");
const maybe = fs.existsSync(DIR) ? it : it.skip;

describe("re-seat: move Gemini's furniture down onto the real floor", () => {
  maybe("puts the floating bedside table (f5b2478d) back on the real floor", async () => {
    const o = fs.readFileSync(path.join(DIR, "1_original.jpg"));
    const { width: w, height: h } = await sharp(o).metadata() as { width: number; height: number };
    const raw = await sharp(path.join(DIR, "3_mask_traced.png")).resize(w, h, { fit: "fill" }).greyscale().raw().toBuffer();
    const mask = Uint8Array.from(raw, (v: number) => (v > 127 ? 1 : 0));
    const before = await checkFloatingFurniture(o, mask, w, h);
    expect(before.floating).toBe(true);
    const gap = before.runs[0].gapPct;
    const after = await checkFloatingFurniture(o, shiftMaskDown(mask, w, h, Math.round((gap / 100) * h)), w, h);
    expect(after.floating).toBe(false);
  }, 60000);

  it("moves masks and pictures straight down, filling the top from the real photo", async () => {
    const w = 4, h = 6;
    const m = new Uint8Array(w * h); m[1 * w + 2] = 1;
    const s = shiftMaskDown(m, w, h, 2);
    expect(s[3 * w + 2]).toBe(1);
    expect(s.reduce((a, b) => a + b, 0)).toBe(1);
    const red = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
    const blue = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 255 } } }).png().toBuffer();
    const out = await sharp(await shiftPictureDown(red, blue, w, h, 2)).raw().toBuffer();
    expect([out[0], out[2]]).toEqual([0, 255]);                 // top row from the real photo
    expect([out[(3 * w) * 3], out[(3 * w) * 3 + 2]]).toEqual([255, 0]); // Gemini's picture below
  });
});
