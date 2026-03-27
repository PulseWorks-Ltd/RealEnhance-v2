import type { GoogleGenAI } from "@google/genai";
import type { Stage2ValidationMode } from "../validators/stage2ValidationMode";
import { logGeminiUsage } from "./usageTelemetry";

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
  modelOverride?: string,
  telemetry?: { jobId?: string; imageId?: string; attempt?: number }
) {
  const complianceModel = modelOverride || process.env.GEMINI_COMPLIANCE_MODEL || "gemini-2.5-flash";
  const requestStartedAt = Date.now();
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
  logGeminiUsage({
    ctx: {
      jobId: telemetry?.jobId || "",
      imageId: telemetry?.imageId || "",
      stage: "compliance",
      attempt: Number.isFinite(telemetry?.attempt) ? Number(telemetry?.attempt) : 1,
    },
    model: complianceModel,
    callType: "validator",
    response: resp,
    latencyMs: Date.now() - requestStartedAt,
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
      "- AFTER is expected to be a realistic staged image.",
    ];
  }
  return [
    "STAGE2 VALIDATION CONTEXT: REFRESH_OR_DIRECT",
    "- BEFORE is structured-retain or light-declutter baseline.",
    "- AFTER is expected to be a realistic staged variant.",
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
    jobId?: string;
    imageId?: string;
    attempt?: number;
  }
): Promise<ComplianceVerdict> {
  const stage2Context = buildStage2ComplianceContext(opts?.validationMode);
  const complianceScopeContext = [
    "COMPLIANCE SCOPE:",
    "- Evaluate visual realism, rendering integrity, and placement plausibility only.",
    "- Ignore architecture, openings, fixed-feature identity, and structural presence/absence.",
  ];

  const structuralPrompt = [
    'Return JSON only: {"ok": true|false, "confidence": 0.0-1.0, "reasons": ["..."]}',
    ...stage2Context,
    ...complianceScopeContext,
    "Compare ORIGINAL vs EDITED.",
    "ok=false ONLY if there are severe rendering artifacts, unnatural warping, or glitches.",
    "Confidence scale: 0.9-1.0 = very certain violation, 0.7-0.9 = likely violation, 0.4-0.7 = uncertain, <0.4 = weak signal",
  ].join("\n");

  const s = await ask(ai, originalB64, editedB64, structuralPrompt, opts?.modelOverride, {
    jobId: opts?.jobId,
    imageId: opts?.imageId,
    attempt: opts?.attempt,
  });
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
    ...complianceScopeContext,
    "Compare ORIGINAL vs EDITED. ok=false ONLY if EDITED places objects in clearly unrealistic or unsafe positions, such as:",
    "- floating furniture,",
    "- furniture not aligned to floor perspective,",
    "- furniture inappropriately passing through other objects.",
    "Ignore all structure/opening/fixed-feature change questions in this check.",
    "Confidence scale: 0.9-1.0 = very certain violation, 0.7-0.9 = likely violation, 0.4-0.7 = uncertain, <0.4 = weak signal",
  ].join("\n");

  const p = await ask(ai, originalB64, editedB64, placementPrompt, opts?.modelOverride, {
    jobId: opts?.jobId,
    imageId: opts?.imageId,
    attempt: opts?.attempt,
  });
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
