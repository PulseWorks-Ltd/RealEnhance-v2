import sharp from "sharp";
import fs from "fs";
import path from "path";

// Optional ONNX support (dynamic import; falls back to heuristics if missing)
type ORT = any;
let ort: ORT | null = null;
let sceneSession: any | null = null;

async function loadOrt(): Promise<ORT | null> {
  try {
    if (!ort) ort = await import("onnxruntime-node");
    return ort;
  } catch {
    return null;
  }
}

async function ensureSceneSession(): Promise<any | null> {
  if (sceneSession) return sceneSession;
  const modelPath = process.env.MODEL_SCENE_PATH || path.join(process.cwd(), "models", "scene_mobilenet.onnx");
  if (!fs.existsSync(modelPath)) return null;
  const o = await loadOrt();
  if (!o) return null;
  sceneSession = await o.InferenceSession.create(modelPath, { executionProviders: ["cpu"] });
  return sceneSession;
}

export type ScenePrimary = "interior" | "exterior";

export interface ScenePrimaryResult {
  label: ScenePrimary;
  confidence: number; // 0..1
  skyPct?: number;
  grassPct?: number;
  woodDeckPct?: number;
  // Extended metrics for sky mode gating
  skyTop10?: number;   // Sky pixels in top 10% of image
  skyTop40?: number;   // Sky pixels in top 40% of image
  blueOverall?: number; // Blue sky pixels in entire image
  reason?: string;
  needsConfirm?: boolean;
  coveredExteriorSuspect?: boolean;
}

async function onnxClassify(buf: Buffer): Promise<ScenePrimaryResult | null> {
  const sess = await ensureSceneSession();
  const o = await loadOrt();
  if (!sess || !o) return null;
  const raw = await sharp(buf).resize(224, 224).removeAlpha().raw().toBuffer();
  const f32 = Float32Array.from(raw, (v) => v / 255);
  const input = new o.Tensor("float32", f32, [1, 224, 224, 3]); // NHWC
  const feeds: Record<string, any> = {};
  feeds[sess.inputNames[0] || "input"] = input;
  const out = await sess.run(feeds);
  const outName = sess.outputNames[0];
  const data = Array.from((out as any)[outName].data as Float32Array);
  const softmax = (v: number[]) => {
    const m = Math.max(...v);
    const e = v.map((x) => Math.exp(x - m));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / s);
  };
  const probs = softmax(data);
  const idx = probs.indexOf(Math.max(...probs));
  const label: ScenePrimary = idx === 1 ? "exterior" : "interior"; // assume [interior, exterior]
  return { label, confidence: probs[idx] ?? 0.5 };
}

async function heuristic(buf: Buffer): Promise<ScenePrimaryResult> {
  const W = 224;
  const img = sharp(buf).resize({ width: W, fit: "inside" }).raw().ensureAlpha();
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  const H = info.height;
  const stride = info.channels; // 4
  let sky = 0, grass = 0, woodDeck = 0, total = 0;

  // Extended metrics for sky mode gating
  let skyTop10 = 0, skyTop40 = 0, blueOverall = 0;
  let pixelsTop10 = 0, pixelsTop40 = 0;
  const top10Boundary = Math.floor(H * 0.1);
  const top40Boundary = Math.floor(H * 0.4);

  const toHSV = (r: number, g: number, b: number) => {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const v = max;
    const d = max - min;
    const s = max === 0 ? 0 : d / max;
    let h = 0;
    if (d !== 0) {
      if (max === R) h = ((G - B) / d) % 6;
      else if (max === G) h = (B - R) / d + 2;
      else h = (R - G) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s, v };
  };

  const lowerBandStart = Math.floor(H * 0.6);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * stride;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const { h, s, v } = toHSV(r, g, b);
      total++;

      // Track pixels in different regions
      if (y < top10Boundary) pixelsTop10++;
      if (y < top40Boundary) pixelsTop40++;

      // Detect bright sky-like pixels (lighter criteria for general sky)
      const isSkyLike = v > 0.7 && s < 0.45 && h >= 190 && h <= 240;
      // Detect specifically blue sky pixels (stricter criteria)
      const isBlue = v > 0.5 && s > 0.2 && h >= 195 && h <= 230;

      if (isSkyLike) {
        sky++;
        if (y < top10Boundary) skyTop10++;
        if (y < top40Boundary) skyTop40++;
      }
      if (isBlue) blueOverall++;

      if (v > 0.35 && s > 0.35 && h >= 75 && h <= 150) grass++;
      if (y >= lowerBandStart && v > 0.25 && s > 0.15) {
        const isRedBrown = (h >= 10 && h <= 30) || (h >= 330 || h <= 5);
        if (isRedBrown) woodDeck++;
      }
    }
  }
  const skyPct = sky / total;
  const grassPct = grass / total;
  const woodDeckPct = woodDeck / (total * 0.4);
  const isExterior = skyPct >= 0.15 || grassPct >= 0.12 || woodDeckPct >= 0.2;
  const label: ScenePrimary = isExterior ? "exterior" : "interior";
  const signal = Math.max(skyPct, grassPct, woodDeckPct);
  const confidence = Math.max(0.55, Math.min(0.95, signal * 2));

  // Calculate extended metrics as ratios
  const skyTop10Pct = pixelsTop10 > 0 ? skyTop10 / pixelsTop10 : 0;
  const skyTop40Pct = pixelsTop40 > 0 ? skyTop40 / pixelsTop40 : 0;
  const blueOverallPct = total > 0 ? blueOverall / total : 0;

  return {
    label,
    confidence,
    skyPct: Number(skyPct.toFixed(4)),
    grassPct: Number(grassPct.toFixed(4)),
    woodDeckPct: Number(woodDeckPct.toFixed(4)),
    skyTop10: Number(skyTop10Pct.toFixed(4)),
    skyTop40: Number(skyTop40Pct.toFixed(4)),
    blueOverall: Number(blueOverallPct.toFixed(4))
  };
}

export async function detectSceneFromImage(buf: Buffer): Promise<ScenePrimaryResult> {
  // Run ONNX first for primary label
  const onnx = await onnxClassify(buf);

  // Always run heuristic to get robust metrics for covered-area detection
  const heur = await heuristic(buf);

  const base = onnx ?? heur;
  const metrics = {
    skyTop10: heur.skyTop10 ?? base.skyTop10 ?? 0,
    skyTop40: heur.skyTop40 ?? base.skyTop40 ?? 0,
    blueOverall: heur.blueOverall ?? base.blueOverall ?? 0,
  };

  // Covered exterior suspect guard: mark unsure regardless of ONNX confidence
  const coveredExteriorSuspect = isCoveredExteriorSuspect({ ...base, ...metrics });
  if (coveredExteriorSuspect) {
    const result: ScenePrimaryResult = {
      ...base,
      ...metrics,
      confidence: Math.min(base.confidence ?? 0, 0.49),
      coveredExteriorSuspect: true,
      needsConfirm: true,
      reason: "covered_exterior_suspect",
    };
    console.debug('[SCENE][worker] covered_exterior_suspect → unsure', {
      skyTop10: metrics.skyTop10,
      skyTop40: metrics.skyTop40,
      blueOverall: metrics.blueOverall,
      onnxConf: onnx?.confidence ?? null,
      label: result.label,
      confidence: result.confidence,
    });
    return result;
  }

  // Return base result with merged metrics for downstream sky mode gating
  return { ...base, ...metrics };
}

/**
 * Sky mode gating for exterior images.
 * Determines whether to use SKY_SAFE (tonal only) or SKY_STRONG (replacement allowed).
 *
 * SKY_STRONG requires:
 * - skyTop40 >= 0.16 (sufficient open sky in top 40% of image)
 * - blueOverall >= 0.10 (sufficient blue sky visible)
 *
 * Covered exterior suspect detection (forces SKY_SAFE):
 * - skyTop10 > 0.02 && blueOverall < 0.06 && skyTop40 > 0.05
 * - This pattern indicates patio covers, pergolas, or awnings that could be mistaken for sky
 */
export type SkyMode = "safe" | "strong";

export interface SkyModeResult {
  mode: SkyMode;
  allowStrongSky: boolean;
  coveredExteriorSuspect: boolean;
  features: {
    skyTop10: number;
    skyTop40: number;
    blueOverall: number;
  };
  thresholds: {
    skyTop40Min: number;
    blueOverallMin: number;
  };
}

function isCoveredExteriorSuspect(sceneResult: ScenePrimaryResult): boolean {
  const coveredEnabled = (process.env.COVERED_EXTERIOR_SUSPECT_ENABLED || '1') === '1';
  if (!coveredEnabled) return false;

  const skyTop10 = sceneResult.skyTop10 ?? 0;
  const skyTop40 = sceneResult.skyTop40 ?? 0;
  const blueOverall = sceneResult.blueOverall ?? 0;

  const coveredSkyTop10Min = Number(process.env.COVERED_SKYTOP10_MIN || 0.02);
  const coveredBlueOverallMax = Number(process.env.COVERED_BLUEOVERALL_MAX || 0.06);
  const coveredSkyTop40Min = Number(process.env.COVERED_SKYTOP40_MIN || 0.05);

  return (
    skyTop10 > coveredSkyTop10Min &&
    blueOverall < coveredBlueOverallMax &&
    skyTop40 > coveredSkyTop40Min
  );
}

/**
 * Determines sky mode for exterior images.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ENV VARS DOCUMENTATION (PART B - SKY_SAFE AUDIT)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * NO ENV VARS REQUIRED for default behavior. Defaults are tuned for:
 * - Open-sky exteriors → SKY_STRONG (replacement allowed)
 * - Covered/uncertain exteriors → SKY_SAFE (tonal only)
 *
 * Optional tuning env vars:
 * - SKY_STRONG_SKYTOP40_MIN (default: 0.16) - Min sky coverage in top 40% for STRONG
 * - SKY_STRONG_BLUEOVERALL_MIN (default: 0.10) - Min blue sky overall for STRONG
 * - COVERED_EXTERIOR_SUSPECT_ENABLED (default: '1') - Enable covered exterior detection
 * - COVERED_SKYTOP10_MIN (default: 0.02) - Covered detection: min sky in top 10%
 * - COVERED_BLUEOVERALL_MAX (default: 0.06) - Covered detection: max blue overall
 * - COVERED_SKYTOP40_MIN (default: 0.05) - Covered detection: min sky in top 40%
 *
 * Missing env vars do NOT force SKY_SAFE by default - the algorithm uses
 * feature-based detection to allow SKY_STRONG for clearly open-sky images.
 */
export function determineSkyMode(sceneResult: ScenePrimaryResult): SkyModeResult {
  // Extract features (default to 0 if not available)
  const skyTop10 = sceneResult.skyTop10 ?? 0;
  const skyTop40 = sceneResult.skyTop40 ?? 0;
  const blueOverall = sceneResult.blueOverall ?? 0;

  // Configurable thresholds via env vars for SKY_STRONG gating
  // These defaults are tuned to allow SKY_STRONG for clearly open-sky images
  const skyTop40Min = Number(process.env.SKY_STRONG_SKYTOP40_MIN || 0.16);
  const blueOverallMin = Number(process.env.SKY_STRONG_BLUEOVERALL_MIN || 0.10);

  // Covered exterior suspect detection (conservative - forces SKY_SAFE)
  // Pattern: some sky-like pixels in top but very little blue overall = likely covered area (pergola, patio cover)
  const coveredExteriorSuspect = isCoveredExteriorSuspect(sceneResult);

  // Determine if features qualify for strong sky
  const meetsStrongThresholds = skyTop40 >= skyTop40Min && blueOverall >= blueOverallMin;

  // Strong sky allowed only if both thresholds met AND not a covered exterior suspect
  const allowStrongSky = !coveredExteriorSuspect && meetsStrongThresholds;

  // Determine reason code for debugging
  let reasonCode: string;
  if (coveredExteriorSuspect) {
    reasonCode = "covered_exterior_suspect";
  } else if (!meetsStrongThresholds) {
    reasonCode = skyTop40 < skyTop40Min ? "low_sky_coverage" : "low_blue_sky";
  } else {
    reasonCode = "confident_open_sky";
  }

  const result: SkyModeResult = {
    mode: allowStrongSky ? "strong" : "safe",
    allowStrongSky,
    coveredExteriorSuspect,
    features: { skyTop10, skyTop40, blueOverall },
    thresholds: { skyTop40Min, blueOverallMin }
  };

  // Dev-only logging (exactly once per image at decision point) - PART B requirement
  console.log(`[SKY_MODE_DECISION] mode=${result.mode} allowStrongSky=${allowStrongSky} ` +
    `reason=${reasonCode} coveredSuspect=${coveredExteriorSuspect} ` +
    `features={skyTop10:${skyTop10.toFixed(3)},skyTop40:${skyTop40.toFixed(3)},blueOverall:${blueOverall.toFixed(3)}} ` +
    `thresholds={skyTop40Min:${skyTop40Min},blueOverallMin:${blueOverallMin}} ` +
    `meetsThresholds=${meetsStrongThresholds}`);

  return result;
}