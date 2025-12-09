// server/services/compliance.ts
import type { GoogleGenAI } from "@google/genai";

export type ComplianceVerdict = {
  ok: boolean;
  structuralViolation?: boolean;
  placementViolation?: boolean;
  reasons: string[];
};

// Compact helper to ask Gemini in strict JSON
async function ask(ai: GoogleGenAI, originalB64: string, editedB64: string, prompt: string) {
  const resp = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { text: "ORIGINAL:" },
        { inlineData: { mimeType: "image/png", data: originalB64 } },
        { text: "EDITED:" },
        { inlineData: { mimeType: "image/png", data: editedB64 } }
      ]
    }]
  });
  const text = resp.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "{}";
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export async function checkStructuralCompliance(
  ai: GoogleGenAI,
  originalB64: string,
  editedB64: string
): Promise<ComplianceVerdict> {
  // 1) Structural integrity (ignore furniture overlapped on walls/floors)
  const structuralPrompt = [
    "Return JSON only: {\"ok\": true|false, \"reasons\": [\"...\"]}",
    "Compare ORIGINAL vs EDITED. ok=false ONLY if the EDITED image alters fixed architectural features:",
    "- adds/removes/moves/resizes doors, windows, walls, ceilings, floors, stairs, pillars, beams, built-ins, fixed plumbing/electrical.",
    "- CRITICAL: Walls must remain EXACTLY the same length, position, and configuration - no extensions, no repositioning, no reshaping.",
    "- CRITICAL: Room dimensions and wall geometry must be IDENTICAL - furniture must fit within existing walls, not modify walls to fit furniture.",
    "- changes room perspective beyond minor lens/exposure correction (but NOT geometry).",
    "Allow staging furniture to overlap walls/floors visually; overlapping is NOT a structural violation.",
    "Reject if walls have been extended, moved, or reshaped to accommodate furniture placement.",
  ].join("\n");

  const s = await ask(ai, originalB64, editedB64, structuralPrompt);
  if (!s) return { ok: false, structuralViolation: true, placementViolation: false, reasons: ["Compliance parser failed"] };
  if (s.ok === false) return { ok: false, structuralViolation: true, placementViolation: false, reasons: s.reasons || ["Structural change detected"] };

  // 2) Placement safety (blocking or going through fixtures/egress)
  const placementPrompt = [
    "Return JSON only: {\"ok\": true|false, \"reasons\": [\"...\"]}",
    "Compare ORIGINAL vs EDITED. ok=false if EDITED places objects in clearly unrealistic or unsafe positions, such as:",
    "- blocking or covering a DOOR or WINDOW (egress/ventilation).",
    "- placing objects through or overlapping a fixed fixture (sink, towel rail, shower, built-in appliance).",
    "- furniture floating or not aligned to floor perspective.",
    "Allow normal staging where furniture is placed against a wall or in the room as long as doors and windows remain accessible and unobstructed.",
  ].join("\n");
  const p = await ask(ai, originalB64, editedB64, placementPrompt);
  if (!p) return { ok: false, structuralViolation: false, placementViolation: true, reasons: ["Compliance parser failed (placement)"] };
  if (p.ok === false) return { ok: false, structuralViolation: false, placementViolation: true, reasons: p.reasons || ["Unrealistic/blocked placement"] };

  return { ok: true, structuralViolation: false, placementViolation: false, reasons: [] };
}