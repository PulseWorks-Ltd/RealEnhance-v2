import { getGeminiClient } from "../ai/gemini";
import { logGeminiUsage } from "../ai/usageTelemetry";
import { toBase64 } from "../utils/images";
import { computeMaterialSignal, computeOpeningGeometrySignal } from "./signalMetrics";
import { classifyIssueTier, ISSUE_TYPES, splitIssueTokens } from "./issueTypes";
import type { ValidatorOutcome } from "./validatorOutcome";

const logger = console;
const FIXTURE_HARD_FAIL_CONFIDENCE_THRESHOLD = 0.9;

export type FixtureValidatorResult = ValidatorOutcome;

function isPendantOrChandelierAdditionRemoval(reason: string, advisorySignals: string[]): boolean {
  const signals = [reason, ...advisorySignals]
    .map((value) => String(value || "").toLowerCase())
    .filter(Boolean);

  const mentionsTargetFixture = signals.some((value) =>
    /pendant|chandelier/.test(value)
  );
  if (!mentionsTargetFixture) return false;

  return signals.some((value) =>
    /\b(add|added|addition|inserted|introduced|remove|removed|removal|missing)\b/.test(value)
  );
}

function parseFixtureResult(rawText: string): FixtureValidatorResult {
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
  const tokens = splitIssueTokens(reason, advisorySignals);
  const has = (prefix: string): boolean => tokens.some((token) => token === prefix || token.startsWith(`${prefix}_`));
  const hardFail = !parsed.ok &&
    confidence >= FIXTURE_HARD_FAIL_CONFIDENCE_THRESHOLD &&
    isPendantOrChandelierAdditionRemoval(reason, advisorySignals);
  const issueType = parsed.ok
    ? ISSUE_TYPES.NONE
    : has("fixture_changed") || has("ceiling") || has("light") || has("downlight")
      ? ISSUE_TYPES.FIXTURE_CHANGED
      : ISSUE_TYPES.FIXTURE_ANOMALY;

  return {
    status: parsed.ok ? "pass" : "fail",
    reason,
    confidence,
    hardFail,
    issueType,
    issueTier: classifyIssueTier(issueType),
    advisorySignals,
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
  const ai = getGeminiClient();
  const before = toBase64(beforeImageUrl).data;
  const after = toBase64(afterImageUrl).data;
  const jobId = options?.jobId;

  const materialSignal = await computeMaterialSignal(before, after).catch(() => ({
    colorShift: 0,
    textureShift: 0,
    suspiciousMaterialChange: false,
  }));

  const openingSignal = await computeOpeningGeometrySignal(before, after).catch(() => ({
    openingAreaDelta: 0,
    aspectRatioDelta: 0,
    suspiciousOpeningGeometry: false,
  }));

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
- Only chandelier or pendant light addition/removal can independently hard-fail.
- If you detect that case, state it explicitly in reason using wording like "pendant_light_added", "pendant_light_removed", "chandelier_added", or "chandelier_removed".
- Other fixed fixture changes should still return ok=false when appropriate, but remain advisory/non-blocking upstream.`;

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
    return parseFixtureResult(text);
  } catch (error: any) {
    throw new Error(`validator_error_fixture:${error?.message || String(error)}`);
  }
}
