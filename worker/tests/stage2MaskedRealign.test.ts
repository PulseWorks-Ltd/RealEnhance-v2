jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { checkCameraAlignment, canRealign, alignStagedToOriginal } from "../src/pipeline/stage2Masked/core";

const IMG = path.join(__dirname, "../../Test Images/Floating Check Fixtures/Bedroom_05/1_original.jpg");
const maybe = fs.existsSync(IMG) ? it : it.skip;

describe("masked Stage 2 line-up", () => {
  maybe("measures a room drawn 4% lower and moves it back into place", async () => {
    const original = await sharp(fs.readFileSync(IMG)).resize(1200).png().toBuffer();
    const m = await sharp(original).metadata();
    const W = m.width!, H = m.height!, dy = Math.round(H * 0.04);
    // "Gemini" drew the same room 4% lower (top rows repeated, bottom cut off)
    const shifted = await sharp(original)
      .extract({ left: 0, top: 0, width: W, height: H - dy })
      .extend({ top: dy, bottom: 0, left: 0, right: 0, extendWith: "copy" })
      .png().toBuffer();
    const cam = await checkCameraAlignment(original, shifted);
    expect(Math.abs(cam.dyPct - 4)).toBeLessThan(1);
    expect(Math.abs(cam.scale - 1)).toBeLessThan(0.02);
    expect(canRealign(cam)).toBe(true);
    const al = await alignStagedToOriginal(original, shifted, cam);
    expect(al.emptyPct).toBeGreaterThan(2);
    expect(al.emptyPct).toBeLessThan(6);
    // after the line-up the picture matches the real photo again
    const [a, b] = await Promise.all([sharp(original).removeAlpha().raw().toBuffer(), sharp(al.aligned).removeAlpha().raw().toBuffer()]);
    const [c] = [await sharp(shifted).removeAlpha().raw().toBuffer()];
    let before = 0, after = 0;
    for (let i = 0; i < a.length; i++) { before += Math.abs(a[i] - c[i]); after += Math.abs(a[i] - b[i]); }
    expect(after / a.length).toBeLessThan(before / a.length / 3);
  }, 120000);

  it("does not line up when the fit barely improves (a new viewpoint)", () => {
    expect(canRealign({ identity: 0.36, best: 0.35, gain: 0.011, scale: 1.125, dxPct: -2, dyPct: -4.5, shiftPct: 4.9, moved: false })).toBe(false);
    expect(canRealign({ identity: 0.34, best: 0.34, gain: 0, scale: 1, dxPct: 0, dyPct: 0, shiftPct: 0, moved: false })).toBe(false);
  });
});

describe("line up before tracing (zoomed/shifted staging)", () => {
  const { shouldPrealign } = require("../src/pipeline/stage2Masked/core");
  const cam = (o: any) => ({ identity: 0.25, best: 0.22, gain: 0.03, scale: 1, dxPct: 0, dyPct: 0, shiftPct: 0, moved: false, ...o });
  it("lines up a 3.5% zoom even when the fit gain is small (production 006)", () => {
    expect(shouldPrealign(cam({ scale: 1.035, gain: 0.018, shiftPct: 1.78 }))).toBe(true);
  });
  it("lines up a 1.5%+ shift", () => {
    expect(shouldPrealign(cam({ shiftPct: 1.6 }))).toBe(true);
  });
  it("leaves small moves and noisy readings to the room check", () => {
    expect(shouldPrealign(cam({ scale: 1.01, shiftPct: 0.5 }))).toBe(false);
    expect(shouldPrealign(cam({ scale: 1.05, gain: 0.005 }))).toBe(false);
    expect(shouldPrealign(null)).toBe(false);
  });
});
