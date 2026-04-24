import sharp from "sharp";

import { getGeminiClient } from "./gemini";
import { siblingOutPath } from "../utils/images";

export type SceneType = "interior" | "exterior";

export type EnvironmentType =
  | "interior"
  | "exterior_overcast"
  | "exterior_sunny"
  | "exterior_no_sky"
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
  if (!decision.shouldReplaceSky) {
    return decision;
  }

  return {
    ...decision,
    strength: Math.min(1, decision.strength + 0.15),
  };
}

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_CONFIDENCE_MIN = 0.7;
const SCENE_CONFIDENCE_MIN = 0.65;
const VALID_ENVIRONMENTS: ReadonlySet<EnvironmentType> = new Set([
  "interior",
  "exterior_overcast",
  "exterior_sunny",
  "exterior_no_sky",
  "uncertain",
]);

const ANALYZER_PROMPT = `You are a strict visual classifier for real estate images.

Classify this image into ONE of the following categories:

interior
exterior_overcast (flat white/grey sky, cloudy, low contrast)
exterior_sunny (blue sky, strong light, clear conditions)
exterior_no_sky (outdoor but sky not visible, e.g. courtyard, under cover)
uncertain

Rules:

Do NOT guess. If unsure, return "uncertain".
Overcast sky may appear white or grey and must NOT be classified as interior ceiling.
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
      return finalizeLightingDecision({
        shouldRelight: true,
        shouldReplaceSky: true,
        profile: "bright_premium",
        strength: 0.85,
        reason: "Overcast exterior — high uplift opportunity",
      });

    case "exterior_sunny":
      return finalizeLightingDecision({
        shouldRelight: true,
        shouldReplaceSky: false,
        profile: "light_sunny",
        strength: 0.35,
        reason: "Already sunny — preserve realism",
      });

    case "exterior_no_sky":
      return finalizeLightingDecision({
        shouldRelight: true,
        shouldReplaceSky: false,
        profile: "overcast",
        strength: 0.4,
        reason: "Exterior without sky — gentle enhancement only",
      });

    case "uncertain":
      return finalizeLightingDecision({
        shouldRelight: true,
        shouldReplaceSky: false,
        profile: "overcast",
        strength: 0.3,
        reason: "Uncertain environment — safe fallback",
      });

    default:
      return finalizeLightingDecision({
        shouldRelight: false,
        shouldReplaceSky: false,
        profile: "overcast",
        strength: 0,
        reason: "Unhandled case",
      });
  }
}

export async function applyExteriorRelighting(
  inputPath: string,
  decision: LightingDecision
): Promise<string> {
  if (!decision.shouldRelight || decision.strength <= 0) {
    return inputPath;
  }

  const strength = Math.max(0, Math.min(1, decision.strength));
  const settings: Record<LightingProfile, {
    brightness: number;
    saturation: number;
    gamma: number;
    contrast: number;
    redGain: number;
    greenGain: number;
    blueGain: number;
  }> = {
    overcast: {
      brightness: 1.06,
      saturation: 1.03,
      gamma: 1.02,
      contrast: 1.03,
      redGain: 1.008,
      greenGain: 1.0,
      blueGain: 0.998,
    },
    light_sunny: {
      brightness: 1.025,
      saturation: 1.02,
      gamma: 1.01,
      contrast: 1.015,
      redGain: 1.004,
      greenGain: 1.0,
      blueGain: 0.999,
    },
    bright_premium: {
      brightness: 1.1,
      saturation: 1.05,
      gamma: 1.03,
      contrast: 1.05,
      redGain: 1.01,
      greenGain: 1.0,
      blueGain: 0.996,
    },
    dusk_dawn: {
      brightness: 1.04,
      saturation: 1.04,
      gamma: 1.015,
      contrast: 1.03,
      redGain: 1.018,
      greenGain: 1.0,
      blueGain: 0.992,
    },
  };

  const profile = settings[decision.profile];
  const brightness = 1 + ((profile.brightness - 1) * strength);
  const saturation = 1 + ((profile.saturation - 1) * strength);
  const gamma = 1 + ((profile.gamma - 1) * strength);
  const contrast = 1 + ((profile.contrast - 1) * strength);
  const redGain = 1 + ((profile.redGain - 1) * strength);
  const greenGain = 1 + ((profile.greenGain - 1) * strength);
  const blueGain = 1 + ((profile.blueGain - 1) * strength);
  const offset = -(128 * (contrast - 1) * 0.35);
  const outputPath = siblingOutPath(inputPath, "-env-relit");

  await sharp(inputPath)
    .rotate()
    .linear([redGain, greenGain, blueGain], [0, 0, 0])
    .modulate({ brightness, saturation })
    .gamma(gamma)
    .linear(contrast, offset)
    .webp({ quality: 95, effort: 6 })
    .toFile(outputPath);

  return outputPath;
}