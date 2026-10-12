jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import fs from "fs";
import path from "path";
import { checkFraming, checkCameraAlignment, checkFloatingFurniture, REFRAMED_MEDIAN_DIFF } from "../src/pipeline/stage2Masked/core";
import sharp from "sharp";

const RUN = path.join(__dirname, "../../Test Images/Stage2_MaskPasteback/2026-10-11T05-21-43-086Z");
const have = fs.existsSync(path.join(RUN, "Bedroom12/2_staged_raw.webp"));
const maybe = have ? it : it.skip;

describe("masked Stage 2 reshape checks", () => {
  maybe("does not flag good results", async () => {
    for (const name of ["Bedroom14", "Living07", "Living10", "Validator_2327860184"]) {
      const o = fs.readFileSync(path.join(RUN, name, "1_original.jpg"));
      const s = fs.readFileSync(path.join(RUN, name, "2_staged_raw.webp"));
      const m = await sharp(o).metadata();
      const r = await checkFraming(o, s, new Uint8Array(m.width! * m.height!), m.width!, m.height!);
      expect({ name, flagged: r.medianDiff > REFRAMED_MEDIAN_DIFF }).toEqual({ name, flagged: false });
    }
  }, 60000);

  maybe("ignores brightness but catches a zoomed or shifted camera", async () => {
    for (const name of ["Bedroom14", "Living07", "Validator_2327860184"]) {
      const o = fs.readFileSync(path.join(RUN, name, "1_original.jpg"));
      const m = await sharp(o).metadata();
      const w = m.width!, h = m.height!;
      const s = await sharp(fs.readFileSync(path.join(RUN, name, "2_staged_raw.webp"))).resize(w, h, { fit: "fill" }).toBuffer();
      const brighter = await sharp(s).linear(1.16, 0).toBuffer();
      const f = await checkFraming(o, brighter, new Uint8Array(w * h), w, h);
      expect({ name, framing: f.framingChanged }).toEqual({ name, framing: false });
      expect({ name, moved: (await checkCameraAlignment(o, brighter)).moved }).toEqual({ name, moved: false });
      expect({ name, moved: (await checkCameraAlignment(o, s)).moved }).toEqual({ name, moved: false });
      const zw = Math.round(w * 0.94), zh = Math.round(h * 0.94);
      const zoomed = await sharp(await sharp(s).resize(zw, zh).toBuffer())
        .extend({ top: Math.floor((h - zh) / 2), bottom: Math.ceil((h - zh) / 2), left: Math.floor((w - zw) / 2), right: Math.ceil((w - zw) / 2), background: { r: 200, g: 200, b: 200 } })
        .toBuffer();
      const z = await checkCameraAlignment(o, zoomed);
      expect({ name, moved: z.moved }).toEqual({ name, moved: true });
      expect(Math.abs(z.scale - 0.94)).toBeLessThan(0.02);
    }
  }, 400000);

  const FIX = path.join(__dirname, "../../Test Images/Floating Check Fixtures");
  const haveFix = fs.existsSync(path.join(FIX, "Bedroom_14/3_mask_traced.png"));
  (haveFix ? it : it.skip)("flags furniture whose legs stop short of the real floor", async () => {
    const expected: Record<string, boolean> = { Bedroom_14: true, Bedroom_07: true, Bedroom_11: false, Bedroom_12: false };
    for (const [name, floats] of Object.entries(expected)) {
      const o = fs.readFileSync(path.join(FIX, name, "1_original.jpg"));
      const m = await sharp(o).metadata();
      const raw = await sharp(path.join(FIX, name, "3_mask_traced.png")).resize(m.width!, m.height!, { fit: "fill" }).greyscale().raw().toBuffer();
      const mask = Uint8Array.from(raw, (v: number) => (v > 127 ? 1 : 0));
      const r = await checkFloatingFurniture(o, mask, m.width!, m.height!);
      expect({ name, floating: r.floating }).toEqual({ name, floating: floats });
    }
  }, 120000);
});
