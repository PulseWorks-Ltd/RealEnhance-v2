import { getGeminiClient } from "../ai/gemini";
import { toBase64 } from "../utils/images";

export type GeminiSemanticVerdict = {
  hardFail: boolean;
  category: "structure" | "opening_blocked" | "furniture_change" | "style_only" | "unknown";
  reasons: string[];
  confidence: number;
  rawText?: string;
};

const MIN_CONFIDENCE = 0.75;

function buildPrompt(stage: "1A" | "1B" | "2", scene: string | undefined) {
  if (stage === "1B") {
    return `You are a Structural Integrity & Quality Auditor for New Zealand real estate imagery
(Stage 1B: Declutter / Furniture Removal).

TASK:
Compare the BEFORE (original) and AFTER (decluttered) images.
Determine whether decluttering was COMPLETE, STRUCTURALLY SAFE, and CLEANLY INPAINTED.

RETURN JSON ONLY. DO NOT include prose outside JSON.

─────────────────────────────
ABSOLUTE ZERO-TOUCH ELEMENTS
─────────────────────────────
The following MUST NOT be altered in any way:
- Walls, ceilings, floors, baseboards
- Windows, doors, sliding doors, frames
- Built-in cabinetry, wardrobes, shelving
- Kitchen units, vanities, splashbacks, rangehoods
- Fixed lighting (pendants, downlights, track lights, ceiling roses, sconces)
- Electrical outlets, switches
- Heat pumps, radiators, vents, HRV/DVS systems
- Smoke detectors, sprinklers, alarms
- Plumbing fixtures (toilets, baths, showers, sinks, tapware)
- Exterior views through windows

ANY modification → category: structure, hardFail: true

─────────────────────────────
CRITICAL CHECKLIST
─────────────────────────────

1. STRUCTURAL PRESERVATION
- Confirm all ZERO-TOUCH elements are present, aligned, and unchanged.
- Warping, removal, distortion, recoloring, or hallucination → structure, hardFail: true

2. DECLUTTER COMPLETENESS
- ALL movable items must be removed:
  chairs, tables, sofas, beds, stools, loose shelving, decor, clutter, appliances.
- Partial removal (some furniture left behind) → category: furniture_change, hardFail: true

3. MATERIAL & INPAINTING QUALITY
- Floors, walls, ceilings retain original texture and continuity.
- No blur, smudge, ghost shadows, or texture mismatch.
- Damaged surfaces → category: structure, hardFail: true

4. FUNCTIONAL ACCESS
- Doors and windows remain fully passable and unobstructed.
- Any blockage or sealing → opening_blocked, hardFail: true

─────────────────────────────
CATEGORIES
─────────────────────────────
- structure (HARD FAIL)
- opening_blocked (HARD FAIL)
- furniture_change (FAIL if incomplete removal)
- style_only (PASS)
- unknown (PASS only if confidence < 0.75)

─────────────────────────────
OUTPUT JSON
─────────────────────────────
{
  "hardFail": boolean,
  "category": "structure" | "opening_blocked" | "furniture_change" | "style_only" | "unknown",
  "reasons": ["Clear, specific reason"],
  "confidence": number
}`;
  }

  if (stage === "2") {
    return `You are a Structural Integrity & Quality Auditor for New Zealand real estate imagery
(Stage 2: Virtual Staging / Furniture Refresh).

TASK:
Compare the BEFORE (empty or decluttered) and AFTER (staged) images.
Identify any violations of structural integrity, zoning logic, circulation, or physics.

RETURN JSON ONLY. DO NOT include prose outside JSON.

─────────────────────────────
ABSOLUTE ZERO-TOUCH ELEMENTS
─────────────────────────────
The following MUST NOT be altered, replaced, restyled, recolored, resized, or removed:
- Walls, ceilings, floors, baseboards
- Windows, doors, frames, sliding tracks
- Built-in cabinetry, wardrobes, shelving
- Kitchen units, islands, vanities, splashbacks, rangehoods
- Fixed lighting (pendants, downlights, track lighting, sconces)
- Electrical switches and outlets
- Heat pumps, vents, radiators, HVAC units
- Smoke detectors, sprinklers, alarms
- Plumbing fixtures
- Exterior views through windows (must remain consistent)

ANY violation → category: structure, hardFail: true

─────────────────────────────
CRITICAL CHECKLIST
─────────────────────────────

1. STRUCTURAL & VIEW PRESERVATION
- No geometry distortion or hallucinated architecture.
- No background view replacement.
→ structure, hardFail: true

2. FUNCTIONAL CIRCULATION
- Clear walk paths to doors, sliding doors, and key access points.
- Furniture blocking paths → opening_blocked, hardFail: true

3. PHYSICS & REALISM
- Furniture grounded with contact shadows.
- Reflections consistent with floor material.
- Rugs lie flat, not merged into baseboards.
- Floating/clipping furniture → furniture_change, hardFail: false

4. STAGING INTENT VALIDATION
- FULL STAGING: Empty rooms must contain appropriate furniture ONLY for the identified room type.
- REFRESH STAGING: ALL existing furniture must be replaced with new furniture.
  Reusing original furniture → furniture_change, hardFail: true

5. MATERIAL PRESERVATION
- Floors, walls, ceilings retain original material and finish.
- Inpainting damage → structure, hardFail: true

─────────────────────────────
CATEGORIES
─────────────────────────────
- structure (HARD FAIL)
- opening_blocked (HARD FAIL)
- furniture_change (FAIL if refresh incomplete)
- style_only (PASS)
- unknown (PASS only if confidence < 0.75)

─────────────────────────────
OUTPUT JSON
─────────────────────────────
{
  "hardFail": boolean,
  "category": "structure" | "opening_blocked" | "furniture_change" | "style_only" | "unknown",
  "reasons": ["Specific violation"],
  "confidence": number
}`;
  }

  const stageLabel = stage === "1A" ? "Stage 1A (color/cleanup)" : stage;
  const sceneLabel = scene === "exterior" ? "EXTERIOR" : "INTERIOR";
  return `You are a Structural Integrity Auditor for New Zealand real estate imagery.

You will receive two images:
- BEFORE (original image)
- AFTER (processed / staged image)

Your sole task is to determine whether the AFTER image violates structural or functional integrity when compared to the BEFORE image.

Return JSON only. Do NOT include any prose outside JSON.

────────────────────────────────
CORE PRINCIPLE
────────────────────────────────

You must verify that FIXED ARCHITECTURE in the AFTER image remains
geometrically, materially, and functionally identical to the BEFORE image.

Movable furniture and décor may change unless they block access or appear permanently fixed.

────────────────────────────────
PHASE 1: GEOMETRIC & COUNT VERIFICATION (CRITICAL)
────────────────────────────────

1. OPENING COUNT
Count all windows, doors, and pass-through openings in BOTH images.

If the number of openings changes (added or removed):
→ category = structure
→ hardFail = true

2. EDGE & GEOMETRIC ALIGNMENT
Check fixed vertical and horizontal edges:
- Walls
- Door frames
- Window frames
- Major openings

If edges are shifted, resized, warped, slanted, or spatially moved:
→ category = structure
→ hardFail = true

Minor lens correction or perspective straightening is acceptable.

3. MATERIAL CONSISTENCY
Check fixed finishes:
- Floors
- Walls
- Ceilings

If a fixed material changes (e.g., carpet → timber, painted wall removed):
→ category = structure
→ hardFail = true

────────────────────────────────
PHASE 2: FUNCTIONAL ACCESS & BLOCKAGE (CRITICAL)
────────────────────────────────

DOORS:
- Must remain realistically passable
- Furniture must not barricade doorways
- Swinging doors must appear able to open
- Sliding doors must retain a usable sliding path

If a door exists but is not realistically usable:
→ category = opening_blocked
→ hardFail = true

WINDOWS:
- Partial visual occlusion by movable furniture is acceptable
- The window must still clearly exist as a window
- Objects must NOT appear permanently fixed to window panes or frames

If a window is fully sealed, replaced, or functionally removed:
→ category = structure OR opening_blocked
→ hardFail = true

────────────────────────────────
PHASE 3: IMPROPER FIXATION (ALWAYS FAILURE)
────────────────────────────────

Treat as STRUCTURAL FAILURE if any movable item appears:
- Permanently attached to a wall, window, door, or opening
- Used to cover, replace, or seal a structural element

Examples (non-exhaustive):
- Artwork or mirrors mounted over doors or windows
- Objects visually replacing glazing
- Panels fixed across openings

If improper fixation is detected:
→ category = structure
→ hardFail = true

────────────────────────────────
PHASE 4: STRUCTURAL ANCHORS (HIGH-RISK ELEMENTS)
────────────────────────────────

The following elements must be treated as FIXED unless clearly movable:
- Window coverings defining openness (curtains, blinds, rods, tracks)
- Built-in wardrobes or shelving
- Heat pumps / wall-mounted HVAC units
- Fixed lighting and wall-mounted fixtures

If these are removed, relocated, or materially altered:
→ category = structure
→ hardFail = true

────────────────────────────────
PHASE 5: FALSE POSITIVE FILTER
────────────────────────────────

DO NOT flag the following as failures:
- Exposure, brightness, colour, or white balance changes
- Virtual staging furniture changes alone
- Minor perspective correction
- Partial visual occlusion by movable furniture that does not block access

────────────────────────────────
CATEGORIES (SELECT ONE)
────────────────────────────────

structure:
- Fixed architecture changed, resized, added, removed, warped
- Openings added/removed
- Structural anchors altered
- Room geometry or proportions manipulated

opening_blocked:
- Doors or windows exist but are functionally unusable
- Circulation paths fully blocked

furniture_change:
- Movable furniture or décor added, removed, or repositioned only

style_only:
- Lighting, exposure, or colour changes only

unknown:
- Insufficient information to decide confidently

────────────────────────────────
CATEGORY PRIORITY
────────────────────────────────

1. structure
2. opening_blocked
3. furniture_change
4. style_only
5. unknown

If fixation or loss of function is involved:
→ NEVER downgrade to furniture_change

────────────────────────────────
DECISION RULES
────────────────────────────────

structure → hardFail = true  
opening_blocked → hardFail = true  
furniture_change → hardFail = false  
style_only → hardFail = false  
If confidence < ${MIN_CONFIDENCE} → hardFail = false  

────────────────────────────────
OUTPUT FORMAT (JSON ONLY)
────────────────────────────────

{
  "hardFail": boolean,
  "category": "structure" | "opening_blocked" | "furniture_change" | "style_only" | "unknown",
  "reasons": [
    "Concise, specific reasons such as 'Window count changed from 2 to 1'",
    "or 'Doorway blocked by fixed wardrobe'"
  ],
  "confidence": number
}

Stage: ${stageLabel}
Scene: ${sceneLabel}`;
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
