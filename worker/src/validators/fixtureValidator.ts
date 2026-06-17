import { getGeminiClient } from "../ai/gemini";
import { logGeminiUsage } from "../ai/usageTelemetry";
import { toBase64 } from "../utils/images";
import { computeMaterialSignal, computeOpeningGeometrySignal } from "./signalMetrics";
import { classifyIssueTier, createStructuredIssue, ISSUE_TYPES, mapIssueTierToSeverity, normalizeReason, splitIssueTokens, type StructuredIssue } from "./issueTypes";
import type { ValidatorOutcome } from "./validatorOutcome";

const logger = console;
const FIXTURE_HARD_FAIL_CONFIDENCE_THRESHOLD = 0.9;
const FIXTURE_MUTATION_REGEX = /\b(add|added|addition|inserted|introduced|install|installed|installation|replace|replaced|replacement|remove|removed|removal|missing)\b/;
const HVAC_TARGET_REGEX = /\b(hvac|air conditioner|ac unit|split unit|fixed ac unit|wall mounted split unit)\b/;
const BUILT_IN_TARGET_REGEX = /\b(built[\s_-]?in|builtin|millwork|cabinetry|cabinet|wardrobe|closet|shelving|shelves)\b/;
const KITCHEN_ISLAND_TARGET_REGEX = /\b(kitchen[\s_-]?island|island)\b/;
const SINK_TARGET_REGEX = /\b(sink|basin)\b/;
const STOVETOP_TARGET_REGEX = /\b(stovetop|cooktop|hob|range|oven range)\b/;
const FIXTURE_TARGET_REGEX = /\b(pendant|chandelier|ceiling fan|recessed light|recessed lights|downlight|downlights|ceiling vent|ceiling vents|smoke detector|smoke detectors|light fixture|light fixtures)\b/;
const LIGHTING_TARGET_REGEX = /\b(light|lights|lighting|light fixture|light fixtures|pendant|chandelier|track light|track lighting|feature light|suspended light|spot rail|rail light|ceiling fixture|ceiling mounted fixture|ceiling fan|recessed light|downlight|decorative ceiling)\b/;

export type FixtureValidatorResult = ValidatorOutcome;

function logFixtureEvent(event: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...payload }));
}

function logFixturePhaseEnd(jobId: string | undefined, phase: string, durationMs: number, extra: Record<string, unknown> = {}): void {
  logFixtureEvent("FIXTURE_PHASE_END", {
    jobId: jobId || "unknown",
    validator: "fixture",
    phase,
    durationMs: Math.max(0, Math.round(durationMs)),
    ...extra,
  });
}

function inferFixtureRepairMetadata(reason: string, advisorySignals: string[], structuredIssues: StructuredIssue[]): NonNullable<FixtureValidatorResult["fixtureRepair"]> {
  const tokens = splitIssueTokens(reason, advisorySignals);
  const normalizedSignals = buildNormalizedSignals(reason, advisorySignals);
  const joinedTokens = tokens.join("|");
  const joinedSignals = normalizedSignals.join(" ");

  const hasAdded = /(^|_)(add|added|addition|inserted|introduced|install|installed|installation)(_|$)/.test(joinedTokens)
    || /\b(add|added|addition|inserted|introduced|install|installed|installation)\b/.test(joinedSignals);
  const hasRemoved = /(^|_)(remove|removed|removal|missing)(_|$)/.test(joinedTokens)
    || /\b(remove|removed|removal|missing)\b/.test(joinedSignals);
  const hasModified = /(^|_)(replace|replaced|replacement|change|changed|modified)(_|$)/.test(joinedTokens)
    || /\b(replace|replaced|replacement|change|changed|modified)\b/.test(joinedSignals);

  const action: "added" | "removed" | "modified" | "unknown" = hasAdded
    ? "added"
    : hasRemoved
      ? "removed"
      : hasModified
        ? "modified"
        : "unknown";
  const fixtureStateChange: "ADDED" | "REMOVED" | "MODIFIED" | "UNKNOWN" = action === "added"
    ? "ADDED"
    : action === "removed"
      ? "REMOVED"
      : action === "modified"
        ? "MODIFIED"
        : "UNKNOWN";

  const structuredObject = String(structuredIssues[0]?.object || "").toLowerCase();
  const isHvac = structuredObject === "hvac_unit"
    || /\bhvac\b|air[\s_-]?conditioner|ac[\s_-]?unit|split[\s_-]?unit|ceiling[\s_-]?vent/.test(joinedSignals);
  const isLighting = ["lighting_fixture", "light_fixture", "pendant_light", "chandelier", "ceiling_fan"].includes(structuredObject)
    || LIGHTING_TARGET_REGEX.test(joinedSignals);
  const fixtureClass: "LIGHTING" | "HVAC" | "UNKNOWN" = isHvac
    ? "HVAC"
    : isLighting
      ? "LIGHTING"
      : "UNKNOWN";
  const supportedStateChange = fixtureStateChange === "ADDED" || fixtureStateChange === "REMOVED" || fixtureStateChange === "MODIFIED";

  if ((fixtureClass === "LIGHTING" || fixtureClass === "HVAC") && supportedStateChange) {
    const repairType: "FIXTURE_ADDED" | "FIXTURE_REMOVED" | "FIXTURE_MODIFIED" = fixtureStateChange === "ADDED"
      ? "FIXTURE_ADDED"
      : fixtureStateChange === "REMOVED"
        ? "FIXTURE_REMOVED"
        : "FIXTURE_MODIFIED";

    return {
      supported: true,
      repairType,
      fixtureClass,
      fixtureStateChange,
      action,
      localizationMode: fixtureClass === "HVAC" ? "diff_zone_hvac" : "diff_zone_ceiling",
      reasonTokens: tokens,
    };
  }

  return {
    supported: false,
    fixtureClass,
    fixtureStateChange,
    action,
    reasonTokens: tokens,
  };
}

function buildNormalizedSignals(reason: string, advisorySignals: string[]): string[] {
  const signals = [reason, ...advisorySignals]
    .map((value) => normalizeReason(String(value || "")))
    .filter(Boolean);

  return signals;
}

function hasMutationSignal(value: string): boolean {
  return FIXTURE_MUTATION_REGEX.test(normalizeReason(value));
}

function isHardFailEligibleFixtureMutation(reason: string, advisorySignals: string[]): boolean {
  const signals = buildNormalizedSignals(reason, advisorySignals);

  return signals.some((value) =>
    hasMutationSignal(value) && (
      FIXTURE_TARGET_REGEX.test(value) ||
      HVAC_TARGET_REGEX.test(value) ||
      BUILT_IN_TARGET_REGEX.test(value) ||
      KITCHEN_ISLAND_TARGET_REGEX.test(value) ||
      SINK_TARGET_REGEX.test(value) ||
      STOVETOP_TARGET_REGEX.test(value)
    )
  );
}

function classifyFixtureIssueType(reason: string, advisorySignals: string[]): (typeof ISSUE_TYPES)[keyof typeof ISSUE_TYPES] {
  const signals = buildNormalizedSignals(reason, advisorySignals);
  const tokens = splitIssueTokens(reason, advisorySignals);
  const has = (prefix: string): boolean => tokens.some((token) => token === prefix || token.startsWith(`${prefix}_`));

  const hasHvacMutation = signals.some((value) => HVAC_TARGET_REGEX.test(value) && hasMutationSignal(value));
  if (has("hvac_changed") || hasHvacMutation) {
    return ISSUE_TYPES.HVAC_CHANGED;
  }

  const hasBuiltInMutation = signals.some((value) => BUILT_IN_TARGET_REGEX.test(value) && hasMutationSignal(value));
  if (hasBuiltInMutation || has("built_in")) {
    return ISSUE_TYPES.FIXTURE_CHANGED;
  }

  const hasIslandMutation = signals.some((value) => KITCHEN_ISLAND_TARGET_REGEX.test(value) && hasMutationSignal(value));
  if (hasIslandMutation || has("kitchen_island") || has("island")) {
    return ISSUE_TYPES.FIXTURE_CHANGED;
  }

  const hasSinkMutation = signals.some((value) => SINK_TARGET_REGEX.test(value) && hasMutationSignal(value));
  if (hasSinkMutation || has("sink")) {
    return ISSUE_TYPES.FIXTURE_CHANGED;
  }

  const hasStovetopMutation = signals.some((value) => STOVETOP_TARGET_REGEX.test(value) && hasMutationSignal(value));
  if (hasStovetopMutation || has("stovetop") || has("cooktop") || has("hob") || has("range")) {
    return ISSUE_TYPES.FIXTURE_CHANGED;
  }

  const hasFixtureMutation = signals.some((value) => FIXTURE_TARGET_REGEX.test(value) && hasMutationSignal(value));
  if (
    has("fixture_changed") ||
    hasFixtureMutation ||
    has("ceiling") ||
    has("light") ||
    has("downlight")
  ) {
    return ISSUE_TYPES.FIXTURE_CHANGED;
  }

  return ISSUE_TYPES.FIXTURE_ANOMALY;
}

function buildFixtureStructuredIssues(params: {
  issueType: FixtureValidatorResult["issueType"];
  issueTier: FixtureValidatorResult["issueTier"];
  confidence: number;
  reason: string;
  advisorySignals: string[];
}): StructuredIssue[] {
  if (params.issueType === ISSUE_TYPES.NONE) return [];

  const tokens = splitIssueTokens(params.reason, params.advisorySignals);
  const evidence = Array.from(new Set(tokens)).filter(Boolean);
  const joined = evidence.join("|");

  const object = /(^|_)hvac(_|$)|air_conditioner|ac_unit|split_unit/.test(joined)
    ? "hvac_unit"
    : /kitchen_island|island/.test(joined)
      ? "kitchen_island"
      : /(^|_)sink(_|$)|basin/.test(joined)
        ? "sink"
        : /stovetop|cooktop|hob|range/.test(joined)
          ? "stovetop"
    : /track_light|track_lighting|feature_light|spot_rail|rail_light|pendant|chandelier|light_fixture|downlight|recessed_light|ceiling_fan/.test(joined)
      ? "lighting_fixture"
      : "fixture";

  const action = /(^|_)(add|added|addition|inserted|introduced|install|installed|installation)(_|$)/.test(joined)
    ? "added"
    : /(^|_)(remove|removed|removal|missing)(_|$)/.test(joined)
      ? "removed"
      : /(^|_)(replace|replaced|replacement)(_|$)/.test(joined)
        ? "replaced"
        : "changed";

  return [createStructuredIssue({
    type: "fixture_change",
    object,
    action,
    severity: mapIssueTierToSeverity(params.issueTier),
    source: "fixture_validator",
    confidence: params.confidence,
    evidence,
  })];
}

export function parseFixtureResult(rawText: string): FixtureValidatorResult {
  const cleaned = String(rawText || "").replace(/```json|```/gi, "").trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
  let parsed: any;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    throw new Error("validator_error_invalid_json");
  }

  if (typeof parsed?.ok !== "boolean") {
    throw new Error("validator_error_invalid_schema");
  }

  const reason = typeof parsed?.reason === "string" && parsed.reason.trim().length > 0
    ? parsed.reason.trim()
    : parsed.ok ? "fixtures_preserved" : "fixtures_changed";
  const confidence = Number.isFinite(parsed?.confidence) ? Number(parsed.confidence) : 0.5;
  const advisorySignals = parsed.ok ? [] : [reason];
  const hardFail = !parsed.ok &&
    confidence >= FIXTURE_HARD_FAIL_CONFIDENCE_THRESHOLD &&
    isHardFailEligibleFixtureMutation(reason, advisorySignals);
  const issueType = parsed.ok ? ISSUE_TYPES.NONE : classifyFixtureIssueType(reason, advisorySignals);
  const issueTier = classifyIssueTier(issueType);
  const structuredIssues = buildFixtureStructuredIssues({
    issueType,
    issueTier,
    confidence,
    reason,
    advisorySignals,
  });
  const fixtureRepair = inferFixtureRepairMetadata(reason, advisorySignals, structuredIssues);

  console.log("[SPECIALIST_REVIEW][FIXTURE]", {
    ok: parsed.ok,
    hardFail,
    confidence: confidence.toFixed(3),
    reason,
    issueType,
  });

  return {
    status: parsed.ok ? "pass" : "fail",
    reason,
    confidence,
    hardFail,
    issueType,
    issueTier,
    advisorySignals,
    primaryStructuredIssue: structuredIssues[0],
    structuredIssues,
    fixtureRepair,
  };
}

export async function runFixtureValidator(
  beforeImageUrl: string,
  afterImageUrl: string,
  options?: {
    jobId?: string;
    imageId?: string;
    attempt?: number;
    localSignals?: {
      maskedEdgeDrift?: number;
      edgeOpeningRisk?: number;
      structuralDegreeChange?: number;
    };
  }
): Promise<FixtureValidatorResult> {
  const validatorStartedAt = Date.now();
  logFixtureEvent("FIXTURE_VALIDATOR_START", {
    jobId: options?.jobId || "unknown",
    validator: "fixture",
    phase: "validator_total",
    durationMs: 0,
  });
  const ai = getGeminiClient();
  const imageDecodeStartedAt = Date.now();
  const before = toBase64(beforeImageUrl).data;
  const after = toBase64(afterImageUrl).data;
  const jobId = options?.jobId;
  logFixturePhaseEnd(jobId, "image_decode", Date.now() - imageDecodeStartedAt);

  const materialSignalStartedAt = Date.now();
  const materialSignal = await computeMaterialSignal(before, after).catch(() => ({
    colorShift: 0,
    textureShift: 0,
    suspiciousMaterialChange: false,
  }));
  logFixturePhaseEnd(jobId, "computeMaterialSignal", Date.now() - materialSignalStartedAt);

  const openingGeometryStartedAt = Date.now();
  const openingSignal = await computeOpeningGeometrySignal(before, after).catch(() => ({
    openingAreaDelta: 0,
    aspectRatioDelta: 0,
    suspiciousOpeningGeometry: false,
  }));
  logFixturePhaseEnd(jobId, "computeOpeningGeometrySignal", Date.now() - openingGeometryStartedAt);

  const localSignals = options?.localSignals ?? {
    maskedEdgeDrift: openingSignal.openingAreaDelta,
    edgeOpeningRisk: openingSignal.openingAreaDelta,
    structuralDegreeChange: Math.max(openingSignal.openingAreaDelta, openingSignal.aspectRatioDelta),
  };

  let occlusionScore = 0;

  if ((localSignals?.maskedEdgeDrift ?? 0) > 0.10) occlusionScore++;
  if ((localSignals?.edgeOpeningRisk ?? 0) > 0.08) occlusionScore++;
  if ((localSignals?.structuralDegreeChange ?? 0) > 0.12) occlusionScore++;
  if (materialSignal?.suspiciousMaterialChange) occlusionScore += 2;

  const occlusionRisk = occlusionScore >= 2;
  const hasStructuralSignal =
    (localSignals?.maskedEdgeDrift ?? 0) > 0.10 ||
    (localSignals?.edgeOpeningRisk ?? 0) > 0.08 ||
    (localSignals?.structuralDegreeChange ?? 0) > 0.12;
  const occlusionRiskFinal =
    occlusionScore >= 2 &&
    (
      hasStructuralSignal ||
      occlusionScore >= 3
    );
  const occlusionSevere = occlusionScore >= 3;

  logger.info("STAGE2_OCCLUSION_SIGNAL", {
    jobId,
    occlusionRisk: occlusionRiskFinal,
    occlusionScore,
    maskedEdgeDrift: localSignals?.maskedEdgeDrift,
    edgeOpeningRisk: localSignals?.edgeOpeningRisk,
    structuralDegreeChange: localSignals?.structuralDegreeChange,
    materialSignal: materialSignal?.suspiciousMaterialChange === true,
  });

  const promptBuildStartedAt = Date.now();
  let prompt = `You are validating whether two images represent the exact same physical room architecture and fixed installed fixtures.

Compare the BASELINE image and the STAGED image.

GLOBAL RULE
The staged image must represent the exact same physical room architecture as the baseline image.
Furniture, decor, and staging objects may change.
Architectural structure and fixed installed fixtures may NOT change.

Set ok=false if ANY major fixed fixture is clearly added, removed, resized, replaced with a different class, or relocated:
* HVAC systems (wall-mounted split units, fixed AC units)
* ceiling fans
* pendant lights
* recessed/downlights
* ceiling vents
* smoke detectors

Also fail if a fixed ceiling/wall fixture present in baseline is replaced by a materially different fixed fixture type in staged image.

Do NOT fail for uncertain visibility alone. Only pass when evidence supports that fixed fixtures are preserved.

Examples that should NOT fail when architecture/fixtures are otherwise preserved:
* light switches or outlets hidden by furniture
* small fixtures partially occluded by decor
* minor camera/perspective/cropping differences
* color temperature/brightness/rendering differences

Return JSON only:
{"ok":true|false,"reason":"short explanation","confidence":0.0-1.0}`;

  prompt += `

HARD-FAIL ELIGIBILITY RULE:
- High-confidence fixed fixture state changes can hard-fail when evidence is clear.
- Prefer categorical reason wording that includes fixture class and state change (examples: "lighting_fixture_added", "track_light_fixture_added", "hvac_unit_removed", "lighting_fixture_modified").
- Keep the reason concise and specific to the fixture state change.`;

  if (materialSignal.suspiciousMaterialChange) {
    prompt += `

MATERIAL IDENTITY ATTENTION SIGNAL:

Local analysis detected a potential material change in built-in elements.

Focus on:
- kitchen countertops / benchtops
- cabinetry finishes
- vanities and fixed surfaces

Check whether material identity has changed:
- stone type, veining, or pattern
- color or finish changes beyond lighting adjustment

If any built-in surface appears replaced or materially altered:
→ return passed=false
→ failReasons=["built_in_material_changed"]`;
  }

  if (occlusionRiskFinal) {
    prompt += `

${occlusionSevere ? "HIGH CONFIDENCE STRUCTURAL DRIFT DETECTED.\n\n" : ""}OCCLUSION INTEGRITY CHECK (CRITICAL)

Determine whether any previously occluded areas (e.g., behind curtains, blinds, furniture, or shadowed regions) have been revealed, modified, or replaced.

FAIL if ANY of the following occurred:

* Curtains, blinds, or coverings have been moved or removed to expose new wall/window space
* Previously hidden regions now contain visible surfaces that were not clearly present in the input
* New walls, artwork, or surfaces appear in areas that were previously occluded
* Occluded regions have been "filled in" with plausible but unverified structure

IMPORTANT:
You must NOT assume hidden structure exists.
If the model has revealed or invented space behind an occlusion → hardFail = true

This is NOT a stylistic check. It is a structural integrity check.`;
  }
  logFixturePhaseEnd(jobId, "prompt_build", Date.now() - promptBuildStartedAt);

  const selectedModel = (occlusionRiskFinal || materialSignal.suspiciousMaterialChange)
    ? "gemini-2.5-pro"
    : "gemini-2.5-flash";

  try {
    const requestStartedAt = Date.now();
    const response = await (ai as any).models.generateContent({
      model: selectedModel,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { text: "IMAGE_BEFORE:" },
            { inlineData: { mimeType: "image/webp", data: before } },
            { text: "IMAGE_AFTER:" },
            { inlineData: { mimeType: "image/webp", data: after } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    });
    logFixturePhaseEnd(jobId, "gemini_request", Date.now() - requestStartedAt, {
      model: selectedModel,
    });
    logGeminiUsage({
      ctx: {
        jobId: jobId || "",
        imageId: options?.imageId || "",
        stage: "validator",
        attempt: Number.isFinite(options?.attempt) ? Number(options?.attempt) : 1,
      },
      model: selectedModel,
      callType: "validator",
      response,
      latencyMs: Date.now() - requestStartedAt,
    });

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parseStartedAt = Date.now();
    const parsed = parseFixtureResult(text);
    logFixturePhaseEnd(jobId, "result_parse", Date.now() - parseStartedAt);
    logFixturePhaseEnd(jobId, "final_decision", 0);
    return parsed;
  } catch (error: any) {
    throw new Error(`validator_error_fixture:${error?.message || String(error)}`);
  } finally {
    logFixtureEvent("FIXTURE_VALIDATOR_END", {
      jobId: options?.jobId || "unknown",
      validator: "fixture",
      phase: "validator_total",
      durationMs: Math.max(0, Math.round(Date.now() - validatorStartedAt)),
    });
  }
}
