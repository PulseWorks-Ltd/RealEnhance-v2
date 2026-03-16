import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";

const OPENING_MODEL_PRIMARY = process.env.GEMINI_VALIDATOR_MODEL_PRIMARY || "gemini-2.5-flash";
const OPENING_MODEL_ESCALATION = process.env.GEMINI_VALIDATOR_MODEL_ESCALATION || "gemini-2.5-pro";
const OPENING_CONFIDENCE_THRESHOLD = Number(process.env.EDIT_SIMPLE_OPENINGS_CONFIDENCE || 0.75);

export type EditSimpleOpeningsResult = {
  openingWalledOver: boolean;
  openingReplacedByDecor: boolean;
  confidence: number;
  reason: string;
  passed: boolean;
  modelUsed: string;
};

function normalizeConfidence(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function parseVerdict(rawText: string): Omit<EditSimpleOpeningsResult, "passed" | "modelUsed"> {
  const cleaned = String(rawText || "").replace(/```json|```/gi, "").trim();
  const jsonCandidate = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
  const parsed = JSON.parse(jsonCandidate || "{}");

  const openingWalledOver = parsed?.openingWalledOver === true;
  const openingReplacedByDecor = parsed?.openingReplacedByDecor === true;
  const confidence = normalizeConfidence(parsed?.confidence);
  const reason = typeof parsed?.reason === "string" && parsed.reason.trim().length > 0
    ? parsed.reason.trim().slice(0, 200)
    : "openings_preserved";

  return {
    openingWalledOver,
    openingReplacedByDecor,
    confidence,
    reason,
  };
}

async function runModelCheck(
  model: string,
  beforeImageUrl: string,
  afterImageUrl: string,
): Promise<Omit<EditSimpleOpeningsResult, "passed" | "modelUsed">> {
  const ai = getGeminiClient();
  const before = toBase64(beforeImageUrl).data;
  const after = toBase64(afterImageUrl).data;

  const prompt = `You are validating preservation of architectural openings in an edited real-estate image.

Compare IMAGE_BEFORE and IMAGE_AFTER.

FAIL CONDITIONS (ONLY THESE):
1) openingWalledOver=true when a window, door, or architectural opening visible in BEFORE is replaced by continuous wall surface in AFTER.
2) openingReplacedByDecor=true when that opening is replaced by decor/artwork/painting/paneling or a non-opening decorative surface in AFTER.

ALLOWED (DO NOT FAIL):
- Partial or full occlusion by furniture, plants, curtains, blinds, or movable objects.
- Openings hidden behind objects as long as not replaced by wall/decor surface.

Return STRICT JSON only:
{
  "openingWalledOver": boolean,
  "openingReplacedByDecor": boolean,
  "confidence": number,
  "reason": string
}`;

  const response = await (ai as any).models.generateContent({
    model,
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
      topP: 0,
      maxOutputTokens: 200,
      responseMimeType: "application/json",
    },
  });

  const rawText = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return parseVerdict(rawText);
}

export async function runEditSimpleOpeningsValidator(
  beforeImageUrl: string,
  afterImageUrl: string,
): Promise<EditSimpleOpeningsResult> {
  let verdict: Omit<EditSimpleOpeningsResult, "passed" | "modelUsed"> | null = null;
  let modelUsed = OPENING_MODEL_PRIMARY;

  try {
    verdict = await runModelCheck(OPENING_MODEL_PRIMARY, beforeImageUrl, afterImageUrl);
  } catch {
    verdict = null;
  }

  if (!verdict) {
    verdict = await runModelCheck(OPENING_MODEL_ESCALATION, beforeImageUrl, afterImageUrl);
    modelUsed = OPENING_MODEL_ESCALATION;
  }

  const hardSignal = verdict.openingWalledOver || verdict.openingReplacedByDecor;
  const passed = !(hardSignal && verdict.confidence >= OPENING_CONFIDENCE_THRESHOLD);

  return {
    ...verdict,
    passed,
    modelUsed,
  };
}
