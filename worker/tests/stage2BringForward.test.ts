import sharp from "sharp";
import { checkFloatingFurniture, planGroupForward, applySkirtingLineUp, GROUP_SHIFT_MARGIN_PCT } from "../src/pipeline/stage2Masked/core";

// An empty room 800x450: light wall, dark carpet from row 360.
async function room() {
  const W = 800, H = 450;
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = y >= 360 ? 60 : 225; const i = (y * W + x) * 3; px[i] = px[i + 1] = px[i + 2] = v; }
  return sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}
function box(m: Uint8Array, W: number, x1: number, y1: number, x2: number, y2: number) { for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) m[y * W + x] = 1; }

describe("floating check: high bedside table beside the bed (Harcourts 07)", () => {
  it("catches a table whose legs stop well above the floor next to a grounded bed", async () => {
    const W = 800, H = 450, m = new Uint8Array(W * H);
    box(m, W, 100, 200, 499, 449); // bed, reaching the bottom of the photo
    box(m, W, 500, 230, 620, 280); // table body
    box(m, W, 505, 230, 514, 300); box(m, W, 606, 230, 615, 300); // legs, 60 px (13%) above the floor
    expect((await checkFloatingFurniture(await room(), m, W, H)).floating).toBe(true);
  });

  it("still ignores a wall-mounted item on its own", async () => {
    const W = 800, H = 450, m = new Uint8Array(W * H);
    box(m, W, 300, 230, 500, 295);
    expect((await checkFloatingFurniture(await room(), m, W, H)).floating).toBe(false);
  });
});

describe("bringing all the furniture forward together", () => {
  it("moves the furniture down and bigger until Gemini's floor line meets the real one", async () => {
    const W = 800, H = 450, m = new Uint8Array(W * H);
    box(m, W, 300, 250, 500, 334); // a piece standing on Gemini's floor line at row 335 (real: 360)
    const plan = await planGroupForward(await room(), [{ x1Pct: 37.5, x2Pct: 62.5, needPct: (25 / H) * 100 }], m, W, H);
    expect(plan.ok).toBe(true);
    expect(plan.k!).toBeGreaterThan(1.05);
    const img = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 200, g: 200, b: 200 } } }).png().toBuffer();
    const ap = await applySkirtingLineUp(img, { floor: m }, m, plan, W, H);
    const fl = ap.masks.floor!;
    let low = -1; for (let y = H - 1; y >= 0; y--) if (fl[y * W + 400]) { low = y; break; }
    expect(low).toBeGreaterThanOrEqual(360); // now reaches the real floor line
    expect(low).toBeLessThanOrEqual(360 + Math.ceil(H * (GROUP_SHIFT_MARGIN_PCT / 100)) + 3);
    let w1 = 0; for (let x = 0; x < W; x++) if (fl[300 * W + x]) w1++;
    expect(w1).toBeGreaterThan(201); // grew
  });

  it("refuses a move that needs too much growth", async () => {
    const W = 800, H = 450, m = new Uint8Array(W * H);
    box(m, W, 300, 230, 500, 260);
    const plan = await planGroupForward(await room(), [{ x1Pct: 37.5, x2Pct: 62.5, needPct: 22 }], m, W, H);
    expect(plan.ok).toBe(false);
  });
});
