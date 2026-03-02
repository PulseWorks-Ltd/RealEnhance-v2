import { getGeminiClient } from "../ai/gemini";
import { MODEL_CONFIG, runWithPrimaryThenFallback } from "../ai/runWithImageModelFallback";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";
import type { StagingProfile } from "../utils/groups";
import { validateStage } from "../ai/unified-validator";
import { validateStage2Structural } from "../validators/stage2StructuralValidator";
import { runOpenCVStructuralValidator } from "../validators/index";
import { NZ_REAL_ESTATE_PRESETS, isNZStyleEnabled } from "../config/geminiPresets";
import { buildStage2PromptNZStyle } from "../ai/prompts.nzRealEstate";
import { getStagingStyleDirective } from "../ai/stagingStyles";
import sharp from "sharp";
import path from "path";
import fs from "fs/promises";
import type { StagingRegion } from "../ai/region-detector";
import { safeToBuffer, safeMetadata } from "../utils/sharp-utils"; // AUDIT FIX: safe sharp wrappers
import { loadStageAwareConfig } from "../validators/stageAwareConfig";
import { validateStructureStageAware } from "../validators/structural/stageAwareValidator";
import { getJob, updateJob } from "../utils/persist";
import { buildTightenedPrompt, getTightenedGenerationConfig, getTightenLevelFromAttempt, logTighteningInfo, TightenLevel } from "../ai/promptTightening";
import type { Mode } from "../validators/validationModes";
import { focusLog } from "../utils/logFocus";
import { buildLayoutContext, type LayoutContextResult } from "../ai/layoutPlanner";
import { buildStructuralRetryInjection, type StructuralFailureType } from "./structuralRetryHelpers";

const logger = console;

// Stage 2: virtual staging (add furniture)

export type Stage2Result = {
  outputPath: string;
  attempts: number;
  maxAttempts: number;
  validationRisk: boolean;
  fallbackUsed: boolean;
  localReasons: string[];
};

export async function runStage2GenerationAttempt(
  basePath: string,
  opts: {
    roomType: string;
    sceneType?: "interior" | "exterior";
    profile?: StagingProfile;
    referenceImagePath?: string;
    stagingRegion?: StagingRegion | null;
    stagingStyle?: string;
    sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
    promptMode?: "full" | "refresh";
    curtainRailLikely?: boolean | "unknown";
    jobId: string;
    outputPath: string;
    generationConfig?: Record<string, any>;
    tightenLevel?: TightenLevel;
    legacyStrictPrompt?: boolean;
    layoutContext?: LayoutContextResult | null;
    modelReason?: string;
    structuralRetryContext?: {
      compositeFail: boolean;
      failureType: StructuralFailureType | null;
      attemptNumber: number;
    };
  }
): Promise<string> {
  const normalizedRoomType = (opts.roomType || "")
    .toLowerCase()
    .replace(/-/g, "_")
    .trim();
  const canonicalRoomType = normalizedRoomType === "multiple_living_areas"
    ? "multiple_living"
    : normalizedRoomType;

  const refreshOnlyRoomTypes = new Set(["multiple_living", "kitchen_dining", "kitchen_living", "living_dining"]);
  const forceRefreshMode = refreshOnlyRoomTypes.has(canonicalRoomType);
  const resolvedPromptMode: "full" | "refresh" = opts.promptMode
    ? opts.promptMode
    : (opts.sourceStage === "1A" && !forceRefreshMode ? "full" : "refresh");

  let inputForStage2 = basePath;
  if (opts.stagingRegion) {
    try {
      const meta = await sharp(basePath).metadata();
      const W = meta.width || 0;
      const H = meta.height || 0;
      const r = opts.stagingRegion;
      const x = Math.max(0, Math.min(Math.floor(r.x), Math.max(0, W - 1)));
      const y = Math.max(0, Math.min(Math.floor(r.y), Math.max(0, H - 1)));
      const w = Math.max(1, Math.min(Math.floor(r.width), W - x));
      const h = Math.max(1, Math.min(Math.floor(r.height), H - y));
      const overlay = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.35 } } }).toBuffer();
      const regionPatch = await sharp(basePath).extract({ left: x, top: y, width: w, height: h }).toBuffer();
      const guided = await sharp(basePath)
        .composite([
          { input: overlay, left: 0, top: 0 },
          { input: regionPatch, left: x, top: y }
        ])
        .toFormat("png")
        .toBuffer();
      const guidedPath = siblingOutPath(basePath, "-staging-guide", ".png");
      await sharp(guided).toFile(guidedPath);
      inputForStage2 = guidedPath;
    } catch (e) {
      focusLog("TEMP_FILE", "[stage2] Failed to build guided staging input; proceeding with original base image", e);
    }
  }

  const scene = opts.sceneType || "interior";
  const { data, mime } = toBase64(inputForStage2);
  const useTest = process.env.USE_TEST_PROMPTS === "1";
  const stagingStyleRaw: any = opts.stagingStyle;
  const stagingStyleNorm = stagingStyleRaw && typeof stagingStyleRaw === "string"
    ? stagingStyleRaw.trim()
    : "none";

  let textPrompt = useTest
    ? require("../ai/prompts-test").buildTestStage2Prompt(scene, normalizedRoomType)
    : buildStage2PromptNZStyle(normalizedRoomType, scene, {
        stagingStyle: stagingStyleNorm,
        sourceStage: opts.sourceStage,
        mode: resolvedPromptMode,
        layoutContext: opts.layoutContext || undefined,
      });

  if (opts.tightenLevel && opts.tightenLevel > 0) {
    textPrompt = buildTightenedPrompt("2", textPrompt, opts.tightenLevel);
  } else if (opts.legacyStrictPrompt) {
    textPrompt += "\n\nSTRICT VALIDATION: Please ensure the output strictly matches the requested room type and scene, and correct any structural issues.";
  }

  console.log(`[STAGE2_PROMPT_STRUCTURE_RULES_ACTIVE] jobId=${opts.jobId}`);

  const structuralRetryContext = opts.structuralRetryContext;
  const retryInjectionResult = buildStructuralRetryInjection({
    compositeFail: structuralRetryContext?.compositeFail === true,
    failureType: structuralRetryContext?.failureType ?? null,
    attemptNumber: structuralRetryContext?.attemptNumber ?? 0,
  });
  if (retryInjectionResult) {
    if (retryInjectionResult.retryInjection.trim().length > 0) {
      textPrompt = textPrompt + "\n\nIMPORTANT STRUCTURAL CORRECTION REQUIRED:\n" + retryInjectionResult.retryInjection;
    }

    console.log("[RETRY_PROMPT_INJECTION]", {
      jobId: opts.jobId,
      attemptNumber: structuralRetryContext?.attemptNumber,
      retryTier: retryInjectionResult.retryTier,
      failureType: structuralRetryContext?.failureType,
    });
  }

  const railLikely = opts.curtainRailLikely;
  if (railLikely === false) {
    textPrompt += `

WINDOW COVERING HARD PROHIBITION:
No curtain rails or tracks are visible in the input image.
DO NOT add curtains, drapes, rods, or tracks.
Leave windows bare.
`;
  } else if (railLikely === true) {
    textPrompt += `

WINDOW COVERING PRESERVATION:
Curtain rails/tracks are present.
Keep existing curtains and rails/tracks unchanged.
Do not add blinds.
`;
  } else if (railLikely === "unknown") {
    textPrompt += `

WINDOW COVERING PRESERVATION:
If curtain rails/tracks and curtains are present, keep them unchanged.
Do not add blinds, rods, tracks, or new window coverings.
`;
  }

  const styleDirective = stagingStyleNorm !== "none" ? getStagingStyleDirective(stagingStyleNorm) : "";
  const requestParts: any[] = [];
  requestParts.push({ inlineData: { mimeType: mime, data } });
  if (opts.referenceImagePath) {
    const ref = toBase64(opts.referenceImagePath);
    requestParts.push({ inlineData: { mimeType: ref.mime, data: ref.data } });
  }
  if (styleDirective) requestParts.push({ text: styleDirective });
  requestParts.push({ text: textPrompt });

  let generationConfig: any = opts.generationConfig || undefined;
  if (opts.profile?.seed !== undefined) {
    generationConfig = { ...(generationConfig || {}), seed: opts.profile.seed };
  }

  const ai = getGeminiClient();
  const { resp } = await runWithPrimaryThenFallback({
    stageLabel: "2",
    ai: ai as any,
    baseRequest: {
      contents: requestParts,
      generationConfig,
    } as any,
    context: "stage2",
    meta: {
      stage: "2",
      jobId: opts.jobId,
      filename: path.basename(inputForStage2 || ""),
      roomType: opts.roomType,
      reason: opts.modelReason
        || (opts.roomType ? `${opts.roomType} → stage2` : "stage2"),
      selectedModel: MODEL_CONFIG.stage2.primary,
      fallbackModel: MODEL_CONFIG.stage2.fallback,
    },
  });

  const responseParts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
  const img = responseParts.find((p) => p.inlineData);
  if (!img?.inlineData?.data) {
    throw new Error("No image data in Gemini response");
  }
  writeImageDataUrl(opts.outputPath, `data:image/webp;base64,${img.inlineData.data}`);
  return opts.outputPath;
}

export async function runStage2(
  basePath: string,
  baseStage: "1A" | "1B",
  opts: {
    roomType: string;
    sceneType?: "interior" | "exterior";
    profile?: StagingProfile;
    angleHint?: "primary" | "secondary" | "other";
    referenceImagePath?: string;
    stagingRegion?: StagingRegion | null;
    stagingStyle?: string;
    sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
    promptMode: "full" | "refresh";
    curtainRailLikely?: boolean;
    // Optional callback to surface strict retry status to job updater
    onStrictRetry?: (info: { reasons: string[] }) => void;
    // Optional callback when a retry attempt supersedes the current attempt
    onAttemptSuperseded?: (nextAttemptId: string) => void;
    /** Stage1A output path for stage-aware validation baseline (CRITICAL) */
    stage1APath?: string;
    /** Job ID for validation tracking */
    jobId: string;
    /** Validation configuration (local-mode driven) */
    validationConfig?: { localMode?: Mode };
  }
): Promise<Stage2Result> {
  // Normalize room type format for prompt compatibility
  // Client sends "dining-room" (hyphen), prompts expect "dining_room" (underscore)
  const normalizedRoomType = (opts.roomType || "")
    .toLowerCase()
    .replace(/-/g, "_")
    .trim();
  const canonicalRoomType = normalizedRoomType === "multiple_living_areas"
    ? "multiple_living"
    : normalizedRoomType;

  let out = basePath;
  const dbg = process.env.STAGE2_DEBUG === "1";
  const validatorNotes: any[] = [];
  let needsRetry = false;
  let lastValidatorResults: any = {};
  let tempMultiplier = 1.0;
  let strictPrompt = false;
  const localMode: Mode = opts.validationConfig?.localMode || "log";
  const effectiveMode: "off" | "log" | "block" = localMode === "block" ? "block" : (localMode === "log" ? "log" : "off");
  const allowRetries = effectiveMode === "block";
  let localReasons: string[] = [];

  const stageAwareConfig = loadStageAwareConfig();
  focusLog("PIPELINE_GLOBAL_READ", "GLOBAL_READ_REMOVED", { file: "pipeline/stage2.ts", variable: "__jobId" });
  const jobId = opts.jobId;
  let attemptsUsed = 0;
  let validationRisk = false;
  let retryCount = 0;

  const clampSampling = (sampling: { temperature: number; topP: number; topK: number }) => ({
    temperature: Math.max(0.05, sampling.temperature),
    topP: Math.max(0.3, sampling.topP),
    topK: Math.max(10, Math.floor(sampling.topK)),
  });

  const nextAdaptiveSampling = (sampling: { temperature: number; topP: number; topK: number }) =>
    clampSampling({
      temperature: sampling.temperature * 0.9,
      topP: sampling.topP * 0.9,
      topK: sampling.topK * 0.9,
    });

  // CRITICAL: Stage2 validation baseline should be Stage1A output, NOT original
  // If stage1APath not provided, fallback to basePath with warning
  const validationBaseline = opts.stage1APath || basePath;
  if (!opts.stage1APath) {
    focusLog("PIPELINE_BASELINE_WARN", `[stage2] ⚠️ No stage1APath provided - using basePath as validation baseline (may cause false positives)`);
  }

  focusLog("PIPELINE_VERBOSE", `[stage2] 🔵 Starting virtual staging...`);
  focusLog("PIPELINE_VERBOSE", `[stage2] Input: ${basePath}`);
  focusLog("PIPELINE_VERBOSE", `[stage2] Validation baseline: ${validationBaseline}`);
  focusLog("PIPELINE_VERBOSE", `[stage2] Source stage: ${baseStage === '1B' ? 'Stage1B (decluttered)' : 'Stage1A (enhanced)'}`);
  focusLog("PIPELINE_VERBOSE", `[stage2] Room type: ${opts.roomType}`);
  focusLog("PIPELINE_VERBOSE", `[stage2] Scene type: ${opts.sceneType || 'interior'}`);
  focusLog("PIPELINE_VERBOSE", `[stage2] Profile: ${opts.profile?.styleName || 'default'}`);
  focusLog("PIPELINE_VERBOSE", `[stage2] Stage-aware validation: ${stageAwareConfig.enabled ? 'ENABLED' : 'DISABLED'}`);

  // Early exit if Stage 2 not enabled
  if (process.env.USE_GEMINI_STAGE2 !== "1") {
    focusLog("PIPELINE_VERBOSE", `[stage2] ⚠️ USE_GEMINI_STAGE2!=1 → skipping (using ${baseStage} output)`);
    if (dbg) focusLog("PIPELINE_VERBOSE", `[stage2] USE_GEMINI_STAGE2!=1 → skipping (using ${baseStage} output)`);
    return { outputPath: out, attempts: 0, maxAttempts: 0, validationRisk: false, fallbackUsed: false, localReasons: [] };
  }

  // Run OpenCV validator after Stage 1B (before staging) - legacy behavior
  if (!stageAwareConfig.enabled) {
    try {
      // AUDIT FIX: routed through safeToBuffer for safe cleanup
      const imageBuffer = await safeToBuffer(basePath, jobId);
      const result1B = await runOpenCVStructuralValidator(imageBuffer, { strict: !!process.env.STRICT_STRUCTURE_VALIDATION });
      validatorNotes.push({ stage: '1B', validator: 'OpenCV', result: result1B });
      lastValidatorResults['1B'] = result1B;
      if (!result1B.ok) needsRetry = true;
    } catch (e) {
      validatorNotes.push({ stage: '1B', validator: 'OpenCV', error: String(e) });
      lastValidatorResults['1B'] = { ok: false, error: String(e) };
      needsRetry = true;
    }
  }

  // Check API key before attempting Gemini calls
  if (!(process.env.GEMINI_API_KEY || process.env.REALENHANCE_API_KEY)) {
    focusLog("PIPELINE_VERBOSE", `[stage2] ⚠️ No GEMINI_API_KEY set – skipping (using ${baseStage} output)`);
    return { outputPath: out, attempts: 0, maxAttempts: 0, validationRisk: false, fallbackUsed: false, localReasons: [] };
  }

  if (dbg) focusLog("PIPELINE_VERBOSE", `[stage2] starting with roomType=${opts.roomType}, base=${basePath}`);

  // ═══════════════════════════════════════════════════════════
  // LAYOUT PLANNER PRE-PASS (Gemini Vision - Low Cost)
  // Only for Stage 2 FULL staging (empty rooms)
  // KILL SWITCH: USE_GEMINI_LAYOUT_PLANNER=1
  // ═══════════════════════════════════════════════════════════
  let layoutContext: LayoutContextResult | null = null;
  const refreshOnlyRoomTypes = new Set(["multiple_living", "kitchen_dining", "kitchen_living", "living_dining"]);
  const forceRefreshMode = refreshOnlyRoomTypes.has(canonicalRoomType);
  const resolvedPromptMode: "full" | "refresh" = opts.promptMode
    ? opts.promptMode
    : (opts.sourceStage === "1A" && !forceRefreshMode ? "full" : "refresh");
  if (!opts.promptMode) {
    focusLog("PIPELINE_VERBOSE", `[stage2] ⚠️ promptMode missing; using fallback inference from sourceStage (legacy caller)`);
  }
  const isFullStaging = resolvedPromptMode === "full";
  const isRefreshStaging = !isFullStaging;
  const layoutPlannerEnabled = process.env.USE_GEMINI_LAYOUT_PLANNER === "1";
  
  if (isFullStaging && process.env.USE_GEMINI_STAGE2 === "1" && layoutPlannerEnabled) {
    focusLog("LAYOUT_PLANNER", "[stage2] 🔍 Running layout planner pre-pass for FULL staging...");
    const plannerStartTime = Date.now();
    try {
      layoutContext = await buildLayoutContext(basePath);
      const plannerElapsed = Date.now() - plannerStartTime;
      
      if (layoutContext) {
        focusLog("LAYOUT_PLANNER", "[stage2] ✅ Layout context extracted", {
          elapsed: plannerElapsed,
          roomTypeGuess: layoutContext.room_type_guess,
          complexity: layoutContext.layout_complexity,
          confidence: layoutContext.confidence,
          zoneCount: layoutContext.zones.length,
          featureCount: layoutContext.major_fixed_features.length,
        });
        
        // Store in job metadata for ROI tracking
        try {
          await updateJob(jobId, {
            layoutPlannerUsed: true,
            layoutPlannerElapsed: plannerElapsed,
            layoutContext: {
              room_type_guess: layoutContext.room_type_guess,
              open_plan: layoutContext.open_plan,
              layout_complexity: layoutContext.layout_complexity,
              occlusion_risk: layoutContext.occlusion_risk,
              confidence: layoutContext.confidence,
              zones: layoutContext.zones.slice(0, 4), // Cap at 4 zones
              major_fixed_features: layoutContext.major_fixed_features.slice(0, 6), // Cap at 6 features
              staging_risk_flags: layoutContext.staging_risk_flags.slice(0, 4), // Cap at 4 flags
            }
          });
        } catch (updateError) {
          focusLog("LAYOUT_PLANNER", "[stage2] ⚠️ Failed to store layout context in job metadata", updateError);
        }
      } else {
        focusLog("LAYOUT_PLANNER", "[stage2] ⚠️ Layout planner returned null - continuing without layout context", {
          elapsed: plannerElapsed,
        });
        // Log that planner was attempted but failed
        try {
          await updateJob(jobId, { layoutPlannerUsed: false, layoutPlannerFailed: true });
        } catch {}
      }
    } catch (error: any) {
      const plannerElapsed = Date.now() - plannerStartTime;
      focusLog("LAYOUT_PLANNER", "[stage2] ⚠️ Layout planner failed - continuing without layout context", {
        elapsed: plannerElapsed,
        error: error.message,
      });
      // Log failure for ROI tracking
      try {
        await updateJob(jobId, { layoutPlannerUsed: false, layoutPlannerFailed: true, layoutPlannerError: error.message });
      } catch {}
    }
  } else if (isFullStaging && process.env.USE_GEMINI_STAGE2 === "1" && !layoutPlannerEnabled) {
    focusLog("LAYOUT_PLANNER", "[stage2] ℹ️ Layout planner disabled (USE_GEMINI_LAYOUT_PLANNER!=1)");
    // Log that planner was not used
    try {
      await updateJob(jobId, { layoutPlannerUsed: false });
    } catch {}
  }

  // Retry loop: honor GEMINI_MAX_RETRIES when provided; otherwise use stage-aware config
  const geminiMaxRetriesRaw = Number(process.env.GEMINI_MAX_RETRIES);
  const geminiMaxRetries = Number.isFinite(geminiMaxRetriesRaw) ? Math.max(0, Math.floor(geminiMaxRetriesRaw)) : null;
  const configuredAttempts = geminiMaxRetries !== null
    ? Math.max(1, geminiMaxRetries + 1)
    : (stageAwareConfig.enabled ? stageAwareConfig.maxRetryAttempts + 1 : 2);
  const maxInternalAttemptsRaw = Number(process.env.STAGE2_INTERNAL_MAX_ATTEMPTS || 3);
  const maxInternalAttempts = Number.isFinite(maxInternalAttemptsRaw)
    ? Math.min(4, Math.max(1, Math.floor(maxInternalAttemptsRaw)))
    : 3;
  const maxAttempts = Math.min(configuredAttempts, maxInternalAttempts);
  const regenEnabled = maxAttempts > 1;
  console.log(`[STAGE2_REGEN_MODE] job=${opts.jobId || "unknown"} enabled=${regenEnabled} maxAttempts=${maxAttempts}`);
  let currentTightenLevel: TightenLevel = 0;
  let adaptiveSamplingOverride: { temperature: number; topP: number; topK: number } | null = null;

  // This change removes duplicate Stage 2 validation retry channels and consolidates retry strategy
  // into internal adaptive loop for clarity, cost control, and deterministic behaviour.

  const buildStage2OutputPath = (attemptIndex: number) => {
    const suffix = attemptIndex === 0 ? "-2" : `-2-retry${attemptIndex}`;
    return siblingOutPath(basePath, suffix, ".webp");
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    needsRetry = false;
    validationRisk = false;
    localReasons = [];
    
    // ✅ FIX: Always use baseline input (Stage 1B or 1A), never compound previous retry outputs
    // This ensures each retry starts fresh from the correct stage baseline
    let inputForStage2 = basePath;
    
    // ✅ GUARD: Log retry baseline usage for debugging
    if (attempt > 0) {
      focusLog("PIPELINE_VERBOSE", `[stage2] Retry attempt ${attempt}: using baseline ${basePath.substring(basePath.length - 60)} (NOT previous output)`);
    }
    
    if (opts.stagingRegion) {
      try {
        // ✅ FIX: Build staging region overlay from baseline, not previous retry output
        const meta = await sharp(basePath).metadata();
        const W = meta.width || 0;
        const H = meta.height || 0;
        const r = opts.stagingRegion;
        const x = Math.max(0, Math.min(Math.floor(r.x), Math.max(0, W - 1)));
        const y = Math.max(0, Math.min(Math.floor(r.y), Math.max(0, H - 1)));
        const w = Math.max(1, Math.min(Math.floor(r.width), W - x));
        const h = Math.max(1, Math.min(Math.floor(r.height), H - y));
        const overlay = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.35 } } }).toBuffer();
        const regionPatch = await sharp(basePath).extract({ left: x, top: y, width: w, height: h }).toBuffer();
        const guided = await sharp(basePath)
          .composite([
            { input: overlay, left: 0, top: 0 },
            { input: regionPatch, left: x, top: y }
          ])
          .toFormat("png")
          .toBuffer();
        const guidedPath = siblingOutPath(basePath, "-staging-guide", ".png");
        await sharp(guided).toFile(guidedPath);
        inputForStage2 = guidedPath;
        if (dbg) focusLog("TEMP_FILE", `[stage2] Built guided input for staging region: ${guidedPath}`);
      } catch (e) {
        focusLog("TEMP_FILE", "[stage2] Failed to build guided staging input; proceeding with original base image", e);
      }
    }

    // Build prompt and call Gemini
    const scene = opts.sceneType || "interior";
    const { data, mime } = toBase64(inputForStage2);
    const profile = opts.profile;
    const useTest = process.env.USE_TEST_PROMPTS === "1";
    // Log incoming staging style from options (before prompt assembly)
    const stagingStyleRaw: any = (opts as any)?.stagingStyle;
    focusLog("PROMPT", "[stage2] incoming stagingStyle =", stagingStyleRaw);
    const stagingStyleNorm = stagingStyleRaw && typeof stagingStyleRaw === "string"
      ? stagingStyleRaw.trim()
      : "none";

    let textPrompt = useTest
      ? require("../ai/prompts-test").buildTestStage2Prompt(scene, normalizedRoomType)
      : buildStage2PromptNZStyle(normalizedRoomType, scene, { 
          stagingStyle: stagingStyleNorm, 
          sourceStage: opts.sourceStage,
          mode: resolvedPromptMode,
          layoutContext: layoutContext || undefined 
        });
    // Build a high-priority staging style directive (system-like block)
    const styleDirective = stagingStyleNorm !== "none" ? getStagingStyleDirective(stagingStyleNorm) : "";
    if (useTest) {
      textPrompt = require("../ai/prompts-test").buildTestStage2Prompt(scene, normalizedRoomType);
    }

    // Apply prompt tightening based on retry attempt
    if (stageAwareConfig.enabled && attempt > 0) {
      currentTightenLevel = getTightenLevelFromAttempt(attempt);
      logTighteningInfo("2", attempt, currentTightenLevel);
      textPrompt = buildTightenedPrompt("2", textPrompt, currentTightenLevel);
      strictPrompt = true;
    } else if (attempt === 1) {
      // Legacy retry behavior when stage-aware is disabled
      textPrompt += "\n\nSTRICT VALIDATION: Please ensure the output strictly matches the requested room type and scene, and correct any structural issues.";
      tempMultiplier = 0.8;
      strictPrompt = true;
    }

    console.log(`[STAGE2_PROMPT_STRUCTURE_RULES_ACTIVE] jobId=${opts.jobId}`);

    focusLog("PIPELINE_GLOBAL_READ", "GLOBAL_READ_REMOVED", { file: "pipeline/stage2.ts", variable: "__curtainRailLikely" });
    const railLikely = opts.curtainRailLikely;
    if (railLikely === false) {
      textPrompt += `

WINDOW COVERING HARD PROHIBITION:
No curtain rails or tracks are visible in the input image.
DO NOT add curtains, drapes, rods, or tracks.
Leave windows bare.
`;
    } else if (railLikely === true) {
      textPrompt += `

WINDOW COVERING PRESERVATION:
Curtain rails/tracks are present.
Keep existing curtains and rails/tracks unchanged.
Do not add blinds.
`;
    } else if (railLikely === "unknown") {
      textPrompt += `

WINDOW COVERING PRESERVATION:
If curtain rails/tracks and curtains are present, keep them unchanged.
Do not add blinds, rods, tracks, or new window coverings.
`;
    }
  logger.debug("Stage2 prompt hierarchy: camera lock placed first");
    const requestParts: any[] = [];
    // Always include the primary input image first
    requestParts.push({ inlineData: { mimeType: mime, data } });
    // Optional reference image (kept immediately after the primary image)
    if (opts.referenceImagePath) {
      const ref = toBase64(opts.referenceImagePath);
      requestParts.push({ inlineData: { mimeType: ref.mime, data: ref.data } });
    }
    // Insert the style directive as a separate text part before the main prompt
    if (styleDirective) {
      requestParts.push({ text: styleDirective });
    }
    // Finally, add the main prompt
    requestParts.push({ text: textPrompt });
    if (dbg) {
      const combinedPrompt = styleDirective + "\n\n" + textPrompt;
      const preview = combinedPrompt.slice(0, 1000);
      focusLog("PROMPT", `[stage2] [PROMPT_ASSEMBLED] stagingStyle=${stagingStyleNorm} len=${combinedPrompt.length}\n${preview}${combinedPrompt.length > 1000 ? '\n...[truncated]' : ''}`);
      focusLog("PROMPT", "[stage2][PROMPT_ASSEMBLED]", {
        stagingStyle: stagingStyleNorm,
        len: combinedPrompt.length,
        preview: combinedPrompt.slice(0, 400),
      });
    }
    if (dbg) focusLog("GEMINI_CALL", "[stage2] invoking Gemini with roomType=%s", opts.roomType);
    focusLog("GEMINI_CALL", `[stage2] 🤖 Calling Gemini API for virtual staging... (attempt ${attempt + 1}${strictPrompt ? ' [STRICT]' : ''})`);
    try {
      let ai: any = null;
      ai = getGeminiClient();
      if (!ai) throw new Error("getGeminiClient returned null/undefined");
      const apiStartTime = Date.now();
      let generationConfig: any = useTest ? (profile?.seed !== undefined ? { seed: profile.seed } : undefined) : (profile?.seed !== undefined ? { seed: profile.seed } : undefined);
      let effectiveSamplingForAttempt: { temperature: number; topP: number; topK: number } | null = null;
      if (isNZStyleEnabled()) {
        const preset = scene === 'interior' ? NZ_REAL_ESTATE_PRESETS.stage2Interior : NZ_REAL_ESTATE_PRESETS.stage2Exterior;
        const refreshSampling = { temperature: 0.30, topP: 0.73, topK: 31 };
        const fullSampling = { temperature: 0.25, topP: 0.70, topK: 30 };
        const isInteriorScene = scene === 'interior';
        const baseSampling = isInteriorScene
          ? (isRefreshStaging ? refreshSampling : fullSampling)
          : { temperature: preset.temperature, topP: preset.topP, topK: preset.topK };
        let temperature = baseSampling.temperature;

        // Apply tightened generation config when stage-aware is enabled
        if (stageAwareConfig.enabled && currentTightenLevel > 0) {
          const tightenedConfig = getTightenedGenerationConfig(currentTightenLevel, {
            temperature: baseSampling.temperature,
            topP: baseSampling.topP,
            topK: baseSampling.topK,
          });
          effectiveSamplingForAttempt = clampSampling({
            temperature: tightenedConfig.temperature,
            topP: tightenedConfig.topP,
            topK: tightenedConfig.topK,
          });
          generationConfig = { ...(generationConfig || {}), ...effectiveSamplingForAttempt };
          focusLog("PIPELINE_VERBOSE", `[stage2] Applied tightened generation config: temp=${effectiveSamplingForAttempt.temperature.toFixed(2)}, topP=${effectiveSamplingForAttempt.topP}, topK=${effectiveSamplingForAttempt.topK}`);
        } else {
          // Legacy behavior
          if (attempt === 1) temperature = Math.max(0.01, temperature * 0.8);
          effectiveSamplingForAttempt = clampSampling({
            temperature,
            topP: Number(baseSampling.topP ?? 0.70),
            topK: Number(baseSampling.topK ?? 30),
          });
          generationConfig = { ...(generationConfig || {}), ...effectiveSamplingForAttempt };
        }

        if (adaptiveSamplingOverride) {
          effectiveSamplingForAttempt = clampSampling(adaptiveSamplingOverride);
          generationConfig = { ...(generationConfig || {}), ...effectiveSamplingForAttempt };
          console.log(`[STAGE2_INTERNAL_RETRY] attempt=${attempt + 1} temperature=${effectiveSamplingForAttempt.temperature.toFixed(3)} topP=${effectiveSamplingForAttempt.topP.toFixed(3)} topK=${effectiveSamplingForAttempt.topK}`);
        }
      }
      // ✅ Stage 2 uses Gemini 3 → fallback to 2.5 on failure
      const { resp, modelUsed } = await runWithPrimaryThenFallback({
        stageLabel: "2",
        ai: ai as any,
        baseRequest: {
          contents: requestParts,
          generationConfig,
        } as any,
        context: "stage2",
        meta: {
          stage: "2",
          jobId,
          filename: path.basename(inputForStage2 || ""),
          roomType: opts.roomType,
          reason: ((): string => {
            if (stagingStyleNorm && stagingStyleNorm !== "none") {
              return `${opts.roomType || "unknown"} → ${stagingStyleNorm}`;
            }
            return opts.roomType ? `${opts.roomType} → stage2` : "stage2";
          })(),
          selectedModel: MODEL_CONFIG.stage2.primary,
          fallbackModel: MODEL_CONFIG.stage2.fallback,
        },
      });
      const apiElapsed = Date.now() - apiStartTime;
      focusLog("PIPELINE_VERBOSE", `[stage2] ✅ Gemini API responded in ${apiElapsed} ms (model=${modelUsed})`);
      const responseParts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
      focusLog("PIPELINE_VERBOSE", `[stage2] 📊 Response parts: ${responseParts.length}`);
      const img = responseParts.find(p => p.inlineData);
      if (!img?.inlineData?.data) {
        validatorNotes.push({ stage: '2', validator: 'Gemini', error: 'No image data in Gemini response' });
        if (dbg) focusLog("PIPELINE_VERBOSE", "[stage2] no image in response → using previous output");
        break;
      }
      const candidatePath = buildStage2OutputPath(attempt);
      if (attempt > 0) {
        try {
          await fs.access(candidatePath);
          throw new Error(`[stage2] Retry output already exists: ${candidatePath}`);
        } catch (err: any) {
          if (err?.code !== "ENOENT") {
            throw err;
          }
        }
        console.log(`[RETRY_OUTPUT] stage=2 attempt=${attempt} path=${candidatePath}`);
      }
      writeImageDataUrl(candidatePath, `data:image/webp;base64,${img.inlineData.data}`);
      out = candidatePath;
      focusLog("TEMP_FILE", `[stage2] 💾 Saved staged image to: ${candidatePath}`);

      // Run validators after Stage 2
      let validatorFailed = false;

      console.log(`[VALIDATOR_INPUT] stage=2 attempt=${attempt} using=${out}`);

      if (stageAwareConfig.enabled) {
        // ===== STAGE-AWARE VALIDATION (Feature-flagged) =====
        // CRITICAL: Use Stage1A output as baseline, NOT original
        try {
          const validationResult = await validateStructureStageAware({
            stage: "stage2",
            baselinePath: validationBaseline, // Stage1A output
            candidatePath: out, // Stage2 output
            mode: localMode === "block" ? "block" : "log",
            jobId,
            sceneType: opts.sceneType || "interior",
            roomType: opts.roomType,
            retryAttempt: attempt,
            config: stageAwareConfig,
          });

          validatorNotes.push({ stage: '2', validator: 'StageAware', result: validationResult });
          lastValidatorResults['2'] = validationResult;

          if (validationResult.risk) {
            validatorFailed = true;
            validationRisk = true;
            localReasons = validationResult.triggers.map((t) => t.message || t.id);
            console.warn(`[stage2] Stage-aware validation detected risk (${validationResult.triggers.length} triggers)`);
            validationResult.triggers.forEach((t, i) => {
              console.warn(`[stage2]   ${i + 1}. ${t.id}: ${t.message}`);
            });

            if (allowRetries && attempt + 1 < maxAttempts) {
              const currentSampling = clampSampling({
                temperature: Number(generationConfig?.temperature ?? 0.25),
                topP: Number(generationConfig?.topP ?? 0.70),
                topK: Number(generationConfig?.topK ?? 30),
              });
              adaptiveSamplingOverride = nextAdaptiveSampling(currentSampling);
              currentTightenLevel = getTightenLevelFromAttempt(attempt + 1);
              needsRetry = true;
              retryCount++;
              console.log(`[STAGE2_INTERNAL_RETRY] attempt=${attempt + 2} temperature=${adaptiveSamplingOverride.temperature.toFixed(3)} topP=${adaptiveSamplingOverride.topP.toFixed(3)} topK=${adaptiveSamplingOverride.topK}`);
              if (opts.onStrictRetry) {
                opts.onStrictRetry({ reasons: validationResult.triggers.map(t => t.message) });
              }
              continue;
            }
            if (!allowRetries) {
              console.warn(`[validator] retry suppressed due to mode=${effectiveMode}`);
            } else {
              console.log(`[STAGE2_INTERNAL_RETRY_EXHAUSTED] attempts=${attempt + 1} maxAttempts=${maxAttempts}`);
            }
            attemptsUsed = attempt + 1;
            break;
          } else {
            console.log(`[stage2] ✅ Stage-aware validation passed (risk=false)`);
            attemptsUsed = attempt + 1;
            break;
          }
        } catch (e) {
          console.error(`[stage2] Stage-aware validation error:`, e);
          validatorNotes.push({ stage: '2', validator: 'StageAware', error: String(e) });
          // On error, don't retry - just continue with the output
          attemptsUsed = attempt + 1;
          break;
        }
      } else {
        // ===== LEGACY VALIDATION (OpenCV) =====
        try {
          // AUDIT FIX: routed through safeToBuffer for safe cleanup
          const stagedBuffer = await safeToBuffer(out, jobId);
          const result2 = await runOpenCVStructuralValidator(stagedBuffer, { strict: !!process.env.STRICT_STRUCTURE_VALIDATION });
          validatorNotes.push({ stage: '2', validator: 'OpenCV', result: result2 });
          lastValidatorResults['2'] = result2;
          if (!result2.ok) {
            validatorFailed = true;
            validationRisk = true;
            const reason = (result2 as any)?.reason || (result2 as any)?.errors?.[0] || "opencv_structural_risk";
            localReasons = [reason];
          }
        } catch (e) {
          validatorNotes.push({ stage: '2', validator: 'OpenCV', error: String(e) });
          lastValidatorResults['2'] = { ok: false, error: String(e) };
          validatorFailed = true;
          validationRisk = true;
          localReasons = ["opencv_structural_error"];
        }

        if (validatorFailed && allowRetries && attempt + 1 < maxAttempts) {
          const currentSampling = clampSampling({
            temperature: Number(generationConfig?.temperature ?? 0.25),
            topP: Number(generationConfig?.topP ?? 0.70),
            topK: Number(generationConfig?.topK ?? 30),
          });
          adaptiveSamplingOverride = nextAdaptiveSampling(currentSampling);
          needsRetry = true;
          retryCount++;
          console.log(`[STAGE2_INTERNAL_RETRY] attempt=${attempt + 2} temperature=${adaptiveSamplingOverride.temperature.toFixed(3)} topP=${adaptiveSamplingOverride.topP.toFixed(3)} topK=${adaptiveSamplingOverride.topK}`);
          continue;
        } else if (validatorFailed && !allowRetries) {
          console.warn(`[validator] retry suppressed due to mode=${effectiveMode}`);
          attemptsUsed = attempt + 1;
          break;
        } else if (validatorFailed) {
          console.log(`[STAGE2_INTERNAL_RETRY_EXHAUSTED] attempts=${attempt + 1} maxAttempts=${maxAttempts}`);
          attemptsUsed = attempt + 1;
          break;
        } else {
          attemptsUsed = attempt + 1;
          break;
        }
      }
    } catch (e: any) {
      validatorNotes.push({ stage: '2', validator: 'Gemini', error: String(e) });
      lastValidatorResults['2'] = { ok: false, error: String(e) };
      console.error("[stage2] ❌ Gemini API error:", e?.message || String(e));
      attemptsUsed = attempt + 1;
      break;
    }
  }
  // After retry, always return the last output and notes
  if (attemptsUsed === 0) attemptsUsed = Math.max(1, maxAttempts);
  
  // ═══════════════════════════════════════════════════════════
  // ROI METRICS TRACKING (Layout Planner Impact)
  // ═══════════════════════════════════════════════════════════
  try {
    const finalJob = await getJob(jobId);
    const layoutPlannerWasUsed = (finalJob as any)?.layoutPlannerUsed === true;
    
    focusLog("LAYOUT_PLANNER_ROI", "[stage2] ROI Metrics", {
      jobId,
      layoutPlannerUsed: layoutPlannerWasUsed,
      stage2RetryCount: attemptsUsed - 1, // 0-indexed retries
      totalAttempts: attemptsUsed,
      validationRisk,
      validatorEscalations: validatorNotes.length,
      finalPassValidatorLevel: localMode, // 'log' or 'block'
      needsRetry: needsRetry,
    });
    
    // Store final metrics in job for analysis
    await updateJob(jobId, {
      stage2Metrics: {
        retryCount: attemptsUsed - 1,
        totalAttempts: attemptsUsed,
        validationRisk,
        validatorEscalations: validatorNotes.length,
        finalValidatorMode: localMode,
      }
    });
  } catch (metricsError) {
    // Don't fail the job if metrics logging fails
    focusLog("LAYOUT_PLANNER_ROI", "[stage2] ⚠️ Failed to log ROI metrics", metricsError);
  }
  
  return { outputPath: out, attempts: attemptsUsed, maxAttempts, validationRisk, fallbackUsed: false, localReasons };
}
