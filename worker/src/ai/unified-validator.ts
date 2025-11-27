import { getGeminiClient } from "./gemini";
import { toBase64 } from "../utils/images";
import { validatePerspectivePreservation } from "./perspective-detector";
import { validateWallPlanes } from "./wall-plane-validator";
import { validateWindowPreservation } from "./windowDetector";
import { validateFurnitureScale } from "./furniture-scale-validator";
import { validateExteriorEnhancement } from "./exterior-validator";
import { getAdminConfig } from "../utils/adminConfig";
import sharp from "sharp";
import { detectWindowsLocal, iouMasks, centroidFromMask } from "../validators/local-windows";
import path from "path";

// Helpers for env parsing
const num = (v: any, d: number) => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : d;
};

function getEdgeSimMin(stage: StageId, scene?: SceneType) {
  const s = (scene === 'exterior') ? 'EXTERIOR' : 'INTERIOR';
  if (stage === '1A') return num(process.env[`LOCAL_EDGE_SIM_MIN_1A_${s}`], scene === 'exterior' ? 0.72 : 0.76);
  if (stage === '1B') return num(process.env[`LOCAL_EDGE_SIM_MIN_1B_${s}`], scene === 'exterior' ? 0.74 : 0.78);
  return num(process.env.LOCAL_EDGE_SIM_MIN_2, 0.83);
}

function getBrightDiffMax(stage: StageId, scene?: SceneType) {
  const s = (scene === 'exterior') ? 'EXTERIOR' : 'INTERIOR';
  if (stage === '1A') return num(process.env[`LOCAL_BRIGHT_DIFF_MAX_1A_${s}`], scene === 'exterior' ? 0.45 : 0.35);
  if (stage === '1B') return num(process.env[`LOCAL_BRIGHT_DIFF_MAX_1B_${s}`], scene === 'exterior' ? 0.40 : 0.32);
  return num(process.env.LOCAL_BRIGHT_DIFF_MAX_2, 0.30);
}

function getEdgeSimHardMin(stage: StageId, scene?: SceneType) {
  const s = (scene === 'exterior') ? 'EXTERIOR' : 'INTERIOR';
  if (stage === '1A') return num(process.env[`LOCAL_EDGE_SIM_HARD_MIN_1A_${s}`], 0.30);
  if (stage === '1B') return num(process.env[`LOCAL_EDGE_SIM_HARD_MIN_1B_${s}`], 0.30);
  return num(process.env.LOCAL_EDGE_SIM_HARD_MIN_2, 0.83);
}

function getBrightDiffHardMax(stage: StageId, scene?: SceneType) {
  const s = (scene === 'exterior') ? 'EXTERIOR' : 'INTERIOR';
  if (stage === '1A') return num(process.env[`LOCAL_BRIGHT_DIFF_HARD_MAX_1A_${s}`], scene === 'exterior' ? 0.55 : 0.40);
  if (stage === '1B') return num(process.env[`LOCAL_BRIGHT_DIFF_HARD_MAX_1B_${s}`], scene === 'exterior' ? 0.50 : 0.38);
  return num(process.env.LOCAL_BRIGHT_DIFF_HARD_MAX_2, 0.30);
}

function getEdgeSimExtremeMin(stage: StageId, scene?: SceneType) {
  // Extreme floor: below this, fail regardless (likely true structural change)
  if (stage === '2') return num(process.env.LOCAL_EDGE_SIM_EXTREME_MIN_2, 0.50);
  if (stage === '1A' || stage === '1B') return num(process.env.LOCAL_EDGE_SIM_EXTREME_MIN_1, 0.20);
  return 0.20;
}

function percentileThreshold(hist: number[], total: number, pct: number): number {
  let acc = 0;
  const target = total * pct;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return 200;
}

function computeHistogram(buf: Uint8Array): number[] {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < buf.length; i++) hist[buf[i]]++;
  return hist;
}

function dilate1(inMap: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(inMap.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) on |= inMap[(y + dy) * w + (x + dx)];
      }
      out[y * w + x] = on ? 1 : 0;
    }
  }
  return out;
}

// Local validation functions (no Gemini calls)
async function validateStructuralIntegrityLocal(
  prevPath: string,
  candPath: string,
  opts: { stage: StageId; sceneType?: SceneType }
): Promise<{ ok: boolean; reason?: string; metrics: { edgeSimilarity: number; brightnessDiff: number } }> {
  try {
    // Load both images with optional pre-blur to stabilize micro edges
    let preBlurSigmaDefault = (opts.stage === '2') ? 0 : num(process.env.LOCAL_EDGE_PREBLUR_SIGMA, 0.8);
    if (!preBlurSigmaDefault || typeof preBlurSigmaDefault !== 'number' || preBlurSigmaDefault < 0.3 || preBlurSigmaDefault > 1000) preBlurSigmaDefault = 0.8;
    const [prevImg, candImg] = await Promise.all([
      sharp(prevPath).greyscale().blur(preBlurSigmaDefault).raw().toBuffer({ resolveWithObject: true }),
      sharp(candPath).greyscale().blur(preBlurSigmaDefault).raw().toBuffer({ resolveWithObject: true })
    ]);

    if (prevImg.info.width !== candImg.info.width || prevImg.info.height !== candImg.info.height) {
      return { ok: false, reason: "Image dimensions changed", metrics: { edgeSimilarity: 0, brightnessDiff: 999 } };
    }

    const width = prevImg.info.width;
    const height = prevImg.info.height;
    const prevData = new Uint8Array(prevImg.data);
    const candData = new Uint8Array(candImg.data);

    // 1) Edge detection for structural changes -> symmetric IoU of edge maps
    const edgeThreshold = num(process.env.LOCAL_EDGE_MAG_THRESHOLD, 35);
    const prevEdge = new Uint8Array(prevData.length);
    const candEdge = new Uint8Array(candData.length);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        const pGx = Math.abs(
          prevData[idx - width - 1] + 2 * prevData[idx - 1] + prevData[idx + width - 1] -
          prevData[idx - width + 1] - 2 * prevData[idx + 1] - prevData[idx + width + 1]
        );
        const pGy = Math.abs(
          prevData[idx - width - 1] + 2 * prevData[idx - width] + prevData[idx - width + 1] -
          prevData[idx + width - 1] - 2 * prevData[idx + width] - prevData[idx + width + 1]
        );
        const cGx = Math.abs(
          candData[idx - width - 1] + 2 * candData[idx - 1] + candData[idx + width - 1] -
          candData[idx - width + 1] - 2 * candData[idx + 1] - candData[idx + width + 1]
        );
        const cGy = Math.abs(
          candData[idx - width - 1] + 2 * candData[idx - width] + candData[idx - width + 1] -
          candData[idx + width - 1] - 2 * candData[idx + width] - candData[idx + width + 1]
        );
        prevEdge[idx] = (Math.sqrt(pGx * pGx + pGy * pGy) > edgeThreshold) ? 1 : 0;
        candEdge[idx] = (Math.sqrt(cGx * cGx + cGy * cGy) > edgeThreshold) ? 1 : 0;
      }
    }
    const dilateR = (opts.stage === '2') ? 0 : Math.max(0, Math.floor(num(process.env.LOCAL_EDGE_DILATE_RADIUS, 2)));
    let mapA: any = prevEdge, mapB: any = candEdge;
    if (dilateR > 0) {
      mapA = dilate1(mapA as Uint8Array, width, height) as any;
      mapB = dilate1(mapB as Uint8Array, width, height) as any;
    }
    let inter = 0, uni = 0;
    for (let i = 0; i < mapA.length; i++) {
      const a = mapA[i] ? 1 : 0;
      const b = mapB[i] ? 1 : 0;
      if (a & b) inter++;
      if (a | b) uni++;
    }
    const edgeSimilarity = uni > 0 ? inter / uni : 1;

    // 2) Brightness analysis (windows/openings proxy) using percentile threshold
    const topExclude = (opts.sceneType === 'exterior') ? num(process.env.LOCAL_BRIGHT_EXTERIOR_TOP_EXCLUDE, 0.15) : 0;
    const pctl = Math.max(0.5, Math.min(0.98, num(process.env.LOCAL_BRIGHT_THRESH_PCTL, 0.88)));
    const sliceForHist = (buf: Uint8Array) => {
      if (!topExclude) return buf;
      const cut = Math.floor(height * topExclude);
      const out = new Uint8Array(width * (height - cut));
      let j = 0;
      for (let y = cut; y < height; y++) {
        const off = y * width;
        out.set(buf.subarray(off, off + width), j);
        j += width;
      }
      return out;
    };
    const prevSlice = sliceForHist(prevData);
    const candSlice = sliceForHist(candData);
    const thrPrev = percentileThreshold(computeHistogram(prevSlice), prevSlice.length, pctl);
    const thrCand = percentileThreshold(computeHistogram(candSlice), candSlice.length, pctl);
    let prevBright = 0, candBright = 0;
    for (let i = 0; i < prevSlice.length; i++) if (prevSlice[i] >= thrPrev) prevBright++;
    for (let i = 0; i < candSlice.length; i++) if (candSlice[i] >= thrCand) candBright++;
    const prevBrightRatio = prevBright / Math.max(1, prevSlice.length);
    const candBrightRatio = candBright / Math.max(1, candSlice.length);
    const brightnessDiff = Math.abs(candBrightRatio - prevBrightRatio);

    console.log(`[LOCAL STRUCTURAL] Edge IoU: ${(edgeSimilarity * 100).toFixed(1)}%, Brightness diff: ${(brightnessDiff * 100).toFixed(1)}%`);

    const softEdgeMin = getEdgeSimMin(opts.stage, opts.sceneType);
    const hardEdgeMin = getEdgeSimHardMin(opts.stage, opts.sceneType);
    const extremeEdgeMin = getEdgeSimExtremeMin(opts.stage, opts.sceneType);
    const softBrightMax = getBrightDiffMax(opts.stage, opts.sceneType);
    const hardBrightMax = getBrightDiffHardMax(opts.stage, opts.sceneType);

    // Stage 2: strict (hard == soft)
    if (opts.stage === '2') {
      if (edgeSimilarity < softEdgeMin) {
        return { ok: false, reason: `Major structural changes detected (${(edgeSimilarity * 100).toFixed(1)}% edge similarity)`, metrics: { edgeSimilarity, brightnessDiff } };
      }
      if (brightnessDiff > softBrightMax) {
        return { ok: false, reason: `Significant brightness shift detected (${(brightnessDiff * 100).toFixed(1)}% change) - possible new openings`, metrics: { edgeSimilarity, brightnessDiff } };
      }
    } else {
      // Stage 1: two-signal rule
      // 1) If edge IoU is extremely low, hard fail outright
      if (edgeSimilarity < extremeEdgeMin) {
        return { ok: false, reason: `Major structural changes detected (${(edgeSimilarity * 100).toFixed(1)}% edge similarity < extreme floor)`, metrics: { edgeSimilarity, brightnessDiff } };
      }
      // 2) Otherwise, require BOTH low edge IoU and large brightness shift to hard fail
      if (edgeSimilarity < hardEdgeMin && brightnessDiff > hardBrightMax) {
        return { ok: false, reason: `Combined structural signals: low edge similarity ${(edgeSimilarity*100).toFixed(1)}% and large brightness change ${(brightnessDiff*100).toFixed(1)}%`, metrics: { edgeSimilarity, brightnessDiff } };
      }
      // If only soft thresholds tripped, allow but log
      if (edgeSimilarity < softEdgeMin || brightnessDiff > softBrightMax) {
        console.log(`[LOCAL STRUCTURAL] Borderline (soft) deviation accepted: edgeIoU=${(edgeSimilarity*100).toFixed(1)}%, brightΔ=${(brightnessDiff*100).toFixed(1)}%`);
      }
    }

    return { ok: true, metrics: { edgeSimilarity, brightnessDiff } };

  } catch (error) {
    console.error("[LOCAL STRUCTURAL] Validation failed:", error);
    return { ok: false, reason: "Structural validation error", metrics: { edgeSimilarity: 0, brightnessDiff: 0 } };
  }
}

export type StageId = "1A" | "1B" | "2";
export type SceneType = "interior" | "exterior" | string | undefined;

export interface Artifact {
  stage: StageId;
  path: string; // local file path
  width?: number;
  height?: number;
}

export interface ValidationCtx {
  sceneType?: SceneType;
  roomType?: string;
}

export interface ValidationVerdict {
  ok: boolean;
  score: number; // 0..1
  reasons: string[];
  metrics: Record<string, number>;
}

/**
 * Unified structural validator that combines local checks using our detectors.
 * Returns a single verdict with weighted score and reasons.
 */
export async function validateStage(
  prev: Artifact,
  cand: Artifact,
  ctx: ValidationCtx = {},
  opts: { skipLocalStructural?: boolean } = {}
): Promise<ValidationVerdict> {
  // If candidate dimensions differ from prev, resize a copy to match prev
  // so that local geometric checks operate on aligned grids. This avoids
  // blanket failures when the model outputs a different absolute size.
  async function normalizeCandidateDims(prevPath: string, candPath: string): Promise<{ usedPath: string; resized: boolean; }> {
    try {
      const [pm, cm] = await Promise.all([sharp(prevPath).metadata(), sharp(candPath).metadata()]);
      if (!pm.width || !pm.height || !cm.width || !cm.height) return { usedPath: candPath, resized: false };
      if (pm.width === cm.width && pm.height === cm.height) return { usedPath: candPath, resized: false };

      // Compute scale by width; keep aspect ratio. If resulting height is off by a few px, pad/crop centrally.
      const tmpOut = path.join(path.dirname(candPath), path.basename(candPath).replace(/(\.[a-z0-9]+)$/i, "-normalized.webp"));
      let img = sharp(candPath).rotate();
      img = img.resize({ width: pm.width });
      const buf = await img.webp({ quality: 95 }).toBuffer({ resolveWithObject: true });
      let resized = sharp(buf.data);
      const rm = buf.info;
      if (rm.height !== pm.height) {
        const delta = pm.height - (rm.height || 0);
        if (Math.abs(delta) <= 2) {
          // Pad or crop by up to 2px to match exact height
          if (delta > 0) {
            resized = resized.extend({ top: Math.floor(delta/2), bottom: delta - Math.floor(delta/2), background: { r: 0, g: 0, b: 0, alpha: 1 } });
          } else if (delta < 0) {
            const crop = Math.abs(delta);
            resized = resized.extract({ left: 0, top: Math.floor(crop/2), width: pm.width!, height: pm.height! });
          }
        } else {
          // If mismatch is large (aspect ratio change), fall back to contain with padding
          resized = sharp(candPath).resize({ width: pm.width, height: pm.height, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } });
        }
      }
      await resized.webp({ quality: 95 }).toFile(tmpOut);
      return { usedPath: tmpOut, resized: true };
    } catch {
      return { usedPath: candPath, resized: false };
    }
  }
  // Load optional config/env overrides for weights/thresholds
  const admin = await getAdminConfig().catch(() => ({} as any));
  const parseNum = (v?: string) => {
    if (v === undefined) return undefined;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const weightsCfg = (admin as any)?.validator?.weights || {};
  const thresholdsCfg = (admin as any)?.validator?.thresholds || {};
  const weights = {
    perspective: parseNum(process.env.VALIDATOR_WEIGHT_PERSPECTIVE) ?? (typeof weightsCfg.perspective === 'number' ? weightsCfg.perspective : 0.35),
    wallPlanes: parseNum(process.env.VALIDATOR_WEIGHT_WALLS) ?? (typeof weightsCfg.wallPlanes === 'number' ? weightsCfg.wallPlanes : 0.35),
    windows: parseNum(process.env.VALIDATOR_WEIGHT_WINDOWS) ?? (typeof weightsCfg.windows === 'number' ? weightsCfg.windows : 0.15),
    furniture: parseNum(process.env.VALIDATOR_WEIGHT_FURNITURE) ?? (typeof weightsCfg.furniture === 'number' ? weightsCfg.furniture : 0.15),
    exterior: parseNum(process.env.VALIDATOR_WEIGHT_EXTERIOR) ?? (typeof weightsCfg.exterior === 'number' ? weightsCfg.exterior : 0.15),
  };
  const thresholds = {
    "1A": parseNum(process.env.VALIDATOR_THRESH_1A) ?? (typeof thresholdsCfg?.["1A"] === 'number' ? thresholdsCfg["1A"] : 0.75),
    "1B": parseNum(process.env.VALIDATOR_THRESH_1B) ?? (typeof thresholdsCfg?.["1B"] === 'number' ? thresholdsCfg["1B"] : 0.70),
    "2": parseNum(process.env.VALIDATOR_THRESH_2) ?? (typeof thresholdsCfg?.["2"] === 'number' ? thresholdsCfg["2"] : 0.68),
  } as Record<StageId, number>;

  // Defer Gemini client initialization and base64 conversion until needed

  // Normalize candidate dims for local checks if needed
  const { usedPath: candNormPath, resized: candWasResized } = await normalizeCandidateDims(prev.path, cand.path);

  const reasons: string[] = [];
  const metrics: Record<string, number> = {};
  let score = 0;
  let totalW = 0;
  if (candWasResized) {
    metrics.resizedForValidation = 1;
    console.log(`[VALIDATOR] Candidate resized for validation to match original dimensions`);
  }

  // ===== LOCAL CHECKS (NO GEMINI CALLS) =====
  
  // 1) Structural integrity check (skip for Stage 2 when external structural validator already executed)
  if (!opts.skipLocalStructural) {
    console.log("[VALIDATOR] Running local structural checks...");
    try {
      const structural = await validateStructuralIntegrityLocal(prev.path, candNormPath, { stage: cand.stage as StageId, sceneType: ctx.sceneType });
      metrics.structuralEdges = structural.metrics.edgeSimilarity;
      metrics.brightnessDiff = structural.metrics.brightnessDiff;
      
      if (!structural.ok) {
        console.error(`[VALIDATOR] CRITICAL: ${structural.reason}`);
        reasons.push(structural.reason!);
        // Hard fail on major structural violations
        return {
          ok: false,
          score: 0,
          reasons: [structural.reason!],
          metrics
        };
      }
      console.log("[VALIDATOR] ✅ Local structural check passed");
    } catch (e) {
      console.warn("[VALIDATOR] Local structural check error:", e);
      reasons.push("structural check error");
    }
  } else {
    console.log("[VALIDATOR] ⚙️ Skipping local structural check (external Stage 2 structural validator used)");
  }

  // ===== GEMINI CHECKS (ONLY FOR COMPLEX SEMANTIC VALIDATION) =====
  // Only run Gemini checks for Stage 2 (staging) - semantic furniture/realism validation
  const useGeminiValidation = cand.stage === "2" && process.env.ENABLE_GEMINI_SEMANTIC_VALIDATION !== "0";

  // ===== LOCAL WINDOW MASK COMPARISON (IoU/Area/Centroid/Occlusion) =====
  try {
    const isStage1 = cand.stage === '1A' || cand.stage === '1B';
    const isExterior = ctx.sceneType === 'exterior';
    // Allow disabling windows check for Stage 1 exteriors if desired
    if (isStage1 && isExterior && process.env.WINDOW_CHECK_EXTERIOR_STAGE1 === '0') {
      console.log('[WINDOW LOCAL] Skipping windows check for Stage 1 exterior as configured');
    } else {
      // Stage 1 uses more tolerant IoU with mask dilation; Stage 2 remains strict
      // IoU minimums: Stage 1A is more lenient (default 0.30), Stage 2 now aligned at 0.30
      const W_IOU_MIN = isStage1
        ? (
            cand.stage === '1A'
              ? Number(process.env[isExterior ? 'WINDOW_IOU_MIN_1A_STAGE_EXTERIOR' : 'WINDOW_IOU_MIN_1A_STAGE_INTERIOR'] || 0.30)
              : Number(process.env[isExterior ? 'WINDOW_IOU_MIN_1_STAGE_EXTERIOR' : 'WINDOW_IOU_MIN_1_STAGE_INTERIOR'] || (isExterior ? 0.45 : 0.50))
          )
        : Number(process.env.WINDOW_IOU_MIN_2 || 0.30);
      const W_AREA_DELTA_MAX = isStage1 ? Number(process.env.WINDOW_AREA_DELTA_MAX_1 || 0.20) : Number(process.env.WINDOW_AREA_DELTA_MAX_2 || 0.15);
      const W_CENTROID_SHIFT_MAX = isStage1 ? Number(process.env.WINDOW_CENTROID_SHIFT_MAX_1 || 0.08) : Number(process.env.WINDOW_CENTROID_SHIFT_MAX_2 || 0.05);
      const W_OCCLUSION_MAX = isStage1 ? Number(process.env[isExterior ? 'WINDOW_OCCLUSION_MAX_1_EXTERIOR' : 'WINDOW_OCCLUSION_MAX_1_INTERIOR'] || (isExterior ? 0.40 : 0.30)) : Number(process.env.WINDOW_OCCLUSION_MAX_2 || 0.25);

      const [origDet, enhDet, origRaw, enhRaw] = await Promise.all([
        detectWindowsLocal(prev.path),
        detectWindowsLocal(candNormPath),
        sharp(prev.path).greyscale().raw().toBuffer({ resolveWithObject: true }),
        sharp(candNormPath).greyscale().raw().toBuffer({ resolveWithObject: true }),
      ]);

      const W = origDet.width;
      const H = origDet.height;
      const diag = Math.sqrt(W * W + H * H);
      const origBuf = new Uint8Array(origRaw.data.buffer, origRaw.data.byteOffset, origRaw.data.byteLength);
      const enhBuf = new Uint8Array(enhRaw.data.buffer, enhRaw.data.byteOffset, enhRaw.data.byteLength);

      // If both zero windows, skip quietly
      if (origDet.windows.length === 0 && enhDet.windows.length === 0) {
        console.log('[WINDOW LOCAL] No windows detected in either image; skipping window compliance.');
      } else {
        // Greedy matching by IoU (sufficient here given small counts)
        const used = new Set<number>();
        // Small helper to dilate masks by 1px for tolerance
        const dilateMask1 = (mask: Uint8Array, Wm: number, Hm: number) => {
          const out = new Uint8Array(mask.length);
          for (let y = 1; y < Hm - 1; y++) {
            for (let x = 1; x < Wm - 1; x++) {
              let on = 0;
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  if (mask[(y + dy) * Wm + (x + dx)]) { on = 1; break; }
                }
                if (on) break;
              }
              out[y * Wm + x] = on ? 255 : 0;
            }
          }
          return out;
        };

        for (let i = 0; i < origDet.windows.length; i++) {
          const ow = origDet.windows[i];
          let bestIdx = -1;
          let bestIou = 0;
          for (let j = 0; j < enhDet.windows.length; j++) {
            if (used.has(j)) continue;
            // For Stage 1, compute IoU with 1px dilation for tolerance
            const aMask = isStage1 ? dilateMask1(ow.mask, W, H) : ow.mask;
            const bMask = isStage1 ? dilateMask1(enhDet.windows[j].mask, W, H) : enhDet.windows[j].mask;
            const iou = iouMasks(aMask, bMask);
            if (iou > bestIou) {
              bestIou = iou;
              bestIdx = j;
            }
          }

          if (bestIdx === -1) {
            const msg = `Window ${i + 1} disappeared entirely`;
            console.error(`[WINDOW LOCAL] ${msg}`);
            return { ok: false, score: 0, reasons: [msg], metrics };
          }
          used.add(bestIdx);

          const nw = enhDet.windows[bestIdx];
          const iou = bestIou;
          const areaDelta = Math.abs(nw.area - ow.area) / Math.max(1, ow.area);
          const occluded = (() => {
            // Brightness drop inside original mask
            let oSum = 0, eSum = 0, c = 0;
            for (let p = 0; p < ow.mask.length; p++) {
              if (ow.mask[p]) {
                oSum += origBuf[p];
                eSum += enhBuf[p];
                c++;
              }
            }
            const drop = c ? Math.max(0, (oSum / c - eSum / c) / Math.max(1, oSum / c)) : 0;
            return drop;
          })();
          const occlusionOk = occluded <= W_OCCLUSION_MAX;

          const { cx: ox, cy: oy } = centroidFromMask(ow.mask, W);
          const { cx: nx, cy: ny } = centroidFromMask(nw.mask, W);
          const cshift = Math.hypot(nx - ox, ny - oy) / Math.max(1, diag);

          // Stage 1: only fail windows if IoU is very low AND one of the geometry/occlusion limits is violated.
          // This prevents false fails from tone-mapped panes while keeping geometry preserved.
          const iouBad = iou < W_IOU_MIN;
          const geomBad = areaDelta > W_AREA_DELTA_MAX || cshift > W_CENTROID_SHIFT_MAX || !occlusionOk;
          if (!isStage1) {
            if (iouBad || geomBad) {
              const rsn = `Window ${i + 1}: IoU=${iou.toFixed(2)} (${iouBad ? '<' : '≥'}${W_IOU_MIN}), areaΔ=${(areaDelta * 100).toFixed(1)}% (${areaDelta > W_AREA_DELTA_MAX ? '>' : '≤'} ${(W_AREA_DELTA_MAX * 100).toFixed(0)}%), centroidΔ=${(cshift * 100).toFixed(2)}% (${cshift > W_CENTROID_SHIFT_MAX ? '>' : '≤'} ${(W_CENTROID_SHIFT_MAX * 100).toFixed(0)}%), occlusion=${(occluded * 100).toFixed(1)}% (${occlusionOk ? '≤' : '>'} ${(W_OCCLUSION_MAX * 100).toFixed(0)}%)`;
              console.error(`[WINDOW LOCAL] ${rsn}`);
              return { ok: false, score: 0, reasons: [rsn], metrics };
            }
          } else {
            if (iouBad && geomBad) {
              const rsn = `Window ${i + 1}: IoU=${iou.toFixed(2)} (<${W_IOU_MIN}) + geometry/occlusion limit exceeded`;
              console.error(`[WINDOW LOCAL] ${rsn}`);
              return { ok: false, score: 0, reasons: [rsn], metrics };
            }
            if (iouBad) {
              console.log(`[WINDOW LOCAL] Borderline IoU accepted (Stage 1): ${iou.toFixed(2)} with areaΔ=${(areaDelta*100).toFixed(1)}%, centroidΔ=${(cshift*100).toFixed(2)}%, occ=${(occluded*100).toFixed(1)}%`);
            }
          }
        }
        console.log(`[WINDOW LOCAL] Passed: ${origDet.windows.length} windows preserved.`);
      }
    }
  } catch (e) {
    console.warn('[WINDOW LOCAL] check failed, continuing with remaining validators:', e);
  }

  if (useGeminiValidation) {
    console.log("[VALIDATOR] Running Gemini semantic checks for Stage 2...");
    const ai = getGeminiClient();
    const prevB64 = toBase64(prev.path).data;
    const candB64 = toBase64(cand.path).data;

    // 1) Perspective stability - semantic check for staging
    try {
      const persp = await validatePerspectivePreservation(ai as any, prevB64, candB64);
      const ok = !!persp.ok;
      const s = ok ? 1 : 0;
      metrics.perspective = s;
      if (!ok) reasons.push(persp.reason || "perspective violation");
      const w = weights.perspective;
      score += s * w; totalW += w;
    } catch (e) {
      metrics.perspective = 0;
      reasons.push("perspective check failed");
      totalW += weights.perspective;
    }

    // 2) Furniture scale and placement - Stage 2 only
    try {
      const furn = await validateFurnitureScale(ai as any, prevB64, candB64);
      const ok = !!furn.ok;
      const s = ok ? 1 : 0;
      metrics.furniture = s;
      if (!ok) reasons.push(furn.reason || "furniture scale/placement issue");
      const w = weights.furniture;
      score += s * w; totalW += w;
    } catch (e) {
      metrics.furniture = 0;
      reasons.push("furniture check failed");
      totalW += weights.furniture;
    }

    // 3) Realism check
    try {
      const { validateRealism } = await import("../validators/realism.js");
      const realism = await validateRealism(cand.path);
      if (!realism.ok) {
        reasons.push(...(realism.notes || ["realism violation detected"]));
      }
    } catch (e) {
      reasons.push("realism check failed");
    }

    // 4) Exterior-specific surface/furniture checks
    try {
      if ((ctx.sceneType === 'exterior') && (process.env.EXTERIOR_SURFACE_CHECK !== '0')) {
        const { validateExteriorEnhancement } = await import("../ai/exterior-validator.js");
        const ext = await validateExteriorEnhancement(ai as any, prevB64, candB64, 'staging');
        if (!ext.passed) {
          for (const v of ext.violations || []) {
            const msg = `exterior violation: ${v.type}${v.description ? ` - ${v.description}` : ''}`;
            reasons.push(msg);
          }
        }
      }
    } catch (e) {
      reasons.push("exterior surface check failed");
    }
  } else {
    console.log("[VALIDATOR] Skipping Gemini semantic checks (Stage 1 or disabled)");
    // For Stage 1, just use local structural checks
    score = 1;
    totalW = 1;
  }

  // Local structural/egress check for Stage 2
  if (cand.stage === "2") {
    try {
      const { validateStructure } = await import("../validators/structural.js");
      const struct = await validateStructure(prev.path, candNormPath);
      if (!struct.ok) {
        reasons.push(...(struct.notes || ["egress/fixture blocking detected"]));
      }
    } catch (e) {
      reasons.push("egress/fixture blocking check failed");
    }
  }

  const normalized = totalW ? (score / totalW) : 0;
  const threshold = thresholds[cand.stage as StageId];
  // Also require no explicit reasons for failure
  const ok = normalized >= threshold && reasons.filter(r => r && r.toLowerCase().includes("violation")).length === 0;

  return {
    ok,
    score: normalized,
    reasons: ok ? [] : reasons,
    metrics,
  };
}
import type { GoogleGenAI } from "@google/genai";

/**
 * Unified Validation Response
 * Combines all architectural preservation checks into single AI call
 */
export interface UnifiedValidationResult {
  // Overall validation
  ok: boolean;
  criticalViolation: boolean; // true if any hard failure detected
  
  // Wall & Opening Validation
  walls: {
    ok: boolean;
    originalOpeningCount: number;
    enhancedOpeningCount: number;
    openingsIdentified: string[];
    openingsStatus: string[];
    violation?: string;
  };
  
  // Window Preservation
  windows: {
    ok: boolean;
    originalCount: number;
    enhancedCount: number;
    violation?: string;
  };
  
  // Perspective Preservation
  perspective: {
    ok: boolean;
    viewpointChanged: boolean;
    originalViewpoint: string;
    enhancedViewpoint: string;
    violation?: string;
  };
  
  // Fixture Preservation
  fixtures: {
    ok: boolean;
    violation?: string;
    details?: string;
  };
  
  // Structural Compliance
  structural: {
    ok: boolean;
    structuralViolation: boolean;
    placementViolation: boolean;
    violations: string[];
  };
  
  // Aggregated reasons for any failures
  reasons: string[];
}

/**
 * Unified validator that combines all architectural preservation checks
 * into a single AI call for maximum efficiency
 */
export async function validateAllPreservation(
  ai: GoogleGenAI,
  originalB64: string,
  editedB64: string,
  userProvidedWindowCount?: number
): Promise<UnifiedValidationResult> {
  try {
    const windowCountContext = userProvidedWindowCount !== undefined
      ? `The user has indicated the original image contains ${userProvidedWindowCount} window(s). Use this count for window validation.`
      : 'Detect and count the windows in the original image for validation.';

    const prompt = `You are an architectural preservation validator. Analyze these two images (ORIGINAL and ENHANCED) to verify ALL architectural elements are preserved exactly. Return a SINGLE comprehensive JSON response.

${windowCountContext}

VALIDATION CATEGORIES:

=== 1. WALLS & OPENINGS ===
Check that ALL walls and openings remain EXACTLY the same:
- Wall length, position, angles, and configuration must be IDENTICAL
- NO NEW openings/windows/doors created on blank walls (false architecture)
- Existing openings/passages must remain OPEN and unobstructed
- Count ALL openings in original, verify same count in enhanced
- Check each opening remains OPEN (not blocked with furniture/units)

=== 2. WINDOW PRESERVATION ===
Verify window count remains identical:
- Count visible windows in both images
- ${userProvidedWindowCount !== undefined ? `Original has ${userProvidedWindowCount} windows` : 'Detect original window count'}
- Enhanced must have exact same count

=== 3. PERSPECTIVE PRESERVATION ===
Verify camera viewpoint is EXACTLY the same:
- Camera position must be unchanged (same physical location)
- Camera angle must be identical (no tilt changes)
- Viewing direction must match (facing same wall/direction)
- Vanishing points and perspective lines must align
- Same room photographed from same viewpoint

=== 4. FIXTURE PRESERVATION ===
Check fixed architectural elements unchanged:
- Door/window frames, shutters, hardware
- Light fixtures, ceiling fans, fireplaces
- Built-in cabinets, counters, appliances
- Staircases, columns, built-in features
- (Loose furniture changes are ALLOWED)

=== 5. STRUCTURAL COMPLIANCE ===
Verify structural integrity and placement safety:
- No additions/removals/movements of fixed architectural features
- No wall extensions, repositioning, or reshaping
- No furniture blocking doors/windows (egress/ventilation)
- No objects through/overlapping fixtures
- Furniture properly aligned to floor perspective

RESPONSE FORMAT - Return ONLY this JSON structure:

{
  "walls": {
    "ok": boolean,
    "original_opening_count": number,
    "enhanced_opening_count": number,
    "openings_identified": ["opening 1", "opening 2", ...],
    "openings_status": ["OPEN", "OPEN", ...],
    "violation": "Wall violation: description" or null
  },
  "windows": {
    "ok": boolean,
    "original_count": number,
    "enhanced_count": number,
    "violation": "description" or null
  },
  "perspective": {
    "ok": boolean,
    "viewpoint_changed": boolean,
    "original_viewpoint": "description",
    "enhanced_viewpoint": "description",
    "violation": "Perspective violation: description" or null
  },
  "fixtures": {
    "ok": boolean,
    "violation": "description" or null,
    "details": "specific fixture modified" or null
  },
  "structural": {
    "ok": boolean,
    "structural_violation": boolean,
    "placement_violation": boolean,
    "violations": ["description 1", "description 2", ...]
  }
}

CRITICAL VALIDATION RULES:
1. If enhanced_opening_count > original_opening_count: walls.ok = false
2. If any opening_status is not "OPEN": walls.ok = false  
3. If viewpoint_changed is true: perspective.ok = false
4. If window counts don't match: windows.ok = false
5. Use "Wall violation:" prefix for wall issues
6. Use "Perspective violation:" prefix for perspective issues
7. All violations must have descriptive text in violation fields

Return ONLY the JSON, no explanatory text.`;

    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        { inlineData: { mimeType: "image/png", data: originalB64 } },
        { inlineData: { mimeType: "image/png", data: editedB64 } },
        { text: prompt }
      ]
    });

    const text = result.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || "";
    console.log("[UNIFIED VALIDATOR] Raw AI response:", text.substring(0, 500));

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[UNIFIED VALIDATOR] No JSON found in response - FAILING SAFE");
      throw new Error("Unified validator failed to return valid JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    console.log("[UNIFIED VALIDATOR] Parsed validation result:", JSON.stringify(parsed, null, 2));

    // Build unified result with validation and fail-safe defaults
    const result_data: UnifiedValidationResult = {
      ok: true,
      criticalViolation: false,
      
      walls: {
        ok: parsed.walls?.ok ?? false,
        originalOpeningCount: parsed.walls?.original_opening_count ?? 0,
        enhancedOpeningCount: parsed.walls?.enhanced_opening_count ?? 0,
        openingsIdentified: parsed.walls?.openings_identified ?? [],
        openingsStatus: parsed.walls?.openings_status ?? [],
        violation: parsed.walls?.violation || undefined
      },
      
      windows: {
        ok: parsed.windows?.ok ?? false,
        originalCount: userProvidedWindowCount ?? parsed.windows?.original_count ?? 0,
        enhancedCount: parsed.windows?.enhanced_count ?? 0,
        violation: parsed.windows?.violation || undefined
      },
      
      perspective: {
        ok: parsed.perspective?.ok ?? false,
        viewpointChanged: parsed.perspective?.viewpoint_changed ?? false,
        originalViewpoint: parsed.perspective?.original_viewpoint ?? "unknown",
        enhancedViewpoint: parsed.perspective?.enhanced_viewpoint ?? "unknown",
        violation: parsed.perspective?.violation || undefined
      },
      
      fixtures: {
        ok: parsed.fixtures?.ok ?? false,
        violation: parsed.fixtures?.violation || undefined,
        details: parsed.fixtures?.details || undefined
      },
      
      structural: {
        ok: parsed.structural?.ok ?? false,
        structuralViolation: parsed.structural?.structural_violation ?? false,
        placementViolation: parsed.structural?.placement_violation ?? false,
        violations: parsed.structural?.violations ?? []
      },
      
      reasons: []
    };

    // Apply fail-safe validations and collect reasons
    
    // Wall validation
    if (!result_data.walls.ok || result_data.walls.enhancedOpeningCount > result_data.walls.originalOpeningCount) {
      result_data.ok = false;
      result_data.criticalViolation = true;
      if (result_data.walls.violation) {
        result_data.reasons.push(result_data.walls.violation);
      } else if (result_data.walls.enhancedOpeningCount > result_data.walls.originalOpeningCount) {
        const violation = `Wall violation: ${result_data.walls.enhancedOpeningCount - result_data.walls.originalOpeningCount} new opening(s) created`;
        result_data.walls.violation = violation;
        result_data.reasons.push(violation);
      }
    }

    // Window validation
    if (!result_data.windows.ok || result_data.windows.originalCount !== result_data.windows.enhancedCount) {
      result_data.ok = false;
      result_data.criticalViolation = true;
      if (result_data.windows.violation) {
        result_data.reasons.push(result_data.windows.violation);
      } else {
        const violation = `Window count mismatch: ${result_data.windows.originalCount} → ${result_data.windows.enhancedCount}`;
        result_data.windows.violation = violation;
        result_data.reasons.push(violation);
      }
    }

    // Perspective validation
    if (!result_data.perspective.ok || result_data.perspective.viewpointChanged) {
      result_data.ok = false;
      result_data.criticalViolation = true;
      if (result_data.perspective.violation) {
        result_data.reasons.push(result_data.perspective.violation);
      } else {
        const violation = "Perspective violation: Camera viewpoint changed";
        result_data.perspective.violation = violation;
        result_data.reasons.push(violation);
      }
    }

    // Fixture validation
    if (!result_data.fixtures.ok) {
      result_data.ok = false;
      result_data.criticalViolation = true;
      if (result_data.fixtures.violation) {
        result_data.reasons.push(result_data.fixtures.violation);
      }
    }

    // Structural validation
    if (!result_data.structural.ok) {
      result_data.ok = false;
      if (result_data.structural.structuralViolation) {
        result_data.criticalViolation = true;
      }
      result_data.reasons.push(...result_data.structural.violations);
    }

    console.log("[UNIFIED VALIDATOR] Final result:", {
      ok: result_data.ok,
      criticalViolation: result_data.criticalViolation,
      reasonCount: result_data.reasons.length
    });

    return result_data;

  } catch (error) {
    console.error("[UNIFIED VALIDATOR] Error:", error);
    // Fail safe: reject on any error
    return {
      ok: false,
      criticalViolation: true,
      walls: { ok: false, originalOpeningCount: 0, enhancedOpeningCount: 0, openingsIdentified: [], openingsStatus: [], violation: "Validation error" },
      windows: { ok: false, originalCount: 0, enhancedCount: 0, violation: "Validation error" },
      perspective: { ok: false, viewpointChanged: false, originalViewpoint: "unknown", enhancedViewpoint: "unknown", violation: "Validation error" },
      fixtures: { ok: false, violation: "Validation error" },
      structural: { ok: false, structuralViolation: true, placementViolation: false, violations: ["Validation error"] },
      reasons: ["Unified validation failed - " + (error instanceof Error ? error.message : String(error))]
    };
  }
}
