import sharp from "sharp";
import { enhanceWithStabilityConservativeStage1A } from "../ai/stabilityConservativeUpscaleStage1A";
import { enhanceWithGemini } from "../ai/gemini";
import { runStage1AContentDiff } from "../validators/stage1AContentDiff";
import type { BaseArtifacts } from "../validators/baseArtifacts";
import { computeEdgeMapFromGray } from "../validators/edgeUtils";
import { getAverageLuminance, selectStage1APrompt } from "../ai/prompts.stage1ARealEstate";
import { NZ_REAL_ESTATE_PRESETS, isNZStyleEnabled } from "../config/geminiPresets";
import { buildStage1APromptNZStyle } from "../ai/prompts.nzRealEstate";
import { INTERIOR_PROFILE_FROM_ENV, INTERIOR_PROFILE_CONFIG } from "../config/enhancementProfiles";
import { applyTransformation } from "../utils/sharp-utils"; // AUDIT FIX: safe sharp wrapper
import type { EnhancementProfile } from "../config/enhancementProfiles";
import { buildStage1AInteriorPromptNZStandard, buildStage1AInteriorPromptNZHighEnd } from "../ai/prompts.nzInterior";
import { validateStage } from "../ai/unified-validator";
import { runLowQualityDetector } from "../ai/qualityDetector";
import { GEMINI_TRIGGER_THRESHOLDS } from "../ai/geminiTriggerThresholds";
import { logIfNotFocusMode } from "../logger";
import { logImageAttemptUrl } from "../utils/debugImageUrls";
import type { PipelineContext } from "../types/pipelineContext";
import { applyStage1APostGenerationFinish } from "./stage1A-post-finish";
import { resolveStage1AAblationSettings } from "./stage1A-presets";

// Feature flag: Enable Stability Conservative Upscaler (primary AI)
const USE_STABILITY_STAGE1A = process.env.USE_STABILITY_STAGE1A !== "0";
// Optional quality gate: when enabled, low-quality images skip Stability and go straight to Gemini
const USE_STABILITY_STAGE1A_QUALITY_GATE = process.env.USE_STABILITY_STAGE1A_QUALITY_GATE === "1";
// Optional hard override to force Gemini
const FORCE_GEMINI_STAGE1A = process.env.FORCE_GEMINI_STAGE1A === "1";
// Optional strict diff gate: reroute to Gemini on content diff failure
const STAGE1A_STRICT_DIFF = process.env.STAGE1A_STRICT_DIFF === "1";
// Automatically disable Stability primary after a payment/credit error
const DISABLE_STABILITY_ON_PAYMENT_REQUIRED = process.env.STABILITY_STAGE1A_DISABLE_ON_PAYMENT_REQUIRED !== "0";
function parseOptionalBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseBoundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function scaleFromNeutral(value: number, scale: number): number {
  return 1 + ((value - 1) * scale);
}

interface Stage1APreGenerationControls {
  preservationMode: boolean;
  normalizeEnabled: boolean;
  normalizeShadowLiftThreshold: number;
  normalizeContrastThreshold: number;
  toneStackScale: number;
  localContrastScale: number;
  shadowOffsetScale: number;
  modulateScale: number;
  pregenMedianEnabled: boolean;
  pregenSharpenEnabled: boolean;
  pregenSharpenScale: number;
  moveSharpenToPost: boolean;
}

interface TransformDiagnosticMeta {
  width: number | null;
  height: number | null;
  space: string | null;
  channels: number | null;
  depth: string | null;
  hasAlpha: boolean | null;
}

interface TransformTraceEvent {
  operation: string;
  phase: "before" | "after" | "skipped" | "error";
  reason?: string;
  gain?: number;
  offset?: number;
  gamma?: number;
  values?: { brightness?: number; saturation?: number; hue?: number; lightness?: number };
  meta: TransformDiagnosticMeta;
}

interface TransformTelemetryContext {
  jobId: string;
  sceneType: string;
  roomType?: string;
  trace?: TransformTraceEvent[];
}

const stage1ATransformSkipCounters = {
  skippedLinearCount: 0,
  skippedGammaCount: 0,
  skippedModulateCount: 0,
  skippedPostFinishCount: 0,
};

function recordTrace(context: TransformTelemetryContext | undefined, event: TransformTraceEvent): void {
  if (!context?.trace) return;
  context.trace.push(event);
}

function bumpSkipCounter(
  key: keyof typeof stage1ATransformSkipCounters,
  context: TransformTelemetryContext | undefined,
  operation: string,
  reason: string,
  meta: TransformDiagnosticMeta
): void {
  stage1ATransformSkipCounters[key] += 1;
  console.warn("[stage1A] transform_skip_metric", {
    key,
    operation,
    reason,
    count: stage1ATransformSkipCounters[key],
    jobId: context?.jobId,
    sceneType: context?.sceneType,
    roomType: context?.roomType ?? null,
    width: meta.width,
    height: meta.height,
    space: meta.space,
    channels: meta.channels,
    depth: meta.depth,
    hasAlpha: meta.hasAlpha,
  });
}

function toTransformDiagnosticMeta(meta: sharp.Metadata | null | undefined): TransformDiagnosticMeta {
  return {
    width: typeof meta?.width === "number" ? meta.width : null,
    height: typeof meta?.height === "number" ? meta.height : null,
    space: meta?.space ?? null,
    channels: typeof meta?.channels === "number" ? meta.channels : null,
    depth: meta?.depth ?? null,
    hasAlpha: typeof meta?.hasAlpha === "boolean" ? meta.hasAlpha : null,
  };
}

function isToneTransformCompatible(meta: TransformDiagnosticMeta): boolean {
  const channels = meta.channels ?? 0;
  const space = (meta.space || "").toLowerCase();
  const rgbLikeSpace = !space || space === "srgb" || space === "rgb";
  return (channels === 3 || channels === 4) && rgbLikeSpace;
}

function shouldConvertToSrgb(meta: TransformDiagnosticMeta): boolean {
  const channels = meta.channels ?? 0;
  const space = (meta.space || "").toLowerCase();

  // libvips cannot reliably expand single-band linear data during colourspace conversion.
  if (space === "linear" && channels > 0 && channels < 3) {
    return false;
  }

  return true;
}

async function canonicalizeToSrgbWithFallback(
  image: sharp.Sharp,
  meta: TransformDiagnosticMeta,
  branch: string,
  reason: string,
): Promise<sharp.Sharp> {
  const buildRgbFromRaw = async (source: sharp.Sharp, sourceReason: string): Promise<sharp.Sharp> => {
    const { data, info } = await source.raw().toBuffer({ resolveWithObject: true });
    const width = info.width || 0;
    const height = info.height || 0;
    const srcChannels = info.channels || 0;
    if (!width || !height || !srcChannels) {
      throw new Error(`canonical_raw_invalid:${sourceReason}:${width}x${height}x${srcChannels}`);
    }

    const pixelCount = width * height;
    const rgbData = Buffer.allocUnsafe(pixelCount * 3);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      const srcOffset = pixelIndex * srcChannels;
      const dstOffset = pixelIndex * 3;
      if (srcChannels >= 3) {
        rgbData[dstOffset] = data[srcOffset] ?? 0;
        rgbData[dstOffset + 1] = data[srcOffset + 1] ?? 0;
        rgbData[dstOffset + 2] = data[srcOffset + 2] ?? 0;
      } else {
        const value = data[srcOffset] ?? 0;
        rgbData[dstOffset] = value;
        rgbData[dstOffset + 1] = value;
        rgbData[dstOffset + 2] = value;
      }
    }

    logTransformDiagnostic("canonicalize_raw_to_rgb", "after", meta, branch, {
      reason: sourceReason,
      width,
      height,
      srcChannels,
      dstChannels: 3,
    });

    // Canonical RGB representation for downstream processing and validators.
    return sharp(rgbData, { raw: { width, height, channels: 3 } });
  };

  const canDirectConvert = shouldConvertToSrgb(meta);
  if (canDirectConvert) {
    try {
      logTransformDiagnostic("toColourspace", "before", meta, branch, { target: "srgb", reason });
      const converted = await image
        .clone()
        .toColourspace("srgb")
        .raw()
        .toBuffer({ resolveWithObject: true });
      logTransformDiagnostic("toColourspace", "after", meta, branch, { target: "srgb", reason });
      return sharp(converted.data, {
        raw: {
          width: converted.info.width,
          height: converted.info.height,
          channels: converted.info.channels,
        },
      }).removeAlpha();
    } catch (err: any) {
      const message = String(err?.message || err || "");
      console.warn("[stage1A] Direct toColourspace('srgb') failed, falling back to canonical raw RGB", {
        reason,
        width: meta.width,
        height: meta.height,
        space: meta.space,
        channels: meta.channels,
        depth: meta.depth,
        hasAlpha: meta.hasAlpha,
        message,
      });
      logTransformDiagnostic("toColourspace", "skipped", meta, branch, {
        target: "srgb",
        reason: `${reason}:direct_conversion_failed`,
      });
      return await buildRgbFromRaw(image.clone(), `${reason}:direct_conversion_failed`);
    }
  }

  try {
    console.warn("[stage1A] Converting unsupported colourspace state via canonical raw RGB fallback", {
      reason,
      width: meta.width,
      height: meta.height,
      space: meta.space,
      channels: meta.channels,
      depth: meta.depth,
      hasAlpha: meta.hasAlpha,
    });
    logTransformDiagnostic("toColourspace", "skipped", meta, branch, {
      target: "srgb",
      reason: `${reason}:unsupported_direct_conversion`,
    });
    return await buildRgbFromRaw(image.clone(), `${reason}:unsupported_direct_conversion`);
  } catch (fallbackErr: any) {
    console.warn("[stage1A] Canonical raw RGB fallback failed-open", {
      reason,
      width: meta.width,
      height: meta.height,
      space: meta.space,
      channels: meta.channels,
      depth: meta.depth,
      hasAlpha: meta.hasAlpha,
      message: String(fallbackErr?.message || fallbackErr || ""),
    });
    logTransformDiagnostic("toColourspace", "skipped", meta, branch, {
      target: "srgb",
      reason: `${reason}:no_safe_canonicalization_path`,
    });
    return image;
  }
}

function logTransformDiagnostic(
  operation: string,
  phase: "before" | "after" | "skipped",
  meta: TransformDiagnosticMeta,
  branch: string,
  extras?: Record<string, unknown>
): void {
  console.debug("[stage1A] transform", {
    operation,
    phase,
    branch,
    width: meta.width,
    height: meta.height,
    space: meta.space,
    channels: meta.channels,
    depth: meta.depth,
    hasAlpha: meta.hasAlpha,
    ...(extras || {}),
  });
}

function applyGuardedLinear(
  image: sharp.Sharp,
  meta: TransformDiagnosticMeta,
  branch: string,
  gain: number,
  offset: number,
  reason: string,
  context?: TransformTelemetryContext
): sharp.Sharp {
  if (!isToneTransformCompatible(meta)) {
    console.warn("[stage1A] Skipping unsupported linear() transform", {
      reason,
      branch,
      gain,
      offset,
      width: meta.width,
      height: meta.height,
      space: meta.space,
      channels: meta.channels,
      depth: meta.depth,
      hasAlpha: meta.hasAlpha,
    });
    logTransformDiagnostic("linear", "skipped", meta, branch, { reason, gain, offset });
    recordTrace(context, { operation: "linear", phase: "skipped", reason, gain, offset, meta });
    bumpSkipCounter("skippedLinearCount", context, "linear", reason, meta);
    return image;
  }
  logTransformDiagnostic("linear", "before", meta, branch, { reason, gain, offset });
  recordTrace(context, { operation: "linear", phase: "before", reason, gain, offset, meta });
  const next = image.linear(gain, offset);
  logTransformDiagnostic("linear", "after", meta, branch, { reason });
  recordTrace(context, { operation: "linear", phase: "after", reason, gain, offset, meta });
  return next;
}

function applyGuardedGamma(
  image: sharp.Sharp,
  meta: TransformDiagnosticMeta,
  branch: string,
  gamma: number,
  reason: string,
  context?: TransformTelemetryContext
): sharp.Sharp {
  if (!isToneTransformCompatible(meta)) {
    console.warn("[stage1A] Skipping unsupported gamma() transform", {
      reason,
      branch,
      gamma,
      width: meta.width,
      height: meta.height,
      space: meta.space,
      channels: meta.channels,
      depth: meta.depth,
      hasAlpha: meta.hasAlpha,
    });
    logTransformDiagnostic("gamma", "skipped", meta, branch, { reason, gamma });
    recordTrace(context, { operation: "gamma", phase: "skipped", reason, gamma, meta });
    bumpSkipCounter("skippedGammaCount", context, "gamma", reason, meta);
    return image;
  }
  logTransformDiagnostic("gamma", "before", meta, branch, { reason, gamma });
  recordTrace(context, { operation: "gamma", phase: "before", reason, gamma, meta });
  const next = image.gamma(gamma);
  logTransformDiagnostic("gamma", "after", meta, branch, { reason });
  recordTrace(context, { operation: "gamma", phase: "after", reason, gamma, meta });
  return next;
}

function applyGuardedModulate(
  image: sharp.Sharp,
  meta: TransformDiagnosticMeta,
  branch: string,
  values: { brightness?: number; saturation?: number; hue?: number; lightness?: number },
  reason: string,
  context?: TransformTelemetryContext
): sharp.Sharp {
  if (!isToneTransformCompatible(meta)) {
    console.warn("[stage1A] Skipping unsupported modulate() transform", {
      reason,
      branch,
      values,
      width: meta.width,
      height: meta.height,
      space: meta.space,
      channels: meta.channels,
      depth: meta.depth,
      hasAlpha: meta.hasAlpha,
    });
    logTransformDiagnostic("modulate", "skipped", meta, branch, { reason });
    recordTrace(context, { operation: "modulate", phase: "skipped", reason, values, meta });
    bumpSkipCounter("skippedModulateCount", context, "modulate", reason, meta);
    return image;
  }
  logTransformDiagnostic("modulate", "before", meta, branch, { reason, ...values });
  recordTrace(context, { operation: "modulate", phase: "before", reason, values, meta });
  const next = image.modulate(values);
  logTransformDiagnostic("modulate", "after", meta, branch, { reason });
  recordTrace(context, { operation: "modulate", phase: "after", reason, values, meta });
  return next;
}

function getStage1APreGenerationControls(sceneType?: string): Stage1APreGenerationControls {
  const { settings } = resolveStage1AAblationSettings(sceneType);
  const preservationMode = settings.STAGE1A_ENABLE_PRESERVATION_PREGEN;
  const normalizeEnabled = settings.STAGE1A_PREGEN_NORMALIZE_ENABLED;
  const moveSharpenToPost = parseOptionalBoolean(process.env.STAGE1A_MOVE_SHARPEN_TO_POST)
    ?? preservationMode;

  return {
    preservationMode,
    normalizeEnabled,
    normalizeShadowLiftThreshold: parseBoundedNumber(
      process.env.STAGE1A_PREGEN_NORMALIZE_SHADOW_THRESHOLD,
      preservationMode ? 0.28 : 0.18,
      0,
      1
    ),
    normalizeContrastThreshold: parseBoundedNumber(
      process.env.STAGE1A_PREGEN_NORMALIZE_CONTRAST_THRESHOLD,
      preservationMode ? 0.34 : 0.24,
      0,
      1
    ),
    toneStackScale: parseBoundedNumber(process.env.STAGE1A_PREGEN_TONE_STACK_SCALE, settings.STAGE1A_PREGEN_TONE_STACK_SCALE, 0, 2),
    localContrastScale: parseBoundedNumber(process.env.STAGE1A_PREGEN_LOCAL_CONTRAST_SCALE, settings.STAGE1A_PREGEN_LOCAL_CONTRAST_SCALE, 0, 2),
    shadowOffsetScale: parseBoundedNumber(process.env.STAGE1A_PREGEN_SHADOW_OFFSET_SCALE, settings.STAGE1A_PREGEN_SHADOW_OFFSET_SCALE, 0, 2),
    modulateScale: parseBoundedNumber(process.env.STAGE1A_PREGEN_MODULATE_SCALE, settings.STAGE1A_PREGEN_MODULATE_SCALE, 0, 2),
    pregenMedianEnabled: parseOptionalBoolean(process.env.STAGE1A_PREGEN_MEDIAN_ENABLED) ?? settings.STAGE1A_PREGEN_MEDIAN_ENABLED,
    pregenSharpenEnabled: parseOptionalBoolean(process.env.STAGE1A_PREGEN_SHARPEN_ENABLED) ?? settings.STAGE1A_PREGEN_SHARPEN_ENABLED,
    pregenSharpenScale: parseBoundedNumber(process.env.STAGE1A_PREGEN_SHARPEN_SCALE, settings.STAGE1A_PREGEN_SHARPEN_SCALE, 0, 2),
    moveSharpenToPost,
  };
}

function getStage1APreGenWebpOptions(sceneType?: string): sharp.WebpOptions {
  const { settings } = resolveStage1AAblationSettings(sceneType);
  if (settings.STAGE1A_PREGEN_HIGH_FIDELITY_ENCODE) {
    return {
      quality: 100,
      effort: 6,
      smartSubsample: true,
      nearLossless: true,
    };
  }

  return {
    quality: 97,
    effort: 6,
    smartSubsample: true,
    nearLossless: false,
  };
}

let stabilityPrimaryLockedReason: string | null = null;

function shouldUseStabilityStage1A(): boolean {
  return USE_STABILITY_STAGE1A && !FORCE_GEMINI_STAGE1A && !stabilityPrimaryLockedReason;
}

function lockStabilityPrimary(reason: string) {
  if (stabilityPrimaryLockedReason) return;
  stabilityPrimaryLockedReason = reason;
  logIfNotFocusMode(`[stage1A] Stability primary disabled: ${reason}`);
}

function isPaymentRequiredError(err: any): boolean {
  const msg = (err?.message || "").toLowerCase();
  const body = (err?.body || "").toLowerCase();
  return err?.status === 402 || msg.includes("payment_required") || body.includes("payment_required") || msg.includes("lack sufficient credits") || body.includes("lack sufficient credits");
}

/**
 * Stage 1A: Professional real estate photo enhancement
 * Includes: HDR tone mapping, lens correction, sky enhancement, AI-ready quality
 *
 * Enhancement pipeline:
 * 1. Auto-rotation (EXIF)
 * 2. Lens distortion correction (wide-angle)
 * 3. Histogram normalization
 * 4. HDR tone mapping (dynamic range expansion)
 * 5. Color enhancement (warmth + saturation)
 * 6. Sky enhancement (blue boost)
 * 7. Advanced sharpening
 * 8. Professional output quality
 * 9. Stability AI enhancement (professional, natural, realistic enhancement)
 */

/**
 * Apply HDR-like tone mapping for better dynamic range
 */
function applyHDRToneMapping(img: sharp.Sharp): sharp.Sharp {
  // Moderated S-curve for tonal stabilization (protect bright openings/windows)
  return img
    .linear(1.12, -(128 * 0.12))
    .gamma(1.10);
}

/**
 * Apply lens correction for wide-angle distortion
 */
async function applyLensCorrection(img: sharp.Sharp): Promise<sharp.Sharp> {
  const metadata = await img.metadata();
  const aspectRatio = (metadata.width || 1) / (metadata.height || 1);

  // Only apply to wide-angle shots (aspect ratio > 1.4)
  if (aspectRatio < 1.4) {
    return img;
  }

  // Slight perspective correction using high-quality resampling
  return img.resize({
    width: metadata.width,
    height: metadata.height,
    fit: 'inside',
    kernel: 'lanczos3',  // Best quality resampling
    withoutEnlargement: true
  });
}

/**
 * Helper: Run Gemini Stage 1A enhancement with scene-adaptive prompts
 */
const STAGE1A_SUNNY_EXTERIOR_INSTRUCTION_BLOCK = `If exterior sky is clearly visible through existing windows or doors, enhance the visible outdoor sky and natural daylight conditions so the scene appears bright, clear, and photographed on a pleasant sunny day.

If exterior views are visible through existing windows or doors, improve the exterior outlook naturally.

Where weather-related glass artifacts are clearly visible, gently remove temporary rain droplets, water streaks, condensation, or similar temporary weather effects from the glass only to improve visibility.

Only remove temporary weather-related visibility obstructions when clearly present.

Only perform this cleanup on clearly transparent glass where the exterior view is already genuinely visible through the opening.

Preserve the existing exterior view exactly as shown.

Do not alter neighboring buildings, landscaping, trees, roads, fences, terrain, or surrounding structures.

Do not invent exterior content that is not visible in the original image.

Do not reveal areas hidden by blinds, curtains, shutters, frosted glass, privacy film, textured glass, patterned glass, reflections, or obstructions.

Do not open, move, remove, or modify blinds, curtains, shutters, window coverings, or doors.

Do not alter, replace, redesign, reshape, tint, resize, relocate, or invent any window, glazing, frame, mullion, blind, curtain, or opening component.

Do not remove privacy glass, frosted glass, textured glass, patterned glass, obscured glazing, decorative glazing, or any intentional architectural glass treatment.

If privacy, frosted, textured, patterned, decorative, translucent, or obscured glazing is present, preserve the same opacity, diffusion, and concealment level exactly as shown.

Do not reveal additional scenery, shapes, silhouettes, or detail behind intentionally obscured glazing.

If exterior visibility is poor because the opening is intentionally covered, leave it unchanged.

Only improve exterior sky appearance and visible natural daylight where the sky is already clearly visible.

If the sky is not clearly visible through an existing opening, make no sky-related modifications.

Structural preservation requirements always take priority.`;

async function enhanceWithGeminiStage1A(
  sharpPath: string,
  sceneType: string | undefined,
  replaceSky: boolean,
  enhanceExteriorSky: boolean,
  applyInteriorProfile: boolean,
  interiorProfileKey: EnhancementProfile,
  skyMode: "safe" | "strong" = "safe",
  jobId: string,
  imageId: string,
  roomType?: string,
  jobSampling?: { temperature?: number; topP?: number; topK?: number }
): Promise<string> {
  let enhancementPrompt: string | undefined = undefined;
  let nzTemp: number | undefined = undefined;
  let nzTopP: number | undefined = undefined;
  let nzTopK: number | undefined = undefined;

  // Priority 1: NZ-style prompts if enabled (for NZ market)
  if (isNZStyleEnabled()) {
    const preset = sceneType === "interior" ? NZ_REAL_ESTATE_PRESETS.stage1AInterior : NZ_REAL_ESTATE_PRESETS.stage1AExterior;
    const interiorCfg = INTERIOR_PROFILE_CONFIG[interiorProfileKey];

    if (applyInteriorProfile) {
      enhancementPrompt = interiorProfileKey === "nz_high_end"
        ? buildStage1AInteriorPromptNZHighEnd("room")
        : buildStage1AInteriorPromptNZStandard("room");
      nzTemp = interiorCfg.geminiTemperature;
    } else {
      enhancementPrompt = buildStage1APromptNZStyle("room", (sceneType === 'interior' ? 'interior' : 'exterior') as any);
      nzTemp = preset.temperature;
    }
    nzTopP = preset.topP;
    nzTopK = preset.topK;
  } else {
    // Priority 2: Scene-adaptive real estate prompts (dark/bright/exterior)
    enhancementPrompt = await selectStage1APrompt(sceneType, sharpPath, skyMode);
    // Use conservative sampling for strict content preservation
    nzTemp = 0.0;  // Fully deterministic for Stage 1A
    nzTopP = 0.9;
    nzTopK = 40;
  }

  const promptInjected =
    enhanceExteriorSky === true
    && typeof enhancementPrompt === "string"
    && enhancementPrompt.trim().length > 0;

  if (promptInjected) {
    enhancementPrompt = `${enhancementPrompt}\n\n${STAGE1A_SUNNY_EXTERIOR_INSTRUCTION_BLOCK}`;
  }

  console.log("[STAGE1A_SUNNY_EXTERIOR_PROMPT]", {
    jobId,
    enabled: enhanceExteriorSky === true,
    promptInjected,
  });

  const geminiPath = await enhanceWithGemini(sharpPath, {
    replaceSky: replaceSky,
    declutter: false,
    sceneType: sceneType,
    stage: "1A",
    jobId,
    imageId,
    roomType,
    modelReason: sceneType ? `${sceneType} enhance` : "enhance",
    promptOverride: enhancementPrompt,
    temperature: jobSampling?.temperature ?? nzTemp,
    topP: jobSampling?.topP ?? nzTopP,
    topK: jobSampling?.topK ?? nzTopK,
    floorClean: false,
    hardscapeClean: sceneType === "exterior",
  });

  await logImageAttemptUrl({
    ctx: {
      jobId,
      imageId,
      stage: "1A",
      attempt: 1,
    },
    localPath: geminiPath,
  });

  return geminiPath;
}

/**
 * Enhance sky regions (boost blues for more dramatic effect)
 */
function applySkyEnhancement(img: sharp.Sharp): sharp.Sharp {
  // Keep sky enhancement conservative to avoid clipped window openings
  return img.modulate({
    brightness: 1.0,    // Keep brightness stable
    saturation: 1.14,
  });
}

export interface Stage1AAnalysis {
  lumMean: number;
  lumStdev: number;
  edgeDensity: number;
  isExterior: boolean;
  isBlurry: boolean;
  sceneType: "interior" | "exterior";
}

interface Stage1AFactors {
  darkness: number;
  shadowLift: number;
  highlightCompress: number;
  gammaBoost: number;
  contrastBoost: number;
  saturationBoost: number;
  sharpenAmount: number;
}

const STAGE1A_BLUR_EDGE_THRESHOLD = 15;
const STAGE1A_SOFT_SHARPEN_EDGE_THRESHOLD = 45;

const clampStage1AFactor = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function normalizeRange(value: number, min: number, max: number) {
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (value - min) / (max - min);
}

async function computeEdgeDensity(image: sharp.Sharp): Promise<number> {
  const kernel = {
    width: 3,
    height: 3,
    kernel: [
      0, 1, 0,
      1, -4, 1,
      0, 1, 0,
    ],
  };

  const { data } = await image
    .greyscale()
    .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .convolve(kernel)
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (!data.length) {
    return 0;
  }

  let mean = 0;
  for (let index = 0; index < data.length; index += 1) {
    mean += data[index] ?? 0;
  }
  mean /= data.length;

  let variance = 0;
  for (let index = 0; index < data.length; index += 1) {
    const diff = (data[index] ?? 0) - mean;
    variance += diff * diff;
  }
  variance /= data.length;

  return Number(variance.toFixed(3));
}

async function inferStage1ASceneType(
  inputPath: string,
  sceneType?: string
): Promise<"interior" | "exterior"> {
  if (sceneType === "interior" || sceneType === "exterior") {
    return sceneType;
  }

  const { data, info } = await sharp(inputPath)
    .rotate()
    .removeAlpha()
    .resize(256, 256, { fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width || 0;
  const height = info.height || 0;
  const channels = info.channels || 3;
  if (!width || !height || channels < 3) {
    return "interior";
  }

  const pixelCount = width * height;
  let skyLike = 0;
  let greenLike = 0;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const channelIndex = pixelIndex * channels;
    const red = data[channelIndex] ?? 0;
    const green = data[channelIndex + 1] ?? 0;
    const blue = data[channelIndex + 2] ?? 0;
    const luma = (red + green + blue) / 3;

    if (luma > 110 && blue > green + 10 && blue > red + 18) {
      skyLike += 1;
    }
    if (green > 72 && green > red + 10 && green > blue + 8) {
      greenLike += 1;
    }
  }

  const exteriorSignal = (skyLike + greenLike) / Math.max(1, pixelCount);
  return exteriorSignal >= 0.16 ? "exterior" : "interior";
}

async function analyzeStage1AInput(
  inputPath: string,
  sceneType?: string
): Promise<Stage1AAnalysis> {
  const image = sharp(inputPath).rotate().removeAlpha();
  const stats = await image.clone().greyscale().stats();
  const lumMean = Number((stats.channels[0]?.mean || 0).toFixed(2));
  const lumStdev = Number((stats.channels[0]?.stdev || 0).toFixed(2));
  const edgeDensity = await computeEdgeDensity(image.clone());
  const resolvedSceneType = await inferStage1ASceneType(inputPath, sceneType);
  const isExterior = resolvedSceneType === "exterior";

  let isBlurry = false;
  if (edgeDensity < STAGE1A_BLUR_EDGE_THRESHOLD) {
    if (lumMean > 150 && lumStdev < 20) {
      isBlurry = false;
    } else {
      isBlurry = true;
    }
  }

  return {
    lumMean,
    lumStdev,
    edgeDensity,
    isExterior,
    isBlurry,
    sceneType: resolvedSceneType,
  };
}

function computeStage1AFactors(analysis: Stage1AAnalysis): Stage1AFactors {
  const darkness = clampStage1AFactor((95 - analysis.lumMean) / 50);
  const brightness = clampStage1AFactor((analysis.lumMean - 180) / 40);
  const edgeDensity = normalizeRange(
    analysis.edgeDensity,
    STAGE1A_BLUR_EDGE_THRESHOLD,
    STAGE1A_SOFT_SHARPEN_EDGE_THRESHOLD
  );

  let gammaBoost = darkness * 0.9;
  let shadowLift = darkness * 0.75;
  let contrastBoost = darkness * 0.25;

  if (analysis.isExterior) {
    gammaBoost *= 1.1;
    contrastBoost *= 1.2;
  }

  if (edgeDensity > 0.15) {
    contrastBoost += 0.05;
  }

  let saturationBoost = 0;
  if (analysis.isExterior) {
    saturationBoost = 0.05 + (darkness * 0.1);
  }

  let sharpenAmount = 0;
  if (!analysis.isBlurry && edgeDensity > 0.12 && edgeDensity < 0.35) {
    sharpenAmount = 0.6 + (edgeDensity * 0.8);
  }

  return {
    darkness,
    shadowLift,
    gammaBoost,
    highlightCompress: brightness,
    contrastBoost,
    saturationBoost,
    sharpenAmount,
  };
}

type Stage1ANeutralBalance = {
  redGain: number;
  greenGain: number;
  blueGain: number;
  sampleCount: number;
};

type Stage1ANeutralBalanceOptions = {
  strength?: number;
  highlightBias?: boolean;
};

function clampStage1AColorGain(value: number): number {
  return Math.max(0.94, Math.min(1.06, Number(value.toFixed(4))));
}

async function estimateStage1ANeutralBalance(
  img: sharp.Sharp,
  options?: Stage1ANeutralBalanceOptions
): Promise<Stage1ANeutralBalance | null> {
  const probe = img.clone().removeAlpha();
  const probeMeta = toTransformDiagnosticMeta(await probe.metadata().catch(() => null));

  const rgbProbe = await canonicalizeToSrgbWithFallback(
    probe,
    probeMeta,
    "neutral_balance",
    "neutral_balance_probe",
  );

  const { data, info } = await rgbProbe.raw().toBuffer({ resolveWithObject: true });

  if (!info.width || !info.height || info.channels < 3) {
    return null;
  }

  const pixelCount = info.width * info.height;
  if (!pixelCount) {
    return null;
  }

  const sampleThresholds = options?.highlightBias
    ? [210, 196, 182, 168]
    : [188, 170, 152];
  let selected: Stage1ANeutralBalance | null = null;

  for (const minLuma of sampleThresholds) {
    let redSum = 0;
    let greenSum = 0;
    let blueSum = 0;
    let sampleCount = 0;

    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      const channelIndex = pixelIndex * info.channels;
      const red = data[channelIndex] ?? 0;
      const green = data[channelIndex + 1] ?? 0;
      const blue = data[channelIndex + 2] ?? 0;
      const maxChannel = Math.max(red, green, blue);
      const minChannel = Math.min(red, green, blue);
      const luma = (red + green + blue) / 3;
      if (luma < minLuma) {
        continue;
      }

      const channelSpread = maxChannel - minChannel;
      const normalizedSpread = channelSpread / Math.max(luma, 1);
      if (normalizedSpread > 0.09) {
        continue;
      }

      redSum += red;
      greenSum += green;
      blueSum += blue;
      sampleCount += 1;
    }

    if (sampleCount < 512) {
      continue;
    }

    const redMean = redSum / sampleCount;
    const greenMean = greenSum / sampleCount;
    const blueMean = blueSum / sampleCount;
    const neutralMean = (redMean + greenMean + blueMean) / 3;
    if (!Number.isFinite(neutralMean) || neutralMean <= 0) {
      continue;
    }

    const redGain = clampStage1AColorGain(neutralMean / Math.max(redMean, 1));
    const greenGain = clampStage1AColorGain(neutralMean / Math.max(greenMean, 1));
    const blueGain = clampStage1AColorGain(neutralMean / Math.max(blueMean, 1));
    const maxGainDelta = Math.max(
      Math.abs(redGain - 1),
      Math.abs(greenGain - 1),
      Math.abs(blueGain - 1)
    );

    if (maxGainDelta < 0.006) {
      return null;
    }

    selected = {
      redGain,
      greenGain,
      blueGain,
      sampleCount,
    };
    break;
  }

  return selected;
}

async function applyStage1ANeutralBalance(
  img: sharp.Sharp,
  options?: Stage1ANeutralBalanceOptions
): Promise<{
  image: sharp.Sharp;
  balance: Stage1ANeutralBalance | null;
}> {
  const balance = await estimateStage1ANeutralBalance(img, options).catch(() => null);
  if (!balance) {
    return { image: img, balance: null };
  }

  const toneMeta = toTransformDiagnosticMeta(await img.clone().metadata().catch(() => null));
  if (!isToneTransformCompatible(toneMeta)) {
    console.warn("[stage1A] Neutral balance skipped due to incompatible band state", {
      width: toneMeta.width,
      height: toneMeta.height,
      space: toneMeta.space,
      channels: toneMeta.channels,
      depth: toneMeta.depth,
      hasAlpha: toneMeta.hasAlpha,
    });
    return { image: img, balance: null };
  }

  const strength = clampStage1AFactor(options?.strength ?? 1, 0, 1);
  const redGain = 1 + ((balance.redGain - 1) * strength);
  const greenGain = 1 + ((balance.greenGain - 1) * strength);
  const blueGain = 1 + ((balance.blueGain - 1) * strength);

  const channels = toneMeta.channels ?? 3;
  const gains = channels === 4
    ? [redGain, greenGain, blueGain, 1]
    : [redGain, greenGain, blueGain];
  const offsets = channels === 4
    ? [0, 0, 0, 0]
    : [0, 0, 0];

  return {
    image: img.linear(gains, offsets),
    balance: {
      ...balance,
      redGain,
      greenGain,
      blueGain,
    },
  };
}

function applyStage1ABrightnessGuard(baseBrightness: number, meanBrightness?: number): number {
  if (typeof meanBrightness !== "number" || !Number.isFinite(meanBrightness)) {
    return baseBrightness;
  }

  // Taper brightness lift on already-bright inputs to avoid overexposure.
  // 125 -> no taper, 195+ -> full taper to neutral (1.0)
  if (meanBrightness <= 125) {
    return baseBrightness;
  }

  const taper = Math.min(1, (meanBrightness - 125) / 70);
  const maxReduction = Math.max(0, baseBrightness - 1.0);
  const guarded = baseBrightness - (maxReduction * taper);
  return Math.max(1.0, Number(guarded.toFixed(3)));
}

export async function runStage1A(
  inputPath: string,
  options: { 
    replaceSky?: boolean;
    enhanceExteriorSky?: boolean;
    declutter?: boolean;
    sceneType?: "interior" | "exterior" | string;
    interiorProfile?: EnhancementProfile;
    skyMode?: "safe" | "strong";
    jobId: string;
    imageId: string;
    roomType?: string;
    baseArtifacts?: BaseArtifacts;
    baseArtifactsCache?: Map<string, BaseArtifacts>;
    jobSampling?: { temperature?: number; topP?: number; topK?: number };
  }
): Promise<string> {
  const {
    replaceSky = false,
    enhanceExteriorSky = false,
    declutter = false,
    sceneType,
    skyMode = "safe",
    jobId,
    imageId,
    roomType,
  } = options;
  logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1A.ts", variable: "__baseArtifacts" });
  const baseArtifacts = options.baseArtifacts ?? undefined;
  logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1A.ts", variable: "__jobId" });
  const jobIdResolved = jobId;
  logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1A.ts", variable: "__jobRoomType" });
  const roomTypeResolved = roomType;
  const stage1ACtx: PipelineContext = {
    jobId,
    imageId,
    stage: "1A",
    attempt: 1,
  };
  const analysis = await analyzeStage1AInput(inputPath, sceneType);
  const { presetName, settings: ablationSettings } = resolveStage1AAblationSettings(analysis.sceneType);
  console.log("[Stage1A Analysis]", analysis);
  const factors = computeStage1AFactors(analysis);
  const preGenControls = getStage1APreGenerationControls(analysis.sceneType);
  const preGenWebpOptions = getStage1APreGenWebpOptions(analysis.sceneType);
  const presetSummary = {
    preset: presetName,
    sceneType: analysis.sceneType,
    normalizeEnabled: preGenControls.normalizeEnabled,
    normalizeShadowThreshold: preGenControls.normalizeShadowLiftThreshold,
    normalizeContrastThreshold: preGenControls.normalizeContrastThreshold,
    toneStackScale: preGenControls.toneStackScale,
    localContrastScale: preGenControls.localContrastScale,
    shadowOffsetScale: preGenControls.shadowOffsetScale,
    postFinish: ablationSettings.STAGE1A_ENABLE_POSTGEN_FINISH,
    highFidelityEncode: ablationSettings.STAGE1A_PREGEN_HIGH_FIDELITY_ENCODE,
    canonicalHighFidelity: ablationSettings.PREPROCESS_CANONICAL_HIGH_FIDELITY,
    canonicalWebpQuality: ablationSettings.PREPROCESS_CANONICAL_WEBP_QUALITY,
  };
  console.log("[Stage1A Factors]", factors);
  logIfNotFocusMode(`[stage1A] Ablation preset resolved: ${presetName}`);
  logIfNotFocusMode("[stage1A] Ablation settings", ablationSettings);
  logIfNotFocusMode("[stage1A] Pre-generation controls", preGenControls);
  logIfNotFocusMode("[stage1A] Pre-generation encode options", preGenWebpOptions);
  console.log("[stage1A] preset_summary", JSON.stringify(presetSummary));
  logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1A.ts", variable: "__jobSampling" });
  const effectiveSceneType = analysis.sceneType;
  const isInterior = effectiveSceneType === "interior";
  const applyInteriorProfile = isInterior && !declutter && isNZStyleEnabled();
  let interiorProfileKey: EnhancementProfile = (options.interiorProfile && (options.interiorProfile in INTERIOR_PROFILE_CONFIG))
    ? options.interiorProfile
    : INTERIOR_PROFILE_FROM_ENV;
  const interiorCfg = INTERIOR_PROFILE_CONFIG[interiorProfileKey];
  if (!applyInteriorProfile) {
    // Fallback to standard so references are safe; will be unused.
    interiorProfileKey = "nz_standard";
  }
  
  const sharpOutputPath = inputPath.replace(/\.(jpg|jpeg|png|webp)$/i, "-1A-sharp.webp");
  const finalOutputPath = inputPath.replace(/\.(jpg|jpeg|png|webp)$/i, "-1A.webp");
  const path1ACore = finalOutputPath;
  const inputMeanBrightness = analysis.lumMean || await getAverageLuminance(inputPath).catch(() => undefined);
  
  let img = sharp(inputPath);
  const metadata = await img.metadata();
  const stage1ATransformMeta = toTransformDiagnosticMeta(metadata);
  const stage1ABranch = effectiveSceneType === "exterior" ? "exterior" : "interior";
  const transformTrace: TransformTraceEvent[] = [];
  const transformTelemetry: TransformTelemetryContext = {
    jobId: jobIdResolved,
    sceneType: effectiveSceneType,
    roomType: roomTypeResolved,
    trace: transformTrace,
  };
  
  // 1. Auto-rotate based on EXIF orientation
  img = img.rotate().removeAlpha();
  const srgbInitMeta = toTransformDiagnosticMeta(await img.metadata().catch(() => null));
  img = await canonicalizeToSrgbWithFallback(
    img,
    srgbInitMeta,
    stage1ABranch,
    "initial_canonicalization",
  );

  const runGeminiStage1AWithOptionalFinish = async (): Promise<string> => {
    console.log("[STAGE1A_SUNNY_EXTERIOR]", {
      jobId: jobIdResolved,
      enabled: enhanceExteriorSky === true,
      roomType: roomTypeResolved ?? null,
        weatherArtifactCleanupEnabled: true,
    });

    const geminiOutputPath = await enhanceWithGeminiStage1A(
      sharpOutputPath,
      effectiveSceneType,
      replaceSky,
      enhanceExteriorSky,
      applyInteriorProfile,
      interiorProfileKey,
      skyMode,
      jobIdResolved,
      imageId,
      roomTypeResolved,
      options.jobSampling
    );

    if (!ablationSettings.STAGE1A_ENABLE_POSTGEN_FINISH) {
      return geminiOutputPath;
    }

    try {
      const finishedPath = await applyStage1APostGenerationFinish(geminiOutputPath, {
        jobId: jobIdResolved,
        sceneType: effectiveSceneType,
        roomType: roomTypeResolved,
      });

      await logImageAttemptUrl({
        ctx: stage1ACtx,
        localPath: finishedPath,
      });

      console.warn("[stage1A] artifact_consistency", {
        deliveryArtifactPath: finishedPath,
        validatorArtifactPath: finishedPath,
        previewArtifactPath: finishedPath,
        mode: "postfinish_success",
      });

      return finishedPath;
    } catch (err: any) {
      stage1ATransformSkipCounters.skippedPostFinishCount += 1;
      console.warn("[stage1A] Post-finish failed, falling back to pre-postfinish artifact", {
        jobId: jobIdResolved,
        sceneType: effectiveSceneType,
        roomType: roomTypeResolved ?? null,
        message: err?.message || String(err),
        skippedPostFinishCount: stage1ATransformSkipCounters.skippedPostFinishCount,
      });
      await logImageAttemptUrl({
        ctx: stage1ACtx,
        localPath: geminiOutputPath,
      });
      console.warn("[stage1A] artifact_consistency", {
        deliveryArtifactPath: geminiOutputPath,
        validatorArtifactPath: geminiOutputPath,
        previewArtifactPath: geminiOutputPath,
        mode: "postfinish_fail_open",
      });
      return geminiOutputPath;
    }
  };

  if (analysis.isBlurry && shouldUseStabilityStage1A()) {
    await img
      .clone()
      .webp(preGenWebpOptions)
      .toFile(sharpOutputPath);

    await logImageAttemptUrl({
      ctx: stage1ACtx,
      localPath: sharpOutputPath,
    });

    logIfNotFocusMode("[stage1A] Blurry image detected — bypassing heavy Sharp enhancement and routing directly to Stability");

    try {
      const stabilityJpeg = await enhanceWithStabilityConservativeStage1A(sharpOutputPath, effectiveSceneType);
      const stabilityWebp = sharpOutputPath.replace("-1A-sharp.webp", "-1A-stability.webp");
      await applyTransformation(stabilityJpeg, stabilityWebp, s => s.webp({ quality: 95 }), jobIdResolved);
      await logImageAttemptUrl({
        ctx: stage1ACtx,
        localPath: stabilityWebp,
      });
      const fs = await import("fs/promises");
      await fs.rename(stabilityWebp, path1ACore);
      await logImageAttemptUrl({
        ctx: stage1ACtx,
        localPath: path1ACore,
      });
      return path1ACore;
    } catch (err) {
      logIfNotFocusMode("[stage1A] Stability blur rescue failed — continuing with softened Sharp path", err);
      img = sharp(inputPath).rotate().removeAlpha();
      const fallbackMeta = toTransformDiagnosticMeta(await img.metadata().catch(() => null));
      img = await canonicalizeToSrgbWithFallback(
        img,
        fallbackMeta,
        stage1ABranch,
        "blurry_fallback_reset",
      );
    }
  }
  
  // 2. Conservative denoise: keep interiors clean, preserve exterior texture and blurry detail.
  if (
    preGenControls.pregenMedianEnabled
    && !analysis.isBlurry
    && !analysis.isExterior
    && (factors.shadowLift > 0.12 || factors.contrastBoost > 0.08)
  ) {
    img = img.median(3);
  }
  
  // 3. Apply lens correction for wide-angle shots
  if (!analysis.isBlurry) {
    img = await applyLensCorrection(img);
  }
  
  // 4. Exposure triage: normalize only when the image is dark or compressed.
  if (
    preGenControls.normalizeEnabled
    && (factors.shadowLift > preGenControls.normalizeShadowLiftThreshold
      || factors.contrastBoost > preGenControls.normalizeContrastThreshold)
  ) {
    logTransformDiagnostic("normalize", "before", stage1ATransformMeta, stage1ABranch);
    img = img.normalize();
    logTransformDiagnostic("normalize", "after", stage1ATransformMeta, stage1ABranch);
  }

  // 4b. Re-anchor white balance on bright low-chroma regions so neutral walls
  // and ceilings stay optically neutral without flattening genuine warm lights.
  const neutralBalanceResult = await applyStage1ANeutralBalance(img);
  img = neutralBalanceResult.image;
  if (neutralBalanceResult.balance) {
    console.log("[Stage1A] Neutral balance applied:", neutralBalanceResult.balance);
    logIfNotFocusMode(
      `[stage1A] Neutral balance applied (samples=${neutralBalanceResult.balance.sampleCount}, redGain=${neutralBalanceResult.balance.redGain.toFixed(3)}, greenGain=${neutralBalanceResult.balance.greenGain.toFixed(3)}, blueGain=${neutralBalanceResult.balance.blueGain.toFixed(3)})`
    );
  } else {
    logIfNotFocusMode("[stage1A] Neutral balance skipped (insufficient neutral highlights)");
  }
  
  // 5. Apply scaled corrections rather than hard switching.
  if (factors.shadowLift > 0.05 && preGenControls.toneStackScale > 0) {
    img = applyGuardedGamma(
      img,
      stage1ATransformMeta,
      stage1ABranch,
      1 + (factors.gammaBoost * 0.6 * preGenControls.toneStackScale),
      "tone_stack_gamma",
      transformTelemetry
    );
    if (!analysis.isExterior) {
      img = applyGuardedLinear(
        img,
        stage1ATransformMeta,
        stage1ABranch,
        1 + (factors.shadowLift * 0.08 * preGenControls.toneStackScale),
        0,
        "tone_stack_shadow_lift",
        transformTelemetry
      );
    }
  }

  if (factors.highlightCompress > 0.05 && preGenControls.toneStackScale > 0) {
    img = applyGuardedLinear(
      img,
      stage1ATransformMeta,
      stage1ABranch,
      1 - (factors.highlightCompress * 0.2 * preGenControls.toneStackScale),
      0,
      "tone_stack_highlight_compress",
      transformTelemetry
    );
  }

  if (factors.contrastBoost > 0.05 && preGenControls.toneStackScale > 0) {
    img = applyGuardedLinear(
      img,
      stage1ATransformMeta,
      stage1ABranch,
      1 + (factors.contrastBoost * 0.3 * preGenControls.toneStackScale),
      0,
      "tone_stack_contrast_boost",
      transformTelemetry
    );
  }

  if ((factors.shadowLift > 0.05 || factors.gammaBoost > 0.05) && preGenControls.toneStackScale > 0.25) {
    const postToneNeutralBalance = await applyStage1ANeutralBalance(img, {
      strength: 0.4 * Math.min(1, preGenControls.toneStackScale),
      highlightBias: true,
    });
    img = postToneNeutralBalance.image;
    if (postToneNeutralBalance.balance) {
      console.log("[Stage1A] Post-tone neutral rebalance applied", postToneNeutralBalance.balance);
      logIfNotFocusMode(
        `[stage1A] Post-tone neutral rebalance applied (samples=${postToneNeutralBalance.balance.sampleCount}, redGain=${postToneNeutralBalance.balance.redGain.toFixed(3)}, greenGain=${postToneNeutralBalance.balance.greenGain.toFixed(3)}, blueGain=${postToneNeutralBalance.balance.blueGain.toFixed(3)})`
      );
    }
  }
  
  // 6. Adaptive brightness/saturation (dynamic interior profile or default exterior)
  if (applyInteriorProfile) {
    const baseBrightness = 1 + (interiorCfg.brightnessBoost * (0.14 + (factors.shadowLift * 0.42)));
    const guardedBrightness = applyStage1ABrightnessGuard(baseBrightness, inputMeanBrightness);
    const brightness = scaleFromNeutral(guardedBrightness, preGenControls.modulateScale);
    const saturationRaw = 1.03 + (interiorCfg.saturation * 0.4) + (factors.contrastBoost * 0.03) + factors.saturationBoost;
    const saturation = scaleFromNeutral(saturationRaw, preGenControls.modulateScale);
    img = applyGuardedModulate(
      img,
      stage1ATransformMeta,
      stage1ABranch,
      { brightness, saturation },
      "interior_profile_modulate",
      transformTelemetry
    );
    if (factors.contrastBoost > 0.05 && factors.highlightCompress < 0.35 && preGenControls.localContrastScale > 0) {
      img = applyGuardedLinear(
        img,
        stage1ATransformMeta,
        stage1ABranch,
        1 + (interiorCfg.localContrast * 0.4 * preGenControls.localContrastScale),
        -(128 * interiorCfg.localContrast * 0.35 * preGenControls.localContrastScale),
        "interior_local_contrast",
        transformTelemetry
      );
    }
    logIfNotFocusMode(`[stage1A] Interior profile applied: ${interiorProfileKey} (brightness=${brightness.toFixed(2)}, sat=${saturation.toFixed(2)}, inputMeanBrightness=${typeof inputMeanBrightness === "number" ? inputMeanBrightness.toFixed(1) : "n/a"})`);
  } else {
    const baseBrightness = analysis.isExterior
      ? 1 + (factors.shadowLift * 0.05)
      : 1 + (factors.shadowLift * 0.08);
    const guardedBrightness = applyStage1ABrightnessGuard(baseBrightness, inputMeanBrightness);
    const brightness = scaleFromNeutral(guardedBrightness, preGenControls.modulateScale);
    const saturationRaw = analysis.isExterior
      ? 1.01 + (factors.contrastBoost * 0.02) + factors.saturationBoost
      : 1.04 + (factors.contrastBoost * 0.04);
    const saturation = scaleFromNeutral(saturationRaw, preGenControls.modulateScale);
    img = applyGuardedModulate(
      img,
      stage1ATransformMeta,
      stage1ABranch,
      {
        brightness,
        saturation,
      },
      "default_profile_modulate",
      transformTelemetry
    );
    logIfNotFocusMode(`[stage1A] Default profile applied (brightness=${brightness.toFixed(2)}, sat=${saturation.toFixed(2)}, inputMeanBrightness=${typeof inputMeanBrightness === "number" ? inputMeanBrightness.toFixed(1) : "n/a"})`);
  }
  
  // 7. Keep only a very mild interior shadow offset; preserve exterior shadows.
  if (!analysis.isExterior && factors.shadowLift > 0.12 && preGenControls.shadowOffsetScale > 0) {
    if (applyInteriorProfile) {
      img = applyGuardedLinear(
        img,
        stage1ATransformMeta,
        stage1ABranch,
        1.0,
        Math.round(128 * interiorCfg.shadowLift * 0.06 * factors.shadowLift * preGenControls.shadowOffsetScale),
        "interior_shadow_offset_profile",
        transformTelemetry
      );
    } else {
      img = applyGuardedLinear(
        img,
        stage1ATransformMeta,
        stage1ABranch,
        1.0,
        Math.round(2 * preGenControls.shadowOffsetScale),
        "interior_shadow_offset_default",
        transformTelemetry
      );
    }
  }
  
  // 8. Sky enhancement (explicit-only): avoid implicit sky edits that can introduce haze.
  if (effectiveSceneType === "exterior" && skyMode === "strong") {
    img = applySkyEnhancement(img);
    logIfNotFocusMode("[stage1A] Sky enhancement pre-pass enabled (scene=exterior, skyMode=strong)");
  } else {
    logIfNotFocusMode(`[stage1A] Sky enhancement pre-pass skipped (scene=${effectiveSceneType}, skyMode=${skyMode})`);
  }
  
  // 9. Keep edge brightening narrow and only for darker interiors.
  if (!analysis.isExterior && factors.shadowLift > 0.18 && preGenControls.shadowOffsetScale > 0) {
    img = applyGuardedLinear(
      img,
      stage1ATransformMeta,
      stage1ABranch,
      1.0,
      Math.round(3 * preGenControls.shadowOffsetScale),
      "interior_edge_brightening",
      transformTelemetry
    );
  }
  
  // 10. Sharpen only for non-blurry images with moderate edge density.
  if (preGenControls.pregenSharpenEnabled && factors.sharpenAmount > 0) {
    logTransformDiagnostic("sharpen", "before", stage1ATransformMeta, stage1ABranch, {
      sigma: 1.2,
      amount: factors.sharpenAmount * preGenControls.pregenSharpenScale,
    });
    img = img.sharpen({
      sigma: 1.2,
      m1: 1.0,
      m2: factors.sharpenAmount * preGenControls.pregenSharpenScale,
      x1: 2.0,
      y2: 10.0,
      y3: 20.0,
    });
    logTransformDiagnostic("sharpen", "after", stage1ATransformMeta, stage1ABranch);
  }
  
  // 12. Export Sharp enhancement with maximum quality
  logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1A.ts", variable: "__baseArtifactsCache" });
  const baseArtifactsCache: Map<string, BaseArtifacts> = options.baseArtifactsCache || new Map();
  const buildArtifacts = !baseArtifactsCache.has(sharpOutputPath);
  const artifactsPromise: Promise<BaseArtifacts | null> | null = buildArtifacts ? (async (): Promise<BaseArtifacts | null> => {
    try {
      const base = img.clone();
      const meta = await base.metadata();
      const [gray, small] = await Promise.all([
        base.clone().greyscale().raw().toBuffer({ resolveWithObject: true }),
        base.clone().greyscale().resize(512, 512, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true }),
      ]);

      const rgbNoAlpha = base.clone().removeAlpha();
      const rgbMeta = toTransformDiagnosticMeta(await rgbNoAlpha.metadata().catch(() => null));
      if ((rgbMeta.channels ?? 0) <= 0) {
        console.warn("[stage1A] BaseArtifacts RGB conversion unavailable: invalid channel metadata", {
          width: rgbMeta.width,
          height: rgbMeta.height,
          space: rgbMeta.space,
          channels: rgbMeta.channels,
          depth: rgbMeta.depth,
          hasAlpha: rgbMeta.hasAlpha,
        });
        logTransformDiagnostic("base_artifacts_rgb", "skipped", rgbMeta, stage1ABranch, {
          reason: "invalid_channel_metadata",
        });
        return null;
      }

      logTransformDiagnostic("removeAlpha", "before", rgbMeta, stage1ABranch, { branch: "base_artifacts_rgb" });
      logTransformDiagnostic("removeAlpha", "after", rgbMeta, stage1ABranch, { branch: "base_artifacts_rgb" });
      const srgb = await canonicalizeToSrgbWithFallback(
        rgbNoAlpha,
        rgbMeta,
        stage1ABranch,
        "base_artifacts_rgb",
      );
      const rgb = await srgb.raw().toBuffer({ resolveWithObject: true });

      if (!meta.width || !meta.height) {
        throw new Error("Failed to read Stage1A artifact dimensions");
      }

      const grayData = new Uint8Array(gray.data.buffer, gray.data.byteOffset, gray.data.byteLength);
      const edge = computeEdgeMapFromGray(grayData, gray.info.width, gray.info.height, 38);
      return {
        path: sharpOutputPath,
        width: meta.width,
        height: meta.height,
        gray: grayData,
        smallGray: new Uint8Array(small.data.buffer, small.data.byteOffset, small.data.byteLength),
        smallWidth: small.info.width,
        smallHeight: small.info.height,
        edge,
        rgb: new Uint8Array(rgb.data.buffer, rgb.data.byteOffset, rgb.data.byteLength),
      };
    } catch (err) {
      // Attach handler at creation time to avoid transient unhandled rejection warnings.
      logIfNotFocusMode("[stage1A] Failed to build BaseArtifacts cache:", err);
      console.warn("[stage1A] BaseArtifacts build failed with transform trace", {
        jobId: jobIdResolved,
        sceneType: effectiveSceneType,
        roomType: roomTypeResolved ?? null,
        error: (err as any)?.message || String(err),
        cacheEntryWritten: false,
        transformTrace: transformTrace.slice(-30),
      });
      return null;
    }
  })() : null;

  try {
    await img
      .webp(preGenWebpOptions)
      .toFile(sharpOutputPath);
  } catch (err: any) {
    console.error("[stage1A] Failed to render pre-generation output", {
      jobId: jobIdResolved,
      sceneType: effectiveSceneType,
      roomType: roomTypeResolved ?? null,
      message: err?.message || String(err),
      transformTrace: transformTrace.slice(-30),
    });
    throw err;
  }

  await logImageAttemptUrl({
    ctx: stage1ACtx,
    localPath: sharpOutputPath,
  });

  if (artifactsPromise) {
    const artifacts = await artifactsPromise;
    if (artifacts) {
      baseArtifactsCache.set(sharpOutputPath, artifacts);
    }
  }
  
  logIfNotFocusMode(`[stage1A] Sharp enhancement complete: ${inputPath} → ${sharpOutputPath}`);

  const runStage1AStructuralValidationSafely = async (
    baselinePath: string,
    candidatePath: string,
    label: "primary output" | "gemini output"
  ): Promise<void> => {
    try {
      const { loadOrComputeStructuralMask } = await import("../validators/structuralMask.js");
      const { validateStage1AStructural } = await import("../validators/stage1AValidator.js");
      const maskPath = await loadOrComputeStructuralMask(jobIdResolved, baselinePath, baseArtifacts);
      const masks = { structuralMask: maskPath };
      const verdict = await validateStage1AStructural(baselinePath, candidatePath, masks, effectiveSceneType as any);
      logIfNotFocusMode(`[stage1A] Structural validator verdict (${label}):`, verdict);
      if (!verdict.ok) {
        logIfNotFocusMode(`[stage1A] HARD FAIL: ${verdict.reason}`);
      }
    } catch (err) {
      logIfNotFocusMode(`[stage1A] Structural validator failed-open (${label}):`, err);
    }
  };

  // --- DETERMINISTIC AI ROUTING (Quality-Based Engine Selection) ---
  if (shouldUseStabilityStage1A()) {
    if (USE_STABILITY_STAGE1A_QUALITY_GATE) {
      const quality = await runLowQualityDetector(sharpOutputPath);
      const forceGemini =
        quality.meanBrightness < GEMINI_TRIGGER_THRESHOLDS.MIN_BRIGHTNESS ||
        quality.noiseStdDev > GEMINI_TRIGGER_THRESHOLDS.MAX_NOISE_STDDEV ||
        quality.dynamicRange < GEMINI_TRIGGER_THRESHOLDS.MIN_DYNAMIC_RANGE ||
        quality.laplacianEstimate > GEMINI_TRIGGER_THRESHOLDS.MAX_LAPLACIAN_ESTIMATE;

      logIfNotFocusMode("[stage1A] Quality Scan:", {
        ...quality,
        forceGemini
      });

      if (forceGemini) {
        logIfNotFocusMode("[stage1A] ⚠️ Quality gate triggered — using Gemini instead of Stability");
        const geminiOutputPath = await runGeminiStage1AWithOptionalFinish();
        return geminiOutputPath;
      }
    } else {
      logIfNotFocusMode("[stage1A] Quality gate disabled — attempting Stability first");
    }

    let primary1AImage: string;

    logIfNotFocusMode("[stage1A] ✅ Using Stability primary (Gemini fallback on error)");
    try {
      const stabilityJpeg = await enhanceWithStabilityConservativeStage1A(sharpOutputPath, effectiveSceneType);
      const stabilityWebp = sharpOutputPath.replace("-1A-sharp.webp", "-1A-stability.webp");
      // AUDIT FIX: routed through applyTransformation for safe cleanup
      await applyTransformation(stabilityJpeg, stabilityWebp, s => s.webp({ quality: 95 }), jobIdResolved);
      await logImageAttemptUrl({
        ctx: stage1ACtx,
        localPath: stabilityWebp,
      });
      primary1AImage = stabilityWebp;
    } catch (err) {
      logIfNotFocusMode("[stage1A] ❌ Stability API failed:", err);
      if (isPaymentRequiredError(err) && DISABLE_STABILITY_ON_PAYMENT_REQUIRED) {
        lockStabilityPrimary("Stability credits exhausted (payment_required)");
      }
      logIfNotFocusMode("[stage1A] 🔁 Falling back to Gemini...");
      primary1AImage = await runGeminiStage1AWithOptionalFinish();
    }

    // ✅ AUTHORITATIVE CONTENT VALIDATION
    const diffResult = await runStage1AContentDiff(
      sharpOutputPath,
      primary1AImage,
      baseArtifacts
    );

    if (!diffResult.passed && STAGE1A_STRICT_DIFF) {
      logIfNotFocusMode("[stage1A] 🚨 Content diff FAIL — rerouting to Gemini (strict mode)");

      try {
        const geminiImage = await runGeminiStage1AWithOptionalFinish();

        await runStage1AStructuralValidationSafely(sharpOutputPath, geminiImage, "gemini output");

        const fs = await import("fs/promises");
        await fs.rename(geminiImage, path1ACore);
        await logImageAttemptUrl({
          ctx: stage1ACtx,
          localPath: path1ACore,
        });
        logIfNotFocusMode(`[stage1A] Professional enhancement complete: ${inputPath} → ${path1ACore}`);
        return path1ACore;

      } catch {
        logIfNotFocusMode("[stage1A] 🔴 Gemini failed — FINAL fallback to Sharp only");
        const fs = await import("fs/promises");
        await fs.rename(sharpOutputPath, path1ACore);
        await logImageAttemptUrl({
          ctx: stage1ACtx,
          localPath: path1ACore,
        });
        logIfNotFocusMode(`[stage1A] Professional enhancement complete: ${inputPath} → ${path1ACore}`);
        return path1ACore;
      }
    } else if (!diffResult.passed) {
      logIfNotFocusMode("[stage1A] ⚠️ Content diff failed but strict mode disabled — keeping Stability output");
    }

    logIfNotFocusMode("[stage1A] ✅ Stage 1A content diff validator PASSED");

    await runStage1AStructuralValidationSafely(sharpOutputPath, primary1AImage, "primary output");

    const fs = await import("fs/promises");
    await fs.rename(primary1AImage, path1ACore);
    await logImageAttemptUrl({
      ctx: stage1ACtx,
      localPath: path1ACore,
    });
    logIfNotFocusMode(`[stage1A] Professional enhancement complete: ${inputPath} → ${path1ACore}`);
    return path1ACore;
  }

  // --- LEGACY FALLBACK (if Stability disabled) ---
  try {
    const reason = stabilityPrimaryLockedReason
      ? `${stabilityPrimaryLockedReason}`
      : FORCE_GEMINI_STAGE1A
        ? "forced via env"
        : "feature flag off";
    logIfNotFocusMode(`[stage1A] 🟡 Using Gemini (Stability disabled: ${reason})...`);

    const geminiOutputPath = await runGeminiStage1AWithOptionalFinish();

    logIfNotFocusMode("[stage1A] ✅ Gemini enhancement complete:", geminiOutputPath);

    if (geminiOutputPath !== sharpOutputPath) {
      await runStage1AStructuralValidationSafely(sharpOutputPath, geminiOutputPath, "gemini output");

      const fs = await import("fs/promises");
      await fs.rename(geminiOutputPath, path1ACore);
      await logImageAttemptUrl({
        ctx: stage1ACtx,
        localPath: path1ACore,
      });
      logIfNotFocusMode(`[stage1A] Professional enhancement complete: ${inputPath} → ${path1ACore}`);
      return path1ACore;
    }

  } catch (err) {
    logIfNotFocusMode("[stage1A] 🔴 Gemini failed — FINAL fallback to Sharp only!", err);
  }

  // --- FINAL EMERGENCY FALLBACK: Sharp Only ---
  logIfNotFocusMode("[stage1A] ℹ️ Using Sharp enhancement only (all AI failed)");
  const fs = await import("fs/promises");
  await fs.rename(sharpOutputPath, path1ACore);
  await logImageAttemptUrl({
    ctx: stage1ACtx,
    localPath: path1ACore,
  });
  logIfNotFocusMode(`[stage1A] Professional enhancement complete: ${inputPath} → ${path1ACore}`);
  return path1ACore;
}
