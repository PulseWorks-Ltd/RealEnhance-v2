jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import sharp from "sharp";
import { refineOutlookMask, buildOutlookMaskPrompt } from "../src/validators/stage1AExteriorOutlookMask";
import { applyOutlookAdjustments } from "../src/validators/stage1AExteriorOutlookAdjust";

const W = 200, H = 100;
const view = (box: number[]) => ({ box: box as [number, number, number, number], sky: "grey" as const, greenery: true, blownOut: false, description: "" });
function block(m: Uint8Array, x1: number, y1: number, x2: number, y2: number) { for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) m[y * W + x] = 1; }

describe("exterior outlook painted outline", () => {
  it("keeps glass near the surveyed views and drops stray white elsewhere", () => {
    const raw = new Uint8Array(W * H);
    block(raw, 40, 20, 80, 60);   // the window's glass
    block(raw, 150, 70, 190, 95); // stray white far from any view
    const r = refineOutlookMask(raw, [view([0.18, 0.15, 0.42, 0.65])], W, H);
    expect(r.mask).not.toBeNull();
    expect(r.mask![40 * W + 60]).toBe(1);
    expect(r.mask![80 * W + 170]).toBe(0);
  });

  it("falls back to the boxes when the outline is empty, tiny or far too big", () => {
    const v = [view([0.2, 0.2, 0.4, 0.6])];
    expect(refineOutlookMask(new Uint8Array(W * H), v, W, H).mask).toBeNull();
    const tiny = new Uint8Array(W * H); block(tiny, 50, 30, 54, 34);
    expect(refineOutlookMask(tiny, v, W, H).mask).toBeNull();
    const huge = new Uint8Array(W * H); block(huge, 0, 0, 200, 100);
    expect(refineOutlookMask(huge, v, W, H).mask).toBeNull();
  });

  it("with an outline, only the glass changes — the wall inside the box stays", async () => {
    // Green view at x 60-100, peach-tinted wall around it; the box runs well past the glass.
    const px = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3, glass = x >= 60 && x < 100 && y >= 30 && y < 70;
      const c = glass ? [70, 120, 60] : [190, 176, 167];
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
    }
    const img = await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
    const mask = new Uint8Array(W * H); block(mask, 60, 30, 100, 70);
    const r = await applyOutlookAdjustments(img, [view([0.2, 0.15, 0.7, 0.85])], { mask });
    expect(r.usedMask).toBe(true);
    const out = await sharp(r.image).raw().toBuffer();
    const at = (x: number, y: number) => [out[(y * W + x) * 3], out[(y * W + x) * 3 + 1], out[(y * W + x) * 3 + 2]];
    expect(at(120, 50)).toEqual([190, 176, 167]); // wall inside the box
    expect(at(80, 50)[1]).toBeGreaterThan(120);   // the view is lifted
  });

  it("asks for the glass only, following its perspective", () => {
    const p = buildOutlookMaskPrompt();
    expect(p).toContain("slanted shape, not a rectangle");
    expect(p).toContain("BLACK: window frames");
  });
});
