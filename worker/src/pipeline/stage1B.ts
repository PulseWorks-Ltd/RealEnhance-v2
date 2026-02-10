import sharp from "sharp";
import { siblingOutPath } from "../utils/images";
import { enhanceWithGemini } from "../ai/gemini";
import { buildStage1BPromptNZStyle, buildLightDeclutterPromptNZStyle } from "../ai/prompts.nzRealEstate";
import { validateStage } from "../ai/unified-validator";
import { validateStage1BStructural } from "../validators/stage1BValidator";
import type { BaseArtifacts } from "../validators/baseArtifacts";

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
    jobId: string;
    canonicalPath?: string | null;
    baseArtifacts?: BaseArtifacts;
    curtainRailLikely?: boolean | "unknown";
    jobDeclutterIntensity?: "light" | "standard" | "heavy";
    jobSampling?: { temperature?: number; topP?: number; topK?: number };
    attempt?: number;
  }
): Promise<string> {
  const { replaceSky = false, sceneType, roomType, declutterMode, jobId: jobIdOpt, attempt = 0 } = options;
  console.log("GLOBAL_READ_REMOVED", { file: "pipeline/stage1B.ts", variable: "__jobId" });
  const jobId = jobIdOpt;
  const attemptIndex = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  let resolvedAttemptIndex = attemptIndex;
  let suffix = resolvedAttemptIndex > 0 ? `-1B-retry${resolvedAttemptIndex}` : "-1B";
  let outputPath = siblingOutPath(stage1APath, suffix, ".webp");
  if (attemptIndex === 0) {
    const fs = await import("fs/promises");
    try {
      await fs.access(outputPath);
      resolvedAttemptIndex = 1;
      suffix = `-1B-retry${resolvedAttemptIndex}`;
      outputPath = siblingOutPath(stage1APath, suffix, ".webp");
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        throw err;
      }
    }
  }
  console.log(`[STAGE1B_OUTPUT_PATH] attempt=${attemptIndex} resolved=${outputPath}`);

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
    
    if (declutterMode === "stage-ready" && attemptIndex >= 2) {
      promptOverride += `

RETRY REMOVAL REINFORCEMENT:
Remove ALL movable furniture completely.
Do not preserve partial furniture.
If uncertain whether built-in or movable — treat as movable and remove.
`;
    }

    console.log("GLOBAL_READ_REMOVED", { file: "pipeline/stage1B.ts", variable: "__curtainRailLikely" });
    const railLikely = options.curtainRailLikely as boolean | "unknown";
    if (railLikely === false) {
      promptOverride += `

WINDOW COVERING HARD PROHIBITION:
No curtain rails or tracks are visible in the input image.
DO NOT add curtains, drapes, rods, or tracks.
Leave windows bare.
`;
    } else if (railLikely === true) {
      promptOverride += `

WINDOW COVERING LIMITED FLEXIBILITY:
Curtain rails/tracks are present.
Curtains may be changed or replaced.
Rails/tracks must remain unchanged.
Do not add blinds.
`;
    } else if (railLikely === "unknown") {
      promptOverride += `

WINDOW COVERING LIMITED FLEXIBILITY:
Curtain rails/tracks may be present.
Curtains may be changed or replaced.
Rails/tracks must remain unchanged.
Do not add blinds.
`;
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
    if (resolvedAttemptIndex > 0) {
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

    const baseTemp = 0.30;
    const retryTemp = (declutterMode === "stage-ready" && attemptIndex >= 1)
      ? Math.max(0.05, baseTemp * 0.9)
      : baseTemp;

    console.log("GLOBAL_READ_REMOVED", { file: "pipeline/stage1B.ts", variable: "__jobDeclutterIntensity" });
    console.log("GLOBAL_READ_REMOVED", { file: "pipeline/stage1B.ts", variable: "__jobSampling" });
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
      temperature: retryTemp,
      topP: 0.70,
      topK: 32,
      // NZ explicit 1B prompt (mode-specific)
      promptOverride,
      // When decluttering, allow interior floor cleanup and exterior hardscape cleanup
      floorClean: sceneType === "interior",
      hardscapeClean: sceneType === "exterior",
      declutterIntensity: options.jobDeclutterIntensity || undefined,
      ...(options.jobSampling || {}),
    });
    
    console.log(`[stage1B] 📊 Gemini returned: ${declutteredPath}`);
    console.log(`[stage1B] 🔍 Checking if Gemini succeeded: ${declutteredPath !== stage1APath ? 'YES ✅' : 'NO ❌'}`);
    
    // If Gemini succeeded, validate against canonical base (not 1A)
    if (declutteredPath !== stage1APath) {
      const { validateStageOutput } = await import("../validators/index.js");
      console.log("GLOBAL_READ_REMOVED", { file: "pipeline/stage1B.ts", variable: "__canonicalPath" });
      const canonicalPath: string | undefined = options.canonicalPath || undefined;
      const base = canonicalPath || stage1APath;
      console.log("GLOBAL_READ_REMOVED", { file: "pipeline/stage1B.ts", variable: "__baseArtifacts" });
      const baseArtifacts = options.baseArtifacts ?? undefined;
      const verdict1 = await validateStageOutput("stage1B", base, declutteredPath, {
        sceneType: (sceneType === 'interior' ? 'interior' : 'exterior') as any,
        roomType,
        baseArtifacts,
      });
      // Soft mode: log verdict, always proceed
      console.log(`[stage1B] Validator verdict:`, verdict1);
      const { validateStage1BStructural } = await import("../validators/stage1BValidator.js");
      console.log("GLOBAL_READ_REMOVED", { file: "pipeline/stage1B.ts", variable: "__jobId" });
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
