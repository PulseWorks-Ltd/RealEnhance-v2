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

function clampTier(value: number): number {
  return Math.max(1, Math.min(3, Math.floor(value)));
}

function resolveTier(confidence: number): number {
  if (confidence >= 0.95) return 3;
  if (confidence >= 0.85) return 2;
  return 1;
}

async function ask(ai: GoogleGenAI, originalB64: string, editedB64: string, prompt: string) {
  const complianceModel = process.env.GEMINI_COMPLIANCE_MODEL || "gemini-2.5-flash";
  const resp = await (ai as any).models.generateContent({
    model: complianceModel,
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { text: "ORIGINAL:" },
        { inlineData: { mimeType: "image/webp", data: originalB64 } },
        { text: "EDITED:" },
        { inlineData: { mimeType: "image/webp", data: editedB64 } }
      ]
    }]
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
  opts?: { validationMode?: Stage2ValidationMode }
): Promise<ComplianceVerdict> {
  const stage2Context = buildStage2ComplianceContext(opts?.validationMode);
    const structuralPrompt = [
    'Return JSON only: {\"ok\": true|false, \"confidence\": 0.0-1.0, \"reasons\": [\"...\"]}',
    ...stage2Context,
    'Compare ORIGINAL vs EDITED. Ignore structural changes (those are handled elsewhere).',
    'ok=false ONLY if there are severe rendering artifacts, unnatural warping, or glitches.',
    'Confidence scale: 0.9–1.0 = very certain violation, 0.7–0.9 = likely violation, 0.4–0.7 = uncertain, <0.4 = weak signal',
  ].join("\n");
  const s = await ask(ai, originalB64, editedB64, structuralPrompt);
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
  const sConfidence = typeof s.confidence === 'number' ? s.confidence : 0.6;
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
    'Return JSON only: {\"ok\": true|false, \"confidence\": 0.0-1.0, \"reasons\": [\"...\"]}',
    ...stage2Context,
    'Compare ORIGINAL vs EDITED. ok=false ONLY if EDITED places objects in clearly unrealistic or unsafe positions, such as:',
    '- floating furniture,',
    '- furniture not aligned to floor perspective,',
    '- furniture inappropriately passing through other objects.',
    'Ignore structural architecture (like walls, windows, fixtures), that is handled elsewhere.',
    'Confidence scale: 0.9–1.0 = very certain violation, 0.7–0.9 = likely violation, 0.4–0.7 = uncertain, <0.4 = weak signal',
  ].join("\n");
  const p = await ask(ai, originalB64, editedB64, placementPrompt);
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
  const pConfidence = typeof p.confidence === 'number' ? p.confidence : 0.6;
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
