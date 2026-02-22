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
  const resp = await (ai as any).models.generateContent({
    model: "gemini-2.0-flash",
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
  const text = resp.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") || "{}";
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
    'Return JSON only: {"ok": true|false, "confidence": 0.0-1.0, "reasons": ["..."]}',
    ...stage2Context,
    'Compare ORIGINAL vs EDITED. ok=false ONLY if the EDITED image alters fixed architectural features:',
    '- adds/removes/moves/resizes doors, windows, walls, ceilings, floors, stairs, pillars, beams, built-ins, fixed plumbing/electrical.',
    '- kitchen islands, fixed counters, bench units, built-in cabinetry bases are structural built-ins.',
    '- kitchen islands and fixed counters: removal, resizing, relocation, or conversion is ALWAYS a structural violation.',
    '- fixed appliances and fixtures are structural built-ins: refrigerators, built-in ovens, cooktops, range hoods, fixed ceiling light fixtures, pendant lights attached to ceiling wiring.',
    '- fixed ceiling light fixtures and pendant lights attached to ceiling wiring are structural fixtures.',
    '- changing fixture TYPE or STYLE counts as replacement and is a structural violation.',
    '- brightness, exposure, or shadow differences alone are NOT violations.',
    '- removal or relocation of fixed appliances/fixtures is ALWAYS a structural violation.',
    '- removing or replacing MOVABLE furniture is allowed and must NOT produce ok=false.',
    '- movable furniture includes desks, tables, chairs, beds, sofas, bedside tables, freestanding wardrobes, freestanding shelving, dressers.',
    '- changes room perspective beyond minor lens/exposure correction (but NOT geometry).',
    '- minor apparent size or framing differences caused by cropping, lens correction, or small perspective shifts are NOT structural violations.',
    'Non-structural cosmetic changes MUST NOT produce ok=false, including:',
    '• curtain or drape color changes',
    '• curtain fabric or pattern changes',
    '• bedding, towels, rugs, cushions, and other textiles changing color or style',
    '• decorative soft furnishings changing appearance',
    'These are cosmetic styling differences and are NOT structural violations.',
    '- If curtain mounting hardware, rods, tracks, or built-in blinds are removed or relocated -> that IS structural.',
    '- only flag window violations if the physical window opening, frame, or position changes.',
    '- do NOT flag due to curtain color change, lighting/exposure difference, view brightness difference, or reflection change.',
    'Allow staging furniture to overlap walls/floors visually; overlapping is NOT a structural violation.',
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
      reason: reasons.join("; "),
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
      reason: reasons.join("; "),
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
    'Compare ORIGINAL vs EDITED. ok=false if EDITED places objects in clearly unrealistic or unsafe positions, such as:',
    '- blocking a DOOR or WINDOW,',
    '- overlapping fixed fixtures,',
    '- furniture not aligned to floor perspective.',
    '- kitchen islands, fixed counters, bench units, built-in cabinetry bases are structural built-ins.',
    '- kitchen islands and fixed counters: removal, resizing, relocation, or conversion is ALWAYS a structural violation.',
    '- fixed appliances and fixtures are structural built-ins: refrigerators, built-in ovens, cooktops, range hoods, fixed ceiling light fixtures, pendant lights attached to ceiling wiring.',
    '- fixed ceiling light fixtures and pendant lights attached to ceiling wiring are structural fixtures.',
    '- changing fixture TYPE or STYLE counts as replacement and is a structural violation.',
    '- brightness, exposure, or shadow differences alone are NOT violations.',
    '- removal or relocation of fixed appliances/fixtures is ALWAYS a structural violation.',
    '- removing or replacing MOVABLE furniture is allowed and must NOT produce ok=false.',
    '- movable furniture includes desks, tables, chairs, beds, sofas, bedside tables, freestanding wardrobes, freestanding shelving, dressers.',
    'Non-structural cosmetic changes MUST NOT produce ok=false, including:',
    '• curtain or drape color changes',
    '• curtain fabric or pattern changes',
    '• bedding, towels, rugs, cushions, and other textiles changing color or style',
    '• decorative soft furnishings changing appearance',
    'These are cosmetic styling differences and are NOT structural violations.',
    '- If curtain mounting hardware, rods, tracks, or built-in blinds are removed or relocated -> that IS structural.',
    '- minor apparent size or framing differences caused by cropping, lens correction, or small perspective shifts are NOT structural violations.',
    '- only flag window violations if the physical window opening, frame, or position changes.',
    '- do NOT flag due to curtain color change, lighting/exposure difference, view brightness difference, or reflection change.',
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
      reason: reasons.join("; "),
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
      reason: reasons.join("; "),
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
