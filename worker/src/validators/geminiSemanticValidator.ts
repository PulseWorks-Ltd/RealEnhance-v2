import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";

export type GeminiSemanticResponse = {
  structural_ok: boolean;
  walkway_ok: boolean;
  hard_fail: boolean;
  confidence: number;
  reasons: string[];
  notes: string;
};

export type GeminiSemanticVerdict = GeminiSemanticResponse & {
  rawText?: string;
};

const MIN_CONFIDENCE = 0.65;

function buildPrompt(stage: "1A" | "1B" | "2", scene: string | undefined) {
  const stageLabel = stage === "2" ? "Stage 2 (virtual staging)" : stage === "1B" ? "Stage 1B (declutter)" : "Stage 1A (color/cleanup)";
  const sceneLabel = scene === "exterior" ? "EXTERIOR" : "INTERIOR";
  return `You are a structural integrity judge for real estate imagery.
Return a SMALL JSON ONLY. No prose outside JSON.
Compare BEFORE vs AFTER images. Focus ONLY on hard architectural facts:
- walls, ceilings/roof planes, floors, staircases, columns
- door and window openings (position/size/visibility)
- patios/driveways/paths if exterior
- camera/viewpoint: no missing room sections or new viewpoints
- walkability: furniture may change, but must NOT block doorways or main circulation paths; there must be a passable gap to each doorway.

IGNORE the following (do NOT fail for them): furniture additions/removals/changes, decor, wall art, rugs, plants, curtains, pillows, styling, color/paint/lighting/contrast/material/finish changes or texture changes.

Hard fail ONLY if architecture is removed/moved/added OR doorways/windows blocked. If unsure or low confidence, DO NOT hard fail.

Output JSON EXACTLY in this shape:
{
  "structural_ok": boolean,
  "walkway_ok": boolean,
  "hard_fail": boolean,
  "confidence": 0..1 number,
  "reasons": string[],
  "notes": string
}

Hard fail rules:
- missing room area / room_deleted / missing_room_area
- wall moved/removed/added
- doorway/window removed/moved/resized materially
- ceiling/roof line materially changed
- floor plane materially changed
- patio/driveway/path removed/moved (exterior)
- doorway blocked or no passable path (walkway_ok=false with high confidence)

Soft warnings only when confidence < ${MIN_CONFIDENCE}. Stage: ${stageLabel}. Scene: ${sceneLabel}.`;
}

export function parseGeminiSemanticText(text: string): GeminiSemanticVerdict {
  const fallback: GeminiSemanticVerdict = {
    structural_ok: true,
    walkway_ok: true,
    hard_fail: false,
    confidence: 0,
    reasons: [],
    notes: "no-parse",
    rawText: text,
  };
  if (!text) return fallback;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const target = jsonMatch ? jsonMatch[0] : text;
  try {
    const parsed = JSON.parse(target);
    return {
      structural_ok: Boolean(parsed.structural_ok),
      walkway_ok: parsed.walkway_ok === false ? false : true,
      hard_fail: Boolean(parsed.hard_fail),
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [],
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
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
    const response = await ai.responses.generate({
      model: "gemini-2.0-flash",
      contents,
      generationConfig: {
        temperature: 0.2,
        topP: 0.5,
        maxOutputTokens: 512,
      },
    });
    const text = response?.response?.text()?.trim() || "";
    const parsed = parseGeminiSemanticText(text);
    parsed.rawText = text;

    // Confidence gating
    const lowConfidence = !Number.isFinite(parsed.confidence) || parsed.confidence < MIN_CONFIDENCE;
    const structuralRisk = parsed.structural_ok === false;
    const walkwayRisk = parsed.walkway_ok === false;
    const hardSignals = parsed.hard_fail === true || parsed.reasons?.some((r: string) => typeof r === "string" && r.toLowerCase().includes("missing_room_area")) || false;

    const shouldHardFail = !lowConfidence && (hardSignals || structuralRisk || walkwayRisk);
    const verdict: GeminiSemanticVerdict = {
      ...parsed,
      hard_fail: shouldHardFail,
      confidence: parsed.confidence ?? 0,
      reasons: parsed.reasons || [],
      notes: parsed.notes || "",
      structural_ok: parsed.structural_ok !== false,
      walkway_ok: parsed.walkway_ok !== false,
      rawText: text,
    };

    // If low confidence, never hard fail
    if (lowConfidence) {
      verdict.hard_fail = false;
    }

    const ms = Date.now() - start;
    console.log(`[gemini-semantic] completed in ${ms}ms (hard_fail=${verdict.hard_fail} conf=${verdict.confidence})`);
    return verdict;
  } catch (err: any) {
    console.warn("[gemini-semantic] error (fail-open):", err?.message || err);
    return {
      structural_ok: true,
      walkway_ok: true,
      hard_fail: false,
      confidence: 0,
      reasons: ["gemini_error"],
      notes: err?.message || "gemini_error",
    };
  }
}
