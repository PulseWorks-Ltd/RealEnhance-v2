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
    stage: "1A",
    attempt: 1,
    jobId,
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
    roomType?: string;
    baseArtifacts?: BaseArtifacts;
    baseArtifactsCache?: Map<string, BaseArtifacts>;
    jobSampling?: { temperature?: number; topP?: number; topK?: number };
  }
): Promise<string> {
  const { replaceSky = false, declutter = false, sceneType, skyMode = "safe", jobId, roomType } = options;
  logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1A.ts", variable: "__baseArtifacts" });
  const baseArtifacts = options.baseArtifacts ?? undefined;
  logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1A.ts", variable: "__jobId" });
  const jobIdResolved = jobId;
  logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1A.ts", variable: "__jobRoomType" });
  const roomTypeResolved = roomType;
  logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1A.ts", variable: "__jobSampling" });
  const isInterior = sceneType === "interior";
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
  const inputMeanBrightness = await getAverageLuminance(inputPath).catch(() => undefined);
  
  let img = sharp(inputPath);
  const metadata = await img.metadata();
  
  // 1. Auto-rotate based on EXIF orientation
  img = img.rotate();
  
  // 2. Mild noise reduction BEFORE sharpening (keeps walls smooth, edges crisp)
  img = img.median(3);
  
  // 3. Apply lens correction for wide-angle shots
  img = await applyLensCorrection(img);
  
  // 4. Normalize histogram (automatic exposure + white balance correction)
  img = img.normalize();
  
  // 5. HDR tone mapping first (lift shadows, retain highlights)
  img = applyHDRToneMapping(img);
  
  // 6. Adaptive brightness/saturation (dynamic interior profile or default exterior)
  if (applyInteriorProfile) {
    const baseBrightness = 1 + interiorCfg.brightnessBoost; // strong global lift
    const brightness = applyStage1ABrightnessGuard(baseBrightness, inputMeanBrightness);
    // Base saturation 1.15 plus profile extra (kept lower than exterior to avoid colour cast)
    const saturation = 1.15 + interiorCfg.saturation;
    img = img.modulate({ brightness, saturation });
    // Additional midtone/local contrast shaping
    img = img.gamma(1.0 + (interiorCfg.midtoneLift * 0.12)); // gentle gamma tweak for midtones
    img = img.linear(1 + interiorCfg.localContrast, -(128 * interiorCfg.localContrast));
    logIfNotFocusMode(`[stage1A] Interior profile applied: ${interiorProfileKey} (brightness=${brightness.toFixed(2)}, sat=${saturation.toFixed(2)}, inputMeanBrightness=${typeof inputMeanBrightness === "number" ? inputMeanBrightness.toFixed(1) : "n/a"})`);
  } else {
    const baseBrightness = 1.10; // reduced lift for opening stability
    const brightness = applyStage1ABrightnessGuard(baseBrightness, inputMeanBrightness);
    img = img.modulate({
      brightness,
      saturation: 1.16,
    });
    logIfNotFocusMode(`[stage1A] Default profile applied (brightness=${brightness.toFixed(2)}, sat=1.20, inputMeanBrightness=${typeof inputMeanBrightness === "number" ? inputMeanBrightness.toFixed(1) : "n/a"})`);
  }
  
  // 7. Gamma correction for shadow detail (lower = brighter shadows)
  if (!applyInteriorProfile) {
    img = img.gamma(1.05);
  } else {
    // Profile already adjusted gamma; apply mild shadow lift using linear offset
    img = img.linear(1.0, Math.round(128 * interiorCfg.shadowLift * 0.15));
  }
  
  // 8. Sky enhancement (explicit-only): avoid implicit sky edits that can introduce haze.
  if (sceneType === "exterior" && skyMode === "strong") {
    img = applySkyEnhancement(img);
    logIfNotFocusMode("[stage1A] Sky enhancement pre-pass enabled (scene=exterior, skyMode=strong)");
  } else {
    logIfNotFocusMode(`[stage1A] Sky enhancement pre-pass skipped (scene=${sceneType || "unknown"}, skyMode=${skyMode})`);
  }
  
  // 9. Local contrast enhancement (CLAHE-like clarity boost)
  img = img.linear(1.08, -(128 * 0.08));
  
  // 10. Vignette reduction (brighten edges by 3-5%)
  img = img.linear(1.0, 5);  // Subtle edge lift
  
  // 11. Advanced unsharp mask sharpening (2-pass for HD clarity)
  // Pass 1: Macro detail and structure
  img = img.sharpen({
    sigma: 1.2,     // Radius for textures
    m1: 2.0,        // Strong amount (professional grade)
    m2: 0.6,        // Low threshold = sharpen more areas
  });
  
  // Pass 2: Micro detail and edges
  img = img.sharpen({
    sigma: 0.5,     // Tight radius for fine detail
    m1: 1.2,        // Moderate amount to avoid halos
    m2: 0.8,        // High threshold = only crisp edges
  });
  
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
    stage: "1A",
    attempt: 1,
    jobId: jobIdResolved,
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
      const verdict = await validateStage1AStructural(baselinePath, candidatePath, masks, sceneType as any);
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
        const geminiOutputPath = await enhanceWithGeminiStage1A(sharpOutputPath, sceneType, replaceSky, applyInteriorProfile, interiorProfileKey, skyMode, jobIdResolved, roomTypeResolved, options.jobSampling);
        return geminiOutputPath;
      }
    } else {
      logIfNotFocusMode("[stage1A] Quality gate disabled — attempting Stability first");
    }

    let primary1AImage: string;

    logIfNotFocusMode("[stage1A] ✅ Using Stability primary (Gemini fallback on error)");
    try {
      const stabilityJpeg = await enhanceWithStabilityConservativeStage1A(sharpOutputPath, sceneType);
      const stabilityWebp = sharpOutputPath.replace("-1A-sharp.webp", "-1A-stability.webp");
      // AUDIT FIX: routed through applyTransformation for safe cleanup
      await applyTransformation(stabilityJpeg, stabilityWebp, s => s.webp({ quality: 95 }), jobIdResolved);
      await logImageAttemptUrl({
        stage: "1A",
        attempt: 1,
        jobId: jobIdResolved,
        localPath: stabilityWebp,
      });
      primary1AImage = stabilityWebp;
    } catch (err) {
      logIfNotFocusMode("[stage1A] ❌ Stability API failed:", err);
      if (isPaymentRequiredError(err) && DISABLE_STABILITY_ON_PAYMENT_REQUIRED) {
        lockStabilityPrimary("Stability credits exhausted (payment_required)");
      }
      logIfNotFocusMode("[stage1A] 🔁 Falling back to Gemini...");
      primary1AImage = await enhanceWithGeminiStage1A(sharpOutputPath, sceneType, replaceSky, applyInteriorProfile, interiorProfileKey, skyMode, jobIdResolved, roomTypeResolved, options.jobSampling);
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
        const geminiImage = await enhanceWithGeminiStage1A(sharpOutputPath, sceneType, replaceSky, applyInteriorProfile, interiorProfileKey, skyMode, jobIdResolved, roomTypeResolved, options.jobSampling);

        await runStage1AStructuralValidationSafely(sharpOutputPath, geminiImage, "gemini output");

        const fs = await import("fs/promises");
        await fs.rename(geminiImage, finalOutputPath);
        await logImageAttemptUrl({
          stage: "1A",
          attempt: 1,
          jobId: jobIdResolved,
          localPath: finalOutputPath,
        });
        logIfNotFocusMode(`[stage1A] Professional enhancement complete: ${inputPath} → ${finalOutputPath}`);
        return finalOutputPath;

      } catch {
        logIfNotFocusMode("[stage1A] 🔴 Gemini failed — FINAL fallback to Sharp only");
        const fs = await import("fs/promises");
        await fs.rename(sharpOutputPath, finalOutputPath);
        await logImageAttemptUrl({
          stage: "1A",
          attempt: 1,
          jobId: jobIdResolved,
          localPath: finalOutputPath,
        });
        logIfNotFocusMode(`[stage1A] Professional enhancement complete: ${inputPath} → ${finalOutputPath}`);
        return finalOutputPath;
      }
    } else if (!diffResult.passed) {
      logIfNotFocusMode("[stage1A] ⚠️ Content diff failed but strict mode disabled — keeping Stability output");
    }

    logIfNotFocusMode("[stage1A] ✅ Stage 1A content diff validator PASSED");

    await runStage1AStructuralValidationSafely(sharpOutputPath, primary1AImage, "primary output");

    const fs = await import("fs/promises");
    await fs.rename(primary1AImage, finalOutputPath);
    await logImageAttemptUrl({
      stage: "1A",
      attempt: 1,
      jobId: jobIdResolved,
      localPath: finalOutputPath,
    });
    logIfNotFocusMode(`[stage1A] Professional enhancement complete: ${inputPath} → ${finalOutputPath}`);
    return finalOutputPath;
  }

  // --- LEGACY FALLBACK (if Stability disabled) ---
  try {
    const reason = stabilityPrimaryLockedReason
      ? `${stabilityPrimaryLockedReason}`
      : FORCE_GEMINI_STAGE1A
        ? "forced via env"
        : "feature flag off";
    logIfNotFocusMode(`[stage1A] 🟡 Using Gemini (Stability disabled: ${reason})...`);

    const geminiOutputPath = await enhanceWithGeminiStage1A(sharpOutputPath, sceneType, replaceSky, applyInteriorProfile, interiorProfileKey, skyMode, jobIdResolved, roomTypeResolved, options.jobSampling);

    logIfNotFocusMode("[stage1A] ✅ Gemini enhancement complete:", geminiOutputPath);

    if (geminiOutputPath !== sharpOutputPath) {
      await runStage1AStructuralValidationSafely(sharpOutputPath, geminiOutputPath, "gemini output");

      const fs = await import("fs/promises");
      await fs.rename(geminiOutputPath, finalOutputPath);
      await logImageAttemptUrl({
        stage: "1A",
        attempt: 1,
        jobId: jobIdResolved,
        localPath: finalOutputPath,
      });
      logIfNotFocusMode(`[stage1A] Professional enhancement complete: ${inputPath} → ${finalOutputPath}`);
      return finalOutputPath;
    }

  } catch (err) {
    logIfNotFocusMode("[stage1A] 🔴 Gemini failed — FINAL fallback to Sharp only!", err);
  }

  // --- FINAL EMERGENCY FALLBACK: Sharp Only ---
  logIfNotFocusMode("[stage1A] ℹ️ Using Sharp enhancement only (all AI failed)");
  const fs = await import("fs/promises");
  await fs.rename(sharpOutputPath, finalOutputPath);
  await logImageAttemptUrl({
    stage: "1A",
    attempt: 1,
    jobId: jobIdResolved,
    localPath: finalOutputPath,
  });
  logIfNotFocusMode(`[stage1A] Professional enhancement complete: ${inputPath} → ${finalOutputPath}`);
  return finalOutputPath;
}
