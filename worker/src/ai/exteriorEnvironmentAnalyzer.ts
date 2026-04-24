import { getGeminiClient } from "./gemini";

export type SceneType = "interior" | "exterior";

export type EnvironmentType =
  | "interior"
  | "exterior_overcast"
  | "exterior_sunny"
  | "exterior_no_sky"
  | "exterior_partial_cover"
  | "uncertain";

export interface SceneDetectionResult {
  sceneType: SceneType;
  confidence: number;
  needsConfirm?: boolean;
}

export interface UserOverride {
  sceneOverride?: SceneType;
}

export interface GeminiEnvironmentResult {
  environment: EnvironmentType;
  confidence: number;
}

export type LightingProfile =
  | "overcast"
  | "light_sunny"
  | "bright_premium"
  | "dusk_dawn";

export interface LightingDecision {
  shouldRelight: boolean;
  shouldReplaceSky: boolean;
  profile: LightingProfile;
  strength: number;
  reason: string;
}

function finalizeLightingDecision(decision: LightingDecision): LightingDecision {
  return {
    ...decision,
    strength: Math.max(0, Math.min(0.85, decision.strength)),
  };
}

function finalizeLightingDecisionForEnvironment(
  environment: EnvironmentType,
  decision: LightingDecision,
  geminiConfidence?: number
): LightingDecision {
  let strength = decision.strength;

  if (decision.shouldReplaceSky) {
    strength += 0.15;
    if (environment === "exterior_partial_cover") {
      strength += 0.1;
    }
  }

  if (
    environment === "exterior_partial_cover" &&
    typeof geminiConfidence === "number" &&
    geminiConfidence < 0.75
  ) {
    strength -= 0.1;
  }

  return finalizeLightingDecision({
    ...decision,
    strength: Math.min(strength, 1),
  });
}

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_CONFIDENCE_MIN = 0.7;
const SCENE_CONFIDENCE_MIN = 0.65;
const VALID_ENVIRONMENTS: ReadonlySet<EnvironmentType> = new Set([
  "interior",
  "exterior_overcast",
  "exterior_sunny",
  "exterior_no_sky",
  "exterior_partial_cover",
  "uncertain",
]);

const ANALYZER_PROMPT = `You are a strict visual classifier for real estate images.

Classify this image into ONE of the following categories:

interior
exterior_overcast (flat white/grey sky, cloudy, low contrast)
exterior_sunny (blue sky, strong light, clear conditions)
exterior_no_sky (outdoor but sky not visible, e.g. courtyard, under cover)
exterior_partial_cover (Outdoor space with overhead structure like pergola, louvre roof, or awning, but with visible sky or open sides)
uncertain

Rules:

Do NOT guess. If unsure, return "uncertain".
Overcast sky may appear white or grey and must NOT be classified as interior ceiling.
If overhead structure exists AND sky visible, classify as "exterior_partial_cover".
Do NOT classify these as interior.
Do NOT classify these as exterior_no_sky.
Only return valid JSON.

Output format:
{
"environment": "...",
"confidence": number (0.0–1.0)
}`;

function clampConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function fallbackEnvironmentResult(): GeminiEnvironmentResult {
  return { environment: "uncertain", confidence: 0 };
}

function extractJsonObject(text: string): string | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }

  let jsonStr = match[0];
  try {
    JSON.parse(jsonStr);
    return jsonStr;
  } catch {
    let braceCount = 0;
    let jsonEnd = -1;
    for (let index = 0; index < jsonStr.length; index += 1) {
      if (jsonStr[index] === "{") braceCount += 1;
      if (jsonStr[index] === "}") {
        braceCount -= 1;
        if (braceCount === 0) {
          jsonEnd = index;
          break;
        }
      }
    }
    if (jsonEnd >= 0) {
      return jsonStr.slice(0, jsonEnd + 1);
    }
    return null;
  }
}

function parseEnvironmentResult(text: string): GeminiEnvironmentResult {
  const jsonStr = extractJsonObject(text);
  if (!jsonStr) {
    return fallbackEnvironmentResult();
  }

  try {
    const parsed = JSON.parse(jsonStr) as {
      environment?: unknown;
      confidence?: unknown;
    };
    const environment = typeof parsed.environment === "string" && VALID_ENVIRONMENTS.has(parsed.environment as EnvironmentType)
      ? parsed.environment as EnvironmentType
      : "uncertain";
    return {
      environment,
      confidence: clampConfidence(parsed.confidence),
    };
  } catch {
    return fallbackEnvironmentResult();
  }
}

export async function analyzeExteriorEnvironment(
  base64Image: string
): Promise<GeminiEnvironmentResult> {
  try {
    const ai = getGeminiClient();
    const resp = await (ai as any).models.generateContent({
      model: GEMINI_MODEL,
      contents: [{
        role: "user",
        parts: [
          { text: ANALYZER_PROMPT },
          { inlineData: { data: base64Image, mimeType: "image/jpeg" } },
        ],
      }],
      config: {
        temperature: 0,
        topP: 0.1,
        topK: 1,
      },
    });

    const text = resp.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") ?? "{}";
    return parseEnvironmentResult(text);
  } catch {
    return fallbackEnvironmentResult();
  }
}

export function determineLightingDecision(params: {
  scene: SceneDetectionResult;
  userOverride?: UserOverride;
  gemini?: GeminiEnvironmentResult;
}): LightingDecision {
  const overrideType =
    params.userOverride?.sceneOverride === "exterior"
      ? params.scene.sceneType === "interior"
        ? "interior_to_exterior"
        : params.scene.needsConfirm
        ? "uncertain_to_exterior"
        : "none"
      : "none";

  if (
    params.scene.sceneType === "interior" &&
    overrideType !== "interior_to_exterior"
  ) {
    return finalizeLightingDecision({
      shouldRelight: false,
      shouldReplaceSky: false,
      profile: "overcast",
      strength: 0,
      reason: "Interior image",
    });
  }

  if (overrideType === "interior_to_exterior") {
    return finalizeLightingDecision({
      shouldRelight: true,
      shouldReplaceSky: false,
      profile: "overcast",
      strength: 0.25,
      reason: "User forced exterior from interior — conservative mode",
    });
  }

  const env = params.gemini?.confidence && params.gemini.confidence > GEMINI_CONFIDENCE_MIN
    ? params.gemini.environment
    : null;

  let finalEnv: EnvironmentType = "uncertain";

  if (env) {
    finalEnv = env;
  } else if (params.scene.sceneType === "exterior") {
    finalEnv = params.scene.confidence >= SCENE_CONFIDENCE_MIN ? "exterior_overcast" : "uncertain";
  }

  switch (finalEnv) {
    case "exterior_overcast":
      return finalizeLightingDecisionForEnvironment(finalEnv, {
        shouldRelight: true,
        shouldReplaceSky: true,
        profile: "bright_premium",
        strength: 0.85,
        reason: "Overcast exterior — high uplift opportunity",
      }, params.gemini?.confidence);

    case "exterior_sunny":
      return finalizeLightingDecisionForEnvironment(finalEnv, {
        shouldRelight: true,
        shouldReplaceSky: false,
        profile: "light_sunny",
        strength: 0.35,
        reason: "Already sunny — preserve realism",
      }, params.gemini?.confidence);

    case "exterior_partial_cover":
      return finalizeLightingDecisionForEnvironment(finalEnv, {
        shouldRelight: true,
        shouldReplaceSky: true,
        profile: "light_sunny",
        strength: 0.65,
        reason: "Covered exterior with visible sky — uplift with controlled sunlight",
      }, params.gemini?.confidence);

    case "exterior_no_sky":
      return finalizeLightingDecisionForEnvironment(finalEnv, {
        shouldRelight: true,
        shouldReplaceSky: false,
        profile: "overcast",
        strength: 0.4,
        reason: "Exterior without sky — gentle enhancement only",
      }, params.gemini?.confidence);

    case "uncertain":
      return finalizeLightingDecisionForEnvironment(finalEnv, {
        shouldRelight: true,
        shouldReplaceSky: false,
        profile: "overcast",
        strength: 0.3,
        reason: "Uncertain environment — safe fallback",
      }, params.gemini?.confidence);

    default:
      return finalizeLightingDecisionForEnvironment(finalEnv, {
        shouldRelight: false,
        shouldReplaceSky: false,
        profile: "overcast",
        strength: 0,
        reason: "Unhandled case",
      }, params.gemini?.confidence);
  }
}