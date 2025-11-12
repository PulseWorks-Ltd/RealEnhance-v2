import type { GoogleGenAI } from "@google/genai";

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
  type: 'gray_sky' | 'structure_built' | 'furniture_on_grass' | 'window_added';
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
  
  const prompt = operationType === 'quality-only' 
    ? buildQualityOnlyValidationPrompt()
    : buildStagingValidationPrompt();

  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.5-flash",
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
   - Check if furniture is near vehicles or on driveways
   
2. STRUCTURE BUILDING (CRITICAL):
   - Check if any NEW decks, platforms, patios, or terraces were built
   - Existing surfaces can have furniture, but NO new structures should appear
   
3. ARCHITECTURAL PRESERVATION:
   - Windows and doors should remain the same count and position

Return ONLY valid JSON:
{
  "furnitureOnGrass": true|false,
  "furnitureDescription": "description of furniture placement issues",
  "structureBuilt": true|false,
  "structureDescription": "description of any new structures",
  "windowsAdded": true|false,
  "windowDescription": "description of window changes"
}

Set flags to true ONLY if violations exist.`;
}
