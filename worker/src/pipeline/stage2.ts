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
import type { StagingRegion } from "../ai/region-detector";
import { loadStageAwareConfig, chooseStage2Baseline, ValidateParams } from "../validators/stageAwareConfig";
import { validateStructureStageAware } from "../validators/structural/stageAwareValidator";
import { shouldRetryStage, markStageFailed, logRetryState } from "../validators/stageRetryManager";
import { getValidatorMode, shouldValidatorBlock } from "../validators/validatorMode";
import { buildTightenedPrompt, getTightenedGenerationConfig, getTightenLevelFromAttempt, logTighteningInfo, TightenLevel, applySamplingBackoff, formatSamplingParams, SamplingParams } from "../ai/promptTightening";
import { compareImageDimensions, STRICT_DIMENSION_PROMPT_SUFFIX, isWithinDimensionTolerance, normalizeCandidateToBaseline, calculateDimensionDelta, getDimensionTolerancePct } from "../utils/dimensionGuard";
const MULTI_LIVING_KEYS = new Set(["multi-living", "multiple-living-areas", "multiple_living_areas", "multiple_living"]);

export function resolveStage2Models(opts: {
  roomType: string;
  stage2Variant: "2A" | "2B";
  jobId?: string;
  imageId?: string;
  multiLivingModelEnv?: string;
}): { primaryModel: string; fallbackModel: string; source: "override" | "config"; endpoint: "image_gen"; isMultiLiving: boolean } {
  const basePrimary = MODEL_CONFIG.stage2.primary;
  const baseFallback = MODEL_CONFIG.stage2.fallback || MODEL_CONFIG.stage2.primary;
  const envFallback = (process.env.GEMINI_STAGE2_MODEL_FALLBACK || "").trim();
  const fallbackModel = envFallback || baseFallback || basePrimary;
  const rawOverride = (opts.multiLivingModelEnv || process.env.GEMINI_STAGE2_MULTI_LIVING_MODEL || "").trim();
  const isMultiLiving = Boolean(opts.roomType && MULTI_LIVING_KEYS.has(opts.roomType.toLowerCase()));

  let primaryModel = isMultiLiving ? rawOverride : basePrimary;
  let source: "override" | "config" = isMultiLiving ? "override" : "config";

  if (!primaryModel) {
    primaryModel = basePrimary;
    source = "config";
    console.warn(`[MODEL_SELECT_WARN] stage=2 reason=missing_override roomType=${opts.roomType} fallback=${primaryModel}`);
  }

  const endpoint: "image_gen" = "image_gen";
  console.log(`[MODEL_SELECT] stage=2 roomType=${opts.roomType} model=${primaryModel} endpoint=${endpoint} source=${source} stage2Variant=${opts.stage2Variant} jobId=${opts.jobId || 'n/a'} imageId=${opts.imageId || 'n/a'} fallback=${fallbackModel}`);

  return { primaryModel, fallbackModel, source, endpoint, isMultiLiving };
}

// Stage 2: virtual staging (add furniture)

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
    stagingMode?: "refresh" | "full";
    // Optional callback to surface strict retry status to job updater
    onStrictRetry?: (info: { reasons: string[] }) => void;
    /** Stage1A output path for stage-aware validation baseline */
    stage1APath?: string;
    /** Stage1B output path (if declutter ran) - used as validation baseline when available */
    stage1BPath?: string;
    /** Job ID for validation tracking */
    jobId?: string;
    imageId?: string;
  }
): Promise<string | null> {
  let out = basePath;
  const dbg = process.env.STAGE2_DEBUG === "1";
  const validatorNotes: any[] = [];
  let retryCount = 0;
  let needsRetry = false;
  let lastValidatorResults: any = {};
  let tempMultiplier = 1.0;
  let strictPrompt = false;
  const stagingMode: "refresh" | "full" = opts.stagingMode === "refresh" ? "refresh" : "full";
  const stagingVariant: "2A" | "2B" = stagingMode === "refresh" ? "2A" : "2B";
  const isMultiLiving = typeof opts.roomType === "string" && MULTI_LIVING_KEYS.has(opts.roomType.toLowerCase());

  // Stage-aware validation config
  const stageAwareConfig = loadStageAwareConfig();
  const jobId = opts.jobId || (global as any).__jobId || `stage2-${Date.now()}`;

  // CRITICAL: Stage2 validation baseline selection
  // Policy: Use Stage1B if it ran successfully, otherwise Stage1A
  // If neither provided:
  // - In block mode: ERROR and return null (validation will cause false positives)
  // - In log mode: warn and fallback to basePath
  const validationMode = shouldValidatorBlock("structure") ? "block" : "log";

  // Choose the correct baseline using the helper
  let validationBaseline: string;
  let baselineStage: "1A" | "1B" | "unknown" = "unknown";

  if (opts.stage1APath) {
    // Use chooseStage2Baseline to select between 1A and 1B
    const baselineChoice = chooseStage2Baseline({
      stage1APath: opts.stage1APath,
      stage1BPath: opts.stage1BPath,
    });
    validationBaseline = baselineChoice.baselinePath;
    baselineStage = baselineChoice.baselineStage;
  } else {
    // No stage1APath provided - fallback to basePath with warning/error
    validationBaseline = basePath;
    baselineStage = "unknown";

    if (stageAwareConfig.enabled) {
      if (validationMode === "block") {
        console.error(`[stage2] ❌ ERROR: No stage1APath provided for Stage2 validation in block mode - cannot validate safely`);
        console.error(`[stage2] ❌ jobId=${jobId} basePath=${basePath} - Stage2 validation requires Stage1A output as baseline`);
        // In block mode, missing stage1APath is a critical error since validation would cause false positives
        return null;
      } else {
        console.warn(`[stage2] ⚠️ No stage1APath provided - using basePath as validation baseline (may cause false positives)`);
      }
    }
  }

  console.log(`[stage2] 🔵 Starting virtual staging...`);
  console.log(`[stage2] Input: ${basePath}`);
  console.log(`[stage2] Validation baseline: ${validationBaseline} (baselineStage=${baselineStage})`);
  console.log(`[stage2] Source stage: ${baseStage === '1B' ? 'Stage1B (decluttered)' : 'Stage1A (enhanced)'}`);
  console.log(`[stage2] Room type: ${opts.roomType}`);
  console.log(`[stage2] Scene type: ${opts.sceneType || 'interior'}`);
  console.log(`[stage2] Profile: ${opts.profile?.styleName || 'default'}`);
  console.log(`[stage2] Stage-aware validation: ${stageAwareConfig.enabled ? 'ENABLED' : 'DISABLED'}`);

  // Early exit if Stage 2 not enabled
  if (process.env.USE_GEMINI_STAGE2 !== "1") {
    console.log(`[stage2] ⚠️ USE_GEMINI_STAGE2!=1 → skipping (using ${baseStage} output)`);
    if (dbg) console.log(`[stage2] USE_GEMINI_STAGE2!=1 → skipping (using ${baseStage} output)`);
    return out;
  }

  // Run OpenCV validator after Stage 1B (before staging) - legacy behavior
  if (!stageAwareConfig.enabled) {
    try {
      const imageBuffer = await sharp(basePath).toBuffer();
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
  if (!process.env.REALENHANCE_API_KEY) {
    console.warn(`[stage2] ⚠️ No REALENHANCE_API_KEY set – skipping (using ${baseStage} output)`);
    return out;
  }

  if (dbg) console.log(`[stage2] starting with roomType=${opts.roomType}, base=${basePath}`);

  // Retry loop: use config.maxRetryAttempts (default 3) if stage-aware enabled
  const maxAttempts = stageAwareConfig.enabled ? stageAwareConfig.maxRetryAttempts + 1 : 2;
  let currentTightenLevel: TightenLevel = 0;

  // ===== BASELINE SAMPLING PARAMS =====
  // Store the original sampling params from presets - these are NOT mutated
  // Retries use applySamplingBackoff() to compute reduced values from this baseline
  const scene = opts.sceneType || "interior";
  const baselineSamplingParams: SamplingParams = isNZStyleEnabled()
    ? (scene === "interior"
        ? { temperature: NZ_REAL_ESTATE_PRESETS.stage2Interior.temperature, topP: NZ_REAL_ESTATE_PRESETS.stage2Interior.topP, topK: NZ_REAL_ESTATE_PRESETS.stage2Interior.topK }
        : { temperature: NZ_REAL_ESTATE_PRESETS.stage2Exterior.temperature, topP: NZ_REAL_ESTATE_PRESETS.stage2Exterior.topP, topK: NZ_REAL_ESTATE_PRESETS.stage2Exterior.topK })
    : { temperature: 0.3, topP: 0.8, topK: 40 }; // Fallback defaults

  console.log(`[stage2] Baseline sampling params: ${formatSamplingParams(baselineSamplingParams)}`);

  // Track which sampling params are actually used on each attempt
  let currentSamplingParams: SamplingParams = { ...baselineSamplingParams };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    needsRetry = false;
    let inputForStage2 = out;
    if (opts.stagingRegion) {
      try {
        const meta = await sharp(out).metadata();
        const W = meta.width || 0;
        const H = meta.height || 0;
        const r = opts.stagingRegion;
        const x = Math.max(0, Math.min(Math.floor(r.x), Math.max(0, W - 1)));
        const y = Math.max(0, Math.min(Math.floor(r.y), Math.max(0, H - 1)));
        const w = Math.max(1, Math.min(Math.floor(r.width), W - x));
        const h = Math.max(1, Math.min(Math.floor(r.height), H - y));
        const overlay = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.35 } } }).toBuffer();
        const regionPatch = await sharp(out).extract({ left: x, top: y, width: w, height: h }).toBuffer();
        const guided = await sharp(out)
          .composite([
            { input: overlay, left: 0, top: 0 },
            { input: regionPatch, left: x, top: y }
          ])
          .toFormat("png")
          .toBuffer();
        const guidedPath = siblingOutPath(out, "-staging-guide", ".png");
        await sharp(guided).toFile(guidedPath);
        inputForStage2 = guidedPath;
        if (dbg) console.log(`[stage2] Built guided input for staging region: ${guidedPath}`);
      } catch (e) {
        console.warn("[stage2] Failed to build guided staging input; proceeding with original base image", e);
      }
    }

    // Build prompt and call Gemini
    // Note: `scene` is already defined before the retry loop (for baseline sampling params)
    const { data, mime } = toBase64(inputForStage2);
    const profile = opts.profile;
    const useTest = process.env.USE_TEST_PROMPTS === "1";
    // Log incoming staging style from options (before prompt assembly)
    const stagingStyleRaw: any = (opts as any)?.stagingStyle;
    console.info("[stage2] incoming stagingStyle =", stagingStyleRaw);
    const stagingStyleNorm = stagingStyleRaw && typeof stagingStyleRaw === "string"
      ? stagingStyleRaw.trim()
      : "none";

    let textPrompt = useTest
      ? require("../ai/prompts-test").buildTestStage2Prompt(scene, opts.roomType)
      : buildStage2PromptNZStyle(opts.roomType, scene, { stagingStyle: stagingStyleNorm });
    // Build a high-priority staging style directive (system-like block)
    const styleDirective = stagingStyleNorm !== "none" ? getStagingStyleDirective(stagingStyleNorm) : "";
    if (useTest) {
      textPrompt = require("../ai/prompts-test").buildTestStage2Prompt(scene, opts.roomType);
    }

    if (stagingMode === "refresh" && scene === "interior") {
      textPrompt += `\n\nREFRESH STAGING MODE (FURNISHED PROPERTIES):\nThis room is already furnished. Do NOT invent a new layout.\n\nRules:\n- Keep all existing major furniture in the same positions and footprint.\n- Do NOT move, rotate, resize, remove, or add major furniture items.\n- Do NOT add wall-dependent furniture in new locations (TV units, dressers, chests of drawers, desks, wardrobes).\n- Only restyle/modernize existing furniture (e.g. fabric, color, wood tone) while preserving placement and scale.\n- You may add ONLY small decorative elements: cushions, throw blanket, rug, plant, simple wall art, small lamp.\n- Never block doors, closet doors, windows, or walkways.\n- Do NOT change camera angle, perspective, framing, or crop to hide conflicts.\n- Do NOT modify or replace fixed fixtures or finishes.\n\nStyle:\n- Aim for a safe, neutral, MLS-appropriate 'furniture refresh.'\n- If uncertain about clearance or what exists out of frame, stage less rather than risk obstruction.`;
    }

    if (isMultiLiving) {
      textPrompt += `\n\nMULTIPLE LIVING AREAS (TWO DISTINCT ZONES):\n- Stage two clear zones (e.g., lounge + dining, or lounge + sitting nook).\n- Keep a clear walkway between doors, kitchen, and primary circulation paths.\n- Use consistent style and palette across both zones; avoid overcrowding.\n- Do not block doorways, windows, or kitchen access.`;
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
      console.log(`[stage2] [PROMPT_ASSEMBLED] stagingStyle=${stagingStyleNorm} len=${combinedPrompt.length}\n${preview}${combinedPrompt.length > 1000 ? '\n...[truncated]' : ''}`);
      console.info("[stage2][PROMPT_ASSEMBLED]", {
        stagingStyle: stagingStyleNorm,
        len: combinedPrompt.length,
        preview: combinedPrompt.slice(0, 400),
      });
    }
    if (dbg) console.log("[stage2] invoking Gemini with roomType=%s", opts.roomType);
    console.log(`[stage2] 🤖 Calling Gemini API for virtual staging... (attempt ${attempt + 1}${strictPrompt ? ' [STRICT]' : ''})`);
    try {
      let ai: any = null;
      ai = getGeminiClient();
      if (!ai) throw new Error("getGeminiClient returned null/undefined");
      const apiStartTime = Date.now();
      let generationConfig: any = useTest ? (profile?.seed !== undefined ? { seed: profile.seed } : undefined) : (profile?.seed !== undefined ? { seed: profile.seed } : undefined);

      // ===== SAMPLING PARAMS FOR THIS ATTEMPT =====
      // On retry attempts, apply progressive sampling backoff from baseline
      if (stageAwareConfig.enabled) {
        // Use applySamplingBackoff to compute reduced params for retries
        currentSamplingParams = applySamplingBackoff(baselineSamplingParams, attempt);

        if (attempt > 0) {
          console.log(`[stage2] Retry ${attempt}: Applying sampling backoff from baseline`);
          console.log(`[stage2]   Baseline: ${formatSamplingParams(baselineSamplingParams)}`);
          console.log(`[stage2]   Reduced:  ${formatSamplingParams(currentSamplingParams)}`);
        }

        // Build generation config from current sampling params
        generationConfig = {
          ...(generationConfig || {}),
          temperature: currentSamplingParams.temperature,
          topP: currentSamplingParams.topP,
          topK: currentSamplingParams.topK,
        };
      } else if (isNZStyleEnabled()) {
        // Legacy behavior when stage-aware is disabled
        const preset = scene === "interior" ? NZ_REAL_ESTATE_PRESETS.stage2Interior : NZ_REAL_ESTATE_PRESETS.stage2Exterior;
        let temperature = preset.temperature;
        if (attempt === 1) temperature = Math.max(0.01, temperature * 0.8);
        generationConfig = { ...(generationConfig || {}), temperature, topP: preset.topP, topK: preset.topK };
        currentSamplingParams = { temperature, topP: preset.topP, topK: preset.topK };
      }
      const modelSelection = resolveStage2Models({
        roomType: opts.roomType,
        stage2Variant: stagingVariant,
        jobId: opts.jobId,
        imageId: opts.imageId,
        multiLivingModelEnv: process.env.GEMINI_STAGE2_MULTI_LIVING_MODEL,
      });

      const primaryOverride = modelSelection.primaryModel;
      const fallbackOverride = modelSelection.fallbackModel;

      const { resp, modelUsed } = await runWithPrimaryThenFallback({
        stageLabel: "2",
        ai: ai as any,
        baseRequest: {
          contents: requestParts,
          generationConfig,
        } as any,
        context: "stage2",
        logCtx: { jobId, imageId: opts.imageId, stage: "2" },
        primaryOverride,
        fallbackOverride,
      });
      const apiElapsed = Date.now() - apiStartTime;
      console.log(`[stage2] ✅ Gemini API responded in ${apiElapsed} ms (model=${modelUsed})`);
      const responseParts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
      console.log(`[stage2] 📊 Response parts: ${responseParts.length}`);
      const img = responseParts.find(p => p.inlineData);
      if (!img?.inlineData?.data) {
        validatorNotes.push({ stage: '2', validator: 'Gemini', error: 'No image data in Gemini response' });
        if (dbg) console.log("[stage2] no image in response → using previous output");
        break;
      }
      let candidatePath = siblingOutPath(out, `-2-retry${attempt + 1}`, ".webp");
      writeImageDataUrl(candidatePath, `data:image/webp;base64,${img.inlineData.data}`);
      out = candidatePath;
      console.log(`[stage2] 💾 Saved staged image to: ${candidatePath}`);

      // Dimension guard: retry once with strict prompt if Gemini drifts dimensions
      let dimContext: ValidateParams["dimContext"] | undefined = undefined;

      if (stageAwareConfig.enabled && stageAwareConfig.blockOnDimensionMismatch) {
        const dimResult = await compareImageDimensions(validationBaseline, candidatePath);
        const deltas = calculateDimensionDelta(dimResult.baseline, dimResult.candidate);
        console.log(
          `[stage2][dim] jobId=${jobId} attempt=${attempt + 1} baseline=${dimResult.baseline.width}x${dimResult.baseline.height} candidate=${dimResult.candidate.width}x${dimResult.candidate.height} ` +
          `deltaW=${(deltas.widthPct * 100).toFixed(2)}% deltaH=${(deltas.heightPct * 100).toFixed(2)}%`
        );

        dimContext = {
          baseline: dimResult.baseline,
          candidateOriginal: dimResult.candidate,
          dw: deltas.widthPct,
          dh: deltas.heightPct,
          maxDelta: Math.max(deltas.widthPct, deltas.heightPct),
          wasNormalized: false,
        };

        if (!dimResult.ok) {
          const tolerancePct = getDimensionTolerancePct();
          const withinTolerance = isWithinDimensionTolerance(dimResult.baseline, dimResult.candidate, tolerancePct);

          if (withinTolerance) {
            const normalization = await normalizeCandidateToBaseline(validationBaseline, candidatePath, { suffix: "-dimnorm" });
            console.log(
              `[stage2][dim-normalize] jobId=${jobId} attempt=${attempt + 1} method=${normalization.method} ` +
              `baseline=${dimResult.baseline.width}x${dimResult.baseline.height} candidate=${dimResult.candidate.width}x${dimResult.candidate.height} ` +
              `normalized=${normalization.normalizedPath} deltaW=${(deltas.widthPct * 100).toFixed(2)}% deltaH=${(deltas.heightPct * 100).toFixed(2)}%`
            );

            if (normalization.ok) {
              out = normalization.normalizedPath;
              candidatePath = normalization.normalizedPath;
              dimContext.wasNormalized = true;
            }
          } else if (stageAwareConfig.maxRetryAttempts > 0) {
            console.warn(
              `[stage2] Dimension mismatch from model output (baseline ${dimResult.baseline.width}x${dimResult.baseline.height}, candidate ${dimResult.candidate.width}x${dimResult.candidate.height}). Retrying once with strict dimension prompt.`
            );

            const strictPrompt = `${textPrompt}\n\n${STRICT_DIMENSION_PROMPT_SUFFIX}`;
            const strictParts = [...requestParts.slice(0, requestParts.length - 1), { text: strictPrompt }];

            try {
              const { resp: strictResp, modelUsed: strictModel } = await runWithPrimaryThenFallback({
                stageLabel: "2",
                ai: ai as any,
                baseRequest: {
                  contents: strictParts,
                  generationConfig,
                } as any,
                context: "stage2-dimension",
                logCtx: { jobId, imageId: opts.imageId, stage: "2" },
              });

              const strictResponseParts: any[] = (strictResp as any).candidates?.[0]?.content?.parts || [];
              const strictImg = strictResponseParts.find(p => p.inlineData);

              if (strictImg?.inlineData?.data) {
                const retryCandidatePath = siblingOutPath(candidatePath, "-dimretry", ".webp");
                writeImageDataUrl(retryCandidatePath, `data:image/webp;base64,${strictImg.inlineData.data}`);
                out = retryCandidatePath;
                candidatePath = retryCandidatePath;

                const retryDim = await compareImageDimensions(validationBaseline, retryCandidatePath);
                const retryDelta = calculateDimensionDelta(retryDim.baseline, retryDim.candidate);
                console.log(
                  `[stage2][dim] retry jobId=${jobId} attempt=${attempt + 1} baseline=${retryDim.baseline.width}x${retryDim.baseline.height} candidate=${retryDim.candidate.width}x${retryDim.candidate.height} ` +
                  `deltaW=${(retryDelta.widthPct * 100).toFixed(2)}% deltaH=${(retryDelta.heightPct * 100).toFixed(2)}%`
                );

                if (!retryDim.ok) {
                  console.error(`[stage2] ❌ Dimension mismatch persisted after strict retry (jobId=${jobId})`);
                  if (validationMode === "block") {
                    return null;
                  }
                } else {
                  console.log(`[stage2] ✅ Dimension retry succeeded; continuing to validation.`);
                  const retryDelta = calculateDimensionDelta(retryDim.baseline, retryDim.candidate);
                  dimContext = {
                    baseline: retryDim.baseline,
                    candidateOriginal: retryDim.candidate,
                    dw: retryDelta.widthPct,
                    dh: retryDelta.heightPct,
                    maxDelta: Math.max(retryDelta.widthPct, retryDelta.heightPct),
                    wasNormalized: true,
                  };
                }
              } else {
                console.warn(`[stage2] ⚠️ Strict dimension retry returned no image data`);
              }
            } catch (dimRetryErr) {
              console.error(`[stage2] Dimension retry failed:`, dimRetryErr);
            }
          } else {
            console.warn(
              `[stage2] Dimension mismatch detected but STRUCT_VALIDATION_MAX_RETRY_ATTEMPTS=0; validator will handle block in ${validationMode} mode.`
            );
          }
        }
      }

      // Run validators after Stage 2
      let validatorFailed = false;

      if (stageAwareConfig.enabled) {
        // ===== STAGE-AWARE VALIDATION (Feature-flagged) =====
        // CRITICAL: Use Stage1A output as baseline, NOT original
        try {
          // Determine validation mode from env var (STRUCTURE_VALIDATOR_MODE)
          const validationMode = shouldValidatorBlock("structure") ? "block" : "log";

          // Structured baseline log for monitoring
          console.log(
            `[STRUCT_BASELINE] stage=2 jobId=${jobId} baseline=${validationBaseline} candidate=${out} ` +
            `baselineStage=${baselineStage} mode=${validationMode}`
          );

          const validationResult = await validateStructureStageAware({
            stage: "stage2",
            baselinePath: validationBaseline, // Stage1A output
            candidatePath: out, // Stage2 output
            mode: validationMode, // Controlled by STRUCTURE_VALIDATOR_MODE env var
            jobId,
            imageId: opts.imageId,
            sceneType: opts.sceneType || "interior",
            roomType: opts.roomType,
            retryAttempt: attempt,
            config: stageAwareConfig,
            dimContext,
          });

          validatorNotes.push({ stage: '2', validator: 'StageAware', result: validationResult });
          lastValidatorResults['2'] = validationResult;

          if (validationResult.risk) {
            validatorFailed = true;
            const hasFatalTrigger = validationResult.triggers.some(t => t.fatal);
            const fatalIds = validationResult.triggers.filter(t => t.fatal).map(t => t.id);
            const nonFatalIds = validationResult.triggers.filter(t => !t.fatal).map(t => t.id);

            // Use retry manager to decide if we should retry
            const retryDecision = shouldRetryStage(jobId, "stage2", validationResult);
            const willRetry = retryDecision.shouldRetry;

            // ===== STRUCTURED FAILURE LOG (single line for monitoring) =====
            console.log(
              `[STRUCT_FAIL] stage=2 mode=${validationMode} attempt=${attempt + 1}/${maxAttempts} willRetry=${willRetry} ` +
              `${formatSamplingParams(currentSamplingParams)} ` +
              `fatal=[${fatalIds.join(",")}] triggers=[${nonFatalIds.join(",")}] jobId=${jobId}`
            );

            // Detailed trigger log
            console.warn(`[stage2] Stage-aware validation detected risk (${validationResult.triggers.length} triggers, fatal=${hasFatalTrigger})`);
            validationResult.triggers.forEach((t, i) => {
              console.warn(`[stage2]   ${i + 1}. ${t.id}${t.fatal ? " [FATAL]" : ""}: ${t.message}`);
            });

            // ===== RETRY LOGIC (both fatal and non-fatal triggers allow retries) =====
            if (willRetry) {
              currentTightenLevel = retryDecision.tightenLevel;
              needsRetry = true;
              retryCount++;
              console.log(`[stage2] ${retryDecision.reason}`);

              if (opts.onStrictRetry) {
                opts.onStrictRetry({ reasons: validationResult.triggers.map(t => t.message) });
              }

              if (retryDecision.isFinalAttempt) {
                console.warn(`[stage2] ⚠️ This is the FINAL retry attempt`);
              }
              continue;
            } else {
              // Max retries reached - only NOW do we reject in block mode
              if (retryDecision.reason.includes("Max attempts")) {
                markStageFailed(jobId, "stage2", validationResult.triggers);
                console.error(`[stage2] ❌ FAILED_FINAL: Stage 2 failed after ${stageAwareConfig.maxRetryAttempts} retries`);

                // In block mode, return null ONLY after all retries exhausted
                if (validationMode === "block") {
                  console.error(`[stage2] ❌ BLOCKED: Max retries reached in block mode - rejecting image`);
                  return null;
                }
              }
              break;
            }
          } else {
            console.log(`[stage2] ✅ Stage-aware validation passed (risk=false)`);
            break;
          }
        } catch (e) {
          console.error(`[stage2] Stage-aware validation error:`, e);
          validatorNotes.push({ stage: '2', validator: 'StageAware', error: String(e) });
          // On error, don't retry - just continue with the output
          break;
        }
      } else {
        // ===== LEGACY VALIDATION (OpenCV) =====
        try {
          const stagedBuffer = await sharp(out).toBuffer();
          const result2 = await runOpenCVStructuralValidator(stagedBuffer, { strict: !!process.env.STRICT_STRUCTURE_VALIDATION });
          validatorNotes.push({ stage: '2', validator: 'OpenCV', result: result2 });
          lastValidatorResults['2'] = result2;
          if (!result2.ok) validatorFailed = true;
        } catch (e) {
          validatorNotes.push({ stage: '2', validator: 'OpenCV', error: String(e) });
          lastValidatorResults['2'] = { ok: false, error: String(e) };
          validatorFailed = true;
        }

        if (validatorFailed && attempt === 0) {
          needsRetry = true;
          retryCount++;
          console.log(`[stage2] Validator requested retry (single retry)`);
          continue;
        } else {
          break;
        }
      }
    } catch (e: any) {
      validatorNotes.push({ stage: '2', validator: 'Gemini', error: String(e) });
      lastValidatorResults['2'] = { ok: false, error: String(e) };
      console.error("[stage2] ❌ Gemini API error:", e?.message || String(e));
      break;
    }
  }
  // After retry, always return the last output and notes
  return out;
}
