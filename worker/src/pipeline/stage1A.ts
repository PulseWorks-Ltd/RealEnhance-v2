import sharp from "sharp";
import { enhanceWithGemini } from "../ai/gemini";
import { NZ_REAL_ESTATE_PRESETS, isNZStyleEnabled } from "../config/geminiPresets";
import { buildStage1APromptNZStyle } from "../ai/prompts.nzRealEstate";
import { INTERIOR_PROFILE_FROM_ENV, INTERIOR_PROFILE_CONFIG } from "../config/enhancementProfiles";
import type { EnhancementProfile } from "../config/enhancementProfiles";
import { buildStage1AInteriorPromptNZStandard, buildStage1AInteriorPromptNZHighEnd } from "../ai/prompts.nzInterior";
import { validateStage } from "../ai/unified-validator";

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
 * 9. Gemini AI enhancement (professional HDR + optional sky replacement)
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
  } = {}
): Promise<string> {
  const { replaceSky = false, declutter = false, sceneType } = options;
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
  
  // Always apply Gemini AI enhancement with professional HDR quality
  // (Stage 1B will handle furniture removal separately if declutter is enabled)
  console.log(`[stage1A] Starting Gemini AI enhancement (replaceSky: ${replaceSky})...`);
  // NZ real estate style sampling overrides (applied before env/config precedence inside enhanceWithGemini)
  let nzTemp: number | undefined = undefined;
  let nzTopP: number | undefined = undefined;
  let nzTopK: number | undefined = undefined;
  if (isNZStyleEnabled()) {
    const preset = sceneType === "interior" ? NZ_REAL_ESTATE_PRESETS.stage1AInterior : NZ_REAL_ESTATE_PRESETS.stage1AExterior;
    if (applyInteriorProfile) {
      // Use profile-specific Gemini temperature for interior
      nzTemp = interiorCfg.geminiTemperature;
    } else {
      nzTemp = preset.temperature;
    }
    nzTopP = preset.topP;
    nzTopK = preset.topK;
  }
  // Inject custom prompt via global hook so buildGeminiPrompt can detect (simplest non-invasive approach)
  let nzPrompt: string | undefined = undefined;
  if (isNZStyleEnabled()) {
    if (applyInteriorProfile) {
      nzPrompt = interiorProfileKey === "nz_high_end"
        ? buildStage1AInteriorPromptNZHighEnd("room")
        : buildStage1AInteriorPromptNZStandard("room");
    } else {
      nzPrompt = buildStage1APromptNZStyle("room", (sceneType === 'interior' ? 'interior' : 'exterior') as any);
    }
  }
  const geminiOutputPath = await enhanceWithGemini(sharpOutputPath, {
    skipIfNoApiKey: true,
    replaceSky: replaceSky,
    declutter: false,
    sceneType: sceneType,
    stage: "1A",
    promptOverride: nzPrompt,
    temperature: nzTemp,
    topP: nzTopP,
    topK: nzTopK,
    // Apply light hardscape cleanup only for exteriors in Stage1A
    floorClean: false,
    hardscapeClean: sceneType === "exterior",
    // Sampling overrides from job options if available (passed via context by worker)
    ...(typeof (global as any).__jobSampling === 'object' ? (global as any).__jobSampling : {}),
  });
  
  // If Gemini enhancement succeeded (returned different path), use it
  // Otherwise, Sharp output is already at sharpOutputPath
  if (geminiOutputPath !== sharpOutputPath) {
    // Use structure-first validator
    const { loadOrComputeStructuralMask } = await import("../validators/structuralMask");
    const { validateStage1AStructural } = await import("../validators/stage1AValidator");
    const jobId = (global as any).__jobId || "default";
    const canonicalBasePath = sharpOutputPath;
    const maskPath = await loadOrComputeStructuralMask(jobId, canonicalBasePath);
    // You may need to pass window/landcover mask paths if available
    const masks = { structuralMask: maskPath };
    let verdict = await validateStage1AStructural(canonicalBasePath, geminiOutputPath, masks, sceneType as any);
    if (!verdict.ok) {
      console.warn(`[stage1A] ❌ Structural validation failed: ${verdict.reason}`);
      // Strict retry (max 2 attempts)
      for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`[stage1A] 🔁 Strict retry #${attempt}...`);
        const retryPath = await enhanceWithGemini(sharpOutputPath, {
          skipIfNoApiKey: true,
          replaceSky: replaceSky,
          declutter: false,
          sceneType: sceneType,
          stage: "1A",
          strictMode: true,
          floorClean: false,
          hardscapeClean: sceneType === "exterior",
        });
        if (retryPath !== sharpOutputPath) {
          verdict = await validateStage1AStructural(canonicalBasePath, retryPath, masks, sceneType as any);
          if (verdict.ok) {
            console.log(`[stage1A] ✅ Strict retry passed validation`);
            const fs = await import("fs/promises");
            await fs.rename(retryPath, finalOutputPath);
            return finalOutputPath;
          }
        }
      }
      // Fallback: use Sharp-only output
      console.warn(`[stage1A] ❌ All retries failed, falling back to Sharp-only output.`);
      const fs = await import("fs/promises");
      await fs.rename(sharpOutputPath, finalOutputPath);
      return finalOutputPath;
    }
    // Passed validation
    const fs = await import("fs/promises");
    await fs.rename(geminiOutputPath, finalOutputPath);
  } else {
    console.log(`[stage1A] ℹ️ Using Sharp enhancement only (Gemini skipped)`);
    const fs = await import("fs/promises");
    await fs.rename(sharpOutputPath, finalOutputPath);
  }
  console.log(`[stage1A] Professional enhancement complete: ${inputPath} → ${finalOutputPath}`);
  return finalOutputPath;
}
