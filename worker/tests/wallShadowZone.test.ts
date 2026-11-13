jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { trimWallShadowZone } from "../src/pipeline/stage2Masked/core";

// 100x100: real floor line at y=70. A bed at x 50-80, y 50-90. The shadow
// zone reaches 8 px all round (like the 8% zone).
describe("wall shadows only right beside a kept piece (Nov 2026, Harcourts photo 08: phantom shadow)", () => {
  const W = 100, H = 100;
  const bed = new Uint8Array(W * H), zone = new Uint8Array(W * H);
  for (let y = 50; y <= 90; y++) for (let x = 50; x <= 80; x++) bed[y * W + x] = 1;
  for (let y = 42; y <= 98; y++) for (let x = 42; x <= 88; x++) if (!bed[y * W + x]) zone[y * W + x] = 1;
  const floorY = new Int32Array(W).fill(70);
  const { zone: out, trimmedPct } = trimWallShadowZone(zone, bed, floorY, W, H, 3);
  const at = (x: number, y: number) => out[y * W + x];

  it("drops wall zone further than the reach from the bed (where a phantom table's shadow sat)", () => {
    expect(at(44, 60)).toBe(0); // wall, 6 px left of the bed
    expect(trimmedPct).toBeGreaterThan(0);
  });
  it("keeps the wall right beside the bed and straight above it", () => {
    expect(at(48, 60)).toBe(1); // 2 px left of the bed
    expect(at(65, 45)).toBe(1); // above the headboard
  });
  it("keeps the whole zone on the floor", () => {
    expect(at(44, 80)).toBe(1);
    expect(at(86, 95)).toBe(1);
  });
});
