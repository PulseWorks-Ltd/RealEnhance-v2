import type { GoogleGenAI } from "@google/genai";
import type { Stage2ValidationMode } from "../validators/stage2ValidationMode";

export type ComplianceVerdict = {
  ok: boolean;
  confidence: number;
  blocking: boolean;
  tier: number;
  reason: string;
  structuralViolation?: boolean;
  placementViolation?: boolean;
  reasons: string[];
};

type OpeningStructuralSignal = {
  type:
    | "opening_removed"
    | "opening_removed_and_relocated"
    | "opening_resize_extreme"
    | "opening_relocated_and_resized";
  confidence: "advisory" | "strong" | "extreme";
  resizeDelta?: number;
};

function clampTier(value: number): number {
  return Math.max(1, Math.min(3, Math.floor(value)));
}

function resolveTier(confidence: number): number {
  if (confidence >= 0.95) return 3;
  if (confidence >= 0.85) return 2;
  return 1;
}

async function ask(
  ai: GoogleGenAI,
  originalB64: string,
  editedB64: string,
  prompt: string,
  modelOverride?: string
) {
  const complianceModel = modelOverride || process.env.GEMINI_COMPLIANCE_MODEL || "gemini-2.5-flash";
  const resp = await (ai as any).models.generateContent({
    model: complianceModel,
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { text: "ORIGINAL:" },
        { inlineData: { mimeType: "image/webp", data: originalB64 } },
        { text: "EDITED:" },
        { inlineData: { mimeType: "image/webp", data: editedB64 } },
      ],
    }],
  });
  const text = resp.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("\n") || "{}";
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function buildStage2ComplianceContext(mode?: Stage2ValidationMode): string[] {
  if (!mode) return [];
  if (mode === "FULL_STAGE_ONLY") {
    return [
      "STAGE2 VALIDATION CONTEXT: FULL_STAGE_ONLY",
      "- BEFORE corresponds to stage-only baseline (typically empty input).",
      "- AFTER is expected to add appropriate staged furniture while preserving fixed architecture.",
    ];
  }
  return [
    "STAGE2 VALIDATION CONTEXT: REFRESH_OR_DIRECT",
    "- BEFORE is structured-retain or light-declutter baseline.",
    "- AFTER is expected to augment staging while preserving fixed architecture.",
  ];
}

export async function checkCompliance(
  ai: GoogleGenAI,
  originalB64: string,
  editedB64: string,
  opts?: {
    validationMode?: Stage2ValidationMode;
    advisorySignals?: string[];
    openingStructuralSignal?: boolean | OpeningStructuralSignal;
    openingStructuralSignalContext?: OpeningStructuralSignal;
    maskedDriftRegions?: Array<{ bbox: [number, number, number, number]; score: number }>;
    openingRegions?: Array<{ bbox: [number, number, number, number]; type: "window" | "door" }>;
    modelOverride?: string;
  }
): Promise<ComplianceVerdict> {
  const stage2Context = buildStage2ComplianceContext(opts?.validationMode);
  const openingStructuralSignalFlag = typeof opts?.openingStructuralSignal === "boolean"
    ? opts?.openingStructuralSignal
    : !!opts?.openingStructuralSignal;
  const openingStructuralSignalContext =
    opts?.openingStructuralSignalContext ||
    (typeof opts?.openingStructuralSignal === "object" ? opts?.openingStructuralSignal : undefined);
  const advisoryContext = Array.isArray(opts?.advisorySignals) && opts.advisorySignals.length > 0
    ? [
        "ADVISORY SIGNALS FROM LOCAL VALIDATORS (focus review here):",
        ...opts.advisorySignals.map((signal) => `- ${signal}`),
      ]
    : [];
  const maskedDriftRegionsContext = Array.isArray(opts?.maskedDriftRegions) && opts.maskedDriftRegions.length > 0
    ? [
        "MASKED DRIFT REGIONS (normalized bbox [x1,y1,x2,y2], score):",
        ...opts.maskedDriftRegions.map((region, idx) =>
          `- drift_region_${idx + 1}: bbox=[${region.bbox.map((v) => Number(v).toFixed(3)).join(",")}], score=${Number(region.score).toFixed(3)}`
        ),
      ]
    : [];
  const openingRegionsContext = Array.isArray(opts?.openingRegions) && opts.openingRegions.length > 0
    ? [
        "DETECTED OPENING REGIONS (normalized bbox [x1,y1,x2,y2], type):",
        ...opts.openingRegions.map((region, idx) =>
          `- opening_region_${idx + 1}: type=${region.type}, bbox=[${region.bbox.map((v) => Number(v).toFixed(3)).join(",")}]`
        ),
      ]
    : [];
  const openingStructuralContext = openingStructuralSignalContext
    ? [
        "OPENING STRUCTURAL SIGNAL (sensor evidence, not final verdict):",
        `- type: ${openingStructuralSignalContext.type}`,
        `- confidence: ${openingStructuralSignalContext.confidence}`,
        ...(typeof openingStructuralSignalContext.resizeDelta === "number"
          ? [`- resizeDelta: ${openingStructuralSignalContext.resizeDelta.toFixed(3)}`]
          : []),
      ]
    : [];
  const openingStructuralGuidance = openingStructuralSignalFlag
    ? [
        "Local structural detectors indicate that an architectural opening",
        "(window or door) may have been partially replaced with wall surface.",
        "",
        "Furniture may hide part of a window, but furniture cannot replace",
        "the architectural opening itself.",
        "",
        "Please confirm visually whether the opening geometry has changed.",
      ]
    : [];
  const openingRelocatedResizedGuidance =
    openingStructuralSignalContext?.type === "opening_relocated_and_resized"
      ? [
          "Local structural detectors observed that a window opening appears both relocated and significantly resized.",
          "This combination frequently indicates that part of the opening may have been replaced by wall surface.",
          "Furniture may hide part of a window, but furniture cannot replace the architectural opening.",
          "Please verify whether the opening geometry has actually changed or whether the difference is caused only by occlusion or perspective.",
        ]
      : [];
  const structuralDecisionInstruction = openingStructuralSignalFlag
    ? "Compare ORIGINAL vs EDITED with focus on confirming or refuting opening-geometry changes signaled above."
    : "Compare ORIGINAL vs EDITED. Ignore structural changes (those are handled elsewhere).";

  const structuralPrompt = [
    'Return JSON only: {"ok": true|false, "confidence": 0.0-1.0, "reasons": ["..."]}',
    ...stage2Context,
    ...advisoryContext,
    ...maskedDriftRegionsContext,
    ...openingRegionsContext,
    ...openingStructuralGuidance,
    ...openingStructuralContext,
    ...openingRelocatedResizedGuidance,
    structuralDecisionInstruction,
    "ok=false ONLY if there are severe rendering artifacts, unnatural warping, or glitches.",
    "Confidence scale: 0.9-1.0 = very certain violation, 0.7-0.9 = likely violation, 0.4-0.7 = uncertain, <0.4 = weak signal",
  ].join("\n");

  const s = await ask(ai, originalB64, editedB64, structuralPrompt, opts?.modelOverride);
  if (!s) {
    const reasons = ["Compliance parser failed"];
    const confidence = 0.3;
    const result = {
      ok: false,
      confidence,
      blocking: true,
      tier: resolveTier(confidence),
      reason: reasons.join("\n; "),
      structuralViolation: true,
      placementViolation: false,
      reasons,
    };
    console.log("[COMPLIANCE_RESULT]", { ok: result.ok, confidence: result.confidence, reasonsCount: result.reasons.length });
    return result;
  }

  const sConfidence = typeof s.confidence === "number" ? s.confidence : 0.6;
  if (s.ok === false) {
    const reasons = s.reasons || ["Structural change detected"];
    const result = {
      ok: false,
      confidence: sConfidence,
      blocking: true,
      tier: resolveTier(sConfidence),
      reason: reasons.join("\n; "),
      structuralViolation: true,
      placementViolation: false,
      reasons,
    };
    console.log("[COMPLIANCE_RESULT]", { ok: result.ok, confidence: result.confidence, reasonsCount: result.reasons.length });
    return result;
  }

  const placementPrompt = [
    'Return JSON only: {"ok": true|false, "confidence": 0.0-1.0, "reasons": ["..."]}',
    ...stage2Context,
    ...advisoryContext,
    ...maskedDriftRegionsContext,
    ...openingRegionsContext,
    ...openingStructuralGuidance,
    ...openingStructuralContext,
    ...openingRelocatedResizedGuidance,
    "Compare ORIGINAL vs EDITED. ok=false ONLY if EDITED places objects in clearly unrealistic or unsafe positions, such as:",
    "- floating furniture,",
    "- furniture not aligned to floor perspective,",
    "- furniture inappropriately passing through other objects.",
    "Ignore structural architecture (like walls, windows, fixtures), that is handled elsewhere.",
    "Confidence scale: 0.9-1.0 = very certain violation, 0.7-0.9 = likely violation, 0.4-0.7 = uncertain, <0.4 = weak signal",
  ].join("\n");

  const p = await ask(ai, originalB64, editedB64, placementPrompt, opts?.modelOverride);
  if (!p) {
    const reasons = ["Compliance parser failed (placement)"];
    const confidence = 0.3;
    const result = {
      ok: false,
      confidence,
      blocking: true,
      tier: resolveTier(confidence),
      reason: reasons.join("\n; "),
      structuralViolation: false,
      placementViolation: true,
      reasons,
    };
    console.log("[COMPLIANCE_RESULT]", { ok: result.ok, confidence: result.confidence, reasonsCount: result.reasons.length });
    return result;
  }

  const pConfidence = typeof p.confidence === "number" ? p.confidence : 0.6;
  if (p.ok === false) {
    const reasons = p.reasons || ["Unrealistic/blocked placement"];
    const result = {
      ok: false,
      confidence: pConfidence,
      blocking: true,
      tier: resolveTier(pConfidence),
      reason: reasons.join("\n; "),
      structuralViolation: false,
      placementViolation: true,
      reasons,
    };
    console.log("[COMPLIANCE_RESULT]", { ok: result.ok, confidence: result.confidence, reasonsCount: result.reasons.length });
    return result;
  }

  const result = {
    ok: true,
    confidence: 0.0,
    blocking: false,
    tier: clampTier(1),
    reason: "",
    structuralViolation: false,
    placementViolation: false,
    reasons: [],
  };
  console.log("[COMPLIANCE_RESULT]", { ok: result.ok, confidence: result.confidence, reasonsCount: result.reasons.length });
  return result;
}
