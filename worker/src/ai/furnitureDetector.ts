// server/ai/furnitureDetector.ts

import { GoogleGenAI } from '@google/genai';

export interface DetectedItem {
  type: string;
  confidence: number;
}

export type FurnitureItemType =
  | "bed"
  | "sofa"
  | "chair"
  | "table"
  | "desk"
  | "nightstand"
  | "dresser"
  | "tv"
  | "appliance"
  | "decor"
  | "other";

export interface FurnitureItem {
  type: FurnitureItemType;
  label: string;
  isAnchor: boolean;
  confidence: number;
  legacyType?: string;
  condition?: 'good' | 'worn' | 'outdated' | 'poor' | 'clutter';
  location?: {
    bbox: [number, number, number, number]; // [x, y, width, height]
    description: string; // e.g., "center of room", "against back wall", "on kitchen counter", "window sill"
  };
  style?: string; // e.g., "traditional", "modern", "rustic", "vintage", "mixed", "cluttered"
  replaceable?: boolean; // whether this item is a good candidate for replacement
  size?: 'small' | 'medium' | 'large';
}

export interface FurnitureAnalysis {
  hasFurniture: boolean;
  detectedAnchors: string[];
  detectedItems?: DetectedItem[];
  confidence: number;
  hasMovableSeating: boolean;
  hasCounterClutter: boolean;
  hasSurfaceClutter: boolean;
  hasLoosePortableItems: boolean;
  isStageReady: boolean;
  roomType: 'living_room' | 'bedroom' | 'dining_room' | 'office' | 'kitchen' | 'bathroom' | 'other';
  furnitureItems?: FurnitureItem[];
  layoutDescription: string;
  replacementOpportunity: 'high' | 'medium' | 'low' | 'none';
  suggestions: string[];
}

export type FurnitureDetectionSuccess = FurnitureAnalysis & {
  status: "success";
  detectorLatencyMs?: number;
};
export type FurnitureDetectorFailureCode =
  | "timeout"
  | "rate_limit"
  | "parse_failure"
  | "empty_response"
  | "unknown";

export type FurnitureDetectionFailure = {
  status: "failed";
  detectorLatencyMs?: number;
  failureCode?: FurnitureDetectorFailureCode;
  retryable?: boolean;
  statusCode?: number | null;
  message?: string;
  attempts?: number;
};
export type FurnitureDetectionResult = FurnitureDetectionSuccess | FurnitureDetectionFailure;
export type RoomStateDetectionResult =
  | {
      success: true;
      state: RoomState;
    }
  | {
      success: false;
      error: string;
    };

/** @deprecated Use deriveRoomState instead. */
export type FurnishedGateDecisionType = "furnished_refresh" | "empty_full_stage" | "needs_declutter_light";

/** @deprecated Use the explicit routing fields instead of this legacy gate-only shape. */
export interface FurnishedGateDecision {
  decision: FurnishedGateDecisionType;
  reason: string;
  confidence: number;
  anchors: string[];
  roomState: "EMPTY" | "FURNISHED_TIDY" | "FURNISHED_CLUTTERED";
  hasClutter: boolean;
  directRefreshEligible: boolean;
  requiresStage1B: boolean;
  stage2ModeCandidate: "FROM_EMPTY" | "REFRESH" | null;
}

/** Canonical room state output from the furniture detector. Routing decisions are made in worker.ts. */
export type RoomState = "EMPTY" | "ANCHOR_CLEAN" | "CLUTTERED";

export type RoutingRoomState = "EMPTY" | "FURNISHED_TIDY" | "FURNISHED_CLUTTERED";

export const CORE_ANCHOR_CLASSES = [
  "bed",
  "sofa",
  "dining_table",
  "desk",
  "coffee_table",
  "tv",
  "freestanding_wardrobe",
  "large_freestanding_cabinet",
] as const;

const CORE_ANCHOR_SET = new Set<string>(CORE_ANCHOR_CLASSES);

/**
 * Returns true when an item type is a natural supporting companion for the present anchors
 * and should NOT count as excess furniture.
 */
function isSupportingItem(itemType: FurnitureItemType, anchors: string[]): boolean {
  // Decor is always supporting (wall art, plants, decorative objects)
  if (itemType === "decor") return true;

  if (anchors.includes("bed")) {
    if (itemType === "nightstand" || itemType === "dresser") return true;
  }

  if (anchors.includes("sofa") || anchors.includes("coffee_table")) {
    if (itemType === "table" || itemType === "chair") return true;
  }

  if (anchors.includes("dining_table")) {
    if (itemType === "chair") return true;
  }

  if (anchors.includes("desk")) {
    if (itemType === "chair") return true;
  }

  return false;
}

function toBool(value: unknown): boolean {
  return value === true;
}

function toRoomType(rawRoomType: unknown): string {
  return String(rawRoomType || "")
    .toLowerCase()
    .replace(/-/g, "_")
    .trim();
}

function isLivingRoomType(normalizedRoomType: string): boolean {
  return normalizedRoomType === "living_room" || normalizedRoomType === "living" || normalizedRoomType === "lounge";
}

function parseErrorStatusCode(err: any): number | null {
  const direct = Number((err as any)?.status ?? (err as any)?.statusCode);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const code = String((err as any)?.code ?? "").trim();
  if (/^\d{3}$/.test(code)) {
    return Number(code);
  }

  const msg = String((err as any)?.message ?? "");
  const httpMatch = msg.match(/\b(429|5\d\d)\b/);
  if (httpMatch) {
    return Number(httpMatch[1]);
  }

  return null;
}

function isTimeoutError(err: any): boolean {
  const code = String((err as any)?.code ?? "").toLowerCase();
  const name = String((err as any)?.name ?? "").toLowerCase();
  const msg = String((err as any)?.message ?? "").toLowerCase();
  return (
    name === "aborterror"
    || code.includes("timeout")
    || code === "etimedout"
    || code === "abort_err"
    || code === "aborted"
    || msg.includes("aborted sending request")
    || msg.includes("this operation was aborted")
    || msg.includes("timeout")
    || msg.includes("timed out")
    || msg.includes("deadline exceeded")
  );
}

function isRateLimitError(err: any): boolean {
  return parseErrorStatusCode(err) === 429;
}

function classifyFurnitureDetectorFailure(err: unknown): FurnitureDetectorFailureCode {
  if (isTimeoutError(err)) {
    return "timeout";
  }

  if (isRateLimitError(err)) {
    return "rate_limit";
  }

  const message = String((err as any)?.message ?? "").toLowerCase();
  if (message.includes("no json object found")) {
    return "empty_response";
  }

  if (
    message.includes("missing required schema") ||
    message.includes("unexpected token") ||
    message.includes("json")
  ) {
    return "parse_failure";
  }

  return "unknown";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FURNITURE_DETECTOR_MAX_CONCURRENCY = Math.max(
  1,
  Math.min(3, Number(process.env.FURNITURE_DETECTOR_MAX_CONCURRENCY || 2))
);
const FURNITURE_DETECTOR_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.FURNITURE_DETECTOR_TIMEOUT_MS || 15000)
);
const FURNITURE_DETECTOR_MAX_ATTEMPTS = 2;

let activeFurnitureDetectorRequests = 0;
const furnitureDetectorWaiters: Array<() => void> = [];

async function withFurnitureDetectorSlot<T>(operation: () => Promise<T>): Promise<T> {
  while (activeFurnitureDetectorRequests >= FURNITURE_DETECTOR_MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => furnitureDetectorWaiters.push(resolve));
  }

  activeFurnitureDetectorRequests += 1;

  try {
    return await operation();
  } finally {
    activeFurnitureDetectorRequests = Math.max(0, activeFurnitureDetectorRequests - 1);
    const next = furnitureDetectorWaiters.shift();
    if (next) {
      next();
    }
  }
}

export const detectorQueue = {
  add<T>(operation: () => Promise<T>): Promise<T> {
    return withFurnitureDetectorSlot(operation);
  },
};

function getFurnitureDetectorRetryDelayMs(attemptIndex: number): number {
  const baseDelayMs = attemptIndex === 0 ? 600 : 1800;
  const jitterMs = Math.floor(Math.random() * 250);
  return baseDelayMs + jitterMs;
}

function delayWithBackoff(attemptIndex: number): Promise<void> {
  const delays = [0, 1500, 3000, 5000];
  return delay(delays[attemptIndex] ?? 5000);
}

function normalizeFurnitureAnalysis(
  parsed: Partial<FurnitureAnalysis> & { detectedAnchors?: unknown; confidence?: unknown }
): FurnitureAnalysis {
  const normalizedAnchors = Array.isArray(parsed.detectedAnchors)
    ? parsed.detectedAnchors
      .map((anchor) => String(anchor || "").toLowerCase().trim().replace(/\s+/g, "_"))
      .filter((anchor) => CORE_ANCHOR_SET.has(anchor))
    : [];

  const normalizedConfidence = typeof parsed.confidence === "number"
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0;

  return {
    hasFurniture: Boolean(parsed.hasFurniture),
    detectedAnchors: normalizedAnchors,
    detectedItems: normalizeDetectedItems((parsed as any).detectedItems),
    confidence: normalizedConfidence,
    hasMovableSeating: toBool((parsed as any).hasMovableSeating),
    hasCounterClutter: toBool((parsed as any).hasCounterClutter),
    hasSurfaceClutter: toBool((parsed as any).hasSurfaceClutter),
    hasLoosePortableItems: toBool((parsed as any).hasLoosePortableItems),
    isStageReady: toBool((parsed as any).isStageReady),
    roomType: (parsed.roomType as FurnitureAnalysis["roomType"]) || "other",
    furnitureItems: normalizeFurnitureItems((parsed as any).furnitureItems),
    layoutDescription: typeof parsed.layoutDescription === "string" ? parsed.layoutDescription : "",
    replacementOpportunity: (parsed.replacementOpportunity as FurnitureAnalysis["replacementOpportunity"]) || "none",
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map((suggestion) => String(suggestion)) : [],
  };
}

function parseFurnitureAnalysisResponse(text: string): FurnitureAnalysis {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON object found in response");
  }

  let jsonStr = jsonMatch[0];
  console.log("[FURNITURE DETECTOR] Extracted JSON:", JSON.stringify(jsonStr));

  try {
    const parsed = JSON.parse(jsonStr) as Partial<FurnitureAnalysis> & {
      detectedAnchors?: unknown;
      detectedItems?: unknown;
      confidence?: unknown;
      hasFurniture?: unknown;
      hasMovableSeating?: unknown;
      hasCounterClutter?: unknown;
      hasSurfaceClutter?: unknown;
      hasLoosePortableItems?: unknown;
      isStageReady?: unknown;
    };
    const hasExpectedSchema =
      typeof parsed.hasFurniture === "boolean"
      && Array.isArray(parsed.detectedAnchors)
      && parsed.detectedAnchors.every((anchor) => typeof anchor === "string")
      && Array.isArray(parsed.detectedItems)
      && parsed.detectedItems.every((item) => {
        if (!item || typeof item !== "object") {
          return false;
        }

        return typeof (item as any).type === "string"
          && typeof (item as any).confidence === "number"
          && Number.isFinite((item as any).confidence);
      })
      && typeof parsed.confidence === "number"
      && Number.isFinite(parsed.confidence)
      && typeof parsed.hasMovableSeating === "boolean"
      && typeof parsed.hasCounterClutter === "boolean"
      && typeof parsed.hasSurfaceClutter === "boolean"
      && typeof parsed.hasLoosePortableItems === "boolean"
      && typeof parsed.isStageReady === "boolean";

    if (!hasExpectedSchema) {
      throw new Error("Detector response missing required schema fields");
    }

    return normalizeFurnitureAnalysis(parsed);
  } catch (error) {
    let braceCount = 0;
    let jsonEnd = -1;
    for (let index = 0; index < jsonStr.length; index += 1) {
      if (jsonStr[index] === '{') braceCount += 1;
      if (jsonStr[index] === '}') {
        braceCount -= 1;
        if (braceCount === 0) {
          jsonEnd = index;
          break;
        }
      }
    }

    if (jsonEnd > 0) {
      jsonStr = jsonStr.substring(0, jsonEnd + 1);
      console.log("[FURNITURE DETECTOR] Trimmed JSON:", JSON.stringify(jsonStr));
      const trimmedParsed = JSON.parse(jsonStr) as Partial<FurnitureAnalysis> & {
        detectedAnchors?: unknown;
        detectedItems?: unknown;
        confidence?: unknown;
        hasFurniture?: unknown;
        hasMovableSeating?: unknown;
        hasCounterClutter?: unknown;
        hasSurfaceClutter?: unknown;
        hasLoosePortableItems?: unknown;
        isStageReady?: unknown;
      };

      const hasExpectedSchema =
        typeof trimmedParsed.hasFurniture === "boolean"
        && Array.isArray(trimmedParsed.detectedAnchors)
        && trimmedParsed.detectedAnchors.every((anchor) => typeof anchor === "string")
        && Array.isArray(trimmedParsed.detectedItems)
        && trimmedParsed.detectedItems.every((item) => {
          if (!item || typeof item !== "object") {
            return false;
          }

          return typeof (item as any).type === "string"
            && typeof (item as any).confidence === "number"
            && Number.isFinite((item as any).confidence);
        })
        && typeof trimmedParsed.confidence === "number"
        && Number.isFinite(trimmedParsed.confidence)
        && typeof trimmedParsed.hasMovableSeating === "boolean"
        && typeof trimmedParsed.hasCounterClutter === "boolean"
        && typeof trimmedParsed.hasSurfaceClutter === "boolean"
        && typeof trimmedParsed.hasLoosePortableItems === "boolean"
        && typeof trimmedParsed.isStageReady === "boolean";

      if (!hasExpectedSchema) {
        throw new Error("Detector response missing required schema fields");
      }

      return normalizeFurnitureAnalysis(trimmedParsed);
    }

    throw error;
  }
}

export function isFurnitureDetectionSuccess(
  result: FurnitureDetectionResult | null | undefined
): result is FurnitureDetectionSuccess {
  return result?.status === "success";
}

/**
 * Derives the canonical room state from a furniture analysis.
 * This is the single routing signal consumed by worker.ts — no routing logic lives here.
 */
export function deriveRoomState(analysis: FurnitureAnalysis): RoomState {
  const hasClutter =
    analysis.hasCounterClutter ||
    analysis.hasSurfaceClutter ||
    analysis.hasLoosePortableItems;

  const anchors = analysis.detectedAnchors;
  const items: FurnitureItem[] = Array.isArray(analysis.furnitureItems) ? analysis.furnitureItems : [];

  const state: RoomState = (() => {
    if (!analysis.hasFurniture && !hasClutter) {
      return "EMPTY";
    }

    if (hasClutter) {
      return "CLUTTERED";
    }

    const nonSupportingItems = items.filter(
      (item) => !item.isAnchor && !isSupportingItem(item.type, anchors)
    );

    if (anchors.length > 0 && nonSupportingItems.length === 0) {
      return "ANCHOR_CLEAN";
    }

    return "CLUTTERED";
  })();

  console.log("[detector-state]", {
    state,
    anchors,
    furnitureItems: items.map((item) => item.type),
    clutterFlags: {
      hasCounterClutter: analysis.hasCounterClutter,
      hasSurfaceClutter: analysis.hasSurfaceClutter,
      hasLoosePortableItems: analysis.hasLoosePortableItems,
    },
  });

  return state;
}

function parseRoomStateResponse(text: string): { state?: RoomState } {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {};
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { state?: unknown };
    const state = String(parsed?.state || "").trim().toUpperCase();
    if (state === "EMPTY" || state === "ANCHOR_CLEAN" || state === "CLUTTERED") {
      return { state: state as RoomState };
    }
  } catch {
    return {};
  }

  return {};
}

function isValidRoomStateResult(result: { state?: RoomState } | null | undefined): result is { state: RoomState } {
  return !!result?.state && ["EMPTY", "ANCHOR_CLEAN", "CLUTTERED"].includes(result.state);
}

async function callGeminiRoomState(
  ai: GoogleGenAI,
  imageBase64: string,
  model: "gemini-2.0-flash" | "gemini-2.5-flash"
): Promise<{ state?: RoomState }> {
  const prompt = `You are classifying an interior real estate image for deterministic staging workflow routing.

Return JSON only in this exact format:
{"state":"EMPTY"}
or
{"state":"ANCHOR_CLEAN"}
or
{"state":"CLUTTERED"}

Definitions:
- EMPTY: no clearly visible large movable furniture anchors and no visible clutter requiring declutter.
- ANCHOR_CLEAN: clearly visible large movable furniture anchors are present, but the room is already clean enough to skip declutter.
- CLUTTERED: visible clutter, loose portable items, or secondary movable items are present and declutter is required before staging.

Allowed large movable furniture anchors:
- bed
- sofa
- dining_table
- coffee_table
- desk
- tv (living rooms only)
- freestanding_wardrobe
- large_freestanding_cabinet

Do not count curtains, blinds, rugs alone, wall art, ceiling fixtures, HVAC, or built-in cabinetry as anchors.
Do not guess. If uncertain, return {"state":"INVALID"}.`;

  const response = await ai.models.generateContent({
    model,
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { inlineData: { data: imageBase64, mimeType: "image/png" } },
      ],
    }],
  });

  const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text).join("") ?? "{}";
  console.log("[ROOM STATE DETECTOR] Raw AI response:", JSON.stringify(text));
  return parseRoomStateResponse(text);
}

export async function detectRoomStateWithRetry(
  ai: GoogleGenAI,
  imageBase64: string
): Promise<RoomStateDetectionResult> {
  const models: Array<{ model: "gemini-2.0-flash" | "gemini-2.5-flash"; attempts: number }> = [
    { model: "gemini-2.0-flash", attempts: 2 },
    { model: "gemini-2.5-flash", attempts: 2 },
  ];

  let globalAttemptIndex = 0;

  for (const { model, attempts } of models) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await callGeminiRoomState(ai, imageBase64, model);
        if (isValidRoomStateResult(result)) {
          return { success: true, state: result.state };
        }
      } catch (error) {
        console.warn("[ROOM STATE DETECTOR] Attempt failed", {
          attempt: globalAttemptIndex + 1,
          model,
          retryable: isRateLimitError(error) || isTimeoutError(error),
          statusCode: parseErrorStatusCode(error),
          message: error instanceof Error ? error.message : String(error),
        });
      }

      await delayWithBackoff(globalAttemptIndex);
      globalAttemptIndex += 1;
    }
  }

  return {
    success: false,
    error: "DETECTION_FAILED_AFTER_RETRIES",
  };
}

/** @deprecated Use deriveRoomState + worker.ts routing instead. */
export function resolveFurnishedGateDecision(params: {
  analysis: FurnitureDetectionResult | null;
  localEmpty: boolean;
  roomType?: string;
  minConfidence?: number;
  /**
   * Retained for compatibility with older call sites.
   * Clutter signals are now authoritative regardless of user intent.
   */
  userSelectedDeclutter?: boolean;
}): FurnishedGateDecision {
  const minConfidence = typeof params.minConfidence === "number" ? params.minConfidence : 0.65;
  const normalizedRoomType = toRoomType(params.roomType);
  const livingRoomLike = isLivingRoomType(normalizedRoomType);
  const isKitchenLike = normalizedRoomType === "kitchen" || normalizedRoomType.startsWith("kitchen_");

  const buildDecision = (input: FurnishedGateDecision): FurnishedGateDecision => input;

  if (params.localEmpty) {
    return buildDecision({
      decision: "empty_full_stage",
      reason: "local_empty_prefilter",
      confidence: 1,
      anchors: [],
      roomState: "EMPTY",
      hasClutter: false,
      directRefreshEligible: false,
      requiresStage1B: false,
      stage2ModeCandidate: "FROM_EMPTY",
    });
  }

  if (!params.analysis || params.analysis.status === "failed") {
    return buildDecision({
      decision: "empty_full_stage",
      reason: params.analysis?.status === "failed" ? "detector_failed_conservative" : "detector_missing_conservative",
      confidence: 0,
      anchors: [],
      roomState: "FURNISHED_CLUTTERED",
      hasClutter: true,
      directRefreshEligible: false,
      requiresStage1B: true,
      stage2ModeCandidate: "REFRESH",
    });
  }

  const analysis = params.analysis;

  const anchors = Array.isArray(analysis.detectedAnchors)
    ? analysis.detectedAnchors
      .map((anchor) => String(anchor || "").toLowerCase().trim().replace(/\s+/g, "_"))
      .filter((anchor) => CORE_ANCHOR_SET.has(anchor))
    : [];

  const hasTvAnchor = anchors.includes("tv");
  const hasNonTvAnchor = anchors.some((anchor) => anchor !== "tv");
  const hasEligibleAnchor = hasNonTvAnchor || (livingRoomLike && hasTvAnchor);
  const tvOnlyAnchor = hasTvAnchor && !hasNonTvAnchor;
  const hasEligibleFurnitureSignal =
    analysis.hasFurniture === true && (!tvOnlyAnchor || livingRoomLike);

  const confidence = typeof analysis.confidence === "number"
    ? Math.max(0, Math.min(1, analysis.confidence))
    : 0;

  const hasCounterClutter = toBool(analysis.hasCounterClutter);
  const hasSurfaceClutter = toBool(analysis.hasSurfaceClutter);
  const hasLoosePortableItems = toBool(analysis.hasLoosePortableItems);
  const hasMovableSeating = toBool(analysis.hasMovableSeating);
  const hasClutterSignals = hasCounterClutter || hasSurfaceClutter || hasLoosePortableItems;
  const hasKitchenDeclutterSignals = hasMovableSeating || hasClutterSignals;
  const detectedItems = Array.isArray(analysis.detectedItems) ? analysis.detectedItems : [];

  const minorPortableClutterOnly =
    !hasCounterClutter
    && !hasSurfaceClutter
    && hasLoosePortableItems
    && detectedItems.length > 0
    && detectedItems.length <= 2;

  const roomState: RoutingRoomState = (() => {
    if (!analysis.hasFurniture && !hasClutterSignals) {
      return "EMPTY";
    }

    if (hasClutterSignals || minorPortableClutterOnly || (isKitchenLike && hasKitchenDeclutterSignals)) {
      return "FURNISHED_CLUTTERED";
    }

    if (hasEligibleAnchor || hasEligibleFurnitureSignal || analysis.isStageReady === true) {
      return "FURNISHED_TIDY";
    }

    return "FURNISHED_CLUTTERED";
  })();

  const requiresStage1B = roomState === "FURNISHED_CLUTTERED";
  const directRefreshEligible = roomState === "FURNISHED_TIDY";
  const stage2ModeCandidate: "FROM_EMPTY" | "REFRESH" | null = roomState === "EMPTY" ? "FROM_EMPTY" : "REFRESH";

  if (confidence < minConfidence) {
    return buildDecision({
      decision: "needs_declutter_light",
      reason: "low_confidence_fail_safe",
      confidence,
      anchors,
      roomState: "FURNISHED_CLUTTERED",
      hasClutter: true,
      directRefreshEligible: false,
      requiresStage1B: true,
      stage2ModeCandidate: "REFRESH",
    });
  }

  if (roomState === "FURNISHED_TIDY") {
    return buildDecision({
      decision: "furnished_refresh",
      reason: hasEligibleAnchor || hasEligibleFurnitureSignal ? "anchor_or_furniture_detected" : "stage_ready_no_signals",
      confidence,
      anchors,
      roomState,
      hasClutter: false,
      directRefreshEligible,
      requiresStage1B: false,
      stage2ModeCandidate: "REFRESH",
    });
  }

  if ((isKitchenLike && hasKitchenDeclutterSignals) || hasClutterSignals || minorPortableClutterOnly) {
    return buildDecision({
      decision: "needs_declutter_light",
      reason: minorPortableClutterOnly
        ? "minor_portable_clutter_requires_declutter"
        : (isKitchenLike ? "kitchen_signals_require_light_declutter" : "clutter_signals_require_light_declutter"),
      confidence,
      anchors,
      roomState: "FURNISHED_CLUTTERED",
      hasClutter: true,
      directRefreshEligible: false,
      requiresStage1B: true,
      stage2ModeCandidate: "REFRESH",
    });
  }

  if (analysis.isStageReady === true) {
    return buildDecision({
      decision: "empty_full_stage",
      reason: "stage_ready_no_signals",
      confidence,
      anchors,
      roomState: "EMPTY",
      hasClutter: false,
      directRefreshEligible: false,
      requiresStage1B: false,
      stage2ModeCandidate: "FROM_EMPTY",
    });
  }

  return buildDecision({
    decision: "empty_full_stage",
    reason: "default_empty_no_signals",
    confidence,
    anchors,
    roomState: roomState === "EMPTY" ? "EMPTY" : roomState,
    hasClutter: roomState === "FURNISHED_CLUTTERED",
    directRefreshEligible,
    requiresStage1B,
    stage2ModeCandidate,
  });
}

export function getAnchorClassSet(analysis: FurnitureAnalysis | FurnitureDetectionResult | null | undefined): Set<string> {
  if (!analysis || (analysis as FurnitureDetectionResult).status === "failed") return new Set<string>();
  const rawAnchors = Array.isArray((analysis as any).detectedAnchors)
    ? (analysis as any).detectedAnchors
    : [];
  return new Set(
    rawAnchors
      .map((anchor: unknown) => String(anchor || "").toLowerCase().trim().replace(/\s+/g, "_"))
      .filter((anchor: string) => CORE_ANCHOR_SET.has(anchor))
  );
}

function normalizeDetectedItems(rawItems: unknown): DetectedItem[] {
  if (!Array.isArray(rawItems)) return [];

  return rawItems
    .map((item) => {
      if (typeof item === "string") {
        return {
          type: item.toLowerCase().trim().replace(/[\s-]+/g, "_"),
          confidence: 0,
        };
      }
      if (!item || typeof item !== "object") return null;

      const rawType = String((item as any).type || "").toLowerCase().trim().replace(/[\s-]+/g, "_");
      const confidence = typeof (item as any).confidence === "number"
        ? Math.max(0, Math.min(1, (item as any).confidence))
        : 0;

      if (!rawType) return null;
      return { type: rawType, confidence };
    })
    .filter((item): item is DetectedItem => !!item);
}

function normalizeFurnitureItemType(rawType: unknown, label: string): FurnitureItemType {
  const normalized = String(rawType || "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  const labelLower = label.toLowerCase();

  if (normalized === "bed" || labelLower.includes("bed")) return "bed";
  if (normalized === "sofa" || normalized === "couch" || labelLower.includes("sofa") || labelLower.includes("couch")) return "sofa";
  if (normalized === "chair" || normalized === "stool" || normalized === "armchair" || normalized === "loose_chair" || labelLower.includes("chair") || labelLower.includes("stool")) return "chair";
  if (
    normalized === "table"
    || normalized === "dining_table"
    || normalized === "coffee_table"
    || normalized === "side_table"
    || normalized === "console_table"
    || normalized === "tv_stand"
    || labelLower.includes("table")
    || labelLower.includes("stand")
  ) return "table";
  if (normalized === "desk" || labelLower.includes("desk")) return "desk";
  if (normalized === "nightstand" || labelLower.includes("nightstand") || labelLower.includes("bedside")) return "nightstand";
  if (
    normalized === "dresser"
    || normalized === "wardrobe"
    || normalized === "freestanding_wardrobe"
    || normalized === "large_freestanding_cabinet"
    || labelLower.includes("dresser")
    || labelLower.includes("wardrobe")
    || labelLower.includes("cabinet")
  ) return "dresser";
  if (normalized === "tv" || labelLower.includes("tv") || labelLower.includes("television")) return "tv";
  if (normalized === "appliance" || labelLower.includes("appliance")) return "appliance";
  if (
    normalized === "decor"
    || normalized === "wall_art"
    || normalized === "decorative_object"
    || normalized === "plant"
    || normalized === "soft_furnishing"
    || normalized === "display_unit"
    || normalized === "bookshelf"
    || normalized === "counter_clutter"
    || normalized === "window_sill_item"
    || normalized === "surface_clutter"
    || labelLower.includes("decor")
    || labelLower.includes("art")
    || labelLower.includes("plant")
  ) return "decor";
  return "other";
}

function normalizeFurnitureItems(rawItems: unknown): FurnitureItem[] | undefined {
  if (!Array.isArray(rawItems)) return undefined;

  const normalizedItems: FurnitureItem[] = [];

  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue;

    const rawType = String((item as any).type || "").toLowerCase().trim().replace(/[\s-]+/g, "_");
    const label = String((item as any).label || rawType || "other").trim();
    const type = normalizeFurnitureItemType(rawType, label);
    const confidence = typeof (item as any).confidence === "number"
      ? Math.max(0, Math.min(1, (item as any).confidence))
      : 0;
    const isAnchor = typeof (item as any).isAnchor === "boolean"
      ? (item as any).isAnchor
      : CORE_ANCHOR_SET.has(rawType);

    const bboxRaw = Array.isArray((item as any).location?.bbox) ? (item as any).location.bbox : null;
    const bbox = bboxRaw && bboxRaw.length === 4
      ? [
          Number(bboxRaw[0]) || 0,
          Number(bboxRaw[1]) || 0,
          Number(bboxRaw[2]) || 0,
          Number(bboxRaw[3]) || 0,
        ] as [number, number, number, number]
      : [0, 0, 0, 0] as [number, number, number, number];

    const condition = (item as any).condition;
    const size = (item as any).size;
    const normalizedItem: FurnitureItem = {
      type,
      label,
      isAnchor,
      confidence,
      ...(rawType && rawType !== type ? { legacyType: rawType } : {}),
      condition: condition === "good" || condition === "worn" || condition === "outdated" || condition === "poor" || condition === "clutter"
        ? condition
        : "good",
      location: {
        bbox,
        description: String((item as any).location?.description || label || type),
      },
      style: typeof (item as any).style === "string" ? (item as any).style : "unknown",
      replaceable: typeof (item as any).replaceable === "boolean" ? (item as any).replaceable : !isAnchor,
      size: size === "small" || size === "medium" || size === "large" ? size : "medium",
    };

    normalizedItems.push(normalizedItem);
  }

  return normalizedItems;
}

/**
 * Analyzes an image to detect existing furniture and assess replacement opportunities
 */
export async function detectFurniture(
  ai: GoogleGenAI,
  imageBase64: string,
  options?: { sceneType?: "interior" | "exterior" }
): Promise<FurnitureDetectionResult> {
  return detectFurnitureWithRetry(ai, imageBase64, options);
}

async function detectFurnitureOnce(
  ai: GoogleGenAI,
  imageBase64: string,
  options?: { sceneType?: "interior" | "exterior"; timeoutMs?: number }
): Promise<FurnitureAnalysis> {
  const sceneType = options?.sceneType === "exterior" ? "exterior" : "interior";
  const system = sceneType === "exterior" ? `
You are determining whether this EXTERIOR real estate image contains clearly identifiable, removable clutter.

Bias toward NO clutter. If you are uncertain, ambiguous, or the object boundary is unclear, return no clutter.

Return JSON only with this exact structure:
{
  "hasFurniture": boolean,
  "detectedAnchors": string[],
  "detectedItems": [{ "type": string, "confidence": number }],
  "confidence": number,
  "hasMovableSeating": boolean,
  "hasCounterClutter": boolean,
  "hasSurfaceClutter": boolean,
  "hasLoosePortableItems": boolean,
  "isStageReady": boolean
}

For detectedItems, only use these canonical removable clutter labels when clearly visible:
- bicycle
- scooter
- ladder
- tools
- wheelbarrow
- hose
- sprinkler
- extension_cord
- bucket
- bin
- trash
- loose_chair
- loose_table
- building_material
- debris

Do NOT treat any of the following as clutter:
- leaves, grass, natural elements, landscaping features
- decorative or intentionally staged outdoor setups
- full outdoor furniture sets
- general messiness, texture noise, shadows, or small ambiguous objects

Non-removable / structural / material conditions are NEVER clutter and must NEVER trigger declutter:
- driveways, paving, concrete, decking, walls, fences, roofs, gutters, paths, steps, pergolas
- cracks, chips, stains, weathering, worn paint, texture variation, patchy concrete, dirty surfaces
- mulch, gravel, soil, dirt patches, lawn variation, weeds, garden beds, edging, stones
- fixed outdoor kitchens, fixed BBQs, built-in benches, fixed planters, retaining walls
- drain covers, service covers, expansion joints, shadows, reflections, water marks

"debris" and "building_material" are only valid when there is a clearly separate portable pile or object with a visible boundary, such as loose boards, offcuts, rubble, packaging, or discarded renovation materials.
Do NOT use "debris" or "building_material" for surface wear, cracked paving, soil, mulch, gravel, or landscaping.

Rules:
- confidence must be between 0 and 1 and reflect your confidence in the clutter assessment.
- detectedItems must be [] unless at least one clearly identifiable removable clutter item is visible as a separate portable object.
- Only report a detected item when the object has a clear boundary and could be removed without reinterpreting or repairing the underlying surface.
- hasSurfaceClutter=true only when removable clutter is clearly visible on exterior surfaces such as decks, patios, tables, or paths.
- hasLoosePortableItems=true only when clearly removable portable exterior clutter is visible.
- hasCounterClutter should be false for exteriors unless obvious removable clutter is visible on an outdoor kitchen or utility surface.
- hasMovableSeating=true only for loose single chairs or stools that are clearly removable, not full outdoor sets.
- If uncertain, set detectedItems to [] and all clutter booleans to false.
- If a candidate signal could also be explained by landscaping, fixed structure, surface damage, weathering, shadows, or texture variation, treat it as NOT clutter.
- detectedAnchors should be [] for exterior scenes unless one of the canonical anchor labels is undeniably visible.
- isStageReady=true only when no clearly removable clutter is visible.
` : `
You are determining whether this room contains LARGE MOVABLE FURNITURE ANCHORS.

A room is considered FURNISHED only if at least one clearly visible anchor exists from this list:
- bed
- sofa
- dining_table
- coffee_table
- desk
- tv (living rooms only)
- freestanding_wardrobe
- large_freestanding_cabinet

Ignore all of the following when deciding furnished status:
- curtains
- blinds
- wall art
- ceiling fixtures
- HVAC units
- built-in cabinetry/counters/islands/vanities
- soft decor
- rugs alone

If only curtains, blinds, rugs, or built-in cabinetry are visible, return hasFurniture=false.
Curtains or wall decor alone do NOT count.

Return JSON only with this exact structure:
{
  "hasFurniture": boolean,
  "detectedAnchors": string[],
  "detectedItems": [{ "type": string, "confidence": number }],
  "confidence": number,
  "hasMovableSeating": boolean,
  "hasCounterClutter": boolean,
  "hasSurfaceClutter": boolean,
  "hasLoosePortableItems": boolean,
  "isStageReady": boolean
}

Rules:
- detectedAnchors must only contain canonical values from the allowed anchor list above.
- detectedItems should usually be [] for interior scenes unless you are highly confident about a clearly identifiable portable clutter object.
- furnitureItems must contain a complete list of visible furniture in the room, including both anchor furniture and secondary items.
- Include ALL visible furniture items. If unsure, include your best guess with a lower confidence rather than omitting the item.
- Do NOT omit furnitureItems. Use [] only when there is truly no visible furniture.
- confidence must be between 0 and 1.
- hasMovableSeating=true if movable stools/chairs/seating are clearly visible.
- hasCounterClutter=true if clutter is clearly visible on kitchen counters/island.
- hasSurfaceClutter=true if clutter is visible on tables/benches/other surfaces.
- hasLoosePortableItems=true for visible loose bags/boxes/portable objects.
- isStageReady=true only when room appears clean and ready for direct staging.
- If no valid anchor is clearly visible, set detectedAnchors to [] and hasFurniture=false.
`;

  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          { text: system },
          { inlineData: { data: imageBase64, mimeType: "image/png" } }
        ]
      }],
      config: {
        httpOptions: {
          timeout: options?.timeoutMs ?? FURNITURE_DETECTOR_TIMEOUT_MS,
        },
      },
    });

    const text = resp.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "{}";
    
    console.log("[FURNITURE DETECTOR] Raw AI response:", JSON.stringify(text));
    const analysis = parseFurnitureAnalysisResponse(text);
    console.log(`[FURNITURE DETECTOR] hasFurniture=${analysis.hasFurniture} anchors=${JSON.stringify(analysis.detectedAnchors)} itemsCount=${analysis.furnitureItems?.length ?? "MISSING"} confidence=${analysis.confidence}`);
    return analysis;
  } catch (error) {
    console.error("[FURNITURE DETECTOR] ❌ Failed to detect furniture");
    console.error("[FURNITURE DETECTOR] Error message:", error instanceof Error ? error.message : String(error));
    console.error("[FURNITURE DETECTOR] Stack trace:", error instanceof Error ? error.stack : 'No stack trace available');
    console.error("[FURNITURE DETECTOR] Error details:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    throw error;
  }
}

export async function detectFurnitureWithRetry(
  ai: GoogleGenAI,
  imageBase64: string,
  options?: { sceneType?: "interior" | "exterior"; timeoutMs?: number }
): Promise<FurnitureDetectionResult> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < FURNITURE_DETECTOR_MAX_ATTEMPTS; attempt += 1) {
    try {
      const analysis = await detectorQueue.add(() =>
        detectFurnitureOnce(ai, imageBase64, {
          ...options,
          timeoutMs: options?.timeoutMs ?? FURNITURE_DETECTOR_TIMEOUT_MS,
        })
      );
      return {
        status: "success",
        ...analysis,
      };
    } catch (error) {
      lastError = error;
      const retryable = isRateLimitError(error) || isTimeoutError(error);
      const lastAttempt = attempt === FURNITURE_DETECTOR_MAX_ATTEMPTS - 1;
      console.warn("[FURNITURE DETECTOR] Detection attempt failed", {
        attempt: attempt + 1,
        retryable,
        statusCode: parseErrorStatusCode(error),
        message: error instanceof Error ? error.message : String(error),
      });

      if (isTimeoutError(error)) {
        console.warn("[FURNITURE_DETECTOR_TIMEOUT]", {
          retryable: true,
          attempt: attempt + 1,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      if (retryable && !lastAttempt) {
        await delay(getFurnitureDetectorRetryDelayMs(attempt));
        continue;
      }

      break;
    }
  }

  const failureCode = classifyFurnitureDetectorFailure(lastError);
  return {
    status: "failed",
    failureCode,
    retryable: lastError ? (isRateLimitError(lastError) || isTimeoutError(lastError)) : false,
    statusCode: lastError ? parseErrorStatusCode(lastError) : null,
    message: lastError instanceof Error ? lastError.message : (lastError ? String(lastError) : "DETECTION_FAILED_AFTER_RETRIES"),
    attempts: FURNITURE_DETECTOR_MAX_ATTEMPTS,
  };
}

/**
 * Generates furniture replacement instructions based on detected items
 * @param analysis - Furniture analysis from detectFurniture
 * @param forceReplacementMode - When true, bypasses "none" opportunity check and forces ALL items to be replaced
 */
export function buildFurnitureReplacementRules(analysis: FurnitureAnalysis | null, forceReplacementMode: boolean = false): string[] {
  // Early exit only if truly no furniture detected
  if (!analysis || !analysis.hasFurniture) {
    console.log(`[FURNITURE RULES] No furniture detected - returning empty rules`);
    return [];
  }
  const furnitureItems = Array.isArray(analysis.furnitureItems) ? analysis.furnitureItems : [];
  
  // Define ALWAYS_REPLACE categories - these MUST be removed regardless of condition
  // Uses only categories that exist in FurnitureItem.type schema
  const ALWAYS_REPLACE = new Set([
    'wall_art',
    'decorative_object',
    'display_unit',
    'console_table',
    'side_table',
    'coffee_table',
    'bookshelf',
    'tv_stand',
    'plant',
    'soft_furnishing',
    'counter_clutter',
    'window_sill_item',
    'surface_clutter',
    'other'  // CRITICAL: "other" type catches miscellaneous items that don't fit categories
  ]);
  
  // When force mode is active, bypass opportunity check and ensure at least 1 item is replaceable
  if (forceReplacementMode) {
    console.log(`[FURNITURE RULES] ⚡ FORCE REPLACEMENT MODE ACTIVE - User explicitly wants furniture replaced`);
    console.log(`[FURNITURE RULES] Detected ${furnitureItems.length} items, forcing ALL to be replaceable`);
    
    // Force ALL detected items to be replaceable (override AI's condition assessment)
    furnitureItems.forEach(item => {
      const wasPreviouslyReplaceable = item.replaceable === true;
      item.replaceable = true; // Force everything
      
      if (!wasPreviouslyReplaceable) {
        console.log(`[FURNITURE RULES] Forced ${item.legacyType || item.type} at ${item.location?.description || item.label} to be replaceable (was: false)`);
      }
    });
    
    // Override opportunity if it was 'none'
    if (analysis.replacementOpportunity === 'none') {
      console.log(`[FURNITURE RULES] Overriding 'none' opportunity to 'high' due to force mode`);
      analysis.replacementOpportunity = 'high';
    }
  } else {
    // Non-force mode: still enforce ALWAYS_REPLACE categories
    furnitureItems.forEach(item => {
      const itemKey = item.legacyType || item.type;
      if (ALWAYS_REPLACE.has(itemKey) && !item.replaceable) {
        console.log(`[FURNITURE RULES] Forcing ${itemKey} to replaceable (ALWAYS_REPLACE category)`);
        item.replaceable = true;
      }
    });
    
    // Check if there are any replaceable items after ALWAYS_REPLACE enforcement
    const hasReplaceableItems = furnitureItems.some(item => item.replaceable === true);
    
    // Only exit early if truly no replaceable items (not even ALWAYS_REPLACE categories)
    if (analysis.replacementOpportunity === 'none' && !hasReplaceableItems) {
      console.log(`[FURNITURE RULES] Opportunity is 'none' and no replaceable items - returning empty rules`);
      return [];
    }
    
    // If ALWAYS_REPLACE items exist, log that we're proceeding despite 'none' opportunity
    if (analysis.replacementOpportunity === 'none' && hasReplaceableItems) {
      console.log(`[FURNITURE RULES] Opportunity is 'none' but ALWAYS_REPLACE items detected - proceeding with directives`);
    }
  }

  const rules: string[] = [];
  
  rules.push("[FURNITURE REPLACEMENT MODE - CLEAN SLATE TRANSFORMATION]");
  rules.push("🔥 CRITICAL: Remove or replace ALL existing furniture, wall art, and décor - no exceptions regardless of quality or style.");
  rules.push("🔥 ABSOLUTE RULE: Do NOT keep ANY existing items. Everything will be replaced with cohesive modern staging.");
  rules.push(`Room type: ${analysis.roomType}. Layout: ${analysis.layoutDescription}`);
  
  // Architectural preservation
  rules.push("");
  rules.push("🏛️ ARCHITECTURAL PRESERVATION (NEVER CHANGE):");
  rules.push("- IMMOVABLE: Walls, windows, doors, built-in cabinets, countertops, fixtures");
  rules.push("- MAINTAIN DOORWAY ACCESS: Keep furniture AT LEAST 1 meter away from doors and entryways");
  rules.push("- PRESERVE TRAFFIC FLOW: Maintain existing pathways and room circulation");
  
  // EXPLICIT PER-ITEM REMOVAL DIRECTIVES
  const replaceableItems = furnitureItems.filter(item => item.replaceable === true);
  
  console.log(`[FURNITURE RULES] Building explicit removal directives for ${replaceableItems.length} items`);
  
  if (replaceableItems.length > 0) {
    rules.push("");
    rules.push("📋 EXPLICIT REMOVAL/REPLACEMENT DIRECTIVES:");
    rules.push("Each item below MUST be removed or replaced - ALL furniture, ALL artwork, ALL décor. No exceptions regardless of quality.");
    rules.push("");
    
    // TWO-PASS APPROACH: ALWAYS_REPLACE categories first, then others
    const mandatoryRemoveItems = replaceableItems.filter(item => ALWAYS_REPLACE.has(item.legacyType || item.type));
    const otherReplaceableItems = replaceableItems.filter(item => !ALWAYS_REPLACE.has(item.legacyType || item.type));
    
    // Pass 1: Mandatory removals (décor, clutter, wall art - ALWAYS remove)
    if (mandatoryRemoveItems.length > 0) {
      rules.push("🎯 MANDATORY REMOVALS (décor, wall art, clutter - MUST remove ALL):");
      mandatoryRemoveItems.forEach(item => {
        const bbox = item.location?.bbox || [0, 0, 0, 0];
        const bboxStr = `[${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}]`;
        const itemKey = item.legacyType || item.type;
        const description = item.location?.description || item.label;
        
        if (itemKey === 'counter_clutter' || itemKey === 'window_sill_item' || itemKey === 'surface_clutter') {
          rules.push(`  REMOVE: ${itemKey} at ${description} ${bboxStr} - CLEAR COMPLETELY`);
        } else if (itemKey === 'wall_art') {
          rules.push(`  REMOVE: ${itemKey} at ${description} ${bboxStr} - ${item.style || 'unknown'} ${item.condition || 'good'} frame/print`);
        } else {
          rules.push(`  REMOVE/REPLACE: ${itemKey} at ${description} ${bboxStr} - Replace with modern alternative`);
        }
      });
      rules.push("");
    }
    
    // Pass 2: Other replaceable furniture
    if (otherReplaceableItems.length > 0) {
      rules.push("🪑 FURNITURE REPLACEMENTS (replace ALL furniture regardless of quality):");
      otherReplaceableItems.forEach(item => {
        const bbox = item.location?.bbox || [0, 0, 0, 0];
        const bboxStr = `[${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}]`;
        rules.push(`  REPLACE: ${item.legacyType || item.type} at ${item.location?.description || item.label} ${bboxStr} - MUST be replaced → modern ${item.size || 'medium'} alternative`);
      });
      rules.push("");
    }
  }
  
  // GLOBAL SAFETY NET - catches items detection missed
  rules.push("");
  rules.push("🚨 GLOBAL SAFETY NET - REMOVE EVERYTHING LISTED BELOW (applies regardless of what was detected above):");
  rules.push("✓ ALL wall art: framed prints, paintings, photos, decorative plates, wall hangings, mirrors with decorative frames");
  rules.push("✓ ALL personal items: family photos, personal memorabilia, photo frames");
  rules.push("✓ ALL shelving/display units: open shelving, bookcases, display cabinets, entertainment centers");
  rules.push("✓ ALL console tables, side tables, accent tables (unless specifically modern and needed)");
  rules.push("✓ ALL window sill items: plants, decorations, books, trinkets, any items on window ledges");
  rules.push("✓ ALL counter clutter: bottles, small appliances, kitchen items, containers, anything on counters");
  rules.push("✓ ALL surface clutter: items on coffee tables, dining tables, shelves, dressers, any surface");
  rules.push("✓ ALL throw blankets and decorative pillows (all patterns, all colors - no exceptions)");
  rules.push("✓ ALL decorative objects: vases, sculptures, figurines, candles, ornaments, trinkets");
  rules.push("✓ ALL plants in any planters");
  rules.push("");
  rules.push("🔍 EDGE/PARTIAL OBJECTS (commonly missed but MUST be replaced):");
  rules.push("✓ Furniture at frame edges/corners: console tables, chairs, sofas, storage units partially visible");
  rules.push("✓ Objects cut off by image boundary are REPLACEABLE unless clearly structural (walls, windows)");
  rules.push("✓ Partial visibility does NOT mean built-in or permanent");
  rules.push("✓ Example: Table with monitor at right edge = REMOVE/REPLACE");
  rules.push("✓ Example: Sofa corner at bottom edge = REMOVE/REPLACE");
  rules.push("");
  rules.push("⚠️ ABSOLUTE RULE: ALL existing furniture and décor MUST be removed - do NOT keep any items regardless of quality or style.");
  rules.push("⚠️ EDGE OBJECTS: Furniture at frame edges is NOT built-in - replace it like any other furniture.");
  rules.push("⚠️ WALL ART: Remove ALL artwork, photos, and wall hangings - no exceptions for 'nice' or 'modern' pieces.");
  rules.push("Do NOT keep ANY existing furniture, wall art, or decorative items - they will ALL be replaced with a cohesive modern design.");
  
  // Staging requirements
  rules.push("");
  rules.push("🎨 COHESIVE DESIGN REQUIREMENTS:");
  rules.push("- UNIFIED PALETTE: All new pieces must work together (grey/white/natural wood/coordinated accents)");
  rules.push("- CONSISTENT STYLE: Choose ONE modern style (contemporary, Scandinavian, minimalist) for ALL items");
  rules.push("- POSITIONAL CONSISTENCY: Place new items in similar locations to originals (don't rearrange layout)");
  rules.push("- NO MIXED STYLES: Traditional + modern = AUTOMATIC FAILURE");
  rules.push("- After removal, restage with consistent palette; ensure no legacy items remain visible");
  
  rules.push("");
  rules.push("📐 POSITIONING RULES:");
  rules.push("- Place new furniture in approximately same locations as removed items");
  rules.push("- Maintain overall room layout and traffic flow");
  rules.push("- Doorway clearance: minimum 1 meter from all doors");
  rules.push("- Keep existing pathways through the room");
  
  // Success/failure criteria
  rules.push("");
  rules.push("✅ SUCCESS CRITERIA:");
  rules.push("- ALL items in removal directives have been removed/replaced");
  rules.push("- NO wall art, photos, or decorative items from original image remain");
  rules.push("- ALL clutter removed (counters, window sills, surfaces clear)");
  rules.push("- Design is cohesive with unified modern style");
  rules.push("- Architectural elements unchanged");
  
  rules.push("");
  rules.push("❌ FAILURE CRITERIA:");
  rules.push("- ANY old furniture/décor left in place alongside new items");
  rules.push("- Mixed styles (keeping original items with new staging)");
  rules.push("- Clutter or decorative items still visible");
  rules.push("- Wall art from original image still present");
  rules.push("- If you cannot remove/replace EVERYTHING listed above, mark as compliance failure");
  
  return rules;
}

/**
 * Determines if furniture replacement should be enabled based on detection results
 * @param analysis - Furniture analysis from detectFurniture
 * @param forceReplacementMode - When true, enables replacement if ANY furniture is detected
 */
export function shouldEnableFurnitureReplacement(analysis: FurnitureAnalysis | null, forceReplacementMode: boolean = false): boolean {
  if (!analysis) return false;
  const furnitureItems = Array.isArray(analysis.furnitureItems) ? analysis.furnitureItems : [];
  
  // Force mode: enable if ANY furniture detected (even 1 item)
  if (forceReplacementMode) {
    const hasAnyItems = analysis.hasFurniture && furnitureItems.length > 0;
    console.log(`[FURNITURE ENABLE] Force mode: ${hasAnyItems ? 'ENABLED' : 'DISABLED'} (${furnitureItems.length} items detected)`);
    return hasAnyItems;
  }
  
  // Normal mode: respect opportunity assessment
  const enabled = analysis.hasFurniture && 
         analysis.replacementOpportunity !== 'none' &&
         furnitureItems.some(item => item.replaceable === true);
  console.log(`[FURNITURE ENABLE] Normal mode: ${enabled ? 'ENABLED' : 'DISABLED'} (opportunity: ${analysis.replacementOpportunity})`);
  return enabled;
}