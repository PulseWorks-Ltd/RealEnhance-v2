jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { checkCameraAlignment, alignStagedToOriginal, planEdgeCrop, applyEdgeCrop } from "../src/pipeline/stage2Masked/core";

const IMG = path.join(__dirname, "../../Test Images/Floating Check Fixtures/Bedroom_05/1_original.jpg");
const maybe = fs.existsSync(IMG) ? it : it.skip;

function stripMask(w: number, h: number, edges: { top?: number; bottom?: number; left?: number; right?: number }) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (y < (edges.top || 0) || y >= h - (edges.bottom || 0) || x < (edges.left || 0) || x >= w - (edges.right || 0)) m[y * w + x] = 1;
  }
  return m;
}

describe("masked Stage 2 edge crop", () => {
  it("trims a thin bottom strip and the same share off the sides", () => {
    const w = 1200, h = 900;
    const plan = planEdgeCrop(stripMask(w, h, { bottom: 18 }), w, h, 4); // 2% strip
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.top).toBe(0); // nothing taken off the top: the strip is at the bottom
    expect(plan.trimPct.bottom).toBeGreaterThanOrEqual(2);
    // shape kept: same share removed from width and height
    expect(Math.abs(plan.width / w - plan.height / h)).toBeLessThan(0.003);
    expect(plan.trimPct.left).toBeCloseTo(plan.trimPct.right, 0);
    expect(plan.zoomPct).toBeGreaterThan(2);
    expect(plan.zoomPct).toBeLessThan(3);
  });

  it("refuses a strip wider than the cap", () => {
    const w = 1200, h = 900;
    const plan = planEdgeCrop(stripMask(w, h, { bottom: 54 }), w, h, 4); // 6%
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/too wide/);
  });

  it("refuses when the empty area is not a plain edge strip", () => {
    const w = 400, h = 300;
    const m = stripMask(w, h, { bottom: 4 });
    for (let y = 100; y < 140; y++) for (let x = 100; x < 160; x++) m[y * w + x] = 1; // hole inside
    const plan = planEdgeCrop(m, w, h, 4);
    expect(plan.ok).toBe(false);
  });

  it("refuses when there is no strip at all", () => {
    expect(planEdgeCrop(new Uint8Array(400 * 300), 400, 300, 4).ok).toBe(false);
  });

  it("handles strips on several edges (a slight zoom-out)", () => {
    const w = 1000, h = 750;
    const plan = planEdgeCrop(stripMask(w, h, { top: 8, bottom: 8, left: 10, right: 10 }), w, h, 4);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.top).toBeGreaterThanOrEqual(8);
      expect(plan.left).toBeGreaterThanOrEqual(10);
    }
  });

  maybe("saves a staged picture drawn 2.5% too low: after the line-up moves it up, the crop removes the bottom strip, size unchanged", async () => {
    const original = await sharp(fs.readFileSync(IMG)).resize(1200).png().toBuffer();
    const m = await sharp(original).metadata();
    const W = m.width!, H = m.height!, dy = Math.round(H * 0.025);
    // "Gemini" drew the room 2.5% lower; lining it up moves it back up and
    // leaves an empty strip along the bottom, where furniture gets cut off.
    const shifted = await sharp(original)
      .extract({ left: 0, top: 0, width: W, height: H - dy })
      .extend({ top: dy, bottom: 0, left: 0, right: 0, extendWith: "copy" })
      .png().toBuffer();
    const cam = await checkCameraAlignment(original, shifted);
    const al = await alignStagedToOriginal(original, shifted, cam);
    const plan = planEdgeCrop(al.empty, W, H);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.trimPct.bottom).toBeGreaterThan(2);
    expect(plan.trimPct.top).toBeLessThan(1.5);
    const cropped = await applyEdgeCrop(al.aligned, plan, W, H);
    const cm = await sharp(cropped).metadata();
    expect([cm.width, cm.height]).toEqual([W, H]);
    // every row the line-up left empty is inside the trimmed part
    let emptyRows = 0;
    for (let y = H - 1; y >= 0; y--) { let n = 0; for (let x = 0; x < W; x++) n += al.empty[y * W + x]; if (n / W > 0.5) emptyRows++; else break; }
    expect(emptyRows).toBeGreaterThan(0);
    expect(H - plan.top - plan.height).toBeGreaterThanOrEqual(emptyRows);
  }, 120000);
});
