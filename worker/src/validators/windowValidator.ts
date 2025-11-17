import { detectWindowsLocal, iouMasks, centroidFromMask } from "./local-windows";
import sharp from "sharp";

export async function runWindowCheck(basePath: string, candidatePath: string): Promise<boolean> {
  const base = await detectWindowsLocal(basePath);
  const cand = await detectWindowsLocal(candidatePath);
  if (base.width !== cand.width || base.height !== cand.height) {
    // Resize candidate to base size for fair comparison
    const tmp = await sharp(candidatePath).resize(base.width, base.height, { fit: "fill" }).toBuffer();
    // Re-detect on resized candidate (simple but sufficient)
    const fs = await import("fs/promises");
    const os = require("os"); const p = require("path");
    const tmpPath = p.join(os.tmpdir(), `wincheck-${Date.now()}.png`);
    await fs.writeFile(tmpPath, tmp);
    const cand2 = await detectWindowsLocal(tmpPath);
    cand.windows = cand2.windows; (cand as any).width = cand2.width; (cand as any).height = cand2.height;
    try { await fs.unlink(tmpPath); } catch {}
  }

  // Thresholds (defaults aligned with existing logic but slightly relaxed)
  const IOU_MIN = Number(process.env.WINDOW_IOU_MIN_2 || 0.30);
  const AREA_DELTA_MAX = Number(process.env.WINDOW_AREA_DELTA_MAX_2 || 0.15);
  const CENTROID_SHIFT_MAX = Number(process.env.WINDOW_CENTROID_SHIFT_MAX_2 || 0.05);
  const OCCLUSION_MAX = Number(process.env.WINDOW_OCCLUSION_MAX_2 || 0.25);

  // Greedy match each base window to best candidate window
  for (const w of base.windows) {
    let bestIou = 0; let best: (typeof w) | undefined;
    for (const c of cand.windows) {
      const iou = iouMasks(w.mask, c.mask);
      if (iou > bestIou) { bestIou = iou; best = c; }
    }
    if (!best) continue; // no candidate; tolerate if base had none
    // IoU gate
    if (bestIou < IOU_MIN) return false;

    // Area/centroid shift
    const areaDelta = Math.abs(best.area - w.area) / Math.max(1, w.area);
    if (areaDelta > AREA_DELTA_MAX) return false;
    const baseCent = centroidFromMask(w.mask, base.width);
    const candCent = centroidFromMask(best.mask, cand.width);
    const cshift = Math.hypot(baseCent.cx - candCent.cx, baseCent.cy - candCent.cy) / Math.hypot(base.width, base.height);
    if (cshift > CENTROID_SHIFT_MAX) return false;

    // Occlusion estimate: brightness drop inside base window region
    const [a, b] = await Promise.all([
      sharp(basePath).greyscale().raw().toBuffer({ resolveWithObject: true }),
      sharp(candidatePath).greyscale().raw().toBuffer({ resolveWithObject: true }),
    ]);
    const aBuf = new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength);
    const bBuf = new Uint8Array(b.data.buffer, b.data.byteOffset, b.data.byteLength);
    let oSum = 0, eSum = 0, cnt = 0;
    for (let i = 0; i < w.mask.length; i++) if (w.mask[i]) { oSum += aBuf[i]; eSum += bBuf[i]; cnt++; }
    const drop = (cnt && oSum > 0) ? Math.max(0, (oSum - eSum) / oSum) : 0;
    if (drop > OCCLUSION_MAX) return false;
  }

  return true;
}
