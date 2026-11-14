import { dropRoomColouredGaps } from "../src/pipeline/stage2Masked/core";

// A 100x60 picture: white wall (top) and dark carpet (bottom, from row 45).
// A brown bedside table: top box rows 10-30, x 40-60, two legs to row 44.
// The outline fill closes the space under the box between the legs (rows
// 31-44, x 42-58) — that "hole" shows whatever Gemini drew there.
function scene(holeColour: [number, number, number], tableColour: [number, number, number] = [140, 90, 50]) {
  const w = 100, h = 60;
  const rgb = Buffer.alloc(w * h * 3);
  const traced = new Uint8Array(w * h), mask = new Uint8Array(w * h);
  const put = (x: number, y: number, c: number[]) => { const i = (y * w + x) * 3; rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2]; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, y >= 45 ? [70, 65, 60] : [235, 235, 232]);
  for (let y = 10; y <= 44; y++) for (let x = 40; x <= 60; x++) {
    const leg = x <= 41 || x >= 59;
    const body = y <= 30;
    if (body || leg) { put(x, y, tableColour); traced[y * w + x] = 1; }
    else put(x, y, holeColour);
    mask[y * w + x] = 1;
  }
  return { w, h, rgb, traced, mask };
}

describe("holes in furniture that show Gemini's room", () => {
  it("leaves Gemini's wall under a table to the real photo", () => {
    const s = scene([235, 235, 232]);
    const r = dropRoomColouredGaps(s.mask, s.traced, s.rgb, s.w, s.h);
    expect(r.mask[35 * s.w + 50]).toBe(0);
    expect(r.mask[20 * s.w + 50]).toBe(1); // table top stays
    expect(r.mask[40 * s.w + 40]).toBe(1); // leg stays
    expect(r.droppedPct).toBeGreaterThan(0);
  });

  it("keeps a hole that looks like the furniture (a dark panel)", () => {
    const s = scene([60, 40, 25]);
    const r = dropRoomColouredGaps(s.mask, s.traced, s.rgb, s.w, s.h);
    expect(r.mask[35 * s.w + 50]).toBe(1);
    expect(r.droppedPct).toBe(0);
  });

  it("keeps a white hole in a white piece on a white wall (can't tell)", () => {
    const s = scene([235, 235, 232], [232, 232, 230]);
    const r = dropRoomColouredGaps(s.mask, s.traced, s.rgb, s.w, s.h);
    expect(r.mask[35 * s.w + 50]).toBe(1);
  });
});
