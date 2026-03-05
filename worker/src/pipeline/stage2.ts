import { getGeminiClient } from "../ai/gemini";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";
import type { StagingProfile } from "../utils/groups";
import { validateStage } from "../ai/unified-validator";
import { validateStage2Structural } from "../validators/stage2StructuralValidator";
import { runOpenCVStructuralValidator } from "../validators/index";
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
import { buildTightenedPrompt, getTightenLevelFromAttempt, logTighteningInfo, TightenLevel } from "../ai/promptTightening";
import type { Mode } from "../validators/validationModes";
import { focusLog } from "../utils/logFocus";
import { buildLayoutContext, type LayoutContextResult } from "../ai/layoutPlanner";
import { buildStructuralRetryInjection, type StructuralFailureType } from "./structuralRetryHelpers";
import { logImageAttemptUrl } from "../utils/debugImageUrls";
import { MODEL_CONFIG, runWithPrimaryThenFallback } from "../ai/runWithImageModelFallback";
import type { Opening } from "../vision/detectOpenings";

const logger = console;
const OPENING_ANCHORING_ENABLED = String(process.env.REALENHANCE_OPENING_ANCHORING || "off").toLowerCase() === "on";

function buildOpeningAnchoringPrompt(openings: Opening[], attempt: number): string {
  const retryTier = attempt >= 3 ? 2 : 1;
  const openingSummary = openings
    .slice(0, 6)
    .map((o, idx) => `${idx + 1}. ${o.type} cx=${o.cx.toFixed(2)} cy=${o.cy.toFixed(2)} w=${o.width.toFixed(2)} h=${o.height.toFixed(2)}`)
    .join("\n");

  const guidance = retryTier === 1
    ? `Architectural openings detected in the room.

These windows and doors must remain in the same position
and approximately the same size relative to the walls.

Do not move, resize, remove, or invent openings.

Furniture and decor must adapt to the existing architecture.`
    : `Important architectural constraint:

Windows and doors must remain fixed in their original
position and size relative to the walls.

Do not shift or resize openings to make room for furniture.
Furniture placement must adapt to the architecture.`;

  return [
    "ARCHITECTURAL OPENING BASELINE:",
    openingSummary || "No opening geometry available.",
    "",
    guidance,
  ].join("\n");
}

type Stage2RetryReason = "initial" | "structural_violation" | "opening_removed" | "cosmetic" | "unknown";

type Stage2GenerationPlan = {
  model: string;
  temperature: number;
  topP: number;
  topK: number;
  escalated: boolean;
};

function isStructuralRetryReason(reason: Stage2RetryReason): boolean {
  return reason === "structural_violation" || reason === "opening_removed";
}

function ensureImageCapableModel(model: string | undefined, fallback: string): string {
  const candidate = String(model || "").trim();
  if (candidate && candidate.toLowerCase().includes("image")) {
    return candidate;
  }
  return fallback;
}

export function resolveStage2Model(attempt: number, reason: Stage2RetryReason, previousModel?: string): string {
  const primary = ensureImageCapableModel(
    process.env.REALENHANCE_MODEL_STAGE2_PRIMARY || MODEL_CONFIG.stage2.primary,
    "gemini-2.5-flash-image"
  );
  const fallback = ensureImageCapableModel(
    process.env.REALENHANCE_MODEL_STAGE2_FALLBACK || MODEL_CONFIG.stage2.fallback || "gemini-2.5-pro-image",
    "gemini-2.5-pro-image"
  );
  if (attempt <= 1) return primary;
  if (!isStructuralRetryReason(reason)) return previousModel || primary;
  return fallback;
}

function resolveStage2Temperature(attempt: number, reason: Stage2RetryReason, previousTemperature?: number): number {
  if (attempt <= 1) return 0.40;
  if (!isStructuralRetryReason(reason)) return previousTemperature ?? 0.40;
  if (attempt === 2) return 0.35;
  return 0.30;
}

function resolveStage2GenerationPlan(opts: {
  attempt: number;
  retryReason: Stage2RetryReason;
  previousPlan?: Stage2GenerationPlan | null;
}): Stage2GenerationPlan {
  const model = resolveStage2Model(opts.attempt, opts.retryReason, opts.previousPlan?.model);
  const temperature = resolveStage2Temperature(opts.attempt, opts.retryReason, opts.previousPlan?.temperature);
  const escalated = !!opts.previousPlan && model !== opts.previousPlan.model;
  return {
    model,
    temperature,
    topP: 0.90,
    topK: 40,
    escalated,
  };
}

function resolveStage2GenerationPlanForAttempt(attempt: number, retryReason: Stage2RetryReason): Stage2GenerationPlan {
  let plan: Stage2GenerationPlan | null = null;
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  for (let idx = 1; idx <= normalizedAttempt; idx += 1) {
    plan = resolveStage2GenerationPlan({
      attempt: idx,
      retryReason: idx === 1 ? "initial" : retryReason,
      previousPlan: plan,
    });
  }
  return plan as Stage2GenerationPlan;
}

function mapStructuralFailureTypeToRetryReason(failureType: StructuralFailureType | null): Stage2RetryReason {
  if (!failureType) return "unknown";
  if (failureType === "opening_removed" || failureType === "opening_infilled" || failureType === "opening_relocated") {
    return "opening_removed";
  }
  return "structural_violation";
}

function deriveRetryReasonFromSignals(signals: string[]): Stage2RetryReason {
  const blob = (signals || []).join(" ").toLowerCase();
  if (!blob.trim()) return "unknown";

  if (/(opening_removed|opening removed|opening_infilled|opening infilled|door|window|closet|walk[\s_-]?through|opening)/i.test(blob)) {
    return "opening_removed";
  }

  if (/(lighting|style|styling|decor|furniture|layout preference|color mismatch|brightness)/i.test(blob)) {
    return "cosmetic";
  }

  if (/(structural|structure|wall|iou|mask|invariant|topology|drift|distortion|orientation|opencv)/i.test(blob)) {
    return "structural_violation";
  }

  return "unknown";
}

// Stage 2: virtual staging (add furnitur)

export type Stage2Result = {
  outputPath: string;
  attempts: number;
  maxAttempts: number;
  validationRisk: boolean;
  fallbackUsed: boolean;
  localReasons: string[];
};

export class Stage2GenerationFailure extends Error {
  public readonly retryable: boolean;
  public readonly code: string;

  constructor(message: string, code = "stage2_generation_failure", retryable = true) {
    super(message);
    this.name = "Stage2GenerationFailure";
    this.retryable = retryable;
    this.code = code;
  }
}

export class Stage2GenerationNoImageError extends Stage2GenerationFailure {
  constructor(message = "No image data in Gemini response") {
    super(message, "stage2_generation_no_image", true);
    this.name = "Stage2GenerationNoImageError";
  }
}

export function isStage2RetryableGenerationError(error: unknown): boolean {
  return error instanceof Stage2GenerationFailure && error.retryable;
}

function summarizeResponsePartTypes(parts: any[]): string {
  if (!Array.isArray(parts) || parts.length === 0) return "none";
  return parts
    .map((part: any) => {
      if (!part || typeof part !== "object") return "unknown";
      if (part.inlineData) return "inlineData";
      if (part.text) return "text";
      if (part.functionCall) return "functionCall";
      if (part.functionResponse) return "functionResponse";
      return Object.keys(part)[0] || "unknown";
    })
    .join(",");
}

function getStage2ConfiguredMaxAttempts(): number {
  const stageAwareConfig = loadStageAwareConfig();
  const geminiMaxRetriesRaw = Number(process.env.GEMINI_MAX_RETRIES);
  const geminiMaxRetries = Number.isFinite(geminiMaxRetriesRaw) ? Math.max(0, Math.floor(geminiMaxRetriesRaw)) : null;
  const configuredAttempts = geminiMaxRetries !== null
    ? Math.max(1, geminiMaxRetries + 1)
    : (stageAwareConfig.enabled ? stageAwareConfig.maxRetryAttempts + 1 : 2);
  const maxInternalAttemptsRaw = Number(process.env.STAGE2_INTERNAL_MAX_ATTEMPTS || 3);
  const maxInternalAttempts = Number.isFinite(maxInternalAttemptsRaw)
    ? Math.min(4, Math.max(1, Math.floor(maxInternalAttemptsRaw)))
    : 3;
  return Math.min(configuredAttempts, maxInternalAttempts);
}

export function resolveStage2MaxAttempts(): number {
  return getStage2ConfiguredMaxAttempts();
}

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
    attempt?: number;
    maxOutputTokens?: number;
    tightenLevel?: TightenLevel;
    legacyStrictPrompt?: boolean;
    layoutContext?: LayoutContextResult | null;
    modelReason?: string;
    structuralRetryContext?: {
      compositeFail: boolean;
      failureType: StructuralFailureType | null;
      attemptNumber: number;
    };
    structuralConstraintBlock?: string;
    openingBaseline?: Opening[];
    bedroomWindowBedConflictHint?: boolean;
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
      await logImageAttemptUrl({
        stage: "2",
        attempt: Math.max(1, opts.attempt ?? 1),
        jobId: opts.jobId,
        localPath: guidedPath,
      });
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

  if (opts.structuralConstraintBlock && opts.structuralConstraintBlock.trim().length > 0) {
    textPrompt = `${textPrompt}\n\n${opts.structuralConstraintBlock}`;
  }

  const attemptNumber = Math.max(1, opts.attempt ?? 1);
  const retryReason: Stage2RetryReason = attemptNumber > 1
    ? (structuralRetryContext
        ? mapStructuralFailureTypeToRetryReason(structuralRetryContext.failureType)
        : "unknown")
    : "initial";

  const generationPlan = resolveStage2GenerationPlanForAttempt(attemptNumber, retryReason);

  if (OPENING_ANCHORING_ENABLED && attemptNumber > 1 && Array.isArray(opts.openingBaseline) && opts.openingBaseline.length > 0) {
    const anchoringBlock = buildOpeningAnchoringPrompt(opts.openingBaseline, attemptNumber);
    textPrompt = `${textPrompt}\n\n${anchoringBlock}`;
    logger.info(`[ANCHORING_INJECTED] job=${opts.jobId} attempt=${attemptNumber} openings=${opts.openingBaseline.length}`);

    if (opts.bedroomWindowBedConflictHint) {
      textPrompt += `\n\nBeds placed under windows must not block or alter the window.

Maintain the original window size and position.
Furniture placement must adapt to the existing window.`;
    }
  }

  if (attemptNumber >= 3) {
    textPrompt += `

The previous attempt removed or altered an architectural opening.

Ensure all windows, doors, closet doors, wardrobe doors, and walk-through openings remain visible and structurally intact.

Do NOT place furniture, walls, mirrors, artwork, or cabinets over these openings.
`;
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

  logger.info(`[STAGE2_MODEL_ESCALATION] job_id=${opts.jobId} attempt=${attemptNumber} model=${generationPlan.model} temperature=${generationPlan.temperature} retry_reason=${retryReason}`);
  const generationConfig: any = {
    temperature: generationPlan.temperature,
    topP: generationPlan.topP,
    topK: generationPlan.topK,
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(opts.profile?.seed !== undefined ? { seed: opts.profile.seed } : {}),
  };

  const ai = getGeminiClient();
  let resp: any;
  let modelUsed = generationPlan.model;
  try {
    const run = await runWithPrimaryThenFallback({
      stageLabel: "2",
      ai: ai as any,
      baseRequest: {
        contents: requestParts,
        generationConfig,
      } as any,
      context: "stage2_generation_attempt",
      meta: {
        stage: "2",
        jobId: opts.jobId,
        roomType: opts.roomType,
        reason: opts.modelReason || `stage2_attempt_${attemptNumber}_${retryReason}`,
        attempt: attemptNumber,
      },
    });
    resp = run.resp;
    modelUsed = run.modelUsed;
  } catch (error: any) {
    const message = String(error?.message || error || "unknown_error");
    if (/no inline image data|no image data in gemini response/i.test(message)) {
      throw new Stage2GenerationNoImageError(message);
    }
    throw new Stage2GenerationFailure(`[stage2] generation failed: ${message}`);
  }

  const responseParts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
  const img = responseParts.find((p) => p.inlineData);
  if (!img?.inlineData?.data) {
    const inlineDataPresent = responseParts.some((part: any) => !!part?.inlineData?.data);
    console.warn(
      `[stage2_generation_no_image] model=${modelUsed} attempt=${attemptNumber} response_parts=${summarizeResponsePartTypes(
        responseParts
      )} inlineData_present=${inlineDataPresent}`
    );
    throw new Stage2GenerationNoImageError();
  }

  if (path.resolve(opts.outputPath) === path.resolve(basePath)) {
    throw new Stage2GenerationFailure("stage2_candidate_collapse: candidate_path_equals_baseline", "stage2_candidate_collapse");
  }

  writeImageDataUrl(opts.outputPath, `data:image/webp;base64,${img.inlineData.data}`);
  try {
    await fs.access(opts.outputPath);
  } catch {
    throw new Stage2GenerationFailure("stage2_candidate_collapse: candidate_file_missing", "stage2_candidate_collapse");
  }

  await logImageAttemptUrl({
    stage: "2",
    attempt: attemptNumber,
    jobId: opts.jobId,
    localPath: opts.outputPath,
  });
  logger.info(`[STAGE2_OUTPUT_PATH] job_id=${opts.jobId} attempt=${attemptNumber} path=${opts.outputPath}`);
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
    promptMode?: "full" | "refresh";
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
    openingBaseline?: Opening[];
    bedroomWindowBedConflictHint?: boolean;
  }
): Promise<Stage2Result> {
  const validationBaseline = opts.stage1APath || basePath;

  if (process.env.USE_GEMINI_STAGE2 !== "1") {
    return { outputPath: basePath, attempts: 0, maxAttempts: 0, validationRisk: false, fallbackUsed: false, localReasons: [] };
  }

  if (!(process.env.GEMINI_API_KEY || process.env.REALENHANCE_API_KEY)) {
    return { outputPath: basePath, attempts: 0, maxAttempts: 0, validationRisk: false, fallbackUsed: false, localReasons: [] };
  }

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

  let layoutContext: LayoutContextResult | null = null;
  const layoutPlannerEnabled = process.env.USE_GEMINI_LAYOUT_PLANNER === "1";
  const isFullStaging = resolvedPromptMode === "full";
  if (isFullStaging && layoutPlannerEnabled) {
    try {
      layoutContext = await buildLayoutContext(basePath);
    } catch (error: any) {
      focusLog("LAYOUT_PLANNER", "[stage2] Layout planner failed - continuing without layout context", {
        error: error?.message || String(error),
      });
    }
  }

  const outputPath = siblingOutPath(basePath, "-2", ".webp");
  const generatedPath = await runStage2GenerationAttempt(basePath, {
    roomType: opts.roomType,
    sceneType: opts.sceneType,
    profile: opts.profile,
    referenceImagePath: opts.referenceImagePath,
    stagingRegion: opts.stagingRegion,
    stagingStyle: opts.stagingStyle,
    sourceStage: opts.sourceStage,
    promptMode: resolvedPromptMode,
    curtainRailLikely: opts.curtainRailLikely,
    jobId: opts.jobId,
    outputPath,
    attempt: 1,
    layoutContext,
    modelReason: "stage2_initial_generation",
    openingBaseline: opts.openingBaseline,
    bedroomWindowBedConflictHint: opts.bedroomWindowBedConflictHint,
  });

  if (path.resolve(generatedPath) === path.resolve(validationBaseline)) {
    throw new Stage2GenerationFailure(
      "stage2_candidate_collapse: candidate_equals_validation_baseline",
      "stage2_candidate_collapse"
    );
  }

  return {
    outputPath: generatedPath,
    attempts: 1,
    maxAttempts: resolveStage2MaxAttempts(),
    validationRisk: false,
    fallbackUsed: false,
    localReasons: [],
  };
}
