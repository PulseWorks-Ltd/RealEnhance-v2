import { carryPlacementMatch } from "../src/pipeline/stage2Masked/core";
import { CARRY_OVER } from "../src/pipeline/stage2Masked/pipeline";

// A bed (big block) and a bedside table, 800x500.
function scene(opts: { dx?: number; scale?: number } = {}) {
  const w = 800, h = 500, m = new Uint8Array(w * h);
  const s = opts.scale ?? 1, dx = opts.dx ?? 0;
  const box = (x1: number, y1: number, x2: number, y2: number) => { for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) if (x >= 0 && x < w && y >= 0 && y < h) m[y * w + x] = 1; };
  const cx = 400 + dx, bw = 300 * s, bh = 180 * s;
  box(Math.round(cx - bw / 2), Math.round(480 - bh), Math.round(cx + bw / 2), 480); // bed
  box(Math.round(cx + bw / 2 + 30), 380, Math.round(cx + bw / 2 + 90), 470); // table, apart from the bed
  return { m, w, h };
}

describe("carry-over placement check (owner review, Nov 2026)", () => {
  it("is on by default", () => {
    expect(CARRY_OVER).toBe(true);
  });
  it("trusts furniture left where it was placed, or shifted a little", () => {
    const a = scene(), b = scene({ dx: 12 });
    const r = carryPlacementMatch(a.m, b.m, a.w, a.h);
    expect(r.ok).toBe(true);
  });
  it("rejects furniture Gemini shrank (Bedroom 18)", () => {
    const a = scene(), b = scene({ scale: 0.78 });
    expect(carryPlacementMatch(a.m, b.m, a.w, a.h).ok).toBe(false);
  });
  it("rejects furniture Gemini moved elsewhere (07 bedroom: the bed under the window)", () => {
    const a = scene(), b = scene({ dx: -120 });
    const r = carryPlacementMatch(a.m, b.m, a.w, a.h);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/moved/);
  });
});
