import sharp from "sharp";
import { checkFloatingFurniture, fillUncoveredBehind, pieceReachesFloor } from "../src/pipeline/stage2Masked/core";

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
    const r = await checkFloatingFurniture(await room(), m, W, H);
    expect(r.floating).toBe(true);
  });

  it("still ignores a wall-mounted item on its own", async () => {
    const W = 800, H = 450, m = new Uint8Array(W * H);
    box(m, W, 300, 230, 500, 295); // 65 px above the floor, nothing beside it
    const r = await checkFloatingFurniture(await room(), m, W, H);
    expect(r.floating).toBe(false);
  });
});

describe("after a piece is moved down", () => {
  it("counts legs that sit right on the real floor line as reaching it", async () => {
    const W = 800, H = 450, m = new Uint8Array(W * H);
    box(m, W, 500, 250, 620, 300); box(m, W, 505, 250, 514, 360); box(m, W, 606, 250, 615, 358);
    expect((await pieceReachesFloor(await room(), m, 500, 620, W, H)).reaches).toBe(true);
    const f = new Uint8Array(W * H);
    box(f, W, 500, 250, 620, 300); box(f, W, 505, 250, 514, 330);
    expect((await pieceReachesFloor(await room(), f, 500, 620, W, H)).reaches).toBe(false);
  });

  it("carries the headboard down into the strip the table uncovered", () => {
    const W = 50, H = 100, floor = new Uint8Array(W * H), rgb = Buffer.alloc(W * H * 3, 230);
    box(floor, W, 10, 10, 20, 40); // headboard end
    for (let y = 10; y <= 40; y++) for (let x = 10; x <= 20; x++) { const j = (y * W + x) * 3; rgb[j] = 180; rgb[j + 1] = 170; rgb[j + 2] = 150; }
    box(floor, W, 5, 55, 30, 80); // the moved table
    const n = fillUncoveredBehind(rgb, floor, [10, 20], W, H);
    expect(n).toBe(11 * 14);
    expect(floor[48 * W + 15]).toBe(1);
    expect(rgb[(48 * W + 15) * 3]).toBe(180);
    expect(floor[48 * W + 25]).toBe(0); // outside the columns: untouched
  });
});
