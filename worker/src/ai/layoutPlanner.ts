import { getGeminiClient } from "./gemini";
import { toBase64 } from "../utils/images";
import { focusLog } from "../utils/logFocus";

/**
 * Layout Context Result from Gemini vision pre-pass
 * Used to provide spatial guidance to Stage 2 staging (FULL mode only)
 */
export interface LayoutContextResult {
  room_type_guess: string | null;
  open_plan: boolean | null;

  zones: Array<{
    type: "kitchen" | "living" | "dining" | "bedroom" | "office" | "unknown";
    position_hint: "left" | "center" | "right" | "rear" | "foreground" | "unknown";
  }>;

  primary_focal_wall: "left" | "right" | "center" | "rear" | "unknown";

  major_fixed_features: string[];
  // examples: ["kitchen_island", "sliding_doors", "wardrobe", "fireplace", "large_windows"]

  occlusion_risk: number;
  // 0.0–1.0 — how much furniture blocks structure

  layout_complexity: "simple" | "moderate" | "complex";

  staging_risk_flags: string[];
  // examples: ["multi_zone_overlap", "blocked_openings", "unclear_window_vs_door"]

  confidence: number;
  // 0.0–1.0 overall confidence
}

const LAYOUT_PLANNER_PROMPT = `SYSTEM:
You are an architectural layout analyzer.
You extract spatial layout signals from interior real-estate photos.
You do NOT design, decorate, or suggest styling.
You ONLY return structured layout metadata.

RULES:
- Output JSON only
- No prose
- No explanations
- No styling suggestions
- If uncertain → use null or "unknown"
- Do not hallucinate hidden areas
- Base answers only on visible evidence

USER:
Analyze this room image for staging-layout context.

Return JSON with fields:

room_type_guess
open_plan
zones[]
primary_focal_wall
major_fixed_features[]
occlusion_risk (0-1)
layout_complexity
staging_risk_flags[]
confidence (0-1)

Definitions:

open_plan = multiple functional zones visible in one space

major_fixed_features = built-in or architectural elements only:
islands, wardrobes, fireplaces, large windows, sliding doors, staircases

occlusion_risk = how much furniture blocks walls/openings:
0 = fully visible structure
1 = heavily blocked

layout_complexity:
simple = single clear room
moderate = 2 zones
complex = multi-zone or ambiguous

Return JSON only.`;

/**
 * Extract layout context from an image using Gemini vision
 * Low-cost, low-temperature, deterministic analysis
 * 
 * @param imageUrl - Path to the image file to analyze
 * @returns Structured layout context or null on failure
 */
export async function buildLayoutContext(imageUrl: string): Promise<LayoutContextResult | null> {
  const startTime = Date.now();
  
  try {
    focusLog("LAYOUT_PLANNER", "[layoutPlanner] Starting vision pre-pass", { imageUrl });

    // Get Gemini client
    const ai = getGeminiClient();
    if (!ai) {
      focusLog("LAYOUT_PLANNER", "[layoutPlanner] No Gemini client available");
      return null;
    }

    // Load image
    const { data, mime } = toBase64(imageUrl);

    // Build request
    const model = (ai as any).getGenerativeModel({
      model: "gemini-2.5-flash", // Low-cost model for analysis
      generationConfig: {
        temperature: 0.1, // Very low for deterministic output
        maxOutputTokens: 512, // Small output
        topP: 0.95,
        topK: 40,
        responseMimeType: "application/json", // Force JSON output
      },
    });

    // Make vision call
    const response = await model.generateContent([
      {
        inlineData: {
          mimeType: mime,
          data: data,
        },
      },
      { text: LAYOUT_PLANNER_PROMPT },
    ]);

    const elapsed = Date.now() - startTime;
    
    // Parse response
    const text = response.response?.text?.();
    if (!text) {
      focusLog("LAYOUT_PLANNER", "[layoutPlanner] No text response", { elapsed });
      return null;
    }

    // Parse JSON
    let result: LayoutContextResult;
    try {
      result = JSON.parse(text);
    } catch (parseError) {
      focusLog("LAYOUT_PLANNER", "[layoutPlanner] JSON parse failed", { 
        elapsed, 
        text: text.substring(0, 200) 
      });
      return null;
    }

    // Validate structure
    if (!isValidLayoutContext(result)) {
      focusLog("LAYOUT_PLANNER", "[layoutPlanner] Invalid structure", { 
        elapsed, 
        result 
      });
      return null;
    }

    focusLog("LAYOUT_PLANNER", "[layoutPlanner] ✅ Vision pre-pass complete", {
      elapsed,
      roomType: result.room_type_guess,
      openPlan: result.open_plan,
      complexity: result.layout_complexity,
      confidence: result.confidence,
      zones: result.zones.length,
      features: result.major_fixed_features.length,
    });

    return result;

  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    focusLog("LAYOUT_PLANNER", "[layoutPlanner] ❌ Error", { 
      elapsed, 
      error: error.message 
    });
    return null;
  }
}

/**
 * Validate that the result matches the expected schema
 */
function isValidLayoutContext(obj: any): obj is LayoutContextResult {
  if (!obj || typeof obj !== "object") return false;
  
  // Check required fields exist (even if null)
  const hasRequiredFields = 
    "room_type_guess" in obj &&
    "open_plan" in obj &&
    "zones" in obj &&
    "primary_focal_wall" in obj &&
    "major_fixed_features" in obj &&
    "occlusion_risk" in obj &&
    "layout_complexity" in obj &&
    "staging_risk_flags" in obj &&
    "confidence" in obj;

  if (!hasRequiredFields) return false;

  // Validate arrays
  if (!Array.isArray(obj.zones)) return false;
  if (!Array.isArray(obj.major_fixed_features)) return false;
  if (!Array.isArray(obj.staging_risk_flags)) return false;

  // Validate numbers
  if (typeof obj.occlusion_risk !== "number") return false;
  if (typeof obj.confidence !== "number") return false;

  return true;
}

/**
 * Format layout context as text for injection into Stage 2 prompt
 */
export function formatLayoutContextForPrompt(context: LayoutContextResult): string {
  return `
────────────────────────────────
LAYOUT CONTEXT (from vision pre-pass)
────────────────────────────────

Room Type: ${context.room_type_guess || "unknown"}
Open Plan: ${context.open_plan === true ? "yes" : context.open_plan === false ? "no" : "unknown"}
Layout Complexity: ${context.layout_complexity}
Occlusion Risk: ${context.occlusion_risk.toFixed(2)}
Confidence: ${context.confidence?.toFixed(2) || "0.00"}

Zones Detected:
${context.zones.map(z => `  • ${z.type} (${z.position_hint})`).join("\n") || "  (none)"}

Major Fixed Features:
${context.major_fixed_features.map(f => `  • ${f}`).join("\n") || "  (none)"}

Primary Focal Wall: ${context.primary_focal_wall}

${context.staging_risk_flags.length > 0 ? `Staging Risk Flags:\n${context.staging_risk_flags.map(f => `  ⚠ ${f}`).join("\n")}` : ""}

INSTRUCTION TO STAGING MODEL:
Use layout context as spatial guidance only.
Do not restyle architectural anchors.
Place furniture in harmony with detected zones and focal points.
Respect occlusion risk when adding items.

────────────────────────────────
`;
}
