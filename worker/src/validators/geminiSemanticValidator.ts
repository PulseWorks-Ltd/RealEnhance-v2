/**
 * Gemini Stage-Aware Semantic Validator
 *
 * Validates image transformations using Gemini vision model with stage-specific rules:
 * - 1B_LIGHT: Only clutter removal allowed, major furniture should remain (no major removals)
 * - 1B_FULL: All furniture/decor removal allowed, room must be empty
 * - 2: Staging allowed, but architecture/openings must be preserved
 *
 * This validator runs AFTER local validators pass (two-lane gating).
 */

import { getGeminiClient } from "../ai/gemini";
import fs from "fs/promises";
import path from "path";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type SemanticStage = "1B_LIGHT" | "1B_FULL" | "2";

export interface SemanticCheck {
  crop_or_reframe: "pass" | "fail" | "unclear";
  perspective_change: "pass" | "fail" | "unclear";
  architecture_preserved: "pass" | "fail" | "unclear";
  openings_preserved: "pass" | "fail" | "unclear";
  curtains_blinds_preserved: "pass" | "fail" | "unclear";
  fixed_cabinetry_joinery_preserved: "pass" | "fail" | "unclear";
  flooring_pattern_preserved: "pass" | "fail" | "unclear";
  wall_ceiling_floor_boundaries: "pass" | "fail" | "unclear";
  new_objects_added: "pass" | "fail" | "unclear";
  furniture_removed_only: "pass" | "fail" | "unclear";
  intent_match: "pass" | "fail" | "unclear";
}

export interface SemanticViolation {
  category: "structural" | "content" | "intent";
  type: string;
  severity: "minor" | "major";
  details: string;
}

export interface SemanticValidationParsed {
  stage: SemanticStage;
  pass: boolean;
  confidence: number;
  allowed_changes_only: boolean;
  reason: string;
  fail_reasons: string[];
  violations: SemanticViolation[];
  checks: SemanticCheck;
}

export interface SemanticValidationResult {
  parsed: SemanticValidationParsed | null;
  rawText?: string;
  isJsonValid: boolean;
  error?: string;
  repairAttempted: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

export function buildGeminiSemanticValidatorPrompt(stage: SemanticStage): string {
  const schema = `
OUTPUT FORMAT (STRICT):
Return ONLY a single JSON object (no markdown, no prose).

{
  "stage": "1B_LIGHT | 1B_FULL | 2",
  "pass": true/false,
  "confidence": 0.0-1.0,
  "allowed_changes_only": true/false,
  "reason": "short summary",
  "fail_reasons": ["..."],
  "violations": [
    {"category":"structural|content|intent","type":"...","severity":"minor|major","details":"..."}
  ],
  "checks": {
    "crop_or_reframe":"pass|fail|unclear",
    "perspective_change":"pass|fail|unclear",
    "architecture_preserved":"pass|fail|unclear",
    "openings_preserved":"pass|fail|unclear",
    "curtains_blinds_preserved":"pass|fail|unclear",
    "fixed_cabinetry_joinery_preserved":"pass|fail|unclear",
    "flooring_pattern_preserved":"pass|fail|unclear",
    "wall_ceiling_floor_boundaries":"pass|fail|unclear",
    "new_objects_added":"pass|fail|unclear",
    "furniture_removed_only":"pass|fail|unclear",
    "intent_match":"pass|fail|unclear"
  }
}

RULES:
- If uncertain, set checks to "unclear" and reduce confidence accordingly.
- Any structural violation => pass=false and add a major violation.
- Return ONLY the JSON object.`;

  const common = `
You are a strict compliance validator for RealEnhance.

You will be given TWO images:
- Image A = BASELINE (pre-stage)
- Image B = CANDIDATE (post-stage output)

Your job:
Compare Image B to Image A and determine whether Image B complies with the stage rules.

STRUCTURAL INVARIANTS (ALWAYS FAIL IF VIOLATED):
- Any crop, zoom, reframe, rotation, resizing, borders, padding
- Any perspective/camera viewpoint change
- Any change to walls/ceilings/floors/trims
- Any change to window/door/opening count, position, or size
- Any change to curtains/blinds/rods
- Any change to fixed cabinetry/joinery/built-ins
- Any change to outside view through windows
- Inventing new openings or removing/painting-over openings

EVALUATE IN THIS ORDER:
1) Structural invariants (if violated => FAIL immediately)
2) Stage content/intent rules
3) Set confidence and fill JSON strictly
`;

  const stageRules =
    stage === "1B_LIGHT"
      ? `
STAGE: 1B_LIGHT (Light Declutter)
INTENT:
The room should remain furnished similarly to before. Only loose clutter / personal items should be removed.
Minor global quality tweaks are allowed.

ALLOWED:
- Remove loose clutter/personal items on surfaces/floors (papers, small decor, toiletries, cables, toys, dishes, etc.)
- Minor global quality corrections (exposure, white balance, noise, compression cleanup, mild clarity)
- Minor adjustments to small accessories (e.g., cushion positions) are tolerable

DISALLOWED (FAIL):
- Removing or substantially altering MAJOR furniture (sofas, beds, dining table/chairs, armchairs, wardrobes, dressers, large rugs under furniture)
- Large-scale repositioning of furniture
- Adding ANY new major object, furniture, decor, plants, rugs, lamps, props, or staging items
- Any "virtual staging" (adding furniture that didn't exist)

NOTE: Do NOT fail for minor furniture repositioning or small accessory changes. Only fail for substantial, obvious removals or additions of major furniture pieces.
`
      : stage === "1B_FULL"
      ? `
STAGE: 1B_FULL (Full Furniture Removal / Empty Room)
INTENT:
Image B must show the SAME room but COMPLETELY EMPTY:
ALL furniture removed, ALL decor removed, ALL rugs/mats removed, ALL loose items removed.
Minor global quality tweaks are allowed.

ALLOWED:
- Removal of furniture/decor/rugs/loose items
- Minor global quality corrections (exposure, white balance, noise, compression cleanup, mild clarity)

DISALLOWED (FAIL):
- ANY furniture remains (beds, sofas, chairs, tables, stools, cabinets, shelving, wardrobes, TV units, etc.)
- ANY rugs/mats/floor coverings remain (even partial)
- ANY decor remains (plants, vases, lamps, art, mirrors, wall decor)
- ANY clutter remains on floors/surfaces
- Adding ANY new objects (staging is forbidden in Stage 1B)
`
      : `
STAGE: 2 (Virtual Staging)
INTENT:
Virtual staging IS ALLOWED: adding furniture, rugs, decor, plants is permitted.
But architecture/openings must remain unchanged and staging must be physically plausible.

ALLOWED:
- Add virtual furniture appropriate to room
- Add rugs/decor/lamps/plants/wall art (tasteful)
- Lighting/shadow adjustments to make furniture realistic
- Minor global quality corrections

DISALLOWED (FAIL):
- Any structural invariant violation (see above)
- Furniture blocking windows/doors/openings
- Furniture floating, intersecting walls, or obviously incorrect scale (major if obvious)
- Adding NEW structural elements (built-ins, fake walls, fireplaces, new cabinetry, etc.)
IMPORTANT:
Do NOT fail Stage 2 simply because new furniture exists. New furniture is expected.
`;

  const stageSpecificOutputNotes =
    stage === "2"
      ? `
STAGE 2 OUTPUT NOTES:
- "new_objects_added" should usually be "pass" unless the "new objects" are structural (built-ins) or violate placement rules.
- "furniture_removed_only" is not applicable; set "pass" unless Image B removed fixed items unexpectedly.
`
      : "";

  return `${common}\n${stageRules}\n${stageSpecificOutputNotes}\n${schema}`.trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// JSON PARSING
// ═══════════════════════════════════════════════════════════════════════════════

function cleanJsonResponse(text: string): string {
  // Remove markdown code blocks
  let cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "");
  // Trim whitespace
  cleaned = cleaned.trim();
  // Try to extract JSON object if there's extra text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }
  return cleaned;
}

function parseSemanticJson(text: string): SemanticValidationParsed | null {
  try {
    const cleaned = cleanJsonResponse(text);
    const parsed = JSON.parse(cleaned);

    // Validate required fields
    if (typeof parsed.pass !== "boolean") return null;
    if (typeof parsed.confidence !== "number") return null;
    if (!parsed.checks) return null;

    // Normalize and return
    return {
      stage: parsed.stage || "2",
      pass: parsed.pass,
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      allowed_changes_only: parsed.allowed_changes_only ?? parsed.pass,
      reason: parsed.reason || "",
      fail_reasons: Array.isArray(parsed.fail_reasons) ? parsed.fail_reasons : [],
      violations: Array.isArray(parsed.violations) ? parsed.violations : [],
      checks: {
        crop_or_reframe: parsed.checks.crop_or_reframe || "unclear",
        perspective_change: parsed.checks.perspective_change || "unclear",
        architecture_preserved: parsed.checks.architecture_preserved || "unclear",
        openings_preserved: parsed.checks.openings_preserved || "unclear",
        curtains_blinds_preserved: parsed.checks.curtains_blinds_preserved || "unclear",
        fixed_cabinetry_joinery_preserved: parsed.checks.fixed_cabinetry_joinery_preserved || "unclear",
        flooring_pattern_preserved: parsed.checks.flooring_pattern_preserved || "unclear",
        wall_ceiling_floor_boundaries: parsed.checks.wall_ceiling_floor_boundaries || "unclear",
        new_objects_added: parsed.checks.new_objects_added || "unclear",
        furniture_removed_only: parsed.checks.furniture_removed_only || "unclear",
        intent_match: parsed.checks.intent_match || "unclear",
      },
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPAIR PROMPT
// ═══════════════════════════════════════════════════════════════════════════════

function buildRepairPrompt(invalidJson: string): string {
  return `Your previous response was NOT valid JSON. Here is what you returned:

---
${invalidJson.slice(0, 2000)}
---

Please return ONLY the corrected JSON object matching this schema:
{
  "stage": "1B_LIGHT | 1B_FULL | 2",
  "pass": true/false,
  "confidence": 0.0-1.0,
  "allowed_changes_only": true/false,
  "reason": "short summary",
  "fail_reasons": ["..."],
  "violations": [...],
  "checks": {
    "crop_or_reframe":"pass|fail|unclear",
    "perspective_change":"pass|fail|unclear",
    "architecture_preserved":"pass|fail|unclear",
    "openings_preserved":"pass|fail|unclear",
    "curtains_blinds_preserved":"pass|fail|unclear",
    "fixed_cabinetry_joinery_preserved":"pass|fail|unclear",
    "flooring_pattern_preserved":"pass|fail|unclear",
    "wall_ceiling_floor_boundaries":"pass|fail|unclear",
    "new_objects_added":"pass|fail|unclear",
    "furniture_removed_only":"pass|fail|unclear",
    "intent_match":"pass|fail|unclear"
  }
}

Return ONLY the JSON. No markdown, no explanation.`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN VALIDATOR
// ═══════════════════════════════════════════════════════════════════════════════

export async function validateSemanticStageCompliance(args: {
  stage: SemanticStage;
  baselineImagePath: string;
  candidateImagePath: string;
  model?: string;
}): Promise<SemanticValidationResult> {
  const { stage, baselineImagePath, candidateImagePath, model = "gemini-2.0-flash" } = args;
  const logRaw = process.env.SEMANTIC_VALIDATOR_LOG_RAW === "1";

  try {
    const ai = getGeminiClient();
    if (!ai) {
      return {
        parsed: null,
        isJsonValid: false,
        error: "Gemini client not available",
        repairAttempted: false,
      };
    }

    // Read images as base64
    const [baselineBuffer, candidateBuffer] = await Promise.all([
      fs.readFile(baselineImagePath),
      fs.readFile(candidateImagePath),
    ]);

    const baselineB64 = baselineBuffer.toString("base64");
    const candidateB64 = candidateBuffer.toString("base64");

    // Determine MIME type from extension
    const getMime = (p: string) => {
      const ext = path.extname(p).toLowerCase();
      if (ext === ".webp") return "image/webp";
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      return "image/webp";
    };

    const baselineMime = getMime(baselineImagePath);
    const candidateMime = getMime(candidateImagePath);

    // Build prompt
    const prompt = buildGeminiSemanticValidatorPrompt(stage);

    // First attempt
    const resp = await (ai as any).models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { text: "IMAGE A (BASELINE):" },
            { inlineData: { mimeType: baselineMime, data: baselineB64 } },
            { text: "IMAGE B (CANDIDATE):" },
            { inlineData: { mimeType: candidateMime, data: candidateB64 } },
          ],
        },
      ],
    });

    const rawText = resp.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") || "";

    if (logRaw) {
      console.log(`[SEMANTIC_RAW] stage=${stage} response:`, rawText.slice(0, 1000));
    }

    // Try to parse
    let parsed = parseSemanticJson(rawText);

    if (parsed) {
      return {
        parsed,
        rawText: logRaw ? rawText : undefined,
        isJsonValid: true,
        repairAttempted: false,
      };
    }

    // Repair attempt
    console.warn(`[SEMANTIC_VALIDATOR] JSON parse failed for stage=${stage}, attempting repair...`);

    const repairPrompt = buildRepairPrompt(rawText);
    const repairResp = await (ai as any).models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [{ text: repairPrompt }],
        },
      ],
    });

    const repairText = repairResp.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") || "";

    if (logRaw) {
      console.log(`[SEMANTIC_REPAIR_RAW] stage=${stage} response:`, repairText.slice(0, 1000));
    }

    parsed = parseSemanticJson(repairText);

    if (parsed) {
      console.log(`[SEMANTIC_VALIDATOR] JSON repair succeeded for stage=${stage}`);
      return {
        parsed,
        rawText: logRaw ? repairText : undefined,
        isJsonValid: true,
        repairAttempted: true,
      };
    }

    // Repair failed
    console.error(`[SEMANTIC_VALIDATOR] JSON repair failed for stage=${stage}`);
    return {
      parsed: null,
      rawText: logRaw ? repairText : undefined,
      isJsonValid: false,
      error: "JSON parse failed after repair attempt",
      repairAttempted: true,
    };
  } catch (err: any) {
    console.error(`[SEMANTIC_VALIDATOR] Error for stage=${stage}:`, err?.message || err);
    return {
      parsed: null,
      isJsonValid: false,
      error: err?.message || String(err),
      repairAttempted: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLACEMENT VALIDATOR (Stage 2 only)
// ═══════════════════════════════════════════════════════════════════════════════

export interface PlacementValidationResult {
  pass: boolean;
  confidence?: number;
  reason?: string;
  rawText?: string;
  error?: string;
}

export async function validatePlacement(args: {
  baselineImagePath: string;
  candidateImagePath: string;
  model?: string;
}): Promise<PlacementValidationResult> {
  const { baselineImagePath, candidateImagePath, model = "gemini-2.0-flash" } = args;
  const logRaw = process.env.SEMANTIC_VALIDATOR_LOG_RAW === "1";

  try {
    const ai = getGeminiClient();
    if (!ai) {
      return { pass: false, error: "Gemini client not available" };
    }

    const [baselineBuffer, candidateBuffer] = await Promise.all([
      fs.readFile(baselineImagePath),
      fs.readFile(candidateImagePath),
    ]);

    const baselineB64 = baselineBuffer.toString("base64");
    const candidateB64 = candidateBuffer.toString("base64");

    const getMime = (p: string) => {
      const ext = path.extname(p).toLowerCase();
      if (ext === ".webp") return "image/webp";
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      return "image/webp";
    };

    const placementPrompt = `Return JSON only: {"ok": true|false, "confidence": 0.0-1.0, "reasons": ["..."]}
Compare ORIGINAL vs EDITED. ok=false if EDITED places objects in clearly unrealistic or unsafe positions, such as:
- blocking a DOOR or WINDOW,
- overlapping fixed fixtures,
- furniture not aligned to floor perspective,
- furniture floating or intersecting walls,
- obviously wrong scale (e.g., giant chairs, tiny tables).
Allow staging furniture to overlap walls/floors visually; overlapping is NOT a placement violation.
Be tolerant of minor imperfections. Only fail on obvious issues.`;

    const resp = await (ai as any).models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: placementPrompt },
            { text: "ORIGINAL:" },
            { inlineData: { mimeType: getMime(baselineImagePath), data: baselineB64 } },
            { text: "EDITED:" },
            { inlineData: { mimeType: getMime(candidateImagePath), data: candidateB64 } },
          ],
        },
      ],
    });

    const rawText = resp.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") || "";

    if (logRaw) {
      console.log(`[PLACEMENT_RAW] response:`, rawText.slice(0, 500));
    }

    try {
      const cleaned = cleanJsonResponse(rawText);
      const parsed = JSON.parse(cleaned);
      return {
        pass: parsed.ok === true,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
        reason: Array.isArray(parsed.reasons) ? parsed.reasons.join("; ") : undefined,
        rawText: logRaw ? rawText : undefined,
      };
    } catch {
      return {
        pass: false,
        reason: "Failed to parse placement response",
        rawText: logRaw ? rawText : undefined,
      };
    }
  } catch (err: any) {
    return {
      pass: false,
      error: err?.message || String(err),
    };
  }
}
