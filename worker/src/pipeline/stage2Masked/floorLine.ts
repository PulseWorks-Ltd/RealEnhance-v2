// Where the floor meets the walls in a photo, found in code (no AI call).
// Kept in its own small module so the room planner can use it without
// loading the whole masked Stage 2 pipeline.
import sharp from "sharp";

export async function realFloorLine(original: Buffer, w: number, h: number): Promise<Int32Array> {
  const g = await sharp(original).removeAlpha().resize(w, h, { fit: "fill" }).greyscale().blur(2).raw().toBuffer();
  const step = Math.max(2, Math.round(h * 0.004));
  const raw = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) {
    for (let y = h - 1 - step; y > h * 0.35; y--) {
      if (Math.abs(g[(y - step) * w + x] - g[(y + step) * w + x]) >= 18) { raw[x] = y; break; }
    }
  }
  const win = Math.max(3, Math.round(w * 0.01));
  const line = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) {
    const v: number[] = [];
    for (let k = -win; k <= win; k++) {
      const xx = x + k;
      if (xx >= 0 && xx < w && raw[xx] >= 0) v.push(raw[xx]);
    }
    if (v.length) { v.sort((a, b) => a - b); line[x] = v[v.length >> 1]; }
  }
  return line;
}

/**
 * Share of the photo that is floor (below the floor line), in percent. A
 * normal room shot shows roughly 15-30%; a tight or badly framed one (camera
 * high or pointed up, standing in a doorway) under about 12% (Oct 2026: 33
 * Golf Rd bedrooms 4.5% and 9.5%). Rough: a column whose floor line isn't
 * found counts as no floor.
 */
export async function visibleFloorPct(image: Buffer): Promise<number> {
  const meta = await sharp(image).metadata();
  const W = 800, H = Math.max(8, Math.round((W * (meta.height || 600)) / (meta.width || 800)));
  const b = await sharp(image).removeAlpha().resize(W, H, { fit: "fill" }).png().toBuffer();
  const line = await realFloorLine(b, W, H);
  let area = 0;
  for (let x = 0; x < W; x++) if (line[x] >= 0) area += H - line[x];
  return +((area / (W * H)) * 100).toFixed(1);
}
