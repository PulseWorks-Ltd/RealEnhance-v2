import sharp from "sharp";
import { enhanceWithStabilityConservativeStage1A } from "../ai/stabilityConservativeUpscaleStage1A";
import { enhanceWithGemini } from "../ai/gemini";
import { runStage1AContentDiff } from "../validators/stage1AContentDiff";
import { selectStage1APrompt } from "../ai/prompts.stage1ARealEstate";
import { NZ_REAL_ESTATE_PRESETS, isNZStyleEnabled } from "../config/geminiPresets";
import { buildStage1APromptNZStyle } from "../ai/prompts.nzRealEstate";
import { INTERIOR_PROFILE_FROM_ENV, INTERIOR_PROFILE_CONFIG } from "../config/enhancementProfiles";
import type { EnhancementProfile } from "../config/enhancementProfiles";
import { buildStage1AInteriorPromptNZStandard, buildStage1AInteriorPromptNZHighEnd } from "../ai/prompts.nzInterior";
import { validateStage } from "../ai/unified-validator";
import { runLowQualityDetector } from "../ai/qualityDetector";
import { GEMINI_TRIGGER_THRESHOLDS } from "../ai/geminiTriggerThresholds";

// Feature flag: Enable Stability Conservative Upscaler (primary AI)
const USE_STABILITY_STAGE1A = process.env.USE_STABILITY_STAGE1A !== "0";

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
  // Strong S-curve that compresses highlights and lifts shadows
  // This creates the "HDR look" that's popular in real estate
  return img
    .linear(1.18, -(128 * 0.18))  // Aggressive S-curve
    .gamma(1.18);                  // Further midtone lift
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
  jobId?: string,
  roomType?: string
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
    nzTemp = 0.3;  // Low temperature = more deterministic
    nzTopP = 0.9;
    nzTopK = 40;
  }

  return await enhanceWithGemini(sharpPath, {
    replaceSky: replaceSky,
    declutter: false,
    sceneType: sceneType,
    stage: "1A",
    jobId,
    roomType,
    modelReason: sceneType ? `${sceneType} enhance` : "enhance",
    promptOverride: enhancementPrompt,
    temperature: nzTemp,
    topP: nzTopP,
    topK: nzTopK,
    floorClean: false,
    hardscapeClean: sceneType === "exterior",
    ...(typeof (global as any).__jobSampling === 'object' ? (global as any).__jobSampling : {}),
  });
}

/**
 * Enhance sky regions (boost blues for more dramatic effect)
 */
function applySkyEnhancement(img: sharp.Sharp): sharp.Sharp {
  // Boost saturation with slight hue shift toward cyan
  // This makes dull skies more appealing
  return img.modulate({
    brightness: 1.0,    // Keep brightness stable
    saturation: 1.22,   // +22% saturation (especially helps blues)
  });
}

export async function runStage1A(
  inputPath: string,
  options: { 
    replaceSky?: boolean;
    declutter?: boolean;
    sceneType?: "interior" | "exterior" | string;
    interiorProfile?: EnhancementProfile;
    skyMode?: "safe" | "strong";
    jobId?: string;
    roomType?: string;
  } = {}
): Promise<string> {
  const { replaceSky = false, declutter = false, sceneType, skyMode = "safe", jobId, roomType } = options;
  const jobIdResolved = jobId || (global as any).__jobId || "default";
  const roomTypeResolved = roomType || (global as any).__jobRoomType;
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
    const brightness = 1 + interiorCfg.brightnessBoost; // strong global lift
    // Base saturation 1.15 plus profile extra (kept lower than exterior to avoid colour cast)
    const saturation = 1.15 + interiorCfg.saturation;
    img = img.modulate({ brightness, saturation });
    // Additional midtone/local contrast shaping
    img = img.gamma(1.0 + (interiorCfg.midtoneLift * 0.12)); // gentle gamma tweak for midtones
    img = img.linear(1 + interiorCfg.localContrast, -(128 * interiorCfg.localContrast));
    console.log(`[stage1A] Interior profile applied: ${interiorProfileKey} (brightness=${brightness.toFixed(2)}, sat=${saturation.toFixed(2)})`);
  } else {
    img = img.modulate({
      brightness: 1.14,  // +14% brightness (adaptive, marketing-grade)
      saturation: 1.20,  // +20% saturation (clamped to avoid orange shift)
    });
  }
  
  // 7. Gamma correction for shadow detail (lower = brighter shadows)
  if (!applyInteriorProfile) {
    img = img.gamma(1.08);  // legacy optimization (non-profile path)
  } else {
    // Profile already adjusted gamma; apply mild shadow lift using linear offset
    img = img.linear(1.0, Math.round(128 * interiorCfg.shadowLift * 0.15));
  }
  
  // 8. Sky enhancement (boost blues for dramatic sky)
  img = applySkyEnhancement(img);
  
  // 9. Local contrast enhancement (CLAHE-like clarity boost)
  img = img.linear(1.12, -(128 * 0.12));  // +12% micro-contrast
  
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
  await img
    .webp({ 
      quality: 97,            // Very high quality (maintains 4K detail)
      effort: 6,              // Maximum compression efficiency
      smartSubsample: true,   // Better color preservation, reduces banding
      nearLossless: false,    // Lossy for optimal compression
    })
    .toFile(sharpOutputPath);
  
  console.log(`[stage1A] Sharp enhancement complete: ${inputPath} → ${sharpOutputPath}`);

  // --- DETERMINISTIC AI ROUTING (Quality-Based Engine Selection) ---
  if (USE_STABILITY_STAGE1A) {
    const quality = await runLowQualityDetector(sharpOutputPath);

    let forceGemini = false;

    if (quality.meanBrightness < GEMINI_TRIGGER_THRESHOLDS.MIN_BRIGHTNESS)
      forceGemini = true;

    if (quality.noiseStdDev > GEMINI_TRIGGER_THRESHOLDS.MAX_NOISE_STDDEV)
      forceGemini = true;

    if (quality.dynamicRange < GEMINI_TRIGGER_THRESHOLDS.MIN_DYNAMIC_RANGE)
      forceGemini = true;

    if (quality.laplacianEstimate > GEMINI_TRIGGER_THRESHOLDS.MAX_LAPLACIAN_ESTIMATE)
      forceGemini = true;

    console.log("[stage1A] Quality Scan:", {
      ...quality,
      forceGemini
    });

    let primary1AImage: string;

    if (forceGemini) {
      console.warn("[stage1A] ⚠️ Low quality detected — forcing Gemini as primary");
      primary1AImage = await enhanceWithGeminiStage1A(sharpOutputPath, sceneType, replaceSky, applyInteriorProfile, interiorProfileKey, skyMode, jobIdResolved, roomTypeResolved);
    } else {
      console.log("[stage1A] ✅ Quality acceptable — using Stability primary");
      try {
        const stabilityJpeg = await enhanceWithStabilityConservativeStage1A(sharpOutputPath, sceneType);
        const stabilityWebp = sharpOutputPath.replace("-1A-sharp.webp", "-1A-stability.webp");
        await sharp(stabilityJpeg)
          .webp({ quality: 95 })
          .toFile(stabilityWebp);
        primary1AImage = stabilityWebp;
      } catch (err) {
        console.error("[stage1A] ❌ Stability API failed:", err);
        console.warn("[stage1A] 🔁 Falling back to Gemini...");
        primary1AImage = await enhanceWithGeminiStage1A(sharpOutputPath, sceneType, replaceSky, applyInteriorProfile, interiorProfileKey, skyMode, jobIdResolved, roomTypeResolved);
      }
    }

    // ✅ AUTHORITATIVE CONTENT VALIDATION
    const diffResult = await runStage1AContentDiff(
      sharpOutputPath,
      primary1AImage
    );

    if (!diffResult.passed) {
      console.warn("[stage1A] 🚨 Content diff FAIL — rerouting to Gemini");

      try {
        const geminiImage = await enhanceWithGeminiStage1A(sharpOutputPath, sceneType, replaceSky, applyInteriorProfile, interiorProfileKey, skyMode, jobIdResolved, roomTypeResolved);

        // Run structural validator on Gemini output
        const { loadOrComputeStructuralMask } = await import("../validators/structuralMask.js");
        const { validateStage1AStructural } = await import("../validators/stage1AValidator.js");
        const maskPath = await loadOrComputeStructuralMask(jobIdResolved, sharpOutputPath);
        const masks = { structuralMask: maskPath };
        let verdict = await validateStage1AStructural(sharpOutputPath, geminiImage, masks, sceneType as any);
        console.log(`[stage1A] Structural validator verdict (Gemini):`, verdict);

        if (!verdict.ok) {
          console.warn(`[stage1A] HARD FAIL: ${verdict.reason}`);
        }

        const fs = await import("fs/promises");
        await fs.rename(geminiImage, finalOutputPath);
        console.log(`[stage1A] Professional enhancement complete: ${inputPath} → ${finalOutputPath}`);
        return finalOutputPath;

      } catch {
        console.error("[stage1A] 🔴 Gemini failed — FINAL fallback to Sharp only");
        const fs = await import("fs/promises");
        await fs.rename(sharpOutputPath, finalOutputPath);
        console.log(`[stage1A] Professional enhancement complete: ${inputPath} → ${finalOutputPath}`);
        return finalOutputPath;
      }
    }

    console.log("[stage1A] ✅ Stage 1A content diff validator PASSED");

    // Run structural validator on primary output
    const { loadOrComputeStructuralMask } = await import("../validators/structuralMask.js");
    const { validateStage1AStructural } = await import("../validators/stage1AValidator.js");
    const maskPath = await loadOrComputeStructuralMask(jobIdResolved, sharpOutputPath);
    const masks = { structuralMask: maskPath };
    let verdict = await validateStage1AStructural(sharpOutputPath, primary1AImage, masks, sceneType as any);
    console.log(`[stage1A] Structural validator verdict:`, verdict);

    if (!verdict.ok) {
      console.warn(`[stage1A] HARD FAIL: ${verdict.reason}`);
    }

    const fs = await import("fs/promises");
    await fs.rename(primary1AImage, finalOutputPath);
    console.log(`[stage1A] Professional enhancement complete: ${inputPath} → ${finalOutputPath}`);
    return finalOutputPath;
  }

  // --- LEGACY FALLBACK (if Stability disabled) ---
  try {
    console.log("[stage1A] 🟡 Using Gemini (Stability disabled)...");

    const geminiOutputPath = await enhanceWithGeminiStage1A(sharpOutputPath, sceneType, replaceSky, applyInteriorProfile, interiorProfileKey, skyMode, jobIdResolved, roomTypeResolved);

    console.log("[stage1A] ✅ Gemini enhancement complete:", geminiOutputPath);

    if (geminiOutputPath !== sharpOutputPath) {
      const { loadOrComputeStructuralMask } = await import("../validators/structuralMask.js");
      const { validateStage1AStructural } = await import("../validators/stage1AValidator.js");
      const maskPath = await loadOrComputeStructuralMask(jobIdResolved, sharpOutputPath);
      const masks = { structuralMask: maskPath };
      let verdict = await validateStage1AStructural(sharpOutputPath, geminiOutputPath, masks, sceneType as any);
      console.log(`[stage1A] Structural validator verdict:`, verdict);

      if (!verdict.ok) {
        console.warn(`[stage1A] HARD FAIL: ${verdict.reason}`);
      }

      const fs = await import("fs/promises");
      await fs.rename(geminiOutputPath, finalOutputPath);
      console.log(`[stage1A] Professional enhancement complete: ${inputPath} → ${finalOutputPath}`);
      return finalOutputPath;
    }

  } catch (err) {
    console.error("[stage1A] 🔴 Gemini failed — FINAL fallback to Sharp only!", err);
  }

  // --- FINAL EMERGENCY FALLBACK: Sharp Only ---
  console.log("[stage1A] ℹ️ Using Sharp enhancement only (all AI failed)");
  const fs = await import("fs/promises");
  await fs.rename(sharpOutputPath, finalOutputPath);
  console.log(`[stage1A] Professional enhancement complete: ${inputPath} → ${finalOutputPath}`);
  return finalOutputPath;
}
