import { colourFinishPixels } from "../src/ai/exteriorColourFinish";

// Exterior colour finish (Nov 2026): colour and tone only, gently.
const px = (rgb: number[], w = 1, h = 1) => Uint8Array.from(Array.from({ length: w * h }, () => rgb).flat());

describe("exterior colour finish", () => {
  it("keeps whites white (cladding and trim)", () => {
    const [r, g, b] = colourFinishPixels(px([245, 245, 245]), 1, 1);
    expect(Math.abs(r - 245)).toBeLessThanOrEqual(3);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
  });
  it("never makes shadows darker", () => {
    for (const v of [10, 30, 60, 90, 120]) {
      const [r, g, b] = colourFinishPixels(px([v, v, v]), 1, 1);
      expect(Math.min(r, g, b)).toBeGreaterThanOrEqual(v);
    }
  });
  it("makes a lawn a little greener, not neon", () => {
    const [r, g, b] = colourFinishPixels(px([90, 130, 60]), 1, 1);
    const before = 130 - Math.max(90, 60), after = g - Math.max(r, b);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(before * 1.6);
  });
  it("deepens open blue sky at the top of the frame only", () => {
    const w = 1, h = 10;
    const out = colourFinishPixels(px([110, 160, 220], w, h), w, h);
    const blueness = (y: number) => out[y * 3 + 2] - Math.max(out[y * 3], out[y * 3 + 1]);
    expect(blueness(0)).toBeGreaterThan(blueness(9));
  });
  it("returns an image of the same size", () => {
    expect(colourFinishPixels(px([100, 100, 100], 4, 3), 4, 3)).toHaveLength(4 * 3 * 3);
  });
});
