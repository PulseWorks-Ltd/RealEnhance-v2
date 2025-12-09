import sharp from "sharp";
import { siblingOutPath } from "../utils/images";
import { enhanceWithGemini } from "../ai/gemini";
import { buildStage1BPromptNZStyle, buildStage1BAPromptNZStyle, buildStage1BBPromptNZStyle, buildStage1BTidyPromptNZStyle } from "../ai/prompts.nzRealEstate";
import { validateStage } from "../ai/unified-validator";
import { validateStage1BStructural } from "../validators/stage1BValidator";
import { runUnifiedValidation } from "../validators/runValidation";
import { callGeminiJsonOnImage } from "../ai/geminiJsonHelper";

/**
 * Stage 1B: Furniture & Clutter Removal System
 *
 * Supports three public modes:
 * - "tidy" (main): Micro declutter only - removes small clutter, keeps ALL furniture
 * - "standard" (auto): Structural clear + conditional micro - removes furniture, auto-escalates to clutter cleanup if needed
 * - "stage-ready" (heavy): Structural clear + forced micro - removes everything loose for staging
 *
 * Pipeline: Sharp → Stage 1A (enhance) → Stage 1B → [1B-B if needed] → Stage 2 (staging)
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
  const publicMode = (global as any).__publicMode || 'standard';
  const declutterIntensity = (global as any).__jobDeclutterIntensity;
  const jobId = (global as any).__jobId || 'unknown';

  console.log(`[stage1B] 🔵 Starting furniture removal system...`);
  console.log(`[stage1B] Input (Stage1A enhanced): ${stage1APath}`);
  console.log(`[stage1B] Options: sceneType=${sceneType}, furnitureRemovalMode=${furnitureRemovalMode}`);

  // Log mode resolution (required by spec)
  console.log(`[stage1B] Public mode resolved`, {
    jobId,
    furnitureRemovalMode,
    declutterIntensity,
    publicMode
  });

  // For exteriors, bypass two-stage system (no furniture to remove)
  if (sceneType === 'exterior') {
    console.log(`[stage1B] ℹ️ Exterior scene detected - using standard declutter`);
    return runLegacyStage1B(stage1APath, options);
  }

  try {
    // Determine execution plan based on public mode
    const willRunStructural = publicMode !== "tidy";
    const willRunMicro = publicMode === "tidy" ||
                         publicMode === "stage-ready" ||
                         (publicMode === "standard"); // standard may run micro based on auto-escalation

    console.log(`[stage1B] Execution plan locked`, {
      jobId,
      publicMode,
      willRunStructural,
      willRunMicro: willRunMicro && publicMode !== "standard" ? true : "conditional"
    });

    // ✅ TIDY MODE: Run only micro declutter (no furniture removal)
    if (publicMode === "tidy") {
      console.log(`[stage1B-TIDY] 🧹 Tidy mode: micro declutter only (keeping furniture)`, {
        jobId,
        input: stage1APath
      });

      const tidyPath = await enhanceWithGemini(stage1APath, {
        skipIfNoApiKey: true,
        replaceSky,
        declutter: true,
        sceneType,
        stage: "1B-A",
        temperature: 0.30,
        topP: 0.70,
        topK: 32,
        promptOverride: buildStage1BTidyPromptNZStyle(roomType, (sceneType === "interior" || sceneType === "exterior" ? sceneType : "interior") as any),
        floorClean: sceneType === "interior",
        hardscapeClean: sceneType === "exterior",
        declutterIntensity: 'light',
        ...(typeof (global as any).__jobSampling === 'object' ? (global as any).__jobSampling : {}),
      });

      console.log(`[stage1B-TIDY] ✅ Tidy complete (furniture preserved)`, {
        jobId,
        output: tidyPath
      });

      // Rename with -1B-A suffix
      if (tidyPath !== stage1APath) {
        const fs = await import("fs/promises");
        const outputPath = siblingOutPath(stage1APath, "-1B-A", ".webp");
        await fs.rename(tidyPath, outputPath);
        console.log(`[stage1B] ✅ TIDY MODE complete: ${outputPath}`);
        return outputPath;
      }
      return stage1APath;
    }

    // ✅ STANDARD & STAGE-READY: Run structural clear (1B-A) first
    console.log(`[stage1B-1] 🚪 STRUCTURAL furniture removal started`, {
      jobId,
      mode: publicMode,
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
      declutterIntensity: 'standard',
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

      // Run unified structural validation (log-only)
      console.log("[VALIDATOR] Running structural validation @ 1B-A");
      await runUnifiedValidation({
        originalPath: stage1APath,
        enhancedPath: stage1BAPath,
        stage: "1B",
        roomType: roomType,
        mode: "log"
      });
    }

    // Decision: Do we need Stage 1B-B (second pass)?
    // NEW LOGIC:
    // - "tidy": Already handled above (returns early)
    // - "standard": Auto-detect residual furniture/items after 1B-A
    // - "stage-ready": ALWAYS run second pass
    let needsStage1BB = false;

    if (publicMode === "stage-ready") {
      console.log("[stage1B] 🎯 Mode is 'stage-ready' - Stage 1B-B will ALWAYS run");
      needsStage1BB = true;
    } else if (publicMode === "standard") {
      console.log("[stage1B] 🤖 Mode is 'standard' - evaluating Stage 1B-A output for residual objects...");
      needsStage1BB = await shouldRunStage1BB(stage1BAPath, {
        jobId,
        roomType,
      });
    } else {
      // tidy-only or other modes
      console.log("[stage1B] ℹ️ Mode is 'tidy' - skipping Stage 1B-B");
      needsStage1BB = false;
    }

    let finalPath = stage1BAPath;
    let stage1BBPath: string | undefined = undefined;

    // Log final decision
    console.log("[stage1B] Heavy declutter decision locked", {
      jobId,
      publicMode,
      requiresSecondPass: needsStage1BB,
    });

    // ✅ Stage 1B-B: Heavy Declutter (conditional)
    if (needsStage1BB && stage1BAPath !== stage1APath) {
      console.log(`[stage1B-2] 🧹 SECONDARY declutter pass started`, {
        jobId,
        mode: 'heavy',
        input: stage1BAPath
      });
      stage1BBPath = await enhanceWithGemini(stage1BAPath, {
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

        // Run unified structural validation (log-only)
        console.log("[VALIDATOR] Running structural validation @ 1B-B");
        await runUnifiedValidation({
          originalPath: stage1APath,
          enhancedPath: stage1BBPath,
          stage: "1B",
          roomType: roomType,
          mode: "log"
        });

        finalPath = stage1BBPath;
      }
    }

    // Rename final output with proper Stage 1B suffix
    // CRITICAL: Use -1B-A or -1B-B to avoid collision with Stage 2
    if (finalPath !== stage1APath) {
      const fs = await import("fs/promises");

      // Determine which pass completed and use appropriate filename
      let stageSuffix: string;
      if (needsStage1BB && finalPath === stage1BBPath) {
        // Dual-pass completed: use -1B-B
        stageSuffix = "-1B-B";
        console.log(`[STAGE1B] MODE=${furnitureRemovalMode} PASS=B → OUTPUT=${finalPath.split('/').pop()}`);
      } else {
        // Single-pass only: use -1B-A
        stageSuffix = "-1B-A";
        console.log(`[STAGE1B] MODE=${furnitureRemovalMode} PASS=A → OUTPUT=${finalPath.split('/').pop()}`);
      }

      const outputPath = siblingOutPath(stage1APath, stageSuffix, ".webp");
      console.log(`[stage1B] 💾 Renaming final output to Stage1B: ${finalPath} → ${outputPath}`);
      await fs.rename(finalPath, outputPath);
      console.log(`[stage1B] ✅ SUCCESS - FULL DECLUTTER complete: ${outputPath}`);
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
 * Detection context for Stage 1B-B decision
 */
interface Stage1BBDecisionContext {
  jobId?: string;
  roomType?: string;
}

/**
 * Furniture detection result
 */
interface FurnitureDetectionResult {
  hasFurniture: boolean;
  confidence: number;
}

/**
 * Personal items detection result
 */
interface PersonalItemsDetectionResult {
  hasPersonalItems: boolean;
  confidence: number;
}

/**
 * Empty room structural metrics
 */
interface EmptyRoomMetrics {
  smallItemDensity: number;
  edgeNoise: number;
}

/**
 * Detect residual furniture using Gemini 2.0 Flash vision
 * (Fast, reliable detection for decision-making)
 */
async function detectResidualFurniture(
  imagePath: string,
  ctx: Stage1BBDecisionContext
): Promise<FurnitureDetectionResult> {
  const prompt = `You are analyzing a real estate image AFTER an initial furniture removal pass.

Question:
Does this image still contain any visible furniture, partially removed furniture, or furniture fragments (such as couches, chairs, tables, beds, wardrobes, TV units, or headboards)?

Return strict JSON ONLY in this exact format:
{
  "hasFurniture": true or false,
  "confidence": number between 0 and 1
}`;

  try {
    const { json } = await callGeminiJsonOnImage(imagePath, prompt);
    const hasFurniture = !!json?.hasFurniture;
    const confidence = typeof json?.confidence === "number" ? json.confidence : 0;

    console.log("[AUTO-EMPTY] Furniture detection", {
      jobId: ctx.jobId,
      imagePath,
      hasFurniture,
      confidence,
    });

    return { hasFurniture, confidence };
  } catch (error: any) {
    // FAIL-OPEN: Assume furniture present on detection failure
    console.error("[AUTO-EMPTY] Furniture detection failed, assuming furniture present (fail-open)", {
      jobId: ctx.jobId,
      error: error?.message || String(error),
    });
    return { hasFurniture: true, confidence: 0 }; // Fail-open: assume items present
  }
}

/**
 * Detect personal items and clutter using Gemini 2.0 Flash vision
 * (Fast, reliable detection for decision-making)
 */
async function detectPersonalItems(
  imagePath: string,
  ctx: Stage1BBDecisionContext
): Promise<PersonalItemsDetectionResult> {
  const prompt = `You are analyzing a real estate image that is being prepared for virtual staging.

Question:
Does this image still contain any personal items, artwork, photo frames, decorative wall art, plants, rugs, clutter, or loose objects (such as shoes, toys, clothes, bathroom items, bench items, cables, or small decor)?

Return strict JSON ONLY in this exact format:
{
  "hasPersonalItems": true or false,
  "confidence": number between 0 and 1
}`;

  try {
    const { json } = await callGeminiJsonOnImage(imagePath, prompt);
    const hasPersonalItems = !!json?.hasPersonalItems;
    const confidence = typeof json?.confidence === "number" ? json.confidence : 0;

    console.log("[AUTO-EMPTY] Personal items detection", {
      jobId: ctx.jobId,
      imagePath,
      hasPersonalItems,
      confidence,
    });

    return { hasPersonalItems, confidence };
  } catch (error: any) {
    // FAIL-OPEN: Assume personal items present on detection failure
    console.error("[AUTO-EMPTY] Personal items detection failed, assuming items present (fail-open)", {
      jobId: ctx.jobId,
      error: error?.message || String(error),
    });
    return { hasPersonalItems: true, confidence: 0 }; // Fail-open: assume items present
  }
}

/**
 * Analyze structural metrics for empty room validation (fallback)
 */
async function analyzeEmptyRoomMetrics(
  imagePath: string,
  ctx: Stage1BBDecisionContext
): Promise<EmptyRoomMetrics> {
  try {
    const metadata = await sharp(imagePath).metadata();
    const { width = 0, height = 0 } = metadata;

    if (width === 0 || height === 0) {
      return { smallItemDensity: 0, edgeNoise: 0 };
    }

    // Read a downsampled version for faster analysis
    const buffer = await sharp(imagePath)
      .resize(256, 256, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = buffer;
    const w = info.width;
    const h = info.height;
    const channels = info.channels;

    // Edge Noise (proxy for residual clutter)
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

    // Small Item Density (count high-frequency regions)
    let smallItemRegions = 0;
    const SMALL_ITEM_THRESH = 40;

    for (let y = 2; y < h - 2; y += 2) {
      for (let x = 2; x < w - 2; x += 2) {
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

    console.log("[AUTO-EMPTY] Structural metrics", {
      jobId: ctx.jobId,
      imagePath,
      smallItemDensity: smallItemDensity.toFixed(3),
      edgeNoise: edgeNoise.toFixed(3),
    });

    return { smallItemDensity, edgeNoise };
  } catch (error: any) {
    console.warn("[AUTO-EMPTY] Metric analysis failed, defaulting to zeroes", {
      jobId: ctx.jobId,
      imagePath,
      error: error?.message || String(error),
    });
    return { smallItemDensity: 0, edgeNoise: 0 };
  }
}

/**
 * Auto mode decision: Should we run Stage 1B-B?
 *
 * NEW IMPLEMENTATION: Uses Gemini 2.0 Flash vision to detect:
 * 1. Residual furniture (primary trigger) - Gemini 2.0 Flash
 * 2. Personal items / artwork / décor (secondary trigger) - Gemini 2.0 Flash
 * 3. Fallback structural metrics (edge noise & clutter density) - Image processing
 *
 * NOTE: Stage 1B-A and 1B-B themselves use Gemini 2.x/2.5 for actual editing
 * This detection uses Gemini 2.0 Flash for fast, reliable decision-making
 *
 * FAIL-OPEN SAFETY: On any error, returns TRUE to force Stage 1B-B
 * Returns true if ANY residual furniture OR personal items OR clutter remains
 * Only skips Stage 1B-B if the room is truly empty and stage-ready
 */
async function shouldRunStage1BB(
  stage1BAPath: string,
  ctx: Stage1BBDecisionContext = {}
): Promise<boolean> {
  const { jobId, roomType } = ctx;

  try {
    // 1) Detect residual furniture (primary trigger) - Gemini 2.0 Flash
    const furniture = await detectResidualFurniture(stage1BAPath, { jobId, roomType });

    // 2) Detect personal items / artwork / décor (secondary trigger) - Gemini 2.0 Flash
    const personal = await detectPersonalItems(stage1BAPath, { jobId, roomType });

    // 3) Fallback structural metrics (edge noise & clutter density) - Image processing
    const metrics = await analyzeEmptyRoomMetrics(stage1BAPath, { jobId, roomType });

    const hasFurniture = furniture?.hasFurniture ?? false;
    const hasPersonalItems = personal?.hasPersonalItems ?? false;

    const smallItemDensity = metrics?.smallItemDensity ?? 0;
    const edgeNoise = metrics?.edgeNoise ?? 0;

    // Thresholds – tuned for "ROOM IS EMPTY" vs "ROOM STILL HAS STUFF"
    const densityThreshold = 0.25;
    const edgeNoiseThreshold = 0.20;

    const decision =
      hasFurniture ||
      hasPersonalItems ||
      smallItemDensity > densityThreshold ||
      edgeNoise > edgeNoiseThreshold;

    console.log("[AUTO-EMPTY] Residual objects assessment", {
      jobId,
      stage1BAPath,
      hasFurniture,
      hasPersonalItems,
      smallItemDensity: smallItemDensity.toFixed(3),
      edgeNoise: edgeNoise.toFixed(3),
      thresholds: {
        smallItemDensity: densityThreshold,
        edgeNoise: edgeNoiseThreshold,
      },
      decision,
    });

    return decision;

  } catch (err) {
    // 🔥 FAIL-OPEN SAFETY — NEVER silently skip 1B-B again
    console.error("[AUTO-EMPTY] Detection failed — FORCING Stage 1B-B", {
      jobId,
      stage1BAPath,
      error: (err as Error)?.message || String(err),
    });

    return true; // FORCE micro declutter when in doubt
  }
}
