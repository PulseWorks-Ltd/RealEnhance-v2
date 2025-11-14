import { getGeminiClient } from "./gemini";
import { toBase64 } from "../utils/images";
import { validatePerspectivePreservation } from "./perspective-detector";
import { validateWallPlanes } from "./wall-plane-validator";
import { validateWindowPreservation } from "./windowDetector";
import { validateFurnitureScale } from "./furniture-scale-validator";
import { validateExteriorEnhancement } from "./exterior-validator";
import { getAdminConfig } from "../utils/adminConfig";

export type StageId = "1A" | "1B" | "2";
export type SceneType = "interior" | "exterior" | string | undefined;

export interface Artifact {
  stage: StageId;
  path: string; // local file path
  width?: number;
  height?: number;
}

export interface ValidationCtx {
  sceneType?: SceneType;
  roomType?: string;
}

export interface ValidationVerdict {
  ok: boolean;
  score: number; // 0..1
  reasons: string[];
  metrics: Record<string, number>;
}

/**
 * Unified structural validator that combines local checks using our detectors.
 * Returns a single verdict with weighted score and reasons.
 */
export async function validateStage(
  prev: Artifact,
  cand: Artifact,
  ctx: ValidationCtx = {}
): Promise<ValidationVerdict> {
  // Load optional config/env overrides for weights/thresholds
  const admin = await getAdminConfig().catch(() => ({} as any));
  const parseNum = (v?: string) => {
    if (v === undefined) return undefined;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const weightsCfg = (admin as any)?.validator?.weights || {};
  const thresholdsCfg = (admin as any)?.validator?.thresholds || {};
  const weights = {
    perspective: parseNum(process.env.VALIDATOR_WEIGHT_PERSPECTIVE) ?? (typeof weightsCfg.perspective === 'number' ? weightsCfg.perspective : 0.35),
    wallPlanes: parseNum(process.env.VALIDATOR_WEIGHT_WALLS) ?? (typeof weightsCfg.wallPlanes === 'number' ? weightsCfg.wallPlanes : 0.35),
    windows: parseNum(process.env.VALIDATOR_WEIGHT_WINDOWS) ?? (typeof weightsCfg.windows === 'number' ? weightsCfg.windows : 0.15),
    furniture: parseNum(process.env.VALIDATOR_WEIGHT_FURNITURE) ?? (typeof weightsCfg.furniture === 'number' ? weightsCfg.furniture : 0.15),
    exterior: parseNum(process.env.VALIDATOR_WEIGHT_EXTERIOR) ?? (typeof weightsCfg.exterior === 'number' ? weightsCfg.exterior : 0.15),
  };
  const thresholds = {
    "1A": parseNum(process.env.VALIDATOR_THRESH_1A) ?? (typeof thresholdsCfg?.["1A"] === 'number' ? thresholdsCfg["1A"] : 0.75),
    "1B": parseNum(process.env.VALIDATOR_THRESH_1B) ?? (typeof thresholdsCfg?.["1B"] === 'number' ? thresholdsCfg["1B"] : 0.70),
    "2": parseNum(process.env.VALIDATOR_THRESH_2) ?? (typeof thresholdsCfg?.["2"] === 'number' ? thresholdsCfg["2"] : 0.68),
  } as Record<StageId, number>;

  const ai = getGeminiClient();
  const prevB64 = toBase64(prev.path).data;
  const candB64 = toBase64(cand.path).data;

  const reasons: string[] = [];
  const metrics: Record<string, number> = {};
  let score = 0;
  let totalW = 0;

  // 1) Perspective stability (heavy weight)
  try {
    const persp = await validatePerspectivePreservation(ai as any, prevB64, candB64);
    const ok = !!persp.ok;
    const s = ok ? 1 : 0;
    metrics.perspective = s;
    if (!ok) reasons.push(persp.reason || "perspective violation");
    const w = weights.perspective;
    score += s * w; totalW += w;
  } catch (e) {
    metrics.perspective = 0;
    reasons.push("perspective check failed");
    totalW += weights.perspective; // count as 0 contribution
  }

  // 2) Wall planes (heavy weight)
  try {
    const wall = await validateWallPlanes(ai as any, prevB64, candB64);
    const ok = !!wall.ok;
    const s = ok ? 1 : 0;
    metrics.wallPlanes = s;
    if (!ok) reasons.push(wall.reason || "wall planes changed");
    const w = weights.wallPlanes;
    score += s * w; totalW += w;
  } catch (e) {
    metrics.wallPlanes = 0;
    reasons.push("wall plane check failed");
    totalW += weights.wallPlanes;
  }

  // 3) Windows (all scenes)
  try {
    const res = await validateWindowPreservation(ai as any, prevB64, candB64);
    const ok = !!res.ok;
    const s = ok ? 1 : 0;
    metrics.windows = s;
    if (!ok) reasons.push(res.reason || "windows changed");
    const w = weights.windows;
    score += s * w; totalW += w;
  } catch (e) {
    metrics.windows = 0;
    reasons.push("window check failed");
    totalW += weights.windows;
  }

  // 4) Furniture checks (not applied for 1A)
  if (cand.stage === "2") {
    try {
      const furn = await validateFurnitureScale(ai as any, prevB64, candB64);
      const ok = !!furn.ok;
      const s = ok ? 1 : 0;
      metrics.furniture = s;
      if (!ok) reasons.push(furn.reason || "furniture scale/added");
      const w = weights.furniture;
      score += s * w; totalW += w;
    } catch (e) {
      metrics.furniture = 0;
      reasons.push("furniture check failed");
      totalW += weights.furniture;
    }

    // Egress/fixture blocking check (Stage 2 only)
    try {
      const { validateStructure } = await import("../validators/structural");
      const struct = await validateStructure(prev.path, cand.path);
      if (!struct.ok) {
        reasons.push(...(struct.notes || ["egress/fixture blocking detected"]));
      }
    } catch (e) {
      reasons.push("egress/fixture blocking check failed");
    }

    // Realism check (Stage 2 only)
    try {
      const { validateRealism } = await import("../validators/realism");
      const realism = await validateRealism(cand.path);
      if (!realism.ok) {
        reasons.push(...(realism.notes || ["realism violation detected"]));
      }
    } catch (e) {
      reasons.push("realism check failed");
    }
  }

  // 5) Exterior sanity (exterior-only)
  if ((ctx.sceneType || "interior").toString() === "exterior") {
    try {
      const ext = await validateExteriorEnhancement(
        ai as any,
        prevB64,
        candB64,
        cand.stage === "2" ? "staging" : "quality-only"
      );
      const ok = !!ext.passed;
      const s = ok ? 1 : 0;
      metrics.exterior = s;
      if (!ok) reasons.push("exterior structure shift");
      const w = weights.exterior;
      score += s * w; totalW += w;
    } catch (e) {
      metrics.exterior = 0;
      reasons.push("exterior check failed");
      totalW += weights.exterior;
    }
  }

  const normalized = totalW ? (score / totalW) : 0;
  const threshold = thresholds[cand.stage as StageId];
  // Also require no explicit reasons for failure
  const ok = normalized >= threshold && reasons.filter(r => r && r.toLowerCase().includes("violation")).length === 0;

  return {
    ok,
    score: normalized,
    reasons: ok ? [] : reasons,
    metrics,
  };
}
import type { GoogleGenAI } from "@google/genai";

/**
 * Unified Validation Response
 * Combines all architectural preservation checks into single AI call
 */
export interface UnifiedValidationResult {
  // Overall validation
  ok: boolean;
  criticalViolation: boolean; // true if any hard failure detected
  
  // Wall & Opening Validation
  walls: {
    ok: boolean;
    originalOpeningCount: number;
    enhancedOpeningCount: number;
    openingsIdentified: string[];
    openingsStatus: string[];
    violation?: string;
  };
  
  // Window Preservation
  windows: {
    ok: boolean;
    originalCount: number;
    enhancedCount: number;
    violation?: string;
  };
  
  // Perspective Preservation
  perspective: {
    ok: boolean;
    viewpointChanged: boolean;
    originalViewpoint: string;
    enhancedViewpoint: string;
    violation?: string;
  };
  
  // Fixture Preservation
  fixtures: {
    ok: boolean;
    violation?: string;
    details?: string;
  };
  
  // Structural Compliance
  structural: {
    ok: boolean;
    structuralViolation: boolean;
    placementViolation: boolean;
    violations: string[];
  };
  
  // Aggregated reasons for any failures
  reasons: string[];
}

/**
 * Unified validator that combines all architectural preservation checks
 * into a single AI call for maximum efficiency
 */
export async function validateAllPreservation(
  ai: GoogleGenAI,
  originalB64: string,
  editedB64: string,
  userProvidedWindowCount?: number
): Promise<UnifiedValidationResult> {
  try {
    const windowCountContext = userProvidedWindowCount !== undefined
      ? `The user has indicated the original image contains ${userProvidedWindowCount} window(s). Use this count for window validation.`
      : 'Detect and count the windows in the original image for validation.';

    const prompt = `You are an architectural preservation validator. Analyze these two images (ORIGINAL and ENHANCED) to verify ALL architectural elements are preserved exactly. Return a SINGLE comprehensive JSON response.

${windowCountContext}

VALIDATION CATEGORIES:

=== 1. WALLS & OPENINGS ===
Check that ALL walls and openings remain EXACTLY the same:
- Wall length, position, angles, and configuration must be IDENTICAL
- NO NEW openings/windows/doors created on blank walls (false architecture)
- Existing openings/passages must remain OPEN and unobstructed
- Count ALL openings in original, verify same count in enhanced
- Check each opening remains OPEN (not blocked with furniture/units)

=== 2. WINDOW PRESERVATION ===
Verify window count remains identical:
- Count visible windows in both images
- ${userProvidedWindowCount !== undefined ? `Original has ${userProvidedWindowCount} windows` : 'Detect original window count'}
- Enhanced must have exact same count

=== 3. PERSPECTIVE PRESERVATION ===
Verify camera viewpoint is EXACTLY the same:
- Camera position must be unchanged (same physical location)
- Camera angle must be identical (no tilt changes)
- Viewing direction must match (facing same wall/direction)
- Vanishing points and perspective lines must align
- Same room photographed from same viewpoint

=== 4. FIXTURE PRESERVATION ===
Check fixed architectural elements unchanged:
- Door/window frames, shutters, hardware
- Light fixtures, ceiling fans, fireplaces
- Built-in cabinets, counters, appliances
- Staircases, columns, built-in features
- (Loose furniture changes are ALLOWED)

=== 5. STRUCTURAL COMPLIANCE ===
Verify structural integrity and placement safety:
- No additions/removals/movements of fixed architectural features
- No wall extensions, repositioning, or reshaping
- No furniture blocking doors/windows (egress/ventilation)
- No objects through/overlapping fixtures
- Furniture properly aligned to floor perspective

RESPONSE FORMAT - Return ONLY this JSON structure:

{
  "walls": {
    "ok": boolean,
    "original_opening_count": number,
    "enhanced_opening_count": number,
    "openings_identified": ["opening 1", "opening 2", ...],
    "openings_status": ["OPEN", "OPEN", ...],
    "violation": "Wall violation: description" or null
  },
  "windows": {
    "ok": boolean,
    "original_count": number,
    "enhanced_count": number,
    "violation": "description" or null
  },
  "perspective": {
    "ok": boolean,
    "viewpoint_changed": boolean,
    "original_viewpoint": "description",
    "enhanced_viewpoint": "description",
    "violation": "Perspective violation: description" or null
  },
  "fixtures": {
    "ok": boolean,
    "violation": "description" or null,
    "details": "specific fixture modified" or null
  },
  "structural": {
    "ok": boolean,
    "structural_violation": boolean,
    "placement_violation": boolean,
    "violations": ["description 1", "description 2", ...]
  }
}

CRITICAL VALIDATION RULES:
1. If enhanced_opening_count > original_opening_count: walls.ok = false
2. If any opening_status is not "OPEN": walls.ok = false  
3. If viewpoint_changed is true: perspective.ok = false
4. If window counts don't match: windows.ok = false
5. Use "Wall violation:" prefix for wall issues
6. Use "Perspective violation:" prefix for perspective issues
7. All violations must have descriptive text in violation fields

Return ONLY the JSON, no explanatory text.`;

    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        { inlineData: { mimeType: "image/png", data: originalB64 } },
        { inlineData: { mimeType: "image/png", data: editedB64 } },
        { text: prompt }
      ]
    });

    const text = result.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || "";
    console.log("[UNIFIED VALIDATOR] Raw AI response:", text.substring(0, 500));

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[UNIFIED VALIDATOR] No JSON found in response - FAILING SAFE");
      throw new Error("Unified validator failed to return valid JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]);
    console.log("[UNIFIED VALIDATOR] Parsed validation result:", JSON.stringify(parsed, null, 2));

    // Build unified result with validation and fail-safe defaults
    const result_data: UnifiedValidationResult = {
      ok: true,
      criticalViolation: false,
      
      walls: {
        ok: parsed.walls?.ok ?? false,
        originalOpeningCount: parsed.walls?.original_opening_count ?? 0,
        enhancedOpeningCount: parsed.walls?.enhanced_opening_count ?? 0,
        openingsIdentified: parsed.walls?.openings_identified ?? [],
        openingsStatus: parsed.walls?.openings_status ?? [],
        violation: parsed.walls?.violation || undefined
      },
      
      windows: {
        ok: parsed.windows?.ok ?? false,
        originalCount: userProvidedWindowCount ?? parsed.windows?.original_count ?? 0,
        enhancedCount: parsed.windows?.enhanced_count ?? 0,
        violation: parsed.windows?.violation || undefined
      },
      
      perspective: {
        ok: parsed.perspective?.ok ?? false,
        viewpointChanged: parsed.perspective?.viewpoint_changed ?? false,
        originalViewpoint: parsed.perspective?.original_viewpoint ?? "unknown",
        enhancedViewpoint: parsed.perspective?.enhanced_viewpoint ?? "unknown",
        violation: parsed.perspective?.violation || undefined
      },
      
      fixtures: {
        ok: parsed.fixtures?.ok ?? false,
        violation: parsed.fixtures?.violation || undefined,
        details: parsed.fixtures?.details || undefined
      },
      
      structural: {
        ok: parsed.structural?.ok ?? false,
        structuralViolation: parsed.structural?.structural_violation ?? false,
        placementViolation: parsed.structural?.placement_violation ?? false,
        violations: parsed.structural?.violations ?? []
      },
      
      reasons: []
    };

    // Apply fail-safe validations and collect reasons
    
    // Wall validation
    if (!result_data.walls.ok || result_data.walls.enhancedOpeningCount > result_data.walls.originalOpeningCount) {
      result_data.ok = false;
      result_data.criticalViolation = true;
      if (result_data.walls.violation) {
        result_data.reasons.push(result_data.walls.violation);
      } else if (result_data.walls.enhancedOpeningCount > result_data.walls.originalOpeningCount) {
        const violation = `Wall violation: ${result_data.walls.enhancedOpeningCount - result_data.walls.originalOpeningCount} new opening(s) created`;
        result_data.walls.violation = violation;
        result_data.reasons.push(violation);
      }
    }

    // Window validation
    if (!result_data.windows.ok || result_data.windows.originalCount !== result_data.windows.enhancedCount) {
      result_data.ok = false;
      result_data.criticalViolation = true;
      if (result_data.windows.violation) {
        result_data.reasons.push(result_data.windows.violation);
      } else {
        const violation = `Window count mismatch: ${result_data.windows.originalCount} → ${result_data.windows.enhancedCount}`;
        result_data.windows.violation = violation;
        result_data.reasons.push(violation);
      }
    }

    // Perspective validation
    if (!result_data.perspective.ok || result_data.perspective.viewpointChanged) {
      result_data.ok = false;
      result_data.criticalViolation = true;
      if (result_data.perspective.violation) {
        result_data.reasons.push(result_data.perspective.violation);
      } else {
        const violation = "Perspective violation: Camera viewpoint changed";
        result_data.perspective.violation = violation;
        result_data.reasons.push(violation);
      }
    }

    // Fixture validation
    if (!result_data.fixtures.ok) {
      result_data.ok = false;
      result_data.criticalViolation = true;
      if (result_data.fixtures.violation) {
        result_data.reasons.push(result_data.fixtures.violation);
      }
    }

    // Structural validation
    if (!result_data.structural.ok) {
      result_data.ok = false;
      if (result_data.structural.structuralViolation) {
        result_data.criticalViolation = true;
      }
      result_data.reasons.push(...result_data.structural.violations);
    }

    console.log("[UNIFIED VALIDATOR] Final result:", {
      ok: result_data.ok,
      criticalViolation: result_data.criticalViolation,
      reasonCount: result_data.reasons.length
    });

    return result_data;

  } catch (error) {
    console.error("[UNIFIED VALIDATOR] Error:", error);
    // Fail safe: reject on any error
    return {
      ok: false,
      criticalViolation: true,
      walls: { ok: false, originalOpeningCount: 0, enhancedOpeningCount: 0, openingsIdentified: [], openingsStatus: [], violation: "Validation error" },
      windows: { ok: false, originalCount: 0, enhancedCount: 0, violation: "Validation error" },
      perspective: { ok: false, viewpointChanged: false, originalViewpoint: "unknown", enhancedViewpoint: "unknown", violation: "Validation error" },
      fixtures: { ok: false, violation: "Validation error" },
      structural: { ok: false, structuralViolation: true, placementViolation: false, violations: ["Validation error"] },
      reasons: ["Unified validation failed - " + (error instanceof Error ? error.message : String(error))]
    };
  }
}
