import { getGeminiClient } from "../ai/gemini";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";
import type { StagingProfile } from "../utils/groups";
import { validateStage } from "../ai/unified-validator";
import { validateStage2Structural } from "../validators/stage2StructuralValidator";
import { runOpenCVStructuralValidator } from "../validators/index";
import { buildStage2PromptNZStyle } from "../ai/prompts.nzRealEstate";
import { normalizeStagingStyle, STYLE_PROMPT_MODIFIERS } from "../ai/stagingStyles";
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
import { formatStage2LayoutPlanForPrompt, type Stage2LayoutPlan } from "./layoutPlanner";
import { buildStructuralRetryInjection, type StructuralFailureType } from "./structuralRetryHelpers";
import { logImageAttemptUrl } from "../utils/debugImageUrls";
import { MODEL_CONFIG, runWithPrimaryThenFallback } from "../ai/runWithImageModelFallback";

const logger = console;

type Stage2RetryReason = "initial" | "structural_violation" | "opening_removed" | "cosmetic" | "unknown";

type Stage2GenerationPlan = {
  model: string;
  temperature: number;
  topP: number;
  topK: number;
  escalated: boolean;
};

export type StructuralReviewProResult = {
  result: "PASS" | "FAIL";
  confidence: number;
  explanation: string;
};

export const STRUCTURAL_IDENTITY_REVIEW_PROMPT = `ROLE
You are an architectural comparison inspector reviewing two photographs of an interior room.

The staged image must clearly represent the same physical room as the baseline image.

Minor differences in camera position, perspective,
or cropping are acceptable if the architectural
structure remains the same.

TASK
Determine whether Image B still represents the same physical room as Image A.

The staged image may contain new furniture, lighting, or decor.
These changes are allowed and should be ignored.

Your task is ONLY to evaluate whether the underlying room architecture is the same.

GLOBAL RULE
The staged image must represent the exact same physical room architecture as the baseline image.
Furniture, decor, and movable staging objects may change.
Architectural structure may NOT change.

ARCHITECTURAL ELEMENTS TO COMPARE

Evaluate whether the following elements remain consistent between the two images:

* wall positions and angles
* room proportions and depth
* window count and window placement
* door count and door placement
* closet door count, closet opening visibility, and closet opening placement
* openings between spaces
* ceiling geometry and height
* major architectural structures (columns, beams, half-walls)
* built-ins (built-in cabinetry, kitchen islands, fireplaces, wall shelving, recessed wall units)
* camera viewpoint and perspective

Treat windows, doors, sliding doors, closet doors, archways, balcony openings, and hallway openings as architectural openings that must be preserved.

Wall Plane Invariant

The set of wall planes defining the room envelope must
remain identical.

If the staged image introduces any new flat wall plane
that did not exist in the baseline image, the review
must fail.

This includes:

* extended walls
* filled recesses
* flattened wall indentations
* new planar surfaces attached to existing walls

Opening Preservation Invariant

Every architectural opening present in the baseline
image must remain visible in the staged image.

Openings include:

* doors
* closet doors
* sliding doors
* hallway openings
* windows
* archways
* balcony doors

If any baseline opening disappears, is sealed,
is replaced by continuous wall surface, or cannot
be visually located, the staged image must fail.

OPENING SIZE INVARIANT

Architectural openings must preserve their size.

Fail the review if the staged image shows:

* windows significantly smaller than the baseline
* doors narrower than the baseline
* openings partially filled with wall surface
* window geometry altered to accommodate furniture

Furniture placement must never modify
the structural dimensions of windows or doors.

PARTIALLY VISIBLE OPENINGS

If an opening is only partially visible in the baseline image,
the visible portion of that opening must remain identical
in the staged image.

The validator must not assume the unseen portion
extends beyond the camera frame.

If the visible opening boundary shrinks or disappears,
the opening has been structurally modified.

Return ok=false.

ACCEPTABLE DIFFERENCES

Ignore differences in:

* furniture
* decorations
* lighting fixtures added for staging
* rugs, curtains, artwork, plants
* color grading or brightness
* minor perspective normalization

Perspective or cropping differences are acceptable ONLY if architectural invariants are preserved.

Occlusion clarification:
Furniture or decor may partially block windows or doors.
This is acceptable if the architectural opening still clearly exists in the wall.
Do not treat furniture occlusion as structural removal.

UNACCEPTABLE DIFFERENCES

Fail the review if any of the following appear:

* walls moved, extended, or removed
* room size or shape changed
* windows moved, resized, removed, added, sealed, blocked, or infilled
* doors moved, resized, removed, or added
* closet doors/openings removed, added, resized, sealed, blocked, infilled, or replaced by flat wall
* any architectural opening disappears, is relocated, or is replaced by continuous wall surface
* built-ins moved, resized, removed, or added
* new architectural openings created
* camera viewpoint shifted significantly
* the room appears to be a different physical space

MANDATORY REJECTION RULE
If any architectural invariant is violated (walls, openings, or built-ins), Image B must be rejected (FAIL).
Do not allow perspective/cropping as an excuse for lost/added/resized/relocated openings.

DECISION RULE

Ask yourself:

"Would a reasonable property buyer clearly recognize this as the same room with identical architecture?"

If YES -> PASS
If NO -> FAIL

OUTPUT FORMAT

Return JSON only.

{
  "result": "PASS" | "FAIL",
  "confidence": 0-100,
  "explanation": "short explanation of the decision"
}`;

export async function runGeminiStructuralReviewPro(
  originalImagePath: string,
  stagedImagePath: string
): Promise<StructuralReviewProResult> {
  const ai = getGeminiClient();
  const original = toBase64(originalImagePath);
  const staged = toBase64(stagedImagePath);

  const response = await (ai as any).models.generateContent({
    model: "gemini-2.5-pro",
    contents: [
      {
        role: "user",
        parts: [
          { text: STRUCTURAL_IDENTITY_REVIEW_PROMPT },
          { text: "Image A (original uploaded room):" },
          { inlineData: { mimeType: original.mime, data: original.data } },
          { text: "Image B (staged output):" },
          { inlineData: { mimeType: staged.mime, data: staged.data } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  });

  const text = String(response?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
  const cleaned = text.replace(/```json|```/gi, "").trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned;

  let parsed: any = null;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return {
      result: "FAIL",
      confidence: 0,
      explanation: "invalid_json_from_structural_review",
    };
  }

  const rawResult = String(parsed?.result || "").toUpperCase();
  const result: "PASS" | "FAIL" = rawResult === "PASS" ? "PASS" : "FAIL";
  const confidenceRaw = Number(parsed?.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(100, confidenceRaw))
    : 0;
  const explanation = typeof parsed?.explanation === "string" && parsed.explanation.trim().length > 0
    ? parsed.explanation.trim()
    : "no_explanation";

  return { result, confidence, explanation };
}

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
    layoutPlan?: Stage2LayoutPlan | null;
    modelReason?: string;
    structuralRetryContext?: {
      compositeFail: boolean;
      failureType: StructuralFailureType | null;
      attemptNumber: number;
    };
    structuralConstraintBlock?: string;
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
  let stagingMaskBuffer: Buffer | null = null;
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
      // Build a strict binary mask (white inside region, transparent outside)
      try {
        const whiteRect = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
        const maskBuf = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
          .composite([{ input: whiteRect, left: x, top: y }])
          .png()
          .toBuffer();
        stagingMaskBuffer = maskBuf;
        const maskPath = siblingOutPath(basePath, "-staging-mask", ".png");
        await sharp(maskBuf).toFile(maskPath);
        await logImageAttemptUrl({ stage: "2", attempt: Math.max(1, opts.attempt ?? 1), jobId: opts.jobId, localPath: maskPath });
        focusLog("STAGE2_MASK", "[stage2] Built explicit staging mask", { jobId: opts.jobId, width: W, height: H, x, y, w, h });
      } catch (e) {
        focusLog("STAGE2_MASK", "[stage2] Failed to build explicit staging mask; continuing without it", { error: String(e), jobId: opts.jobId });
        stagingMaskBuffer = null;
      }
      inputForStage2 = guidedPath;
    } catch (e) {
      focusLog("TEMP_FILE", "[stage2] Failed to build guided staging input; proceeding with original base image", e);
    }
  }

  const scene = opts.sceneType || "interior";
  const { data, mime } = toBase64(inputForStage2);
  const useTest = process.env.USE_TEST_PROMPTS === "1";
  const selectedStyleRaw = normalizeStagingStyle(opts.stagingStyle);
  const selectedStyle = ["nz_standard", "standard_listing", "standard", "default"].includes(selectedStyleRaw)
    ? "nz_standard"
    : selectedStyleRaw;

  let textPrompt = useTest
    ? require("../ai/prompts-test").buildTestStage2Prompt(scene, normalizedRoomType)
    : buildStage2PromptNZStyle(normalizedRoomType, scene, {
        stagingStyle: selectedStyle,
        sourceStage: opts.sourceStage,
        mode: resolvedPromptMode,
        layoutContext: opts.layoutContext || undefined,
      });

  // If we have a staging region, strongly insist edits are limited to the provided mask.
  if (opts.stagingRegion) {
    textPrompt = `ONLY EDIT INSIDE MASK: An explicit mask image is supplied as a separate part. You MUST only modify pixels inside the mask region. Do NOT alter any pixels, architecture, openings, windows, doors, floors, or lighting outside the provided mask. If the mask is empty, return the input image unchanged.` + "\n\n" + textPrompt;
  }

  const styleModifier = selectedStyle === "nz_standard" ? undefined : STYLE_PROMPT_MODIFIERS[selectedStyle];
  if (styleModifier) {
    textPrompt += "\n\nSTYLE CONTEXT:\n" + styleModifier;
  }

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

  if (opts.layoutPlan) {
    textPrompt += `

Use the following furniture placement plan exactly.
Do not place furniture outside the defined zones.

${formatStage2LayoutPlanForPrompt(opts.layoutPlan)}
`;
  }

  const attemptNumber = Math.max(1, opts.attempt ?? 1);
  const retryReason: Stage2RetryReason = attemptNumber > 1
    ? (structuralRetryContext
        ? mapStructuralFailureTypeToRetryReason(structuralRetryContext.failureType)
        : "unknown")
    : "initial";

  const generationPlan = resolveStage2GenerationPlanForAttempt(attemptNumber, retryReason);

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

  const requestParts: any[] = [];
  // Preferred ordering: text prompt first, then base image(s), then explicit mask (if available)
  requestParts.push({ text: textPrompt });
  requestParts.push({ inlineData: { mimeType: mime, data } });
  if (opts.referenceImagePath) {
    const ref = toBase64(opts.referenceImagePath);
    requestParts.push({ inlineData: { mimeType: ref.mime, data: ref.data } });
  }
  if (stagingMaskBuffer) {
    try {
      const maskB64 = stagingMaskBuffer.toString("base64");
      requestParts.push({ inlineData: { mimeType: "image/png", data: maskB64 } });
    } catch (e) {
      focusLog("STAGE2_MASK", "[stage2] Failed to attach mask to requestParts", { error: String(e), jobId: opts.jobId });
    }
  }

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
    layoutPlan?: Stage2LayoutPlan | null;
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
    layoutPlan: opts.layoutPlan,
    modelReason: "stage2_initial_generation",
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
