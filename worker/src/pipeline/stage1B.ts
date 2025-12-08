import sharp from "sharp";
import { siblingOutPath } from "../utils/images";
import { enhanceWithGemini } from "../ai/gemini";
import { buildStage1BPromptNZStyle, buildStage1BAPromptNZStyle, buildStage1BBPromptNZStyle } from "../ai/prompts.nzRealEstate";
import { validateStage } from "../ai/unified-validator";
import { validateStage1BStructural } from "../validators/stage1BValidator";

/**
 * Stage 1B: Two-Stage Furniture & Clutter Removal System
 *
 * Supports three modes:
 * - "main": Stage 1B-A only (remove large furniture, keep décor)
 * - "heavy": Stage 1B-A + 1B-B (remove all furniture and clutter)
 * - "auto": Stage 1B-A, evaluate clutter, conditionally run 1B-B
 *
 * Pipeline: Sharp → Stage 1A (enhance) → Stage 1B-A (main furniture) → [1B-B if needed] → Stage 2 (staging)
 */
export async function runStage1B(
  stage1APath: string,
  options: {
    replaceSky?: boolean;
    sceneType?: "interior" | "exterior" | string;
    roomType?: string;
  } = {}
): Promise<string> {
  const { replaceSky = false, sceneType, roomType } = options;
  const furnitureRemovalMode = (global as any).__furnitureRemovalMode || 'auto';

  console.log(`[stage1B] 🔵 Starting two-stage furniture removal system...`);
  console.log(`[stage1B] Input (Stage1A enhanced): ${stage1APath}`);
  console.log(`[stage1B] Options: sceneType=${sceneType}, furnitureRemovalMode=${furnitureRemovalMode}`);

  // For exteriors, bypass two-stage system (no furniture to remove)
  if (sceneType === 'exterior') {
    console.log(`[stage1B] ℹ️ Exterior scene detected - using standard declutter`);
    return runLegacyStage1B(stage1APath, options);
  }

  try {
    // ✅ Stage 1B-A: Main Furniture Removal (always runs first)
    const jobId = (global as any).__jobId || 'unknown';
    console.log(`[stage1B-1] 🚪 PRIMARY furniture removal started`, {
      jobId,
      mode: 'main-only',
      input: stage1APath
    });
    const stage1BAPath = await enhanceWithGemini(stage1APath, {
      skipIfNoApiKey: true,
      replaceSky,
      declutter: true,
      sceneType,
      stage: "1B-A",
      temperature: 0.30,
      topP: 0.70,
      topK: 32,
      promptOverride: buildStage1BAPromptNZStyle(roomType, (sceneType === "interior" || sceneType === "exterior" ? sceneType : "interior") as any),
      floorClean: sceneType === "interior",
      hardscapeClean: sceneType === "exterior",
      declutterIntensity: 'standard', // 1B-A always uses standard intensity
      ...(typeof (global as any).__jobSampling === 'object' ? (global as any).__jobSampling : {}),
    });

    console.log(`[stage1B-1] ✅ PRIMARY furniture removal complete`, {
      jobId,
      output: stage1BAPath
    });

    // Validate 1B-A
    if (stage1BAPath !== stage1APath) {
      const { validateStageOutput } = await import("../validators/index.js");
      const canonicalPath: string | undefined = (global as any).__canonicalPath;
      const base = canonicalPath || stage1APath;
      const verdict1 = await validateStageOutput("stage1B", base, stage1BAPath, { sceneType: 'interior', roomType });
      console.log(`[stage1B-A] Validator verdict:`, verdict1);
      const { validateStage1BStructural } = await import("../validators/stage1BValidator.js");
      const jobId = (global as any).__jobId || "default";
      const { loadOrComputeStructuralMask } = await import("../validators/structuralMask.js");
      const maskPath = await loadOrComputeStructuralMask(jobId, base);
      const masks = { structuralMask: maskPath };
      const verdict2 = await validateStage1BStructural(base, stage1BAPath, masks);
      console.log(`[stage1B-A] Structural validator verdict:`, verdict2);
      if (!verdict2.ok) {
        console.warn(`[stage1B-A] STRUCTURAL FAIL: ${verdict2.reason}`);
      }
    }

    // Decision: Do we need Stage 1B-B?
    // SAFETY: Also check declutterIntensity as a backup (belt-and-suspenders)
    const declutterIntensity = (global as any).__jobDeclutterIntensity;
    let needsStage1BB = false;

    if (furnitureRemovalMode === 'heavy' || declutterIntensity === 'heavy') {
      console.log(`[stage1B] 🎯 Mode is 'heavy' - will run Stage 1B-B`);
      needsStage1BB = true;
    } else if (furnitureRemovalMode === 'auto') {
      console.log(`[stage1B] 🤖 Mode is 'auto' - evaluating clutter density...`);
      needsStage1BB = await shouldRunStage1BB(stage1BAPath);
      console.log(`[stage1B] ${needsStage1BB ? '✅ High clutter detected - proceeding to Stage 1B-B' : '✅ Low clutter - skipping Stage 1B-B'}`);
    } else {
      console.log(`[stage1B] ℹ️ Mode is 'main' - skipping Stage 1B-B`);
      needsStage1BB = false;
    }

    let finalPath = stage1BAPath;

    // Log final decision
    console.log(`[stage1B] Heavy declutter decision locked`, {
      jobId,
      furnitureRemovalMode,
      requiresHeavyDeclutter: needsStage1BB
    });

    // ✅ Stage 1B-B: Heavy Declutter (conditional)
    if (needsStage1BB && stage1BAPath !== stage1APath) {
      console.log(`[stage1B-2] 🧹 SECONDARY declutter pass started`, {
        jobId,
        mode: 'heavy',
        input: stage1BAPath
      });
      const stage1BBPath = await enhanceWithGemini(stage1BAPath, {
        skipIfNoApiKey: true,
        replaceSky: false, // Already done in 1A
        declutter: true,
        sceneType,
        stage: "1B-B",
        temperature: 0.30,
        topP: 0.70,
        topK: 32,
        promptOverride: buildStage1BBPromptNZStyle(roomType, (sceneType === "interior" || sceneType === "exterior" ? sceneType : "interior") as any),
        floorClean: sceneType === "interior",
        hardscapeClean: sceneType === "exterior",
        declutterIntensity: 'heavy',
        ...(typeof (global as any).__jobSampling === 'object' ? (global as any).__jobSampling : {}),
      });

      console.log(`[stage1B-2] ✅ SECONDARY declutter pass complete`, {
        jobId,
        output: stage1BBPath
      });

      // Validate 1B-B
      if (stage1BBPath !== stage1BAPath) {
        const { validateStageOutput } = await import("../validators/index.js");
        const canonicalPath: string | undefined = (global as any).__canonicalPath;
        const base = canonicalPath || stage1APath;
        const verdict1 = await validateStageOutput("stage1B", base, stage1BBPath, { sceneType: 'interior', roomType });
        console.log(`[stage1B-B] Validator verdict:`, verdict1);
        const { validateStage1BStructural } = await import("../validators/stage1BValidator.js");
        const jobId = (global as any).__jobId || "default";
        const { loadOrComputeStructuralMask } = await import("../validators/structuralMask.js");
        const maskPath = await loadOrComputeStructuralMask(jobId, base);
        const masks = { structuralMask: maskPath };
        const verdict2 = await validateStage1BStructural(base, stage1BBPath, masks);
        console.log(`[stage1B-B] Structural validator verdict:`, verdict2);
        if (!verdict2.ok) {
          console.warn(`[stage1B-B] STRUCTURAL FAIL: ${verdict2.reason}`);
        }
        finalPath = stage1BBPath;
      }
    }

    // Rename final output to -1B
    if (finalPath !== stage1APath) {
      const outputPath = siblingOutPath(stage1APath, "-1B", ".webp");
      const fs = await import("fs/promises");
      console.log(`[stage1B] 💾 Renaming final output to Stage1B: ${finalPath} → ${outputPath}`);
      await fs.rename(finalPath, outputPath);
      console.log(`[stage1B] ✅ SUCCESS - Two-stage furniture removal complete: ${outputPath}`);
      return outputPath;
    }
    
    // Fallback: If Gemini unavailable, use Sharp-based gentle cleanup
    console.log(`[stage1B] ⚠️ Gemini unavailable or skipped, using Sharp fallback`);
    const out = siblingOutPath(stage1APath, "-1B", ".webp");
    await sharp(stage1APath)
      .rotate()
      .median(3)
      .blur(0.5)
      .sharpen(0.4)
      .webp({ quality: 90 })
      .toFile(out);
    console.log(`[stage1B] ℹ️ Sharp fallback complete: ${out}`);
    return out;
    
  } catch (error) {
    console.error(`[stage1B] Error during two-stage declutter:`, error);
    // Fallback to Sharp on error
    const out = siblingOutPath(stage1APath, "-1B", ".webp");
    await sharp(stage1APath)
      .rotate()
      .median(3)
      .blur(0.5)
      .sharpen(0.4)
      .webp({ quality: 90 })
      .toFile(out);
    return out;
  }
}

/**
 * Legacy Stage 1B implementation (single-stage, complete removal)
 * Used for exteriors and backwards compatibility
 */
async function runLegacyStage1B(
  stage1APath: string,
  options: {
    replaceSky?: boolean;
    sceneType?: "interior" | "exterior" | string;
    roomType?: string;
  } = {}
): Promise<string> {
  const { replaceSky = false, sceneType, roomType } = options;

  console.log(`[stage1B-legacy] 🔵 Running legacy single-stage declutter...`);

  try {
    const declutteredPath = await enhanceWithGemini(stage1APath, {
      skipIfNoApiKey: true,
      replaceSky,
      declutter: true,
      sceneType,
      stage: "1B",
      temperature: 0.30,
      topP: 0.70,
      topK: 32,
      promptOverride: buildStage1BPromptNZStyle(roomType, (sceneType === "interior" || sceneType === "exterior" ? sceneType : "interior") as any),
      floorClean: sceneType === "interior",
      hardscapeClean: sceneType === "exterior",
      declutterIntensity: (global as any).__jobDeclutterIntensity || undefined,
      ...(typeof (global as any).__jobSampling === 'object' ? (global as any).__jobSampling : {}),
    });

    if (declutteredPath !== stage1APath) {
      const { validateStageOutput } = await import("../validators/index.js");
      const canonicalPath: string | undefined = (global as any).__canonicalPath;
      const base = canonicalPath || stage1APath;
      const verdict1 = await validateStageOutput("stage1B", base, declutteredPath, { sceneType: (sceneType === 'interior' ? 'interior' : 'exterior') as any, roomType });
      console.log(`[stage1B-legacy] Validator verdict:`, verdict1);
      const { validateStage1BStructural } = await import("../validators/stage1BValidator.js");
      const jobId = (global as any).__jobId || "default";
      const { loadOrComputeStructuralMask } = await import("../validators/structuralMask.js");
      const maskPath = await loadOrComputeStructuralMask(jobId, base);
      const masks = { structuralMask: maskPath };
      const verdict2 = await validateStage1BStructural(base, declutteredPath, masks);
      console.log(`[stage1B-legacy] Structural validator verdict:`, verdict2);
      if (!verdict2.ok) {
        console.warn(`[stage1B-legacy] HARD FAIL: ${verdict2.reason}`);
      }
      const outputPath = siblingOutPath(stage1APath, "-1B", ".webp");
      const fs = await import("fs/promises");
      await fs.rename(declutteredPath, outputPath);
      console.log(`[stage1B-legacy] ✅ SUCCESS: ${outputPath}`);
      return outputPath;
    }

    // Fallback
    console.log(`[stage1B-legacy] ⚠️ Gemini unavailable, using Sharp fallback`);
    const out = siblingOutPath(stage1APath, "-1B", ".webp");
    await sharp(stage1APath)
      .rotate()
      .median(3)
      .blur(0.5)
      .sharpen(0.4)
      .webp({ quality: 90 })
      .toFile(out);
    return out;

  } catch (error) {
    console.error(`[stage1B-legacy] Error:`, error);
    const out = siblingOutPath(stage1APath, "-1B", ".webp");
    await sharp(stage1APath)
      .rotate()
      .median(3)
      .blur(0.5)
      .sharpen(0.4)
      .webp({ quality: 90 })
      .toFile(out);
    return out;
  }
}

/**
 * Auto mode decision: Should we run Stage 1B-B?
 * Evaluates clutter density after Stage 1B-A (main furniture removal)
 * Returns true if significant clutter remains (lamps, rugs, wall art, small items)
 *
 * Decision criteria:
 * - Edge noise after 1B(1) > 28% → high residual clutter
 * - Small item density > 35% → many decorative objects remain
 * - Removed object count > 6 → complex room with likely more items
 */
async function shouldRunStage1BB(stage1BAPath: string): Promise<boolean> {
  const jobId = (global as any).__jobId || 'unknown';

  try {
    // Analyze image for remaining visual complexity
    const metadata = await sharp(stage1BAPath).metadata();
    const { width = 0, height = 0 } = metadata;

    if (width === 0 || height === 0) {
      console.log(`[AUTO-HEAVY] Invalid image dimensions, defaulting to LIGHT`, { jobId });
      return false;
    }

    // Read a downsampled version for faster analysis
    const buffer = await sharp(stage1BAPath)
      .resize(256, 256, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = buffer;
    const w = info.width;
    const h = info.height;
    const channels = info.channels;

    // ========================================
    // SIGNAL 1: Edge Noise (proxy for residual clutter)
    // ========================================
    let edgeCount = 0;
    const EDGE_THRESH = 30;

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = (y * w + x) * channels;
        const iUp = ((y - 1) * w + x) * channels;
        const iLeft = (y * w + (x - 1)) * channels;

        const r = data[i] || 0, g = data[i + 1] || 0, b = data[i + 2] || 0;
        const rUp = data[iUp] || 0, gUp = data[iUp + 1] || 0, bUp = data[iUp + 2] || 0;
        const rLeft = data[iLeft] || 0, gLeft = data[iLeft + 1] || 0, bLeft = data[iLeft + 2] || 0;

        const lumaCenter = 0.299 * r + 0.587 * g + 0.114 * b;
        const lumaUp = 0.299 * rUp + 0.587 * gUp + 0.114 * bUp;
        const lumaLeft = 0.299 * rLeft + 0.587 * gLeft + 0.114 * bLeft;

        const gradY = Math.abs(lumaCenter - lumaUp);
        const gradX = Math.abs(lumaCenter - lumaLeft);
        const gradMag = Math.sqrt(gradY * gradY + gradX * gradX);

        if (gradMag >= EDGE_THRESH) {
          edgeCount++;
        }
      }
    }

    const totalPixels = w * h;
    const edgeNoise = edgeCount / totalPixels;

    // ========================================
    // SIGNAL 2: Small Item Density (count high-frequency regions)
    // ========================================
    let smallItemRegions = 0;
    const SMALL_ITEM_THRESH = 40;

    for (let y = 2; y < h - 2; y += 2) {
      for (let x = 2; x < w - 2; x += 2) {
        // Sample 3x3 local variance
        let localVariance = 0;
        const centerI = (y * w + x) * channels;
        const centerLuma = 0.299 * (data[centerI] || 0) + 0.587 * (data[centerI + 1] || 0) + 0.114 * (data[centerI + 2] || 0);

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ni = ((y + dy) * w + (x + dx)) * channels;
            const nLuma = 0.299 * (data[ni] || 0) + 0.587 * (data[ni + 1] || 0) + 0.114 * (data[ni + 2] || 0);
            localVariance += Math.abs(nLuma - centerLuma);
          }
        }

        if (localVariance / 9 >= SMALL_ITEM_THRESH) {
          smallItemRegions++;
        }
      }
    }

    const totalRegions = ((h - 4) / 2) * ((w - 4) / 2);
    const smallItemDensity = smallItemRegions / Math.max(1, totalRegions);

    // ========================================
    // SIGNAL 3: Removed Object Count (from global state if available)
    // ========================================
    const imageStats = (global as any).__imageStats || {};
    const removedCount = imageStats.removedObjectCount || 0;

    // ========================================
    // DECISION LOGIC
    // ========================================
    const decision =
      removedCount > 6 ||
      smallItemDensity > 0.35 ||
      edgeNoise > 0.28;

    console.log(`[AUTO-HEAVY] Escalation decision`, {
      jobId,
      removedCount,
      smallItemDensity: smallItemDensity.toFixed(3),
      edgeNoise: edgeNoise.toFixed(3),
      decision
    });

    return decision;

  } catch (error: any) {
    console.warn(`[AUTO-HEAVY] Escalation failed — defaulting to LIGHT`, {
      jobId,
      error: error?.message || String(error)
    });
    // Default to LIGHT mode (1B(1) only) on error - safer to under-declutter
    return false;
  }
}
