import sharp from "sharp";
import { siblingOutPath } from "../utils/images";
import { enhanceWithGemini } from "../ai/gemini";
import { buildStage1BPromptNZStyle, buildLightDeclutterPromptNZStyle } from "../ai/prompts.nzRealEstate";
import { validateStage } from "../ai/unified-validator";
import { validateStage1BStructural } from "../validators/stage1BValidator";
import { loadStageAwareConfig } from "../validators/stageAwareConfig";
import { validateStructureStageAware } from "../validators/structural/stageAwareValidator";
import { shouldValidatorBlock, getValidatorMode } from "../validators/validatorMode";
import { compareImageDimensions, STRICT_DIMENSION_PROMPT_SUFFIX, isWithinDimensionTolerance, normalizeCandidateToBaseline, calculateDimensionDelta, getDimensionTolerancePct } from "../utils/dimensionGuard";

/**
 * Stage 1B: Furniture & Clutter Removal
 * 
 * Takes the enhanced output from Stage 1A and removes furniture/clutter based on mode:
 * - "light": Removes clutter/mess only, keeps all main furniture
 * - "stage-ready": Removes ALL furniture and clutter to create empty room
 * 
 * Pipeline: Sharp → Stage 1A (Gemini enhance) → Stage 1B (Gemini declutter) → Stage 2 (Gemini stage)
 * 
 * The output is either a tidied room (light) or empty room (stage-ready), ready for Stage 2 staging.
 */
export async function runStage1B(
  stage1APath: string,
  options: {
    replaceSky?: boolean;
    sceneType?: "interior" | "exterior" | string;
    roomType?: string;
    declutterMode?: "light" | "stage-ready";
    /** Original image path (for reference/masks if needed) */
    originalPath?: string;
    /** Job ID for validation tracking */
    jobId?: string;
  } = {}
): Promise<string | null> {
  const { replaceSky = false, sceneType, roomType, declutterMode, originalPath, jobId: providedJobId } = options;

  // Stage-aware validation config
  const stageAwareConfig = loadStageAwareConfig();
  const validationMode = shouldValidatorBlock("structure") ? "block" : "log";
  const jobId = providedJobId || (global as any).__jobId || `stage1B-${Date.now()}`;

  // ✅ HARD REQUIREMENT: declutterMode MUST be provided (no defaults)
  if (!declutterMode || (declutterMode !== "light" && declutterMode !== "stage-ready")) {
    const errMsg = `[stage1B] FATAL: declutterMode is required and must be "light" or "stage-ready". Received: ${declutterMode}`;
    console.error(errMsg);
    throw new Error(errMsg);
  }

  console.log(`[stage1B] 🔵 Starting furniture & clutter removal...`);
  console.log(`[stage1B] Input (Stage1A enhanced): ${stage1APath}`);
  console.log(`[stage1B] Declutter mode: ${declutterMode} (${declutterMode === "light" ? "keep furniture, remove clutter" : "remove ALL furniture"})`);
  console.log(`[stage1B] Options: sceneType=${sceneType}, roomType=${roomType}`);
  
  try {
    // ✅ PROMPT SELECTION SAFETY — Explicit mode-based routing
    let promptOverride: string;
    
    if (declutterMode === "light") {
      // Declutter-only: aggressive clutter removal, furniture preservation
      promptOverride = buildLightDeclutterPromptNZStyle(roomType, (sceneType === "interior" || sceneType === "exterior" ? sceneType : "interior") as any);
      console.log("[stage1B] 📋 Using LIGHT (declutter-only) prompt");
    } else if (declutterMode === "stage-ready") {
      // Stage-ready: complete furniture removal for virtual staging
      promptOverride = buildStage1BPromptNZStyle(roomType, (sceneType === "interior" || sceneType === "exterior" ? sceneType : "interior") as any);
      console.log("[stage1B] 📋 Using STAGE-READY (full removal) prompt");
    } else {
      throw new Error(`Invalid declutterMode: ${declutterMode}. Must be "light" or "stage-ready"`);
    }
    
    // ✅ FINAL MODE RESOLUTION LOGGING (for acceptance criteria verification)
    const promptUsed = declutterMode === "light" ? "light (declutter-only)" : "full (stage-ready)";
    console.log("[stage1B] Declutter mode resolved:", {
      declutter: true,
      declutterMode: declutterMode,
      promptUsed: promptUsed
    });
    console.log(`[WORKER] ✅ Stage 1B ENABLED - mode: ${declutterMode}`);
    
    console.log(`[stage1B] 🤖 Calling Gemini in ${declutterMode} mode...`);
    // Call Gemini with declutter-only prompt (Stage 1A already enhanced)
    const geminiRequest = {
      replaceSky,
      declutter: true,
      sceneType,
      stage: "1B",
      // Low-temp for deterministic, aggressive removal
      temperature: 0.30,
      topP: 0.70,
      topK: 32,
      // NZ explicit 1B prompt (mode-specific)
      promptOverride,
      // When decluttering, allow interior floor cleanup and exterior hardscape cleanup
      floorClean: sceneType === "interior",
      hardscapeClean: sceneType === "exterior",
      declutterIntensity: (global as any).__jobDeclutterIntensity || undefined,
      ...(typeof (global as any).__jobSampling === 'object' ? (global as any).__jobSampling : {}),
    } as const;

    const declutteredPath = await enhanceWithGemini(stage1APath, geminiRequest);
    
    console.log(`[stage1B] 📊 Gemini returned: ${declutteredPath}`);
    console.log(`[stage1B] 🔍 Checking if Gemini succeeded: ${declutteredPath !== stage1APath ? 'YES ✅' : 'NO ❌'}`);
    
    // If Gemini succeeded, validate the decluttered output
    if (declutteredPath !== stage1APath) {
      const outputPath = siblingOutPath(stage1APath, "-1B", ".webp");
      const fs = await import("fs/promises");
      console.log(`[stage1B] 💾 Renaming Gemini output to Stage1B: ${declutteredPath} → ${outputPath}`);
      await fs.rename(declutteredPath, outputPath);

      // Early dimension guard so compliant images can pass after a single strict retry
      let stage1BPath = outputPath;
      if (stageAwareConfig.enabled && stageAwareConfig.blockOnDimensionMismatch) {
        const dimResult = await compareImageDimensions(stage1APath, stage1BPath);
        const deltas = calculateDimensionDelta(dimResult.baseline, dimResult.candidate);
        console.log(
          `[stage1B][dim] jobId=${jobId} baseline=${dimResult.baseline.width}x${dimResult.baseline.height} candidate=${dimResult.candidate.width}x${dimResult.candidate.height} ` +
          `deltaW=${(deltas.widthPct * 100).toFixed(2)}% deltaH=${(deltas.heightPct * 100).toFixed(2)}%`
        );

        if (!dimResult.ok) {
          const tolerancePct = getDimensionTolerancePct();
          const withinTolerance = isWithinDimensionTolerance(dimResult.baseline, dimResult.candidate, tolerancePct);

          if (withinTolerance) {
            const normalization = await normalizeCandidateToBaseline(stage1APath, stage1BPath, { suffix: "-dimnorm" });
            console.log(
              `[stage1B][dim-normalize] jobId=${jobId} method=${normalization.method} baseline=${dimResult.baseline.width}x${dimResult.baseline.height} ` +
              `candidate=${dimResult.candidate.width}x${dimResult.candidate.height} normalized=${normalization.normalizedPath} ` +
              `deltaW=${(deltas.widthPct * 100).toFixed(2)}% deltaH=${(deltas.heightPct * 100).toFixed(2)}%`
            );

            if (normalization.ok) {
              stage1BPath = normalization.normalizedPath;
            }
          } else if (stageAwareConfig.maxRetryAttempts > 0) {
            console.warn(
              `[stage1B] Dimension mismatch from model output (baseline ${dimResult.baseline.width}x${dimResult.baseline.height}, candidate ${dimResult.candidate.width}x${dimResult.candidate.height}). Retrying once with strict dimension prompt.`
            );

            const strictPrompt = `${promptOverride}\n\n${STRICT_DIMENSION_PROMPT_SUFFIX}`;
            const strictPath = await enhanceWithGemini(stage1APath, { ...geminiRequest, promptOverride: strictPrompt });
            const retryPath = siblingOutPath(stage1APath, "-1B-dimretry", ".webp");
            await fs.rename(strictPath, retryPath);

            const retryDim = await compareImageDimensions(stage1APath, retryPath);
            const retryDelta = calculateDimensionDelta(retryDim.baseline, retryDim.candidate);
            console.log(
              `[stage1B][dim] retry jobId=${jobId} baseline=${retryDim.baseline.width}x${retryDim.baseline.height} candidate=${retryDim.candidate.width}x${retryDim.candidate.height} ` +
              `deltaW=${(retryDelta.widthPct * 100).toFixed(2)}% deltaH=${(retryDelta.heightPct * 100).toFixed(2)}%`
            );

            if (!retryDim.ok) {
              console.error(`[stage1B] ❌ Dimension mismatch persisted after strict retry (jobId=${jobId})`);
              if (validationMode === "block") {
                return null;
              }
            } else {
              stage1BPath = retryPath;
              console.log(`[stage1B] ✅ Dimension retry succeeded, continuing with ${stage1BPath}`);
            }
          } else {
            console.warn(
              `[stage1B] Dimension mismatch detected but STRUCT_VALIDATION_MAX_RETRY_ATTEMPTS=0; validator will handle block in ${validationMode} mode.`
            );
          }
        }
      }

      // ═══════════════════════════════════════════════════════════════════════════════
      // STAGE-AWARE VALIDATION FOR STAGE 1B
      // ═══════════════════════════════════════════════════════════════════════════════
      // CRITICAL: Stage1B validation baseline MUST be Stage1A output (NOT original)
      // Comparing 1B vs original would inflate diffs since 1A already changed lighting/contrast
      if (stageAwareConfig.enabled) {
        // Structured baseline log for monitoring
        console.log(
          `[STRUCT_BASELINE] stage=1B jobId=${jobId} baseline=${stage1APath} candidate=${stage1BPath} ` +
          `original=${originalPath || "(not provided)"} mode=${validationMode}`
        );

        try {
          const validationResult = await validateStructureStageAware({
            stage: "stage1B",
            baselinePath: stage1APath, // CRITICAL: Compare 1B output vs 1A output (NOT original)
            candidatePath: stage1BPath,
            mode: validationMode,
            jobId,
            sceneType: (sceneType === "interior" || sceneType === "exterior" ? sceneType : "interior") as "interior" | "exterior",
            roomType,
            config: stageAwareConfig,
          });

          console.log(`[stage1B] Stage-aware validation result: risk=${validationResult.risk}, score=${validationResult.score.toFixed(3)}`);

          if (validationResult.risk) {
            const hasFatalTrigger = validationResult.triggers.some(t => t.fatal);
            const fatalIds = validationResult.triggers.filter(t => t.fatal).map(t => t.id);
            const nonFatalIds = validationResult.triggers.filter(t => !t.fatal).map(t => t.id);

            console.warn(`[stage1B] Stage-aware validation detected risk (${validationResult.triggers.length} triggers, fatal=${hasFatalTrigger})`);
            validationResult.triggers.forEach((t, i) => {
              console.warn(`[stage1B]   ${i + 1}. ${t.id}${t.fatal ? " [FATAL]" : ""}: ${t.message}`);
            });

            // Structured failure log
            console.log(
              `[STRUCT_FAIL] stage=1B mode=${validationMode} ` +
              `fatal=[${fatalIds.join(",")}] triggers=[${nonFatalIds.join(",")}] jobId=${jobId}`
            );

            // In block mode with risk, return null to signal failure
            if (validationMode === "block") {
              console.error(`[stage1B] ❌ BLOCKED: Stage 1B structural validation failed in block mode`);
              return null;
            }
          }
        } catch (validationError) {
          console.error(`[stage1B] Stage-aware validation error (fail-open):`, validationError);
          // Continue in case of validation error - fail-open
        }
      } else {
        // Legacy validation path when stage-aware is disabled
        const { validateStageOutput } = await import("../validators/index.js");
        const canonicalPath: string | undefined = (global as any).__canonicalPath;
        const base = canonicalPath || stage1APath;
        const verdict1 = await validateStageOutput("stage1B", base, stage1BPath, { sceneType: (sceneType === 'interior' ? 'interior' : 'exterior') as any, roomType });
        // Soft mode: log verdict, always proceed
        console.log(`[stage1B] Validator verdict:`, verdict1);
        const { validateStage1BStructural } = await import("../validators/stage1BValidator.js");
        const { loadOrComputeStructuralMask } = await import("../validators/structuralMask.js");
        const maskPath = await loadOrComputeStructuralMask(jobId, base);
        const masks = { structuralMask: maskPath };
        const verdict2 = await validateStage1BStructural(base, stage1BPath, masks);
        console.log(`[stage1B] Structural validator verdict:`, verdict2);
        if (!verdict2.ok) {
          console.warn(`[stage1B] HARD FAIL: ${verdict2.reason}`);
        }
      }

      console.log(`[stage1B] ✅ SUCCESS - Furniture removal complete: ${stage1BPath}`);
      return stage1BPath;
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
    console.error(`[stage1B] Error during declutter:`, error);
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
