import sharp from "sharp";
import { detectNearWallStrip, remapBox, remapBaselineForCrop, pasteBackIntoFullPhoto, type NearWallCrop } from "../src/pipeline/stage2Masked/nearWallStrip";
import fs from "fs";
import os from "os";
import path from "path";

// A simple room picture: back wall (light), floor (darker, bottom third), and
// optionally a plain grey strip on the left that runs top to bottom, or a
// side wall whose edge stops at the floor.
async function room(opts: { strip?: number; stripStopsAtFloor?: boolean; busyStrip?: boolean }) {
  const W = 800, H = 450;
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = y > H * 0.66 ? 120 : 200; // floor / wall
    const inStrip = opts.strip && x < W * opts.strip && (!opts.stripStopsAtFloor || y <= H * 0.66);
    if (inStrip) v = opts.busyStrip ? ((x >> 3) + (y >> 3)) % 2 ? 90 : 190 : 150;
    const i = (y * W + x) * 3;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  return sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

describe("near-wall strip detection (Bedroom_05 wall return)", () => {
  it("finds a plain full-height strip whose edge runs out of the top and bottom", async () => {
    const r = await detectNearWallStrip(await room({ strip: 0.16 }));
    expect(r.crop).not.toBeNull();
    expect(r.crop!.side).toBe("left");
    expect(r.crop!.stripPct).toBeGreaterThan(15);
    expect(r.crop!.stripPct).toBeLessThan(19);
  });

  it("ignores an edge that stops at the floor (a side wall of the room)", async () => {
    const r = await detectNearWallStrip(await room({ strip: 0.16, stripStopsAtFloor: true }));
    expect(r.crop).toBeNull();
  });

  it("ignores a busy strip (not a plain wall)", async () => {
    const r = await detectNearWallStrip(await room({ strip: 0.16, busyStrip: true }));
    expect(r.crop).toBeNull();
  });

  it("finds nothing in a room with no strip", async () => {
    expect((await detectNearWallStrip(await room({}))).crop).toBeNull();
  });
});

describe("near-wall strip crop and paste-back", () => {
  const crop: NearWallCrop = { side: "left", left: 200, right: 1000, W: 1000, H: 500, stripPct: 20, score: 1, strips: [{ side: "left", seam: [200, 200], stripPct: 20, score: 1, busyPct: 0 }] };

  it("moves window/door boxes into the cropped picture and drops ones inside the strip", () => {
    const moved = remapBox([0.6, 0.1, 1.0, 0.9], crop)!;
    expect(moved[0]).toBeCloseTo(0.5);
    expect(moved.slice(1)).toEqual([0.1, 1, 0.9]);
    expect(remapBox([0.0, 0.1, 0.15, 0.9], crop)).toBeNull();
    const b = remapBaselineForCrop({ openings: [{ id: "w1", bbox: [0.6, 0.1, 1.0, 0.5] }, { id: "d1", bbox: [0.05, 0.1, 0.18, 0.9] }] } as any, crop);
    expect(b.openings.map((o: any) => o.id)).toEqual(["w1"]);
  });

  it("pastes the staged picture back next to the untouched strip", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nws-"));
    const full = path.join(dir, "full.png");
    await sharp({ create: { width: 1000, height: 500, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toFile(full);
    const staged = await sharp({ create: { width: 800, height: 500, channels: 3, background: { r: 200, g: 100, b: 50 } } }).png().toBuffer();
    const out = await pasteBackIntoFullPhoto(full, staged, crop);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([1000, 500]);
    const at = (x: number) => Array.from(data.subarray((250 * 1000 + x) * info.channels, (250 * 1000 + x) * info.channels + 3));
    expect(at(150)).toEqual([10, 20, 30]); // strip unchanged
    expect(at(600)).toEqual([200, 100, 50]); // staged room
  });

  it("follows a leaning edge: the staged wedge of the strip is replaced by the real strip", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nws-"));
    const full = path.join(dir, "full.png");
    await sharp({ create: { width: 1000, height: 500, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toFile(full);
    // Edge leans from x=800 (top) to x=900 (bottom) on the right; staged box 0-900.
    const lean: NearWallCrop = { side: "right", left: 0, right: 900, W: 1000, H: 500, stripPct: 20, score: 1, strips: [{ side: "right", seam: [800, 900], stripPct: 20, score: 1, busyPct: 0 }] };
    const staged = await sharp({ create: { width: 900, height: 500, channels: 3, background: { r: 200, g: 100, b: 50 } } }).png().toBuffer();
    const out = await pasteBackIntoFullPhoto(full, staged, lean);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => Array.from(data.subarray((y * 1000 + x) * info.channels, (y * 1000 + x) * info.channels + 3));
    expect(at(850, 10)).toEqual([10, 20, 30]); // top: past the edge -> real strip
    expect(at(850, 490)).toEqual([200, 100, 50]); // bottom: edge is further right -> staged room
    expect(at(950, 250)).toEqual([10, 20, 30]);
  });
});
