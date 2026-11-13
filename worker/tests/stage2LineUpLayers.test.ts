jest.mock("../src/ai/gemini", () => ({ getGeminiClient: () => ({}), closestGeminiAspectRatio: () => "4:3" }));
import { layersAfterLineUp } from "../src/pipeline/stage2Masked/pipeline";

describe("after a skirting line-up, gaps between legs show the real room", () => {
  it("removes leg pockets from the furniture layers and adds them to the shadow zone", () => {
    const n = 16;
    const on = (idx: number[]) => { const m = new Uint8Array(n); for (const i of idx) m[i] = 1; return m; };
    const pocket = on([5, 6]);
    const furn = on([1, 2, 3, 4, 5, 6, 7]);
    const layers: any = { floor: furn, tightFloor: furn, solid: furn, core: furn, zone: new Uint8Array(n), artRegion: new Uint8Array(n), legPocket: pocket };
    const out = layersAfterLineUp(layers, { floor: furn, tightFloor: furn, solid: furn, core: furn, zone: new Uint8Array(n), artRegion: new Uint8Array(n), legPocket: pocket });
    for (const k of ["floor", "tightFloor", "solid", "core"]) {
      expect(Array.from((out as any)[k] as Uint8Array)).toEqual([0, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    }
    expect(out.zone[5]).toBe(1);
    expect(out.zone[6]).toBe(1);
    expect(furn[5]).toBe(1); // inputs untouched
  });
});
