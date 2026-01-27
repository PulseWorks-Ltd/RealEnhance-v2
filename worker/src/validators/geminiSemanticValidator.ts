import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";

export type GeminiSemanticVerdict = {
  hardFail: boolean;
  category: "structure" | "opening_blocked" | "furniture_change" | "style_only" | "unknown";
  reasons: string[];
  confidence: number;
  rawText?: string;
};

const MIN_CONFIDENCE = 0.65;

function buildPrompt(stage: "1A" | "1B" | "2", scene: string | undefined) {
  const stageLabel = stage === "2" ? "Stage 2 (virtual staging)" : stage === "1B" ? "Stage 1B (declutter)" : "Stage 1A (color/cleanup)";
  const sceneLabel = scene === "exterior" ? "EXTERIOR" : "INTERIOR";
  return `You are a structural integrity judge for real estate imagery.
Return JSON only. No prose outside JSON.

STRUCTURE means ONLY: walls, ceilings/rooflines, floors, stairs, columns, permanent openings (doors, windows, arches, closets), built-in boundaries.
NON-STRUCTURAL (never hard fail): all furniture/decor (beds, HEADBOARDS, couches, tables), lighting/fixtures, style/color/brightness/contrast/material changes.

Categories you must choose:
- structure: architectural element moved/removed/added (wall/ceiling/floor/roofline/closet/arch/stair/door/window changed)
- opening_blocked: doorway/window fully occluded or path not passable
- furniture_change: furniture/decor added/removed/changed
- style_only: style/color/exposure/lighting-only change
  - unknown: can't tell

Rules:
- structure => hardFail=true
- opening_blocked => hardFail=true ONLY if fully blocked or no passable path; otherwise warning
- furniture_change => hardFail=false (warning only)
- style_only => hardFail=false
- If confidence < ${MIN_CONFIDENCE}, set hardFail=false (warning)

Output JSON EXACTLY:
{
  "hardFail": boolean,
  "category": "structure"|"opening_blocked"|"furniture_change"|"style_only"|"unknown",
  "reasons": string[],
  "confidence": 0..1 number
}

Stage: ${stageLabel}. Scene: ${sceneLabel}.`;
}

export function parseGeminiSemanticText(text: string): GeminiSemanticVerdict {
  const fallback: GeminiSemanticVerdict = {
    hardFail: false,
    category: "unknown",
    reasons: [],
    confidence: 0,
    rawText: text,
  };
  if (!text) return fallback;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const target = jsonMatch ? jsonMatch[0] : text;
  try {
    const parsed = JSON.parse(target);
    return {
      hardFail: Boolean(parsed.hardFail),
      category: parsed.category || "unknown",
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [],
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
      rawText: text,
    };
  } catch (err) {
    return fallback;
  }
}

export async function runGeminiSemanticValidator(opts: {
  basePath: string;
  candidatePath: string;
  stage: "1A" | "1B" | "2";
  sceneType?: string;
}): Promise<GeminiSemanticVerdict> {
  const ai = getGeminiClient();
  const before = toBase64(opts.basePath).data;
  const after = toBase64(opts.candidatePath).data;
  const prompt = buildPrompt(opts.stage, opts.sceneType);

  const contents = [
    { role: "user", parts: [{ text: prompt }] },
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/webp", data: before } },
        { inlineData: { mimeType: "image/webp", data: after } },
      ],
    },
  ];

  try {
    const start = Date.now();
    const response = await (ai as any).models.generateContent({
      model: "gemini-2.0-flash",
      contents,
      generationConfig: {
        temperature: 0.2,
        topP: 0.5,
        maxOutputTokens: 512,
      },
    } as any);
    const textParts = (response as any)?.candidates?.[0]?.content?.parts || [];
    const text = textParts.map((p: any) => p?.text || "").join(" ").trim();
    const parsed = parseGeminiSemanticText(text);
    parsed.rawText = text;

    // Confidence gating & category-based rules
    const lowConfidence = !Number.isFinite(parsed.confidence) || parsed.confidence < MIN_CONFIDENCE;
    const category = parsed.category as GeminiSemanticVerdict["category"];

    let hardFail = parsed.hardFail;
    if (category === "structure") hardFail = true;
    else if (category === "opening_blocked") hardFail = parsed.hardFail;
    else if (category === "furniture_change" || category === "style_only") hardFail = false;

    if (lowConfidence) hardFail = false;

    const verdict: GeminiSemanticVerdict = {
      hardFail,
      category,
      reasons: parsed.reasons || [],
      confidence: parsed.confidence ?? 0,
      rawText: text,
    };

    const ms = Date.now() - start;
    console.log(`[gemini-semantic] completed in ${ms}ms (hardFail=${verdict.hardFail} conf=${verdict.confidence} cat=${verdict.category})`);
    return verdict;
  } catch (err: any) {
    console.warn("[gemini-semantic] error (fail-open):", err?.message || err);
    return {
      hardFail: false,
      category: "unknown",
      confidence: 0,
      reasons: ["gemini_error"],
      rawText: err?.message,
    };
  }
}
