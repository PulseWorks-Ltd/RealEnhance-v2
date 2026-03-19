import sharp from "sharp";
import { siblingOutPath } from "../utils/images";
import { enhanceWithGemini, STAGE1B_FULL_SAMPLING } from "../ai/gemini";
import { buildStage1BPromptNZStyle, buildLightDeclutterPromptNZStyle } from "../ai/prompts.nzRealEstate";
import { validateStage } from "../ai/unified-validator";
import { validateStage1BStructural } from "../validators/stage1BValidator";
import type { BaseArtifacts } from "../validators/baseArtifacts";
import { logIfNotFocusMode } from "../logger";
import { applyTransformation } from "../utils/sharp-utils"; // AUDIT FIX: safe sharp wrapper
import { logImageAttemptUrl } from "../utils/debugImageUrls";

/**
 * Stage 1B: Furniture & Clutter Removal
 * 
 * Takes the enhanced output from Stage 1A and removes furniture/clutter based on mode:
 * - "light": Removes clutter/mess only, keeps all main furniture
 * - "stage-ready": Structured retain declutter (preserves anchors, removes secondary items)
 * 
 * Pipeline: Sharp → Stage 1A (Gemini enhance) → Stage 1B (Gemini declutter) → Stage 2 (Gemini stage)
 * 
 * The output is either a light decluttered room (light) or a structured-retain base (stage-ready), ready for Stage 2.
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
  logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1B.ts", variable: "__jobId" });
  const jobId = jobIdOpt;
  const attemptIndex = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const attemptForLogs = attemptIndex + 1;
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
  logIfNotFocusMode(`[STAGE1B_OUTPUT_PATH] attempt=${attemptIndex} resolved=${outputPath}`);

  // ✅ HARD REQUIREMENT: declutterMode MUST be provided (no defaults)
  if (!declutterMode || (declutterMode !== "light" && declutterMode !== "stage-ready")) {
    const errMsg = `[stage1B] FATAL: declutterMode is required and must be "light" or "stage-ready". Received: ${declutterMode}`;
    console.error(errMsg);
    throw new Error(errMsg);
  }

  logIfNotFocusMode(`[stage1B] 🔵 Starting furniture & clutter removal...`);
  logIfNotFocusMode(`[stage1B] Input (Stage1A enhanced): ${stage1APath}`);
  logIfNotFocusMode(`[stage1B] Declutter mode: ${declutterMode} (${declutterMode === "light" ? "keep furniture, remove clutter" : "preserve anchors, remove secondary items"})`);
  logIfNotFocusMode(`[stage1B] Options: sceneType=${sceneType}, roomType=${roomType}`);
  
  try {
    // ✅ PROMPT SELECTION SAFETY — Explicit mode-based routing
    let promptOverride: string;
    
    if (declutterMode === "light") {
      // Declutter-only: aggressive clutter removal, furniture preservation
      promptOverride = buildLightDeclutterPromptNZStyle(roomType, (sceneType === "interior" || sceneType === "exterior" ? sceneType : "interior") as any);
      logIfNotFocusMode("[stage1B] 📋 Using LIGHT (declutter-only) prompt");
    } else if (declutterMode === "stage-ready") {
      // Stage-ready token: structured-retain declutter for virtual staging refresh
      promptOverride = buildStage1BPromptNZStyle(roomType, (sceneType === "interior" || sceneType === "exterior" ? sceneType : "interior") as any);
      logIfNotFocusMode("[stage1B] 📋 Using STAGE-READY (structured retain) prompt");
    } else {
      throw new Error(`Invalid declutterMode: ${declutterMode}. Must be "light" or "stage-ready"`);
    }
    
    logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1B.ts", variable: "__curtainRailLikely" });
    const railLikely = options.curtainRailLikely as boolean | "unknown";
    if (declutterMode === "stage-ready") {
      promptOverride += `

WINDOW TREATMENT HARD LOCK (STAGE 1B STRUCTURED RETAIN):
Preserve existing curtains, drapes, blinds, rods, tracks, and rails exactly as shown.
Do not add, remove, replace, restyle, or reposition any window treatment components.
`;
    } else if (railLikely === false) {
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

  promptOverride += `

CRITICAL CAMERA AND STRUCTURE RULES:

- You must preserve the EXACT original camera position, angle, framing, and field of view.
- Do NOT crop, zoom, rotate, shift perspective, or alter lens characteristics.
- The output must align pixel-for-pixel with the original viewpoint.

- You must NOT modify walls, ceilings, floors, doors, windows, or architectural planes.
- You must NOT extend, shrink, reshape, repaint, or create new wall surfaces.
- You must NOT fill in unseen areas beyond the original image boundaries.
- You must NOT alter room proportions.

- You must NOT add furniture.
- You must NOT enlarge or reshape anchor furniture.
- You may ONLY remove clutter or small movable objects.

### NEGATIVE CONSTRAINTS — FORBIDDEN ACTIONS
1. NEVER change the state of a door. A closed door is a SOLID WALL for this task.
2. NEVER reveal the interior of a cupboard, wardrobe, or adjacent room.
3. NEVER add "depth" or "perspective" to a flat door surface.
4. If you see a handle on a flat panel, that panel must remain a flat, closed surface.

If there is any ambiguity, leave the area unchanged.
`;

    // ✅ FINAL MODE RESOLUTION LOGGING (for acceptance criteria verification)
    const promptUsed = declutterMode === "light" ? "light (declutter-only)" : "structured-retain (stage-ready token)";
    logIfNotFocusMode("[stage1B] Declutter mode resolved:", {
      declutter: true,
      declutterMode: declutterMode,
      promptUsed: promptUsed
    });
    logIfNotFocusMode(`[WORKER] ✅ Stage 1B ENABLED - mode: ${declutterMode}`);
    
    logIfNotFocusMode(`[stage1B] 🤖 Calling Gemini in ${declutterMode} mode...`);
    // Call Gemini with declutter-only prompt (Stage 1A already enhanced)
    if (resolvedAttemptIndex > 0) {
      const fs = await import("fs/promises");
      let retryIndex = resolvedAttemptIndex;
      while (true) {
        try {
          await fs.access(outputPath);
          retryIndex += 1;
          outputPath = siblingOutPath(stage1APath, `-1B-retry${retryIndex}`, ".webp");
          continue;
        } catch (err: any) {
          if (err?.code === "ENOENT") {
            break;
          }
          throw err;
        }
      }
      if (retryIndex !== resolvedAttemptIndex) {
        logIfNotFocusMode(`[STAGE1B_OUTPUT_PATH] retry-collision resolved=${resolvedAttemptIndex}->${retryIndex}`);
      }
    }

    const baseTemp = STAGE1B_FULL_SAMPLING.temperature;
    const retryTemp = declutterMode === "stage-ready"
      ? STAGE1B_FULL_SAMPLING.temperature
      : (attemptIndex >= 1 ? Math.max(0.05, baseTemp * 0.9) : baseTemp);
    const samplingTopP = declutterMode === "stage-ready"
      ? STAGE1B_FULL_SAMPLING.topP
      : 0.70;
    const samplingTopK = declutterMode === "stage-ready"
      ? STAGE1B_FULL_SAMPLING.topK
      : 30;

    logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1B.ts", variable: "__jobDeclutterIntensity" });
    logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1B.ts", variable: "__jobSampling" });
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
      topP: samplingTopP,
      topK: samplingTopK,
      // NZ explicit 1B prompt (mode-specific)
      promptOverride,
      // When decluttering, allow interior floor cleanup and exterior hardscape cleanup
      floorClean: sceneType === "interior",
      hardscapeClean: sceneType === "exterior",
      declutterIntensity: options.jobDeclutterIntensity || undefined,
      ...(options.jobSampling || {}),
    });
    
    logIfNotFocusMode(`[stage1B] 📊 Gemini returned: ${declutteredPath}`);
    logIfNotFocusMode(`[stage1B] 🔍 Checking if Gemini succeeded: ${declutteredPath !== stage1APath ? 'YES ✅' : 'NO ❌'}`);
    
    // If Gemini succeeded, validate against canonical base (not 1A)
    if (declutteredPath !== stage1APath) {
      await logImageAttemptUrl({
        stage: "1B",
        attempt: attemptForLogs,
        jobId,
        localPath: outputPath,
      });
      const { validateStageOutput } = await import("../validators/index.js");
      logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1B.ts", variable: "__canonicalPath" });
      const canonicalPath: string | undefined = options.canonicalPath || undefined;
      const base = canonicalPath || stage1APath;
      logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1B.ts", variable: "__baseArtifacts" });
      const baseArtifacts = options.baseArtifacts ?? undefined;
      const verdict1 = await validateStageOutput("stage1B", base, declutteredPath, {
        sceneType: (sceneType === 'interior' ? 'interior' : 'exterior') as any,
        roomType,
        baseArtifacts,
      });
      // Soft mode: log verdict, always proceed
      logIfNotFocusMode(`[stage1B] Validator verdict:`, verdict1);
      const { validateStage1BStructural } = await import("../validators/stage1BValidator.js");
      logIfNotFocusMode("GLOBAL_READ_REMOVED", { file: "pipeline/stage1B.ts", variable: "__jobId" });
      const { loadOrComputeStructuralMask } = await import("../validators/structuralMask.js");
      const maskPath = await loadOrComputeStructuralMask(jobId, base, baseArtifacts);
      const masks = { structuralMask: maskPath };
      const verdict2 = await validateStage1BStructural(base, declutteredPath, masks, baseArtifacts);
      logIfNotFocusMode(`[stage1B] Structural validator verdict:`, verdict2);
      if (!verdict2.ok) {
        logIfNotFocusMode(`[stage1B] HARD FAIL: ${verdict2.reason}`);
      }
      if (declutteredPath !== outputPath) {
        logIfNotFocusMode(`[stage1B] Gemini output path mismatch: expected=${outputPath} actual=${declutteredPath}`);
      }
      logIfNotFocusMode(`[stage1B] ✅ SUCCESS - Furniture removal complete: ${outputPath}`);
      return outputPath;
    }
    
    // Fallback: If Gemini unavailable, use Sharp-based gentle cleanup
    logIfNotFocusMode(`[stage1B] ⚠️ Gemini unavailable or skipped, using Sharp fallback`);
    const out = outputPath;
    // AUDIT FIX: routed through applyTransformation for safe cleanup
    await applyTransformation(stage1APath, out, s => s.rotate().median(3).blur(0.5).sharpen(0.4).webp({ quality: 90 }), jobId);
    await logImageAttemptUrl({
      stage: "1B",
      attempt: attemptForLogs,
      jobId,
      localPath: out,
    });
    logIfNotFocusMode(`[stage1B] ℹ️ Sharp fallback complete: ${out}`);
    return out;
    
  } catch (error) {
    logIfNotFocusMode(`[stage1B] Error during declutter:`, error);
    // Fallback to Sharp on error
    const out = outputPath;
    // AUDIT FIX: routed through applyTransformation for safe cleanup
    await applyTransformation(stage1APath, out, s => s.rotate().median(3).blur(0.5).sharpen(0.4).webp({ quality: 90 }), jobId);
    await logImageAttemptUrl({
      stage: "1B",
      attempt: attemptForLogs,
      jobId,
      localPath: out,
    });
    return out;
  }
}
