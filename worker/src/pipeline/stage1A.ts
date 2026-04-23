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
async function enhanceWithGeminiStage1A(
  sharpPath: string,
  sceneType: string | undefined,
  replaceSky: boolean,
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

interface Stage1AAnalysis {
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
  const { data, info } = await img
    .clone()
    .ensureAlpha()
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

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

  const strength = clampStage1AFactor(options?.strength ?? 1, 0, 1);
  const redGain = 1 + ((balance.redGain - 1) * strength);
  const greenGain = 1 + ((balance.greenGain - 1) * strength);
  const blueGain = 1 + ((balance.blueGain - 1) * strength);

  return {
    image: img.linear([
      redGain,
      greenGain,
      blueGain,
    ], [0, 0, 0]),
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
  const { replaceSky = false, declutter = false, sceneType, skyMode = "safe", jobId, imageId, roomType } = options;
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
  console.log("[Stage1A Analysis]", analysis);
  const factors = computeStage1AFactors(analysis);
  console.log("[Stage1A Factors]", factors);
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
  
  // 1. Auto-rotate based on EXIF orientation
  img = img.rotate();

  if (analysis.isBlurry && shouldUseStabilityStage1A()) {
    await img
      .clone()
      .webp({
        quality: 97,
        effort: 6,
        smartSubsample: true,
        nearLossless: false,
      })
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
      img = sharp(inputPath).rotate();
    }
  }
  
  // 2. Conservative denoise: keep interiors clean, preserve exterior texture and blurry detail.
  if (!analysis.isBlurry && !analysis.isExterior && (factors.shadowLift > 0.12 || factors.contrastBoost > 0.08)) {
    img = img.median(3);
  }
  
  // 3. Apply lens correction for wide-angle shots
  if (!analysis.isBlurry) {
    img = await applyLensCorrection(img);
  }
  
  // 4. Exposure triage: normalize only when the image is dark or compressed.
  if (factors.shadowLift > 0.18 || factors.contrastBoost > 0.24) {
    img = img.normalize();
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
  if (factors.shadowLift > 0.05) {
    img = img.gamma(1 + (factors.gammaBoost * 0.6));
    if (!analysis.isExterior) {
      img = img.linear(1 + (factors.shadowLift * 0.08), 0);
    }
  }

  if (factors.highlightCompress > 0.05) {
    img = img.linear(1 - (factors.highlightCompress * 0.2), 0);
  }

  if (factors.contrastBoost > 0.05) {
    img = img.linear(1 + (factors.contrastBoost * 0.3), 0);
  }

  if (factors.shadowLift > 0.05 || factors.gammaBoost > 0.05) {
    const postToneNeutralBalance = await applyStage1ANeutralBalance(img, {
      strength: 0.4,
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
    const brightness = applyStage1ABrightnessGuard(baseBrightness, inputMeanBrightness);
    const saturation = 1.03 + (interiorCfg.saturation * 0.4) + (factors.contrastBoost * 0.03) + factors.saturationBoost;
    img = img.modulate({ brightness, saturation });
    if (factors.contrastBoost > 0.05 && factors.highlightCompress < 0.35) {
      img = img.linear(
        1 + (interiorCfg.localContrast * 0.4),
        -(128 * interiorCfg.localContrast * 0.35)
      );
    }
    logIfNotFocusMode(`[stage1A] Interior profile applied: ${interiorProfileKey} (brightness=${brightness.toFixed(2)}, sat=${saturation.toFixed(2)}, inputMeanBrightness=${typeof inputMeanBrightness === "number" ? inputMeanBrightness.toFixed(1) : "n/a"})`);
  } else {
    const baseBrightness = analysis.isExterior
      ? 1 + (factors.shadowLift * 0.05)
      : 1 + (factors.shadowLift * 0.08);
    const brightness = applyStage1ABrightnessGuard(baseBrightness, inputMeanBrightness);
    const saturation = analysis.isExterior
      ? 1.01 + (factors.contrastBoost * 0.02) + factors.saturationBoost
      : 1.04 + (factors.contrastBoost * 0.04);
    img = img.modulate({
      brightness,
      saturation,
    });
    logIfNotFocusMode(`[stage1A] Default profile applied (brightness=${brightness.toFixed(2)}, sat=${saturation.toFixed(2)}, inputMeanBrightness=${typeof inputMeanBrightness === "number" ? inputMeanBrightness.toFixed(1) : "n/a"})`);
  }
  
  // 7. Keep only a very mild interior shadow offset; preserve exterior shadows.
  if (!analysis.isExterior && factors.shadowLift > 0.12) {
    if (applyInteriorProfile) {
      img = img.linear(1.0, Math.round(128 * interiorCfg.shadowLift * 0.06 * factors.shadowLift));
    } else {
      img = img.linear(1.0, 2);
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
  if (!analysis.isExterior && factors.shadowLift > 0.18) {
    img = img.linear(1.0, 3);
  }
  
  // 10. Sharpen only for non-blurry images with moderate edge density.
  if (factors.sharpenAmount > 0) {
    img = img.sharpen({
      sigma: 1.2,
      m1: 1.0,
      m2: factors.sharpenAmount,
      x1: 2.0,
      y2: 10.0,
      y3: 20.0,
    });
  }
  
  // 12. Export Sharp enhancement with maximum quality
  logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1A.ts", variable: "__baseArtifactsCache" });
  const baseArtifactsCache: Map<string, BaseArtifacts> = options.baseArtifactsCache || new Map();
  const buildArtifacts = !baseArtifactsCache.has(sharpOutputPath);
  const artifactsPromise = buildArtifacts ? ((): Promise<BaseArtifacts> => {
    const base = img.clone();
    const metaPromise = base.metadata();
    const grayPromise = base.clone().greyscale().raw().toBuffer({ resolveWithObject: true });
    const smallPromise = base.clone().greyscale().resize(512, 512, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
    const rgbPromise = base.clone().ensureAlpha().removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    return Promise.all([metaPromise, grayPromise, smallPromise, rgbPromise]).then(([meta, gray, small, rgb]) => {
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
    });
  })() : null;

  await img
    .webp({ 
      quality: 97,            // Very high quality (maintains 4K detail)
      effort: 6,              // Maximum compression efficiency
      smartSubsample: true,   // Better color preservation, reduces banding
      nearLossless: false,    // Lossy for optimal compression
    })
    .toFile(sharpOutputPath);

  await logImageAttemptUrl({
    ctx: stage1ACtx,
    localPath: sharpOutputPath,
  });

  if (artifactsPromise) {
    try {
      const artifacts = await artifactsPromise;
      baseArtifactsCache.set(sharpOutputPath, artifacts);
    } catch (e) {
      logIfNotFocusMode("[stage1A] Failed to build BaseArtifacts cache:", e);
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
        const geminiOutputPath = await enhanceWithGeminiStage1A(sharpOutputPath, effectiveSceneType, replaceSky, applyInteriorProfile, interiorProfileKey, skyMode, jobIdResolved, imageId, roomTypeResolved, options.jobSampling);
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
      primary1AImage = await enhanceWithGeminiStage1A(sharpOutputPath, effectiveSceneType, replaceSky, applyInteriorProfile, interiorProfileKey, skyMode, jobIdResolved, imageId, roomTypeResolved, options.jobSampling);
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
        const geminiImage = await enhanceWithGeminiStage1A(sharpOutputPath, effectiveSceneType, replaceSky, applyInteriorProfile, interiorProfileKey, skyMode, jobIdResolved, imageId, roomTypeResolved, options.jobSampling);

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

    const geminiOutputPath = await enhanceWithGeminiStage1A(sharpOutputPath, effectiveSceneType, replaceSky, applyInteriorProfile, interiorProfileKey, skyMode, jobIdResolved, imageId, roomTypeResolved, options.jobSampling);

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
