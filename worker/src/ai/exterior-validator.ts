import type { GoogleGenAI } from "@google/genai";
import { GEMINI_VISION_MODEL } from "./visionModelConfig";
import sharp from "sharp";

/**
 * Unified Exterior Validator
 * 
 * Consolidates all exterior-specific validation checks into a single comprehensive pass:
 * 1. Sky Quality - Verifies gray/overcast skies became vibrant blue
 * 2. Structure Building - Detects new decks, platforms, walls, or windows
 * 3. Furniture Placement - Confirms no furniture on grass, driveways, or near vehicles
 * 4. Surface Analysis - Validates furniture only on existing hard surfaces
 */

export interface ExteriorViolation {
  type: 'gray_sky' | 'structure_built' | 'furniture_on_grass' | 'window_added' | 'furniture_on_driveway' | 'furniture_near_vehicle';
  severity: 'critical' | 'moderate';
  description: string;
}

export interface ExteriorValidationResult {
  passed: boolean;
  violations: ExteriorViolation[];
}

/**
 * Comprehensive exterior validation in a single AI call
 */
export async function validateExteriorEnhancement(
  ai: GoogleGenAI,
  originalBase64: string,
  enhancedBase64: string,
  operationType: 'quality-only' | 'staging'
): Promise<ExteriorValidationResult> {
  // 1) HYBRID LOCAL HEURISTIC – fast check for lawn→hard-surface conversions
  try {
    const heuristic = await analyzeSurfaceChange(originalBase64, enhancedBase64);
    if (heuristic) {
      const { greenOrig, greenEnh, hardOrig, hardEnh } = heuristic;
      const greenDrop = greenOrig - greenEnh;
      const hardRise = hardEnh - hardOrig;
      // Trigger if lawn area drops substantially while hard surface increases
      if (greenDrop >= 0.15 && hardRise >= 0.10) {
        return {
          passed: false,
          violations: [{
            type: 'structure_built',
            severity: 'critical',
            description: `Local check found significant lawn→hard-surface change (green -${(greenDrop*100).toFixed(0)}%, hard +${(hardRise*100).toFixed(0)}%).`
          }]
        };
      }
    }
  } catch (e) {
    console.warn('[EXTERIOR VALIDATOR] Heuristic surface analysis failed (continuing with AI):', (e as any)?.message || e);
  }

  // 2) AI VALIDATION
  const prompt = operationType === 'quality-only' 
    ? buildQualityOnlyValidationPrompt()
    : buildStagingValidationPrompt();

  try {
    const resp = await ai.models.generateContent({
      model: GEMINI_VISION_MODEL,
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { data: originalBase64, mimeType: "image/png" } },
          { inlineData: { data: enhancedBase64, mimeType: "image/png" } }
        ]
      }]
    });

    const text = resp.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      console.warn('[EXTERIOR VALIDATOR] No JSON response from AI');
      return { passed: true, violations: [] };
    }

    const result = JSON.parse(jsonMatch[0]);
    const violations: ExteriorViolation[] = [];

    // Check sky quality (quality-only operations)
    if (operationType === 'quality-only' && result.skyIssue) {
      violations.push({
        type: 'gray_sky',
        severity: 'critical',
        description: result.skyDescription || 'Sky remains gray/overcast - should be vibrant blue'
      });
    }

    // Check for new structures
    if (result.structureBuilt) {
      violations.push({
        type: 'structure_built',
        severity: 'critical',
        description: result.structureDescription || 'New deck, platform, or structure detected'
      });
    }

    // Check for furniture on inappropriate surfaces (staging operations)
    if (operationType === 'staging' && result.furnitureOnGrass) {
      violations.push({
        type: 'furniture_on_grass',
        severity: 'critical',
        description: result.furnitureDescription || 'Furniture placed on grass or inappropriate surface'
      });
    }
    if (operationType === 'staging' && result.furnitureOnDriveway) {
      violations.push({
        type: 'furniture_on_driveway',
        severity: 'critical',
        description: result.furnitureDescription || 'Furniture placed on driveway (vehicle area)'
      });
    }
    if (operationType === 'staging' && result.furnitureNearVehicle) {
      violations.push({
        type: 'furniture_near_vehicle',
        severity: 'critical',
        description: result.furnitureDescription || 'Furniture placed near vehicle(s)'
      });
    }

    // Check for added windows
    if (result.windowsAdded) {
      violations.push({
        type: 'window_added',
        severity: 'critical',
        description: result.windowDescription || 'New windows or doors added to structure'
      });
    }

    const passed = violations.length === 0;

    if (!passed) {
      console.log('[EXTERIOR VALIDATOR] Violations detected:', violations.map(v => v.type).join(', '));
    }

    return { passed, violations };

  } catch (error) {
    console.error('[EXTERIOR VALIDATOR] Validation failed:', error);
    // On error, pass to avoid blocking legitimate enhancements
    return { passed: true, violations: [] };
  }
}

/**
 * Analyze bottom portion of the image to estimate green lawn and hard-surface proportions.
 * Returns fractions 0..1 for green and hard surfaces in original/enhanced.
 */
async function analyzeSurfaceChange(originalBase64: string, enhancedBase64: string): Promise<{ greenOrig: number; greenEnh: number; hardOrig: number; hardEnh: number } | null> {
  const oBuf = Buffer.from(originalBase64, 'base64');
  const eBuf = Buffer.from(enhancedBase64, 'base64');

  const oImg = sharp(oBuf).ensureAlpha();
  const eImg = sharp(eBuf).ensureAlpha();

  const oMeta = await oImg.metadata();
  const eMeta = await eImg.metadata();
  if (!oMeta.width || !oMeta.height || !eMeta.width || !eMeta.height) return null;

  // Normalize both to same analysis size to simplify math
  const W = 384; // analysis width
  const H = 256; // analysis height
  const [oRaw, eRaw] = await Promise.all([
    oImg.resize(W, H, { fit: 'cover' }).raw().toBuffer(),
    eImg.resize(W, H, { fit: 'cover' }).raw().toBuffer(),
  ]);

  function classify(buf: Buffer): { green: number; hard: number; total: number } {
    let green = 0, hard = 0, total = 0;
    // Focus on lower 60% (ground region)
    const startY = Math.floor(H * 0.40);
    for (let y = startY; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = buf[i] / 255, g = buf[i+1] / 255, b = buf[i+2] / 255;
        const max = Math.max(r,g,b), min = Math.min(r,g,b);
        const v = max; const d = max - min; const s = max === 0 ? 0 : d / max;
        let h = 0;
        if (d !== 0) {
          if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
          h *= 60; if (h < 0) h += 360;
        }
        // green lawn: reasonably saturated greens
        const isGreen = (v > 0.25) && (s > 0.28) && (h >= 70 && h <= 160);
        // gray concrete/asphalt: low saturation mid/high value
        const isGray = (s < 0.18) && (v > 0.35 && v < 0.95);
        // brown/red deck/wood: warm hues reasonably saturated
        const isBrown = (v > 0.25) && (s > 0.25) && ((h >= 8 && h <= 35) || (h >= 340 && h <= 360));
        if (isGreen) green++;
        if (isGray || isBrown) hard++;
        total++;
      }
    }
    return { green, hard, total };
  }

  const O = classify(oRaw);
  const E = classify(eRaw);
  const greenOrig = O.green / Math.max(1, O.total);
  const greenEnh = E.green / Math.max(1, E.total);
  const hardOrig = O.hard / Math.max(1, O.total);
  const hardEnh = E.hard / Math.max(1, E.total);
  return { greenOrig, greenEnh, hardOrig, hardEnh };
}

function buildQualityOnlyValidationPrompt(): string {
  return `You are validating an exterior property photo enhancement (Stage 1: Quality-Only).

Compare the ORIGINAL image (first) with the ENHANCED image (second).

Check for these violations:

1. SKY QUALITY (CRITICAL):
   - If original has gray/overcast/dull sky, enhanced MUST have vibrant blue sky with clouds
   - Daytime exteriors should ALWAYS have blue skies after enhancement
   
2. STRUCTURE BUILDING (CRITICAL):
   - Check if any NEW decks, platforms, patios, or terraces were built
   - Check if walls were extended or expanded
   - Check if new windows or doors were added
   
3. ARCHITECTURAL PRESERVATION:
   - Windows and doors should remain the same count and position

Return ONLY valid JSON:
{
  "skyIssue": true|false,
  "skyDescription": "description of sky state in enhanced image",
  "structureBuilt": true|false,
  "structureDescription": "description of any new structures",
  "windowsAdded": true|false,
  "windowDescription": "description of window changes"
}

Set flags to true ONLY if violations exist.`;
}

function buildStagingValidationPrompt(): string {
    return `You are validating an exterior property photo enhancement (Stage 2: Staging).

  Compare the ORIGINAL image (first) with the STAGED image (second).

  Check for these violations:

  1. FURNITURE PLACEMENT (CRITICAL):
    - Check if furniture (chairs, tables, sofas, umbrellas) is on grass, lawn, dirt, or garden beds
    - Furniture should ONLY be on: decks, patios, verandas, concrete, stone, tile
    - Check if furniture is on driveways (concrete/asphalt used for vehicles)
    - Check if furniture is near vehicles (cars, trucks, motorcycles, etc.)

  2. STRUCTURE BUILDING (CRITICAL):
    - Check if any NEW decks, platforms, patios, or terraces were built
    - Existing surfaces can have furniture, but NO new structures should appear

  3. ARCHITECTURAL PRESERVATION:
    - Windows and doors should remain the same count and position

  Return ONLY valid JSON:
  {
    "furnitureOnGrass": true|false,
    "furnitureOnDriveway": true|false,
    "furnitureNearVehicle": true|false,
    "furnitureDescription": "description of furniture placement issues",
    "structureBuilt": true|false,
    "structureDescription": "description of any new structures",
    "windowsAdded": true|false,
    "windowDescription": "description of window changes"
  }

  Set flags to true ONLY if violations exist.`;
}
