jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import fs from "fs";
import os from "os";
import path from "path";
import { runMaskedStage2Job, REFRAMED_EARLY_MEDIAN_DIFF } from "../src/pipeline/stage2Masked/pipeline";
import { checkFraming, checkCameraAlignment } from "../src/pipeline/stage2Masked/core";
import sharp from "sharp";

const RUN = path.join(__dirname, "../../Test Images/Stage2_MaskPasteback/2026-10-11T05-21-43-086Z");
const have = fs.existsSync(path.join(RUN, "Bedroom12/2_staged_raw.webp"));
const maybe = have ? it : it.skip;

describe("masked Stage 2 early reshape screen", () => {
  maybe("catches a reshaped room before any tracing call", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "early-reshape-"));
    let traceLoads = 0;
    const res = await runMaskedStage2Job({
      inputPath: path.join(RUN, "Bedroom12/1_original.jpg"),
      roomType: "bedroom",
      jobId: "job_test",
      doors: null,
      maxRestages: 0,
      stage: async () => path.join(RUN, "Bedroom12/2_staged_raw.webp"),
      outputPathFor: (a) => path.join(work, `out${a}.webp`),
      workDir: work,
      replay: () => { traceLoads++; return null; },
    });
    expect(res.ok).toBe(false);
    expect((res as any).reasons).toContain("room reshaped");
    expect(res.reports[0].framingCheck.early).toBe(true);
    expect(traceLoads).toBe(0);
  }, 60000);

  maybe("does not flag good results", async () => {
    for (const name of ["Bedroom14", "Living07", "Living10", "Validator_2327860184"]) {
      const o = fs.readFileSync(path.join(RUN, name, "1_original.jpg"));
      const s = fs.readFileSync(path.join(RUN, name, "2_staged_raw.webp"));
      const m = await sharp(o).metadata();
      const r = await checkFraming(o, s, new Uint8Array(m.width! * m.height!), m.width!, m.height!);
      expect({ name, flagged: r.medianDiff > REFRAMED_EARLY_MEDIAN_DIFF }).toEqual({ name, flagged: false });
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
});
