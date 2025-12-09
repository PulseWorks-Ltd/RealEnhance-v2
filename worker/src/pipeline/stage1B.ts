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
 * - "tidy": Micro declutter only (1 pass) - removes small clutter, keeps ALL furniture
 * - "standard": Comprehensive furniture removal (1-2 passes) - Stage 1B-A removes all furniture, Stage 1B-B runs conditionally if Gemini audit detects residual items
 * - "stage-ready": Comprehensive furniture removal (1-2 passes) - Stage 1B-A removes all furniture, Stage 1B-B runs unless Gemini audit confirms perfectly clean
 *
 * Pipeline: Sharp → Stage 1A (enhance) → Stage 1B-A → [Gemini audit] → [Stage 1B-B if needed] → Stage 2 (staging)
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
  const jobId = (global as any).__jobId || 'unknown';

  // ✅ CANONICAL MODE AUTHORITY - Read execution plan from global (set by worker)
  const publicMode = (global as any).__publicMode as "tidy" | "standard" | "stage-ready" | undefined;
  const willRunStructural = (global as any).__willRunStructural as boolean;
  const autoDetect = (global as any).__autoDetect as boolean;

  // ✅ FATAL GUARD - publicMode MUST exist
  if (!publicMode || !['tidy', 'standard', 'stage-ready'].includes(publicMode)) {
    throw new Error(`[STAGE1B-FATAL] Invalid or missing publicMode: "${publicMode}". Cannot execute Stage 1B without valid mode contract.`);
  }

  console.log(`[stage1B] 🔵 Starting furniture removal system...`);
  console.log(`[stage1B] Input (Stage1A enhanced): ${stage1APath}`);
  console.log(`[stage1B] Execution plan enforced from publicMode`, {
    jobId,
    publicMode,
    willRunStructural,
    autoDetect,
    sceneType,
    roomType
  });

  // For exteriors, bypass two-stage system (no furniture to remove)
  if (sceneType === 'exterior') {
    console.log(`[stage1B] ℹ️ Exterior scene detected - using standard declutter`);
    return runLegacyStage1B(stage1APath, options);
  }

  try {

    // ✅ TIDY MODE: Run only micro declutter (no furniture removal)
    if (publicMode === "tidy") {
      // ✅ FATAL GUARD - Tidy mode must NEVER run structural removal
      if (willRunStructural) {
        throw new Error(`[STAGE1B-FATAL] Mode contract violation: publicMode="tidy" but willRunStructural=true. This is a bug.`);
      }

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
    // ✅ FATAL GUARD - These modes MUST run structural removal
    if (!willRunStructural) {
      throw new Error(`[STAGE1B-FATAL] Mode contract violation: publicMode="${publicMode}" but willRunStructural=false. This is a bug.`);
    }
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
    // - "stage-ready": Auto-detect after 1B-A, skip ONLY if audit confirms perfectly clean
    let needsStage1BB = false;

    if (publicMode === "stage-ready") {
      console.log("[stage1B] 🎯 Mode is 'stage-ready' - checking if Stage 1B-B needed...");

      // Run audit to check room status
      const audit = await auditResidualObjects(stage1BAPath, { jobId, roomType });

      // SKIP Stage 1B-B ONLY if audit confirms room is perfectly clean
      const isPerfectlyClean =
        !audit.hasFurniture &&
        !audit.hasPersonalItems &&
        audit.isStageReady === true;

      needsStage1BB = !isPerfectlyClean;

      console.log("[stage1B] Stage-Ready audit decision", {
        jobId,
        isPerfectlyClean,
        needsStage1BB,
        audit: {
          hasFurniture: audit.hasFurniture,
          residualFurniture: audit.residualFurniture,
          hasPersonalItems: audit.hasPersonalItems,
          residualPersonalItems: audit.residualPersonalItems,
          isStageReady: audit.isStageReady,
          confidence: audit.confidence
        }
      });
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

      // Get structured audit with specific items to target
      const audit = await auditResidualObjects(stage1BAPath, { jobId, roomType });

      // Extract targeted items for prompt injection
      const targetedItems = [
        ...audit.residualFurniture,
        ...audit.residualPersonalItems
      ].filter(Boolean);

      console.log(`[stage1B-2] Targeted removal items`, {
        jobId,
        count: targetedItems.length,
        items: targetedItems
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
        promptOverride: buildStage1BBPromptNZStyle(
          roomType,
          (sceneType === "interior" || sceneType === "exterior" ? sceneType : "interior") as any,
          targetedItems
        ),
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
        console.log(`[STAGE1B] MODE=${publicMode} PASS=B → OUTPUT=${finalPath.split('/').pop()}`);
      } else {
        // Single-pass only: use -1B-A
        stageSuffix = "-1B-A";
        console.log(`[STAGE1B] MODE=${publicMode} PASS=A → OUTPUT=${finalPath.split('/').pop()}`);
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
 * Structured residual object audit result
 */
interface ResidualObjectAudit {
  hasFurniture: boolean;
  residualFurniture: string[];
  hasPersonalItems: boolean;
  residualPersonalItems: string[];
  isStageReady: boolean;
  confidence: number;
}

/**
 * Structured residual object audit using Gemini 2.0 Flash
 * Identifies specific remaining items for targeted removal
 */
async function auditResidualObjects(
  imagePath: string,
  ctx: Stage1BBDecisionContext
): Promise<ResidualObjectAudit> {
  const prompt = `You are analyzing a real estate image AFTER a main furniture removal pass.

Your task is to identify ANY remaining items that prevent this room from being completely EMPTY and stage-ready.

Focus on:
- Furniture (couches, chairs, tables, beds, wardrobes, TV units)
- Partial or ghost furniture fragments
- Artwork, photo frames, wall decor
- Rugs, loose curtains, plants
- Personal items: shoes, clothes, toys, cables, bench clutter, bathroom items

Return STRICT JSON ONLY in this exact format:

{
  "hasFurniture": true or false,
  "residualFurniture": ["specific furniture item 1", "specific furniture item 2"],
  "hasPersonalItems": true or false,
  "residualPersonalItems": ["specific item 1", "specific item 2"],
  "isStageReady": true or false,
  "confidence": 0.0 to 1.0
}`;

  try {
    const { json } = await callGeminiJsonOnImage(imagePath, prompt);

    const result: ResidualObjectAudit = {
      hasFurniture: !!json?.hasFurniture,
      residualFurniture: Array.isArray(json?.residualFurniture) ? json.residualFurniture : [],
      hasPersonalItems: !!json?.hasPersonalItems,
      residualPersonalItems: Array.isArray(json?.residualPersonalItems) ? json.residualPersonalItems : [],
      isStageReady: !!json?.isStageReady,
      confidence: typeof json?.confidence === "number" ? json.confidence : 0,
    };

    console.log("[AUTO-EMPTY] Residual object audit", {
      jobId: ctx.jobId,
      imagePath,
      ...result,
    });

    return result;
  } catch (err) {
    // FAIL-OPEN: Assume items present on detection failure
    console.error("[AUTO-EMPTY] Residual audit FAILED — FAIL-OPEN → FORCE Stage 1B-B", {
      jobId: ctx.jobId,
      imagePath,
      error: (err as Error)?.message || String(err),
    });

    return {
      hasFurniture: true,
      residualFurniture: ["unknown furniture"],
      hasPersonalItems: true,
      residualPersonalItems: ["unknown personal items"],
      isStageReady: false,
      confidence: 0,
    };
  }
}

/**
 * Auto mode decision: Should we run Stage 1B-B?
 *
 * NEW IMPLEMENTATION: Uses structured residual audit with Gemini 2.0 Flash vision
 * Returns structured item-aware feedback for targeted removal
 *
 * FAIL-OPEN SAFETY: On any error in audit, forces Stage 1B-B to run
 * Returns true if ANY residual furniture OR personal items detected OR room not stage-ready
 * Only skips Stage 1B-B if audit confirms room is truly empty and stage-ready
 */
async function shouldRunStage1BB(
  stage1BAPath: string,
  ctx: Stage1BBDecisionContext = {}
): Promise<boolean> {
  const audit = await auditResidualObjects(stage1BAPath, ctx);

  const decision =
    audit.hasFurniture ||
    audit.hasPersonalItems ||
    audit.isStageReady === false;

  console.log("[AUTO-EMPTY] Stage 1B-B decision", {
    jobId: ctx.jobId,
    decision,
  });

  return decision;
}
