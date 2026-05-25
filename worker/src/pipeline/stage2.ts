import { getGeminiClient } from "../ai/gemini";
import { siblingOutPath, toBase64, writeImageDataUrl } from "../utils/images";
import type { StagingProfile } from "../utils/groups";
import { validateStage } from "../ai/unified-validator";
import { validateStage2Structural } from "../validators/stage2StructuralValidator";
import { runOpenCVStructuralValidator } from "../validators/index";
import { buildStage2PromptNZStyle } from "../ai/prompts.nzRealEstate";
import { normalizeStagingStyle, STYLE_PROMPT_MODIFIERS } from "../ai/stagingStyles";
import type { StagingRegion } from "../ai/region-detector";
import { safeToBuffer, safeMetadata } from "../utils/sharp-utils"; // AUDIT FIX: safe sharp wrappers
import { loadStageAwareConfig } from "../validators/stageAwareConfig";
import { validateStructureStageAware } from "../validators/structural/stageAwareValidator";
import { getJob, updateJob } from "../utils/persist";
import { buildTightenedPrompt, getTightenLevelFromAttempt, logTighteningInfo, TightenLevel } from "../ai/promptTightening";
import type { Mode } from "../validators/validationModes";
import { focusLog } from "../utils/logFocus";
import { nLog } from "../logger";
import {
  SECONDARY_CONTINUITY_PROVIDER,
  SECONDARY_CONTINUITY_PLANNER,
  SECONDARY_CONTINUITY_RENDERER,
} from "../config";
import { buildLayoutContext, type LayoutContextResult } from "../ai/layoutPlanner";
import { formatStage2LayoutPlanForPrompt, type Stage2LayoutPlan } from "./layoutPlanner";
import { buildStructuralRetryInjection, type StructuralFailureType } from "./structuralRetryHelpers";
import { logImageAttemptUrl } from "../utils/debugImageUrls";
import { logEvent as logPipelineEvent, logGeminiUsage } from "../ai/usageTelemetry";
import { runWithSelectedImageModel } from "../ai/runWithImageModelFallback";
import { resolveStage2ImageModel } from "../ai/modelResolver";
import { runPerceptualDiff } from "../validators/perceptualDiff";
import { CONTINUITY_RENDER_QUEUE } from "../../../shared/src/constants";
import { RoomConsistencyContextV1 } from "../../../shared/src/types";
import { runExperimentalSecondaryContinuity } from "../continuity/experimentalSecondaryContinuity";
import { VertexSecondaryContinuityError } from "../continuity/types";
import sharp from "sharp";
import path from "path";
import fs from "fs/promises";

type Stage2RetryReason =
  | "opening_authoritative_fail"
  | "opening_preservation"
  | "other_reason"
  | "structural_violation"
  | "opening_removed"
  | "unknown"
  | "initial"
  | "cosmetic";

type Stage2ModeOverride = "REFRESH" | "FROM_EMPTY";

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

type Stage2GenerationProfileName =
  | "PRIMARY_STAGING_PROFILE"
  | "SECONDARY_VIEW_CONTINUITY_PROFILE";

type Stage2GenerationProfile = {
  profileName: Stage2GenerationProfileName;
  temperature: number;
  topP: number;
  topK: number;
  candidateCount: number;
};

function resolveSecondaryViewContinuityTemperature(
  attempt: number,
  reason: Stage2RetryReason,
  previousTemperature?: number
): number {
  if (attempt <= 1) return 0.26;
  if (!isStructuralRetryReason(reason)) return previousTemperature ?? 0.26;
  if (attempt === 2) return 0.24;
  return 0.22;
}

function resolveStage2GenerationProfile(opts: {
  attempt: number;
  retryReason: Stage2RetryReason;
  isSecondaryViewContinuityMode: boolean;
  previousPlan?: Stage2GenerationPlan | null;
}): Stage2GenerationProfile {
  if (opts.isSecondaryViewContinuityMode) {
    return {
      profileName: "SECONDARY_VIEW_CONTINUITY_PROFILE",
      temperature: resolveSecondaryViewContinuityTemperature(
        opts.attempt,
        opts.retryReason,
        opts.previousPlan?.temperature
      ),
      topP: 0.68,
      topK: 20,
      candidateCount: 2,
    };
  }

  return {
    profileName: "PRIMARY_STAGING_PROFILE",
    temperature: resolveStage2Temperature(opts.attempt, opts.retryReason, opts.previousPlan?.temperature),
    topP: 0.90,
    topK: 40,
    candidateCount: 1,
  };
}

type Stage2GenerationPlan = {
  profileName: Stage2GenerationProfileName;
  model: string;
  temperature: number;
  retryReason: Stage2RetryReason;
  previousPlan?: Stage2GenerationPlan | null;
  topP: number;
  topK: number;
  candidateCount: number;
  escalated: boolean;
};

function resolveStage2GenerationPlan(opts: {
  attempt: number;
  retryReason: Stage2RetryReason;
  isSecondaryViewContinuityMode: boolean;
  previousPlan?: Stage2GenerationPlan | null;
}): Stage2GenerationPlan {
  const model = resolveStage2Model(opts.attempt, opts.retryReason, opts.previousPlan?.model);
  const profile = resolveStage2GenerationProfile({
    attempt: opts.attempt,
    retryReason: opts.retryReason,
    isSecondaryViewContinuityMode: opts.isSecondaryViewContinuityMode,
    previousPlan: opts.previousPlan,
  });
  const escalated = !!opts.previousPlan && model !== opts.previousPlan.model;
  return {
    profileName: profile.profileName,
    model,
    temperature: profile.temperature,
    topP: profile.topP,
    topK: profile.topK,
    candidateCount: profile.candidateCount,
    escalated,
    retryReason: "initial",
  };
}

function resolveStage2GenerationPlanForAttempt(
  attempt: number,
  retryReason: Stage2RetryReason,
  isSecondaryViewContinuityMode: boolean
): Stage2GenerationPlan {
  let plan: Stage2GenerationPlan | null = null;
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  for (let idx = 1; idx <= normalizedAttempt; idx += 1) {
    plan = resolveStage2GenerationPlan({
      attempt: idx,
      retryReason: idx === 1 ? "initial" : retryReason,
      isSecondaryViewContinuityMode,
      previousPlan: plan,
    });
  }
  return plan as Stage2GenerationPlan;
}

function resolveContinuityGroupId(roomConsistency?: RoomConsistencyContextV1): string | null {
  const identity = roomConsistency as
    | (RoomConsistencyContextV1 & { continuityGroupId?: string | null; roomGroupId?: string | null })
    | undefined;
  return String(
    identity?.roomGroupId ||
    identity?.continuityGroupId ||
    roomConsistency?.roomId ||
    ""
  ).trim() || null;
}

function collectSecondaryViewPromptWeighting(textPrompt: string): {
  preserveCount: number;
  doNotCount: number;
  maintainCount: number;
  unchangedCount: number;
  stageCount: number;
  mandatoryCount: number;
  transferCount: number;
  suppressionBiasScore: number;
} {
  const count = (pattern: RegExp): number => (textPrompt.match(pattern) || []).length;
  const preserveCount = count(/\bpreserve\b/gi);
  const doNotCount = count(/\bdo not\b/gi);
  const maintainCount = count(/\bmaintain\b/gi);
  const unchangedCount = count(/\bunchanged\b/gi);
  const stageCount = count(/\bstage\b/gi);
  const mandatoryCount = count(/\bmandatory\b|must become|must transfer|returning the target image unchanged is incorrect/gi);
  const transferCount = count(/\btransfer\b|continuity guidance|same staged room|room-state continuity/gi);
  const suppressionBiasScore = preserveCount + doNotCount + maintainCount + unchangedCount - stageCount - mandatoryCount - transferCount;

  return {
    preserveCount,
    doNotCount,
    maintainCount,
    unchangedCount,
    stageCount,
    mandatoryCount,
    transferCount,
    suppressionBiasScore,
  };
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
        "Primary anchor (MANDATORY): the main sofa or sectional seating group. Build the living-room layout around this seating anchor. A freestanding, non-permanent TV/media console is OPTIONAL only when there is a clearly suitable uninterrupted wall area that does not conflict with windows, doors, openings, or circulation. Do not force a TV/media unit into the layout when no such area exists.";
      roomRules = [
        "Include a realistic sofa or sectional as the primary living-room anchor.",
        "If a suitable uninterrupted wall area exists, you may add a freestanding TV unit/media console as a secondary focal element.",
        "If no suitable TV wall exists, use conversation grouping, fireplace, or view as the focal point instead.",
        "Arrange seating for natural circulation and a believable living-room focal point.",
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

RESOURCE CONSTRAINT (ZERO TOLERANCE)
Furniture must adapt to the room; the room must never adapt to furniture.
Do not extend wall planes, flatten recesses, or shift openings to create placement surface.
Internal doorways, walk-throughs, and alcoves are structural voids—not blank canvases.
EGRESS & CLEARANCE: Maintain a minimum 80cm clear path for all doors and walk-throughs.
Priority Hierarchy: Doorway access and floor-plan flow always outrank furniture density.
If an item blocks an opening's path or overlaps a door swing zone, you MUST omit that item.
Do not alter window-to-wall ratio, door-to-wall ratio, sill height, or wall returns.
If an item does not fit on existing wall area, omit the item.

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
- If a TV, artwork, console, or shelf requires more continuous wall than exists between openings, you MUST omit that item. Do not create new mountable wall area by shrinking, shifting, or removing any opening.

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

export function wrapRetryableSecondaryContinuityError(error: unknown): unknown {
  const message = String((error as any)?.message || error || "");
  const normalized = message.toLowerCase();
  const isFailedPrecondition = normalized.includes("failed_precondition");
  if (!isFailedPrecondition) {
    return error;
  }

  return new Stage2GenerationFailure(
    message,
    "vertex_continuity_failed_precondition",
    true,
  );
}

type FurnishingAnchorDepth = "foreground" | "midground" | "background" | "unknown";

type StructuredFurnishingAnchor = {
  type: string;
  roomAnchor: string;
  depth: FurnishingAnchorDepth;
  lateralBias?: string;
  relationToPrimaryAnchor?: string;
  notes?: string;
};

type StructuredFurnishingAnchorMap = {
  primaryAnchor: string;
  roomSummary?: string;
  viewpointNotes?: string[];
  objects: StructuredFurnishingAnchor[];
};

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

function normalizeAnchorDepth(value: unknown): FurnishingAnchorDepth {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "foreground" || normalized === "midground" || normalized === "background") {
    return normalized;
  }
  return "unknown";
}

function sanitizeStructuredAnchorMap(raw: any): StructuredFurnishingAnchorMap | null {
  if (!raw || typeof raw !== "object") return null;

  const objects = Array.isArray(raw.objects)
    ? raw.objects
        .slice(0, 8)
        .map((entry: any) => {
          const type = String(entry?.type || "").trim().toLowerCase().replace(/\s+/g, "_");
          const roomAnchor = String(entry?.roomAnchor || "").trim();
          if (!type || !roomAnchor) return null;
          return {
            type,
            roomAnchor,
            depth: normalizeAnchorDepth(entry?.depth),
            ...(String(entry?.lateralBias || "").trim() ? { lateralBias: String(entry.lateralBias).trim() } : {}),
            ...(String(entry?.relationToPrimaryAnchor || "").trim()
              ? { relationToPrimaryAnchor: String(entry.relationToPrimaryAnchor).trim() }
              : {}),
            ...(String(entry?.notes || "").trim() ? { notes: String(entry.notes).trim() } : {}),
          };
        })
        .filter(Boolean) as StructuredFurnishingAnchor[]
    : [];

  if (objects.length === 0) return null;

  return {
    primaryAnchor: String(raw.primaryAnchor || "room_anchor").trim() || "room_anchor",
    ...(String(raw.roomSummary || "").trim() ? { roomSummary: String(raw.roomSummary).trim() } : {}),
    ...(Array.isArray(raw.viewpointNotes)
      ? {
          viewpointNotes: raw.viewpointNotes
            .map((note: any) => String(note || "").trim())
            .filter(Boolean)
            .slice(0, 4),
        }
      : {}),
    objects,
  };
}

function parseJsonCandidate(text: string): any | null {
  const cleaned = String(text || "").replace(/```json|```/gi, "").trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned;
  try {
    return JSON.parse(jsonCandidate);
  } catch {
    return null;
  }
}

async function extractStructuredFurnishingAnchorMap(params: {
  referenceImagePath: string;
  roomType: string;
  stagingStyle?: string;
  jobId: string;
  imageId: string;
}): Promise<StructuredFurnishingAnchorMap | null> {
  const enabled = String(process.env.ROOM_CONSISTENCY_STRUCTURED_ANCHORS || "1") !== "0";
  if (!enabled) return null;

  try {
    const ai = getGeminiClient();
    const master = toBase64(params.referenceImagePath);
    const model = String(process.env.REALENHANCE_MODEL_ROOM_CONSISTENCY_ANCHOR || "gemini-2.5-flash").trim();
    const prompt = `You are extracting a lightweight furnishing anchor map from a single approved virtual staging image.

Return JSON only.

Goal:
- Identify the primary staged anchor object.
- Identify the most important movable staged objects.
- Describe each object relative to ROOM GEOMETRY, not relative only to other furniture.
- Use coarse relational anchors only. Do not infer 3D coordinates.

Room type: ${params.roomType}
Staging style: ${params.stagingStyle || "standard_listing"}

Allowed roomAnchor phrases:
- near wall
- far wall
- window side
- doorway wall
- left wall
- right wall
- center floor
- left corner
- right corner
- foot of bed zone
- headboard wall

Allowed depth values:
- foreground
- midground
- background
- unknown

Output schema:
{
  "primaryAnchor": "bed",
  "roomSummary": "short summary",
  "viewpointNotes": ["short note"],
  "objects": [
    {
      "type": "floor_lamp",
      "roomAnchor": "near wall",
      "depth": "foreground",
      "lateralBias": "left side of frame",
      "relationToPrimaryAnchor": "near foot of bed",
      "notes": "optional"
    }
  ]
}

Rules:
- Include 3 to 8 objects.
- Prioritize large movable objects and visually important decor.
- Describe stable room-relative placement that can be preserved from another angle.
- Do not describe architecture changes.
- Do not output markdown.`;

    const requestStartedAt = Date.now();
    const response = await (ai as any).models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: master.mime, data: master.data } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        topP: 0.1,
        maxOutputTokens: 700,
        responseMimeType: "application/json",
      },
    });
    logGeminiUsage({
      ctx: {
        jobId: params.jobId,
        imageId: params.imageId,
        stage: "2",
        attempt: 1,
      },
      model,
      callType: "text_generation",
      response,
      latencyMs: Date.now() - requestStartedAt,
    });

    const text = String(response?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || "").join(" ") || "").trim();
    const parsed = parseJsonCandidate(text);
    const anchorMap = sanitizeStructuredAnchorMap(parsed);
    nLog("[ROOM_CONSISTENCY_ANCHOR_MAP]", {
      jobId: params.jobId,
      imageId: params.imageId,
      extracted: !!anchorMap,
      primaryAnchor: anchorMap?.primaryAnchor || null,
      objectCount: anchorMap?.objects.length || 0,
    });
    return anchorMap;
  } catch (error) {
    nLog("[ROOM_CONSISTENCY_ANCHOR_MAP_WARN]", {
      jobId: params.jobId,
      imageId: params.imageId,
      error: String((error as any)?.message || error),
    });
    return null;
  }
}

function formatStructuredAnchorMapForPrompt(anchorMap: StructuredFurnishingAnchorMap | null): string {
  if (!anchorMap || anchorMap.objects.length === 0) return "";

  const objectLines = anchorMap.objects.map((object) => {
    const details = [
      `roomAnchor=${object.roomAnchor}`,
      `depth=${object.depth}`,
      ...(object.lateralBias ? [`lateralBias=${object.lateralBias}`] : []),
      ...(object.relationToPrimaryAnchor ? [`relationToPrimaryAnchor=${object.relationToPrimaryAnchor}`] : []),
      ...(object.notes ? [`notes=${object.notes}`] : []),
    ];
    return `- ${object.type}: ${details.join(" | ")}`;
  });

  const viewpointNotes = Array.isArray(anchorMap.viewpointNotes) && anchorMap.viewpointNotes.length > 0
    ? `Viewpoint notes:\n${anchorMap.viewpointNotes.map((note) => `- ${note}`).join("\n")}\n`
    : "";

  return `
REFERENCE ANCHORS
Primary anchor: ${anchorMap.primaryAnchor}
${anchorMap.roomSummary ? `Room summary: ${anchorMap.roomSummary}\n` : ""}${viewpointNotes}Keep these room-relative furnishing anchors:
${objectLines.join("\n")}

Keep large movable items in the same room-relative positions. Do not rebalance them for composition alone.
`;
}

function invertAnchorDepth(depth: FurnishingAnchorDepth): FurnishingAnchorDepth {
  if (depth === "foreground") return "background";
  if (depth === "background") return "foreground";
  return depth;
}

function formatAnchorTypeLabel(value: string): string {
  return String(value || "object")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatFramingLabel(depth: FurnishingAnchorDepth): string {
  if (depth === "foreground") return "Foreground (Closer to Camera)";
  if (depth === "background") return "Background (Further from Camera)";
  if (depth === "midground") return "Midground (Stable Depth Band)";
  return "Viewpoint-Dependent";
}

function detectReverseAngle(params: {
  roomConsistency?: RoomConsistencyContextV1;
  anchorMap?: StructuredFurnishingAnchorMap | null;
}): boolean {
  const signalText = [
    params.roomConsistency?.roomState?.relationalSummary?.placementDirective || "",
    ...(params.anchorMap?.viewpointNotes || []),
  ]
    .join(" ")
    .toLowerCase();

  if (/(reverse angle|opposite side|opposite angle|180|flipped viewpoint|viewpoint inversion|from the opposite side)/.test(signalText)) {
    return true;
  }

  return false;
}

function buildOperationalAnchorMap(
  roomType: string,
  isReverseAngle: boolean,
  anchorMap?: StructuredFurnishingAnchorMap | null,
): string {
  const normalizedRoomType = String(roomType || "").trim().toLowerCase();
  if (normalizedRoomType !== "bedroom" && (!anchorMap || anchorMap.objects.length === 0)) return "";

  const primaryAnchorLabel = formatAnchorTypeLabel(anchorMap?.primaryAnchor || (normalizedRoomType === "bedroom" ? "bed" : "primary_furniture"));
  const selectedObjects = (anchorMap?.objects || []).slice(0, 4);
  const objectLines = selectedObjects.length > 0
    ? selectedObjects.map((object) => {
        const mappedDepth = isReverseAngle ? invertAnchorDepth(object.depth) : object.depth;
        const roomAnchor = object.relationToPrimaryAnchor
          ? `${object.roomAnchor} / ${object.relationToPrimaryAnchor}`
          : object.roomAnchor;
        return `- Item: ${formatAnchorTypeLabel(object.type)} -> Anchor: ${roomAnchor} -> Framing: ${formatFramingLabel(mappedDepth)}`;
      }).join("\n")
    : `- Item: Bed -> Anchor: Center Wall -> Framing: Dominant Focal Point\n- Item: Bedside Table -> Anchor: Window-Side of Bed -> Framing: ${isReverseAngle ? "Foreground (Closer to Camera)" : "Background (Further from Camera)"}\n- Item: Floor Lamp -> Anchor: Doorway-Side of Bed -> Framing: ${isReverseAngle ? "Background (Further from Camera)" : "Foreground (Closer to Camera)"}\n- Item: Accent Rug -> Anchor: Under Foot of Bed -> Framing: Lower Center Floor`;

  return `
ANCHOR MAP
Primary anchor: ${primaryAnchorLabel}
View relation: ${isReverseAngle ? "reverse angle" : "standard angle"}
${objectLines}

Keep each item anchored to the same physical room location. Visual left/right may flip when the camera angle changes.
`;
}

function estimatePromptTokens(text: string): number {
  return Math.max(0, Math.ceil(String(text || "").length / 4));
}

function countInlineImages(parts: any[]): number {
  return (parts || []).filter((part) => !!part?.inlineData?.data).length;
}

function safeTruncateForLog(value: unknown, maxLength = 1200): string | undefined {
  if (value == null) return undefined;

  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, Object.getOwnPropertyNames(value as object));
    } catch {
      text = String(value);
    }
  }

  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...<truncated>`;
}

function estimateResponseSize(resp: any): number {
  try {
    return JSON.stringify(resp).length;
  } catch {
    return 0;
  }
}

function buildSecondaryReferencePrompt(params: {
  canonicalRoomType: string;
  roomId: string;
  operationalAnchorMap: string;
  supplementalAnchorMapBlock: string;
}): string {
  const anchorBlocks = [params.operationalAnchorMap.trim(), params.supplementalAnchorMapBlock.trim()]
    .filter(Boolean)
    .join("\n\n");

  return `SECONDARY VIEW CONSISTENCY OVERRIDE
Stage the TARGET room image.

MANDATORY STAGING OUTCOME
The TARGET image must become a staged version of this same room, not remain an unstaged or nearly unchanged copy of the input.
Furnishing transfer from the REFERENCE image is mandatory whenever the referenced pieces or their equivalents can naturally appear in this angle.
Returning the original TARGET room with little or no furniture insertion is incorrect.

AUTHORITATIVE HIERARCHY
1. TARGET architecture is authoritative.
2. TARGET camera geometry is authoritative.
3. REFERENCE image is furnishing and layout continuity guidance only.
4. Furnishings must adapt to TARGET scene geometry.

ARCHITECTURAL IMMUTABILITY
Preserve the exact architecture, openings, framing, perspective, vanishing points, and room proportions of the TARGET image.
Do not alter geometry, reinterpret the room structure, or change openings.

PERSPECTIVE / VANISHING-POINT LOCK
The perspective lines and vanishing points of the TARGET image are absolutely locked.
You must warp, skew, scale, and adapt the REFERENCE furnishings to fit the native 3D geometry and perspective of the TARGET room.
NEVER warp, skew, rotate, widen, narrow, stretch, bend, or reinterpret the walls, corners, ceiling lines, floor plane, openings, or architectural geometry to accommodate furniture placement.
Furniture must adapt to the room.
The room must never adapt to the furniture.

CAMERA IMMUTABILITY
The TARGET image camera position, focal geometry, framing, crop, horizon alignment, perspective depth, and field-of-view are immutable.
Do NOT recrop, rotate, widen, narrow, normalize, rebalance, reinterpret, center, improve composition, alter viewing angle, or adjust perspective.
All staging must conform to the exact existing camera geometry of the TARGET image.

WALL TOPOLOGY LOCK
Preserve all wall intersection geometry exactly as seen in the TARGET image.
Corners, wall junctions, ceiling junctions, floor junctions, wall angles, and wall-to-wall relationships are immutable.
Do NOT shift wall endpoints, bend corners, alter perpendicularity, create angled wall transitions, widen or narrow corner geometry, reshape wall junctions, taper walls, create non-parallel wall drift, deform room-edge topology, or modify local architectural junction geometry.
Localized architectural deformation is prohibited even when the overall room geometry appears preserved.
If furniture placement conflicts with room geometry, reposition the furniture, reduce furniture scale slightly, tighten spacing naturally, or simplify placement.
NEVER modify wall geometry to improve furniture composition or placement.
Tighter furniture placement is preferable to architectural deformation.
Furniture compromise is acceptable. Architectural deformation is not.

The REFERENCE image shows the same staged room from another angle.
Use it to preserve furnishing identity, furnishing family, major layout continuity, overall style palette, and room-state continuity.
The REFERENCE image is NOT a compositional template.
It is ONLY a furnishing continuity reference.
Do NOT reconstruct the REFERENCE room layout, framing, wall geometry, room proportions, or perspective.
Do not copy the REFERENCE camera framing or architectural shell verbatim.
Transfer the same furnishing logic and room-relative placements into the TARGET view.
You are staging the TARGET room ONLY.

Adapt the REFERENCE furnishings so they fit the native 3D geometry and perspective of the TARGET room.
Contact points between furniture and architectural surfaces must respect the TARGET room's geometry.
Furniture must visually conform to the existing floor plane and wall angles.
Architectural surfaces must not deform at furniture contact points.

Keep furnishings anchored to the same real room locations relative to permanent features such as walls, windows, openings, hallway transitions, balcony edges, and other fixed architectural features.
When seen from another angle, furnishings may appear on opposite sides of the image while remaining anchored to the same room locations.
Do not arbitrarily reposition furnishings for visual balancing or composition cleanup when the REFERENCE establishes a stable room-state relationship.

Affirmative staging rule:
- Actively insert the transferred staging furniture into the TARGET image.
- Reconstruct the established staged room state for this new viewpoint.
- If a referenced furniture piece is naturally visible from this angle, include it unless geometry, occlusion, or crop truly prevents visibility.

Prioritize continuity of major furniture placement, furnishing category, spatial layout, side relationships, room function, and overall style palette.
Minor decorative objects may vary naturally provided the room remains clearly the same staged space.
Do not force exact replication of artwork, lamp shape, rug pattern, pillow count, or minor decor accessories.

Preserve architecture first. Preserve camera geometry second. Preserve major furnishing identities next.
Omit secondary decor or minor items when space, visibility, camera framing, or geometry conflicts occur.
Keep major furnishing identities and materials consistent with the approved master whenever they are naturally visible in this view. Partial visibility and occlusion are acceptable.

${anchorBlocks ? `${anchorBlocks}\n\n` : ""}Room ID: ${params.roomId}`;
}

async function rejectReferenceEchoIfNeeded(params: {
  basePath: string;
  candidatePath: string;
  referenceImagePath?: string;
  jobId?: string;
  imageId?: string;
}) {
  if (!params.referenceImagePath) return;

  try {
    const [baseSimilarity, referenceSimilarity] = await Promise.all([
      runPerceptualDiff({
        originalPath: params.basePath,
        enhancedPath: params.candidatePath,
        stage: "2",
      }),
      runPerceptualDiff({
        originalPath: params.referenceImagePath,
        enhancedPath: params.candidatePath,
        stage: "2",
      }),
    ]);

    const suspiciousReferenceEcho =
      (referenceSimilarity.score >= 0.985 &&
        referenceSimilarity.score >= baseSimilarity.score + 0.05)
      || (referenceSimilarity.score >= 0.975 &&
        baseSimilarity.score <= 0.94 &&
        referenceSimilarity.score >= baseSimilarity.score + 0.03);

    nLog("[ROOM_CONSISTENCY_REFERENCE_ECHO_CHECK]", {
      jobId: params.jobId,
      imageId: params.imageId,
      suspiciousReferenceEcho,
      baseSimilarity: Number(baseSimilarity.score.toFixed(4)),
      referenceSimilarity: Number(referenceSimilarity.score.toFixed(4)),
    });

    if (suspiciousReferenceEcho) {
      throw new Stage2GenerationFailure(
        "stage2_reference_echo_suspected: generated output appears to match the approved master reference instead of the target input view",
        "stage2_reference_echo",
        true
      );
    }
  } catch (error) {
    if (error instanceof Stage2GenerationFailure) {
      throw error;
    }
    nLog("[ROOM_CONSISTENCY_REFERENCE_ECHO_CHECK_WARN]", {
      jobId: params.jobId,
      imageId: params.imageId,
      error: String((error as any)?.message || error),
    });
  }
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
    roomConsistencyV1?: RoomConsistencyContextV1;
    referenceAnchorMap?: StructuredFurnishingAnchorMap | null;
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
  let occupancyConstraintMaskPath: string | undefined;
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
        occupancyConstraintMaskPath = maskPath;
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

Openings: Do not alter the existence, size, or shape of any windows, doors, doorways, archways, or skylights. Do not paint or change frames, glass, or hardware. Do not cover them. This includes keeping the floor area immediately in front of and within the swing-path of any door entirely clear of furniture, rugs, or decor.

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

  if (resolvedPromptMode === "full") {
    textPrompt += "\n\nDOOR STATE LOCK: Any door that is closed in the input image must remain closed in the staged output.";
  }

  // If we have a staging region, strongly insist edits are limited to the provided mask.
  if (opts.stagingRegion) {
    textPrompt = `ONLY EDIT INSIDE MASK: An explicit mask image is supplied as a separate part. You MUST only modify pixels inside the mask region. Do NOT alter any pixels, architecture, openings, windows, doors, floors, or lighting outside the provided mask. If the mask is empty, return the input image unchanged.` + "\n\n" + textPrompt;
  }

  const styleModifier = selectedStyle === "nz_standard" ? undefined : STYLE_PROMPT_MODIFIERS[selectedStyle];
  if (styleModifier) {
    textPrompt += "\n\nSTYLE CONTEXT:\n" + styleModifier;
  }

  const roomConsistency = opts.roomConsistencyV1;
  const roomConsistencyFeatureEnabled =
    roomConsistency?.enabled === true &&
    (String(process.env.EXPERIMENT_ROOM_CONSISTENCY_V1 || "").toLowerCase() === "true" ||
      String(process.env.EXPERIMENT_ROOM_CONSISTENCY_V1 || "") === "1");
  const isReferenceViewWithMaster =
    roomConsistencyFeatureEnabled
    && roomConsistency?.viewRole === "reference"
    && !!String(roomConsistency?.approvedMasterImageUrl || "").trim();
  if (roomConsistencyFeatureEnabled) {
    const roomState = roomConsistency.roomState;
    const roleLabel = roomConsistency.viewRole === "primary" ? "Primary View" : "Reference View";
    const styleHint = roomState?.styleProfile?.stagingStyle || selectedStyle;
    const lightingHint = roomState?.lightingProfile || {};
    const furnitureHint = roomState?.furnitureMemory || {};
    const relationalHint = roomState?.relationalSummary || {};

    if (isReferenceViewWithMaster) {
      const isReverseAngle = detectReverseAngle({
        roomConsistency,
        anchorMap: opts.referenceAnchorMap || null,
      });
      const operationalAnchorMap = buildOperationalAnchorMap(
        canonicalRoomType,
        isReverseAngle,
        opts.referenceAnchorMap || null,
      );
      const supplementalAnchorMapBlock = formatStructuredAnchorMapForPrompt(opts.referenceAnchorMap || null);
      const consistencyOverride = buildSecondaryReferencePrompt({
        canonicalRoomType,
        roomId: roomConsistency.roomId,
        operationalAnchorMap,
        supplementalAnchorMapBlock,
      });
      textPrompt = consistencyOverride + textPrompt;
    }

    textPrompt += `\n\nROOM CONSISTENCY
View role: ${roleLabel}
Room ID: ${roomConsistency.roomId}
Style: ${styleHint}
Furniture continuity: ${furnitureHint.persistentIdentityGoal || "Preserve anchor identity, color continuity, and materials."}
Material palette: ${(furnitureHint.materialPalette || []).join(", ") || "neutral, wood, textile"}
Placement directive: ${relationalHint.placementDirective || "Preserve room-relative furnishing anchors while maintaining spatial plausibility in this viewpoint."}
Lighting continuity: brightness=${lightingHint.brightnessProfile || "balanced"}, warmth=${lightingHint.warmthProfile || "neutral"}, weather=${lightingHint.weatherMood || "neutral"}, direction=${lightingHint.directionHint || "unknown"}, shadow_softness=${lightingHint.shadowSoftness || "soft"}
Anchor visibility: ${relationalHint.anchorVisibility || "medium"}`;
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

  if (opts.layoutPlan && !isReferenceViewWithMaster) {
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
  } else if (opts.layoutPlan && isReferenceViewWithMaster) {
    nLog("[ROOM_CONSISTENCY_LAYOUT_PLAN_SKIPPED]", {
      jobId: opts.jobId,
      imageId: opts.imageId,
      reason: "secondary_reference_view_uses_world_space_anchor_transfer",
    });
  }

  const retryReason: Stage2RetryReason = attemptNumber > 1
    ? (structuralRetryContext
        ? mapStructuralFailureTypeToRetryReason(structuralRetryContext.failureType)
        : "unknown")
    : "initial";

  const generationPlan = resolveStage2GenerationPlanForAttempt(
    attemptNumber,
    retryReason,
    isReferenceViewWithMaster
  );
  const continuityGroupId = resolveContinuityGroupId(roomConsistency);

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
  if (isReferenceViewWithMaster && opts.referenceImagePath) {
    const finalSecondaryReminder = `Final requirement:
Preserve the TARGET room architecture, camera geometry, framing, and perspective exactly.
Only furnishings may change, and they must adapt to the TARGET room.
The TARGET image must become a properly staged continuation of the approved room state.
Mandatory: transfer the established furniture family and relational layout logic from the REFERENCE image.
Returning the TARGET image unchanged or nearly unchanged is incorrect.

If any conflict exists between TARGET geometry and REFERENCE composition, TARGET geometry always wins.
The REFERENCE image is furnishing continuity guidance only, not a compositional template.
Do not reconstruct the REFERENCE room framing, wall geometry, layout shell, or perspective.
Keep TARGET vanishing points, camera framing, crop, horizon alignment, and field-of-view locked.
Major furniture continuity matters most; minor decorative objects may vary naturally.
Use the REFERENCE image to preserve the same staged room state, furniture family, and object relationships from this new angle.`;
    requestParts.push({ text: textPrompt });
    requestParts.push({ inlineData: { mimeType: mime, data } });
    const ref = toBase64(opts.referenceImagePath);
    requestParts.push({ inlineData: { mimeType: ref.mime, data: ref.data } });
    requestParts.push({ text: finalSecondaryReminder });
  } else {
    // Preferred ordering for non-room-consistency paths: prompt first, then base image(s), then explicit mask.
    requestParts.push({ text: textPrompt });
    requestParts.push({ inlineData: { mimeType: mime, data } });
    if (opts.referenceImagePath) {
      const ref = toBase64(opts.referenceImagePath);
      requestParts.push({
        text: "APPROVED_MASTER_STAGED_REFERENCE — This is the approved virtual staging output for this same room photographed from a different camera angle. Use it as same-room furnishing continuity guidance only: preserve major furniture identity, furnishing family, room-relative layout continuity, overall style palette, material finishes, and styling decisions whenever they can naturally appear from this angle. Furnishing transfer is mandatory for naturally visible pieces. The TARGET image must become a staged continuation of this approved room state, not an unchanged copy of the input. The REFERENCE image is NOT a compositional template. Do NOT reconstruct the reference room framing, wall geometry, room proportions, or perspective. Do NOT copy the reference camera framing, and do NOT alter the TARGET architecture, openings, vanishing points, camera geometry, or perspective to imitate the reference. Furniture must adapt to the TARGET room geometry; the room must never adapt to the reference furniture. Major furniture continuity matters most; minor decorative objects may vary naturally.",
      });
      requestParts.push({ inlineData: { mimeType: ref.mime, data: ref.data } });
    }
  }
  if (stagingMaskBuffer) {
    try {
      const maskB64 = stagingMaskBuffer.toString("base64");
      requestParts.push({ inlineData: { mimeType: "image/png", data: maskB64 } });
    } catch (e) {
      focusLog("STAGE2_MASK", "[stage2] Failed to attach mask to requestParts", { error: String(e), jobId: opts.jobId });
    }
  }

  if (isReferenceViewWithMaster) {
    const promptWeighting = collectSecondaryViewPromptWeighting(textPrompt);
    nLog("[ROOM_CONSISTENCY_PROVIDER_DEBUG]", {
      phase: "request",
      jobId: opts.jobId,
      imageId: opts.imageId,
      attempt: attemptNumber,
      promptChars: textPrompt.length,
      promptEstimatedTokens: estimatePromptTokens(textPrompt),
      requestPartCount: requestParts.length,
      imageCount: countInlineImages(requestParts),
      hasStructuredAnchorMap: !!opts.referenceAnchorMap,
      hasMask: !!stagingMaskBuffer,
      promptWeighting,
    });
  }

  nLog(`[STAGE2_MODEL_ESCALATION] job_id=${opts.jobId} attempt=${attemptNumber} model=${generationPlan.model} profile=${generationPlan.profileName} temperature=${generationPlan.temperature} topP=${generationPlan.topP} topK=${generationPlan.topK} candidateCount=${generationPlan.candidateCount} retry_reason=${retryReason} continuity_mode=${isReferenceViewWithMaster}`);
  nLog(`[STAGE2_MODEL] attempt=${attemptNumber} model=${generationPlan.model} profile=${generationPlan.profileName}`);
  const generationConfig: any = {
    temperature: generationPlan.temperature,
    topP: generationPlan.topP,
    topK: generationPlan.topK,
    candidateCount: generationPlan.candidateCount,
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(opts.profile?.seed !== undefined ? { seed: opts.profile.seed } : {}),
  };

  if (generationPlan.profileName === "SECONDARY_VIEW_CONTINUITY_PROFILE") {
    nLog("[SECONDARY_VIEW_CONTINUITY_PROFILE]", {
      jobId: opts.jobId,
      imageId: opts.imageId,
      continuityGroupId,
      attempt: attemptNumber,
      temperature: generationConfig.temperature,
      topP: generationConfig.topP,
      topK: generationConfig.topK,
      candidateCount: generationConfig.candidateCount,
      continuityMode: isReferenceViewWithMaster,
    });
  }

  nLog("[STAGE2_GENERATION_PROFILE]", {
    jobId: opts.jobId,
    imageId: opts.imageId,
    continuityGroupId,
    attempt: attemptNumber,
    profileName: generationPlan.profileName,
    temperature: generationConfig.temperature,
    topP: generationConfig.topP,
    topK: generationConfig.topK,
    candidateCount: generationConfig.candidateCount,
    continuityMode: isReferenceViewWithMaster,
    requestPartCount: requestParts.length,
    hasStructuredAnchorMap: !!opts.referenceAnchorMap,
  });

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
    if (isReferenceViewWithMaster) {
      nLog("[ROOM_CONSISTENCY_PROVIDER_DEBUG]", {
        phase: "error",
        jobId: opts.jobId,
        imageId: opts.imageId,
        attempt: attemptNumber,
        model: generationPlan.model,
        message,
        status: Number(error?.status ?? error?.statusCode) || undefined,
        rawErrorBody: safeTruncateForLog(error?.response || error?.error || error?.cause || error),
      });
    }
    if (/no inline image data|no image data in gemini response/i.test(message)) {
      emitStage2AttemptComplete(false, message);
      throw new Stage2GenerationNoImageError(message);
    }
    emitStage2AttemptComplete(false, message);
    throw new Stage2GenerationFailure(`[stage2] generation failed: ${message}`);
  }

  const responseParts: any[] = (resp as any).candidates?.[0]?.content?.parts || [];
  const img = responseParts.find((p) => p.inlineData);
  if (isReferenceViewWithMaster) {
    nLog("[ROOM_CONSISTENCY_PROVIDER_DEBUG]", {
      phase: "response",
      jobId: opts.jobId,
      imageId: opts.imageId,
      attempt: attemptNumber,
      model: modelUsed,
      responsePartCount: responseParts.length,
      responseSizeChars: estimateResponseSize(resp),
      hasInlineImage: !!img?.inlineData?.data,
      inlineImageBytes: img?.inlineData?.data?.length || 0,
    });
  }
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

  await rejectReferenceEchoIfNeeded({
    basePath,
    candidatePath: opts.outputPath,
    referenceImagePath: opts.referenceImagePath,
    jobId: opts.jobId,
    imageId: opts.imageId,
  });

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
  nLog(`[STAGE2_OUTPUT_PATH] job_id=${opts.jobId} attempt=${attemptNumber} path=${opts.outputPath}`);
  return opts.outputPath;
}

export async function runStage2(
  basePath: string,
  baseStage: "1A" | "1B",
  opts: {
    baseImageUri?: string;
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
    roomConsistencyV1?: RoomConsistencyContextV1;
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
  const workerIdentity = process.env.WORKER_ROLE || "worker";
  const queueName = CONTINUITY_RENDER_QUEUE;
  const executionAuthority = "main-worker";
  const dispatchTarget = "worker-vertex-experimental";
  const provider = SECONDARY_CONTINUITY_PROVIDER.toLowerCase();
  const stage2Mode = opts.stage2Mode || null;
  const continuityGroupId = resolveContinuityGroupId(opts.roomConsistencyV1);
  const isReferenceContinuityJob =
    opts.roomConsistencyV1?.enabled === true
    && opts.roomConsistencyV1?.viewRole === "reference";
  const isSecondaryRoomConsistencyStage2 =
    isReferenceContinuityJob
    && !!String(opts.roomConsistencyV1?.approvedMasterImageUrl || "").trim()
    && !!opts.referenceImagePath;
  const hasSupportedExperimentalRouting =
    provider === "vertex"
    && SECONDARY_CONTINUITY_RENDERER.toLowerCase() === "imagen3"
    && SECONDARY_CONTINUITY_PLANNER.toLowerCase() === "gemini25pro";
  const referenceAnchorMap = isSecondaryRoomConsistencyStage2 && opts.referenceImagePath
    ? await extractStructuredFurnishingAnchorMap({
        referenceImagePath: opts.referenceImagePath,
        roomType: opts.roomType,
        stagingStyle: opts.stagingStyle,
        jobId: opts.jobId,
        imageId: opts.imageId,
      })
    : null;

  const runAttempt = async (attempt: number, structuralRetryContext?: {
    compositeFail: boolean;
    failureType: StructuralFailureType | null;
    attemptNumber: number;
  }): Promise<string> => {
    const renderMode = resolvedPromptMode === "full" ? "full_secondary_continuity" : "continuity_refresh";

    if (isReferenceContinuityJob && !isSecondaryRoomConsistencyStage2) {
      nLog("[CONTINUITY_DISPATCH_FAILURE]", {
        continuityGroupId,
        imageId: opts.imageId,
        jobId: opts.jobId,
        renderMode,
        queueName,
        workerIdentity,
        executionAuthority,
        executionMode: "orchestrator-preflight",
        dispatchTarget,
        provider,
        stage2Mode,
        error: "missing_approved_master_reference",
      });
      nLog("[CONTINUITY_INLINE_EXECUTION_DETECTED]", {
        continuityGroupId,
        imageId: opts.imageId,
        jobId: opts.jobId,
        renderMode,
        queueName,
        workerIdentity,
        executionAuthority,
        executionMode: "inline-blocked",
        dispatchTarget: "legacy-stage2-inline",
        provider,
        stage2Mode,
        reason: "secondary_continuity_missing_master_reference",
      });
      throw new VertexSecondaryContinuityError(
        "Secondary continuity requires an approved master reference and must dispatch through the experimental queue",
        "secondary_continuity_missing_master_reference"
      );
    }

    if (isSecondaryRoomConsistencyStage2 && opts.referenceImagePath) {
      if (!hasSupportedExperimentalRouting) {
        nLog("[CONTINUITY_DISPATCH_FAILURE]", {
          continuityGroupId,
          imageId: opts.imageId,
          jobId: opts.jobId,
          renderMode,
          queueName,
          workerIdentity,
          executionAuthority,
          executionMode: "orchestrator-preflight",
          dispatchTarget,
          provider,
          stage2Mode,
          error: "secondary_continuity_routing_misconfigured",
          planner: SECONDARY_CONTINUITY_PLANNER,
          renderer: SECONDARY_CONTINUITY_RENDERER,
        });
        nLog("[CONTINUITY_INLINE_EXECUTION_DETECTED]", {
          continuityGroupId,
          imageId: opts.imageId,
          jobId: opts.jobId,
          renderMode,
          queueName,
          workerIdentity,
          executionAuthority,
          executionMode: "inline-blocked",
          dispatchTarget: "legacy-stage2-inline",
          provider,
          stage2Mode,
          reason: "secondary_continuity_routing_misconfigured",
        });
        throw new VertexSecondaryContinuityError(
          "Secondary continuity routing is misconfigured; the normal worker is not allowed to render continuity inline",
          "secondary_continuity_routing_misconfigured"
        );
      }

      nLog("[CONTINUITY_RENDER_REQUEST]", {
        continuityGroupId,
        imageId: opts.imageId,
        jobId: opts.jobId,
        renderMode,
        queueName,
        workerIdentity,
        executionAuthority,
        executionMode: "orchestrator-request",
        dispatchTarget,
        provider,
        stage2Mode,
        sourceStage: opts.sourceStage,
        attempt,
      });

      try {
        nLog("[CONTINUITY_CONSTRAINT_MASK_SOURCE]", {
          continuityGroupId,
          imageId: opts.imageId,
          jobId: opts.jobId,
          renderMode,
          source: occupancyConstraintMaskPath ? "staging-region-mask" : "none",
          occupancyConstraintMaskPath: occupancyConstraintMaskPath || null,
          hasStagingRegion: !!opts.stagingRegion,
          fallbackModeIfMissing: "planner-occupancy-without-constraint-mask",
        });
        localReasons.push(`vertex_secondary_continuity_attempt:${attempt}`);
        return await runExperimentalSecondaryContinuity({
          secondaryImagePath: basePath,
          secondaryImageUri: opts.baseImageUri || null,
          masterImagePath: opts.referenceImagePath,
          masterImageUri: opts.roomConsistencyV1?.approvedMasterImageUrl || null,
          occupancyConstraintMaskPath,
          outputPath,
          roomType: opts.roomType,
          stagingStyle: opts.stagingStyle,
          roomConsistency: opts.roomConsistencyV1,
          continuityGroupId,
          jobId: opts.jobId,
          imageId: opts.imageId,
          attempt,
          renderMode,
          intent: {
            operationLabel: "secondary_room_continuity_render",
            promptScope: resolvedPromptMode,
            rendererIsolationMode: "continuity_strict_insertion",
            plannerVersion: SECONDARY_CONTINUITY_PLANNER,
            rendererVersion: SECONDARY_CONTINUITY_RENDERER,
          },
        });
      } catch (error: any) {
        const fallbackReason = error instanceof VertexSecondaryContinuityError
          ? error.fallbackReason
          : "vertex_secondary_continuity_error";
        nLog("[CONTINUITY_DISPATCH_FAILURE]", {
          continuityGroupId,
          imageId: opts.imageId,
          jobId: opts.jobId,
          renderMode,
          queueName,
          workerIdentity,
          executionAuthority,
          executionMode: "orchestrator-dispatch",
          dispatchTarget,
          provider,
          stage2Mode,
          error: String(error?.message || error),
          fallbackReason,
        });
        throw wrapRetryableSecondaryContinuityError(error);
      }
    }

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
      roomConsistencyV1: opts.roomConsistencyV1,
      referenceAnchorMap,
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

