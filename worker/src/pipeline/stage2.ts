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
import { nLog } from "../logger";
import { buildLayoutContext, type LayoutContextResult } from "../ai/layoutPlanner";
import { formatStage2LayoutPlanForPrompt, type Stage2LayoutPlan } from "./layoutPlanner";
import { buildStructuralRetryInjection, type StructuralFailureType } from "./structuralRetryHelpers";
import { logImageAttemptUrl } from "../utils/debugImageUrls";
import { logEvent as logPipelineEvent, logGeminiUsage } from "../ai/usageTelemetry";
import { runWithSelectedImageModel } from "../ai/runWithImageModelFallback";
import { resolveStage2ImageModel } from "../ai/modelResolver";

const logger = console;

type Stage2RetryReason = "initial" | "structural_violation" | "opening_removed" | "cosmetic" | "unknown";
type Stage2ModeOverride = "REFRESH" | "FROM_EMPTY";

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
  stagedImagePath: string,
  options?: { jobId?: string; imageId?: string; attempt?: number }
): Promise<StructuralReviewProResult> {
  const ai = getGeminiClient();
  const original = toBase64(originalImagePath);
  const staged = toBase64(stagedImagePath);

  const requestStartedAt = Date.now();
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
  logGeminiUsage({
    ctx: {
      jobId: options?.jobId || "",
      imageId: options?.imageId || "",
      stage: "validator",
      attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) : 1,
    },
    model: "gemini-2.5-pro",
    callType: "validator",
    response,
    latencyMs: Date.now() - requestStartedAt,
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
  if (!candidate) {
    return fallback;
  }
  if (candidate.toLowerCase().includes("-image")) {
    return candidate;
  }
  throw new Error(`[MODEL_CONFIG_INVALID] stage=stage2 value=${candidate} reason=non_image_model`);
}

export function resolveStage2Model(attempt: number, reason: Stage2RetryReason, previousModel?: string): string {
  void reason;
  void previousModel;
  const resolved = resolveStage2ImageModel(attempt);
  return ensureImageCapableModel(resolved, "gemini-2.5-flash-image");
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

function buildNanoRoomProgramGuidance(opts: {
  roomType: string;
  stagingStyle: string;
}): string {
  const room = String(opts.roomType || "").toLowerCase().trim();
  const style = String(opts.stagingStyle || "standard_listing").toLowerCase().trim();

  let anchorGuidance = "Primary anchor: choose one clear, room-appropriate anchor and build the rest of the layout around it.";
  let roomRules: string[] = [];
  let itemBudget = "Furniture budget: max 3 major furniture pieces. Decor budget: max 3 small decor accents total.";

  switch (room) {
    case "living_room":
    case "living":
      anchorGuidance =
        "Primary anchor (MANDATORY): a freestanding, non-permanent media console/TV unit on the TV wall. It must sit in front of the wall and must not be integrated into the wall or built-in cabinetry. Build all living seating and secondary furniture around this TV/media anchor.";
      roomRules = [
        "Include a realistic freestanding TV unit/media console as the focal anchor.",
        "Arrange sofa/chairs to support TV viewing and natural circulation.",
        "Do not stage this as a dining room or bedroom.",
      ];
      itemBudget = "Furniture budget: max 4 major furniture pieces. Decor budget: max 3 small decor accents total.";
      break;
    case "bedroom":
      anchorGuidance =
        "Primary anchor (MANDATORY): bed placement as the dominant focal object.";
      roomRules = [
        "Include a realistic bed at correct scale.",
        "Use supporting bedside furniture proportionally.",
      ];
      itemBudget = "Furniture budget: max 3 major furniture pieces (bed + up to 2 supporting pieces). Decor budget: max 2 small decor accents total.";
      break;
    case "dining":
    case "dining_room":
      anchorGuidance =
        "Primary anchor (MANDATORY): dining table with chairs as the dominant focal object.";
      roomRules = [
        "Dining table and chairs must be present and to-scale.",
        "Do not convert to a lounge-first layout.",
      ];
      itemBudget = "Furniture budget: max 3 major furniture pieces. Decor budget: max 2 small decor accents total.";
      break;
    case "office":
      anchorGuidance =
        "Primary anchor (MANDATORY): desk and office chair as the dominant focal object.";
      roomRules = [
        "Keep layout functional for work use.",
      ];
      itemBudget = "Furniture budget: max 3 major furniture pieces. Decor budget: max 2 small decor accents total.";
      break;
    case "kitchen":
      anchorGuidance =
        "Primary anchor: existing kitchen context (cabinets/counters) must remain visually dominant; add only compatible, minimal movable staging.";
      roomRules = [
        "Do NOT add a dining table when room type is kitchen.",
        "Do NOT add chairs, stools, or benches to kitchen islands.",
        "Kitchen staging is countertop/window-sill/open-shelf only; no added floor furniture in kitchen areas.",
        "Allow up to 2 small appliances total (kettle, toaster, coffee machine, blender).",
        "Allow up to 3 decor/accessory items total (vase, fruit bowl, cookbooks, utensil holder, knife block, oven gloves, dish towel).",
      ];
      itemBudget = "Kitchen budget: no new floor furniture. Add up to 2 small appliances and up to 3 decor/accessory items on countertop/window-sill/open-shelf only.";
      break;
    case "kitchen_living":
      anchorGuidance =
        "Primary anchors (MANDATORY): preserve kitchen context and include a clear living-room seating anchor.";
      roomRules = [
        "Do NOT add chairs, stools, or benches to kitchen islands.",
        "Do NOT introduce a third functional zone.",
        "Kitchen zone allows micro-staging only: countertop/window-sill/open-shelf items; no added floor furniture in kitchen area.",
        "Kitchen micro-staging cap: up to 2 small appliances and up to 3 decor/accessory items total.",
      ];
      itemBudget = "Furniture budget: max 4 major furniture pieces total across both zones. Decor budget: max 3 small decor accents total.";
      break;
    case "kitchen_dining":
      anchorGuidance =
        "Primary anchors (MANDATORY): preserve kitchen context and include a clear dining-table anchor.";
      roomRules = [
        "Do NOT add chairs, stools, or benches to kitchen islands.",
        "Do NOT introduce a third functional zone.",
        "Kitchen zone allows micro-staging only: countertop/window-sill/open-shelf items; no added floor furniture in kitchen area.",
        "Kitchen micro-staging cap: up to 2 small appliances and up to 3 decor/accessory items total.",
      ];
      itemBudget = "Furniture budget: max 4 major furniture pieces total across both zones. Decor budget: max 3 small decor accents total.";
      break;
    case "living_dining":
      anchorGuidance =
        "Primary anchors (MANDATORY): one living anchor and one dining anchor, both clearly readable.";
      roomRules = [
        "Do NOT collapse both functions into a single furniture cluster.",
      ];
      itemBudget = "Furniture budget: max 5 major furniture pieces total across both zones. Decor budget: max 3 small decor accents total.";
      break;
    default:
      roomRules = [
        "Use room type as authoritative for furniture program and anchor choice.",
      ];
      break;
  }

  return `CRITICAL PRIORITY 1: ARCHITECTURAL LOCK
The input image is an immutable architectural blueprint.
You are strictly forbidden from modifying any permanent structure or built-in elements.
Do not modify walls, ceilings, floors, windows, doors, openings, trims, fixed lighting, built-ins, or permanent fixtures.
Do not repaint, re-floor, renovate, remodel, or add any built architectural elements.
All openings must remain fully functional and unobstructed in realistic use.

Style must be achieved through freestanding furniture and movable decor only.
Do not add architectural features to achieve style, including coffered ceilings, wall moldings, built-in LED strips, recessed-lighting additions, wall panels, or integrated cabinetry.

CRITICAL PRIORITY 2: PRIMARY ANCHOR
Selected room type: ${room || "unknown"}
${anchorGuidance}

Required room-program guidance:
${roomRules.map((rule) => `- ${rule}`).join("\n")}

CRITICAL PRIORITY 3: STYLE OVERLAY
Selected staging style: ${style || "standard_listing"}
- Respect the selected staging style as the aesthetic layer (materials, palette, decor mood).
- Room type and functional anchor rules are higher priority than style.
- Never violate architecture, openings, or permanent fixtures to satisfy style.

CRITICAL PRIORITY 4: FIT-FIRST DENSITY CONTROL
- ${itemBudget}
- Stage only what comfortably fits in the visible room volume and circulation paths.
- If an item would feel crowded, reduce walkway clearance, or risk covering architecture, omit it.
- Prefer fewer, correctly scaled items over adding extra furniture/decor.
- Keep at least one clear path from entry to the main window/opening.

STRUCTURAL CONFLICT RESOLUTION

When staging conflicts with structure or openings:
- First, reposition or reorient items within the space
- If needed, use appropriately scaled alternatives
- Reduce secondary items before removing primary furniture
- Only omit items when no structurally safe placement is possible

Maintain a complete, intentional, and professionally staged appearance.
Avoid leaving the room sparse unless absolutely necessary.

OPENING SAFETY (MANDATORY)
- Never place art, mirrors, shelving, cabinets, or decor on top of windows, glazed doors, or door openings.
- Only place wall art on uninterrupted wall segments with no opening behind or directly adjacent.
- If wall availability is uncertain, omit wall art entirely.
- If a bed or headboard must be placed in front of a window due to room size, keep the full window frame, sill height, and visible glass unchanged behind and around the furniture. Never raise the sill or shorten the window to fit furniture.

NEGATIVE CONSTRAINTS
- Apply all strict prohibitions in this prompt exactly.
- If any style request conflicts with architecture lock rules, architecture lock rules always win.
`;
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
    stage2Mode?: Stage2ModeOverride;
    curtainRailLikely?: boolean | "unknown";
    jobId: string;
    imageId: string;
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
  const attemptNumber = Math.max(1, opts.attempt ?? 1);
  const emitStage2AttemptComplete = (success: boolean, error?: string): void => {
    logPipelineEvent(
      {
        jobId: opts.jobId,
        imageId: opts.imageId,
        stage: "2",
        attempt: attemptNumber,
      },
      "PIPELINE_STEP",
      {
        step: "stage2_attempt_complete",
        attempt: attemptNumber,
        success,
        ...(error ? { error } : {}),
      },
    );
  };
  logPipelineEvent(
    {
      jobId: opts.jobId,
      imageId: opts.imageId,
      stage: "2",
      attempt: attemptNumber,
    },
    "PIPELINE_STEP",
    {
      step: "stage2_attempt_start",
      attempt: attemptNumber,
      promptMode: opts.promptMode || null,
      sourceStage: opts.sourceStage || null,
    },
  );

  const normalizedRoomType = (opts.roomType || "")
    .toLowerCase()
    .replace(/-/g, "_")
    .trim();
  const canonicalRoomType = normalizedRoomType === "multiple_living_areas"
    ? "multiple_living"
    : normalizedRoomType;

  const refreshOnlyRoomTypes = new Set(["multiple_living", "kitchen_dining", "kitchen_living", "living_dining"]);
  const forceRefreshMode = refreshOnlyRoomTypes.has(canonicalRoomType);
  const resolvedPromptMode: "full" | "refresh" = opts.stage2Mode
    ? (opts.stage2Mode === "REFRESH" ? "refresh" : "full")
    : (opts.promptMode
      ? opts.promptMode
      : (opts.sourceStage === "1A" && !forceRefreshMode ? "full" : "refresh"));

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
        ctx: {
          jobId: opts.jobId,
          imageId: opts.imageId,
          stage: "2",
          attempt: attemptNumber,
        },
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
        await logImageAttemptUrl({
          ctx: {
            jobId: opts.jobId,
            imageId: opts.imageId,
            stage: "2",
            attempt: attemptNumber,
          },
          localPath: maskPath,
        });
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

  const STAGE2_PROMPT_LEGACY = `${useTest
    ? require("../ai/prompts-test").buildTestStage2Prompt(scene, normalizedRoomType)
    : buildStage2PromptNZStyle(normalizedRoomType, scene, {
        stagingStyle: selectedStyle,
        sourceStage: opts.sourceStage,
        mode: resolvedPromptMode,
        layoutContext: opts.layoutContext || undefined,
      })}`;

  const STAGE2_PROMPT_NANO_BANANA = `Virtual Staging Instructions for nano banana (or Pro)

As an advanced virtual staging AI, your only role is to add realistic, correctly-scaled furniture and decor to the provided room photo. You are to act only as an decorator, placing items within the unchanging physical structure of the room.

STRUCTURAL PRIORITY RULE — NON-NEGOTIABLE

Structural integrity is the highest-priority requirement.

You must preserve all architectural elements exactly:

* walls, ceilings, floors, doors, windows, openings, built-ins, and camera geometry.

If staging conflicts with structure:

* structure always takes priority,
* but you must still produce a high-quality, fully staged, listing-ready result.

Do not default to sparse or minimal staging.
Instead, adapt placement, scale, and composition to resolve conflicts.

I. Allowed Items:
You are allowed to add, but are not limited to, the following categories of items:

Furniture: Sofas, armchairs, coffee tables, dining tables, chairs, beds, dressers, nightstands, desks, office chairs, bookcases.

Decor: Area rugs, floor lamps, table lamps, framed artwork (placed on open wall space, not windows/doors), decorative objects (vases, books, bowls), pillows, and throws.

All added items must be rendered with realistic lighting and shadows that match the room, and must be in the correct perspective for the photo. All items must be to-scale.

II. Strict Prohibitions (Negative Constraints):
You are explicitly and completely prohibited from making ANY changes, of any kind, to the core structure, appearance, or built-in elements of the room itself. You must not add, remove, resize, extend, re-color, or alter in ANY way, the following:

Walls: No changes to their location, dimension, surface texture, or existing finish. (Do not repaint or apply wallpaper, as that is not virtual staging). No adding or removing walls.

Openings: Do not alter the existence, size, or shape of any windows, doors, doorways, archways, or skylights. Do not paint or change frames, glass, or hardware. Do not cover them.

Floors & Ceilings: Do not alter the floor material (e.g., hardwood, carpet, tile) or the ceiling (e.g., paint, texture, tray ceilings). Only place rugs and furniture on top of the existing floor.

Built-Ins: Do not change any permanent built-in features, including but not limited to:
Kitchen islands, cabinetry, and countertops.
Built-in shelves, entertainment centers, or window seats.
Fireplaces, mantels, and hearths.
Closets and their doors.

Fixtures & Features: Do not change, remove, or alter existing:
Faucets, sinks, tubs, and showers.
Pendant lights, chandeliers, recessed lighting, or ceiling fans.
HVAC vents, thermostats, switches, or outlets.
Baseboards, crown molding, and railings.

View: Do not change the existing view through windows or doors.

III. Core Principle:
The photo of the room must remain an exact structural and architectural copy of the original. Your function is limited entirely to placing a realistic layer of furniture and decor within this unchanging, permanent framework. Do not extend, expand, contract, or warp any space or element of the original photo. Only place furniture and decor in logical, realistic positions within the room.

Camera & Perspective Constraint:
The camera viewpoint, lens perspective, and framing of the image must remain exactly the same as in the original photo. Do not zoom, crop, rotate, widen, narrow, or otherwise shift the camera position or perspective. The final staged image must appear as though the exact same photo was taken from the same camera position, with furniture simply placed into the scene.
   `;

  const USE_NANO_BANANA_PROMPT =
    process.env.STAGE2_PROMPT_VARIANT === "nano" && resolvedPromptMode === "full";

  const nanoRoomProgramGuidance = buildNanoRoomProgramGuidance({
    roomType: canonicalRoomType,
    stagingStyle: selectedStyleRaw,
  });

  const stage2Prompt = USE_NANO_BANANA_PROMPT
    ? `${STAGE2_PROMPT_NANO_BANANA}\n\n${nanoRoomProgramGuidance}`
    : STAGE2_PROMPT_LEGACY;

  nLog("[STAGE2_PROMPT_VARIANT]", {
    requested: process.env.STAGE2_PROMPT_VARIANT || "legacy",
    mode: resolvedPromptMode,
    variant: USE_NANO_BANANA_PROMPT ? "nano_banana" : "legacy"
  });

  let textPrompt = stage2Prompt;

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
    const anchorRegion = opts.layoutPlan.anchorRegion;
    if (anchorRegion) {
      textPrompt += `

ANCHOR REGION GUIDANCE (SOFT, NOT A HARD MASK)
Prefer placing the primary anchor furniture within this normalized region when structurally valid:
- x=${anchorRegion.x.toFixed(3)}
- y=${anchorRegion.y.toFixed(3)}
- width=${anchorRegion.width.toFixed(3)}
- height=${anchorRegion.height.toFixed(3)}

This region is guidance only. You may adjust slightly for realism and circulation.
Do NOT modify architecture, openings, or permanent fixtures to satisfy this guidance.
`;
    }

    textPrompt += `

Use the following furniture placement plan exactly.
Do not place furniture outside the defined zones.

${formatStage2LayoutPlanForPrompt(opts.layoutPlan)}
`;
  }

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
  logger.info(`[STAGE2_MODEL] attempt=${attemptNumber} model=${generationPlan.model}`);
  const generationConfig: any = {
    temperature: generationPlan.temperature,
    topP: generationPlan.topP,
    topK: generationPlan.topK,
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(opts.profile?.seed !== undefined ? { seed: opts.profile.seed } : {}),
  };

  // Fail early — before spending any API budget — if logging context is incomplete.
  // Without both jobId and imageId, assertContext() in usageTelemetry throws AFTER the
  // model returns a valid image, causing the image to be silently discarded.
  if (!opts.jobId || !opts.imageId) {
    emitStage2AttemptComplete(false, "missing_context");
    throw new Stage2GenerationFailure(
      `Missing jobId or imageId before Stage 2 generation: jobId=${opts.jobId || "missing"} imageId=${opts.imageId || "missing"}`,
      "missing_context",
      false // not retryable — caller must supply context
    );
  }

  const ai = getGeminiClient();
  let resp: any;
  let modelUsed = generationPlan.model;
  try {
    const run = await runWithSelectedImageModel({
      stageLabel: "2",
      ai: ai as any,
      model: generationPlan.model,
      baseRequest: {
        contents: requestParts,
        generationConfig,
      } as any,
      context: "stage2_generation_attempt",
      meta: {
        stage: "2",
        jobId: opts.jobId,
        imageId: opts.imageId,
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
      emitStage2AttemptComplete(false, message);
      throw new Stage2GenerationNoImageError(message);
    }
    emitStage2AttemptComplete(false, message);
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
    emitStage2AttemptComplete(false, "no_inline_image_data");
    throw new Stage2GenerationNoImageError();
  }

  console.log("[STAGE2_OUTPUT]", {
    jobId: opts.jobId,
    imageId: opts.imageId,
    attempt: attemptNumber,
    model: modelUsed,
    hasImage: true,
    imageSize: img.inlineData.data.length,
  });

  if (path.resolve(opts.outputPath) === path.resolve(basePath)) {
    emitStage2AttemptComplete(false, "stage2_candidate_collapse: candidate_path_equals_baseline");
    throw new Stage2GenerationFailure("stage2_candidate_collapse: candidate_path_equals_baseline", "stage2_candidate_collapse");
  }

  writeImageDataUrl(opts.outputPath, `data:image/webp;base64,${img.inlineData.data}`);
  try {
    await fs.access(opts.outputPath);
  } catch {
    emitStage2AttemptComplete(false, "stage2_candidate_collapse: candidate_file_missing");
    throw new Stage2GenerationFailure("stage2_candidate_collapse: candidate_file_missing", "stage2_candidate_collapse");
  }

  await logImageAttemptUrl({
    ctx: {
      jobId: opts.jobId,
      imageId: opts.imageId,
      stage: "2",
      attempt: attemptNumber,
    },
    localPath: opts.outputPath,
  });
  emitStage2AttemptComplete(true);
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
    stage2Mode?: Stage2ModeOverride;
    curtainRailLikely?: boolean;
    // Optional callback to surface strict retry status to job updater
    onStrictRetry?: (info: { reasons: string[] }) => void;
    // Optional callback when a retry attempt supersedes the current attempt
    onAttemptSuperseded?: (nextAttemptId: string) => void;
    /** Stage1A output path for stage-aware validation baseline (CRITICAL) */
    stage1APath?: string;
    /** Job ID for validation tracking */
    jobId: string;
    imageId: string;
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
  const resolvedPromptMode: "full" | "refresh" = opts.stage2Mode
    ? (opts.stage2Mode === "REFRESH" ? "refresh" : "full")
    : (opts.promptMode
      ? opts.promptMode
      : (opts.sourceStage === "1A" && !forceRefreshMode ? "full" : "refresh"));

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
  const maxAttempts = resolveStage2MaxAttempts();
  const localReasons: string[] = [];

  const runAttempt = async (attempt: number, structuralRetryContext?: {
    compositeFail: boolean;
    failureType: StructuralFailureType | null;
    attemptNumber: number;
  }): Promise<string> => {
    const generatedPath = await runStage2GenerationAttempt(basePath, {
      roomType: opts.roomType,
      sceneType: opts.sceneType,
      profile: opts.profile,
      referenceImagePath: opts.referenceImagePath,
      stagingRegion: opts.stagingRegion,
      stagingStyle: opts.stagingStyle,
      sourceStage: opts.sourceStage,
      promptMode: resolvedPromptMode,
      stage2Mode: opts.stage2Mode,
      curtainRailLikely: opts.curtainRailLikely,
      jobId: opts.jobId,
      imageId: opts.imageId,
      outputPath,
      attempt,
      layoutContext,
      layoutPlan: opts.layoutPlan,
      modelReason: attempt === 1 ? "stage2_initial_generation" : `stage2_retry_generation_attempt_${attempt}`,
      structuralRetryContext,
    });

    if (path.resolve(generatedPath) === path.resolve(validationBaseline)) {
      throw new Stage2GenerationFailure(
        "stage2_candidate_collapse: candidate_equals_validation_baseline",
        "stage2_candidate_collapse"
      );
    }

    return generatedPath;
  };

  try {
    const generatedPath = await runAttempt(1);
    return {
      outputPath: generatedPath,
      attempts: 1,
      maxAttempts,
      validationRisk: false,
      fallbackUsed: false,
      localReasons,
    };
  } catch (firstErr: any) {
    if (maxAttempts < 2 || !isStage2RetryableGenerationError(firstErr)) {
      throw firstErr;
    }

    localReasons.push(`attempt1_retryable_failure:${firstErr?.code || firstErr?.message || "unknown"}`);
    opts.onStrictRetry?.({
      reasons: [
        "stage2_attempt1_retryable_failure",
        String(firstErr?.code || firstErr?.message || "unknown"),
      ],
    });

    const retryContext = {
      compositeFail: true,
      failureType: "other" as StructuralFailureType,
      attemptNumber: 1,
    };

    try {
      const generatedPath = await runAttempt(2, retryContext);
      return {
        outputPath: generatedPath,
        attempts: 2,
        maxAttempts,
        validationRisk: false,
        fallbackUsed: false,
        localReasons,
      };
    } catch (secondErr: any) {
      localReasons.push(`attempt2_failure:${secondErr?.code || secondErr?.message || "unknown"}`);
      throw secondErr;
    }
  }
}
