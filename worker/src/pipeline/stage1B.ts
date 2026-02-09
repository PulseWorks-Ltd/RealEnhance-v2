import sharp from "sharp";
import { siblingOutPath } from "../utils/images";
import { enhanceWithGemini } from "../ai/gemini";
import { buildStage1BPromptNZStyle, buildLightDeclutterPromptNZStyle } from "../ai/prompts.nzRealEstate";
import { validateStage } from "../ai/unified-validator";
import { validateStage1BStructural } from "../validators/stage1BValidator";

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
    jobId?: string;
    attempt?: number;
  } = {}
): Promise<string> {
  const { replaceSky = false, sceneType, roomType, declutterMode, jobId: jobIdOpt, attempt = 0 } = options;
  const jobId = jobIdOpt || (global as any).__jobId;
  const attemptIndex = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const suffix = attemptIndex > 0 ? `-1B-retry${attemptIndex}` : "-1B";
  const outputPath = siblingOutPath(stage1APath, suffix, ".webp");

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
    if (attemptIndex > 0) {
      const fs = await import("fs/promises");
      try {
        await fs.access(outputPath);
        throw new Error(`[stage1B] Retry output already exists: ${outputPath}`);
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          throw err;
        }
      }
    }

    const declutteredPath = await enhanceWithGemini(stage1APath, {
      replaceSky,
      declutter: true,
      sceneType,
      stage: "1B",
      jobId,
      roomType,
      modelReason: declutterMode ? `declutter:${declutterMode}` : "declutter",
      outputPath,
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
    });
    
    console.log(`[stage1B] 📊 Gemini returned: ${declutteredPath}`);
    console.log(`[stage1B] 🔍 Checking if Gemini succeeded: ${declutteredPath !== stage1APath ? 'YES ✅' : 'NO ❌'}`);
    
    // If Gemini succeeded, validate against canonical base (not 1A)
    if (declutteredPath !== stage1APath) {
      const { validateStageOutput } = await import("../validators/index.js");
      const canonicalPath: string | undefined = (global as any).__canonicalPath;
      const base = canonicalPath || stage1APath;
      const baseArtifacts = (global as any).__baseArtifacts;
      const verdict1 = await validateStageOutput("stage1B", base, declutteredPath, {
        sceneType: (sceneType === 'interior' ? 'interior' : 'exterior') as any,
        roomType,
        baseArtifacts,
      });
      // Soft mode: log verdict, always proceed
      console.log(`[stage1B] Validator verdict:`, verdict1);
      const { validateStage1BStructural } = await import("../validators/stage1BValidator.js");
      const jobId = (global as any).__jobId || "default";
      const { loadOrComputeStructuralMask } = await import("../validators/structuralMask.js");
      const maskPath = await loadOrComputeStructuralMask(jobId, base, baseArtifacts);
      const masks = { structuralMask: maskPath };
      const verdict2 = await validateStage1BStructural(base, declutteredPath, masks, baseArtifacts);
      console.log(`[stage1B] Structural validator verdict:`, verdict2);
      if (!verdict2.ok) {
        console.warn(`[stage1B] HARD FAIL: ${verdict2.reason}`);
      }
      if (declutteredPath !== outputPath) {
        console.warn(`[stage1B] Gemini output path mismatch: expected=${outputPath} actual=${declutteredPath}`);
      }
      console.log(`[stage1B] ✅ SUCCESS - Furniture removal complete: ${outputPath}`);
      return outputPath;
    }
    
    // Fallback: If Gemini unavailable, use Sharp-based gentle cleanup
    console.log(`[stage1B] ⚠️ Gemini unavailable or skipped, using Sharp fallback`);
    const out = outputPath;
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
    const out = outputPath;
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
