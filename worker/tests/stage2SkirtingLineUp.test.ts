jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import sharp from "sharp";
import { planSkirtingLineUp, applySkirtingLineUp } from "../src/pipeline/stage2Masked/core";

// 100x100 photo. The bed's wall runs from x 15 to the corner at x 53 (floor
// line rising from 90% to 70% down), then the next wall (floor line falling).
const realLine = Array.from({ length: 100 }, (_, x) => (x < 15 ? -1 : x <= 53 ? 0.9 - ((x - 15) / 38) * 0.2 : 0.7 + ((x - 53) / 47) * 0.15));
function room(): Uint8Array {
  const m = new Uint8Array(100 * 100);
  for (let y = 45; y <= 85; y++) for (let x = 22; x <= 50; x++) m[y * 100 + x] = 1; // bed + bedside table
  for (let y = 50; y <= 68; y++) for (let x = 62; x <= 66; x++) m[y * 100 + x] = 1; // plant against the next wall
  for (let y = 86; y <= 99; y++) for (let x = 30; x <= 75; x++) m[y * 100 + x] = 1; // rug on the open floor
  return m;
}
const run = { x1Pct: 16, x2Pct: 21, widthPct: 5, dyPct: -4.9 };

describe("skirting beside furniture: pull forward (Bedroom 05, Oct 2026)", () => {
  it("pulls the furniture against that wall forward: lower and bigger", () => {
    const plan = planSkirtingLineUp([run], room(), 100, 100, realLine);
    expect(plan.ok).toBe(true);
    expect(plan.k!).toBeGreaterThan(1.05);
    expect(plan.k!).toBeLessThan(1.25);
    expect(plan.wallPct![1]).toBeGreaterThanOrEqual(50);
    expect(plan.wallPct![1]).toBeLessThanOrEqual(56);
  });

  it("moves the bed and the rug, but not the plant standing against the next wall", () => {
    const plan = planSkirtingLineUp([run], room(), 100, 100, realLine);
    expect(plan.select![60 * 100 + 30]).toBe(1); // bed
    expect(plan.select![95 * 100 + 70]).toBe(1); // rug beyond the corner, on the open floor
    expect(plan.select![55 * 100 + 64]).toBe(0); // plant
  });

  it("never moves or overwrites a piece that stays", async () => {
    const m = room();
    const plan = planSkirtingLineUp([run], m, 100, 100, realLine);
    const img = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#808080" } }).png().toBuffer();
    const out = await applySkirtingLineUp(img, { floor: m }, m, plan, 100, 100);
    for (let y = 50; y <= 68; y++) for (let x = 62; x <= 66; x++) expect(out.masks.floor![y * 100 + x]).toBe(1);
  });

  it("refuses when offsets point both ways, an offset is too large, or nothing stands beside it", () => {
    expect(planSkirtingLineUp([run, { x1Pct: 70, x2Pct: 74, widthPct: 4, dyPct: 3 }], room(), 100, 100, realLine).ok).toBe(false);
    expect(planSkirtingLineUp([{ ...run, dyPct: -12 }], room(), 100, 100, realLine).ok).toBe(false);
    const empty = new Uint8Array(100 * 100);
    expect(planSkirtingLineUp([run], empty, 100, 100, realLine).ok).toBe(false);
  });
});
