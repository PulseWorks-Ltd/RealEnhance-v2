jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import fs from "fs";
import os from "os";
import path from "path";
import { runMaskedStage2Job, REFRAMED_EARLY_MEDIAN_DIFF } from "../src/pipeline/stage2Masked/pipeline";
import { checkFraming } from "../src/pipeline/stage2Masked/core";
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
});
