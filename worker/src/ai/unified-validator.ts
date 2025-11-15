import { getGeminiClient } from "./gemini";
import { toBase64 } from "../utils/images";
import { validatePerspectivePreservation } from "./perspective-detector";
import { validateWallPlanes } from "./wall-plane-validator";
import { validateWindowPreservation } from "./windowDetector";
import { validateFurnitureScale } from "./furniture-scale-validator";
import { validateExteriorEnhancement } from "./exterior-validator";
import { getAdminConfig } from "../utils/adminConfig";
import sharp from "sharp";
import { detectWindowsLocal, iouMasks, centroidFromMask } from "../validators/local-windows";
import path from "path";

// Local validation functions (no Gemini calls)
async function validateStructuralIntegrityLocal(
  prevPath: string,
  candPath: string
): Promise<{ ok: boolean; reason?: string; metrics: { edgeSimilarity: number; brightnessDiff: number } }> {
  try {
    // Load both images
    const [prevImg, candImg] = await Promise.all([
      sharp(prevPath).greyscale().raw().toBuffer({ resolveWithObject: true }),
      sharp(candPath).greyscale().raw().toBuffer({ resolveWithObject: true })
    ]);

    if (prevImg.info.width !== candImg.info.width || prevImg.info.height !== candImg.info.height) {
      return { ok: false, reason: "Image dimensions changed", metrics: { edgeSimilarity: 0, brightnessDiff: 999 } };
    }

    const width = prevImg.info.width;
    const height = prevImg.info.height;
    const prevData = prevImg.data;
    const candData = candImg.data;

    // 1) Edge detection for structural changes
    // Simple Sobel-like edge detection
    let prevEdges = 0, candEdges = 0, matchingEdges = 0;
    const edgeThreshold = 30;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        
        // Sobel gradients
        const prevGx = Math.abs(
          prevData[idx - width - 1] + 2 * prevData[idx - 1] + prevData[idx + width - 1] -
          prevData[idx - width + 1] - 2 * prevData[idx + 1] - prevData[idx + width + 1]
        );
        const prevGy = Math.abs(
          prevData[idx - width - 1] + 2 * prevData[idx - width] + prevData[idx - width + 1] -
          prevData[idx + width - 1] - 2 * prevData[idx + width] - prevData[idx + width + 1]
        );
        const prevEdge = Math.sqrt(prevGx * prevGx + prevGy * prevGy) > edgeThreshold;

        const candGx = Math.abs(
          candData[idx - width - 1] + 2 * candData[idx - 1] + candData[idx + width - 1] -
          candData[idx - width + 1] - 2 * candData[idx + 1] - candData[idx + width + 1]
        );
        const candGy = Math.abs(
          candData[idx - width - 1] + 2 * candData[idx - width] + candData[idx - width + 1] -
          candData[idx + width - 1] - 2 * candData[idx + width] - candData[idx + width + 1]
        );
        const candEdge = Math.sqrt(candGx * candGx + candGy * candGy) > edgeThreshold;

        if (prevEdge) prevEdges++;
        if (candEdge) candEdges++;
        if (prevEdge && candEdge) matchingEdges++;
      }
    }

    const edgeSimilarity = prevEdges > 0 ? matchingEdges / prevEdges : 1;

    // 2) Brightness analysis (windows detection)
    let prevBright = 0, candBright = 0;
    const brightThreshold = 200;

    for (let i = 0; i < prevData.length; i++) {
      if (prevData[i] > brightThreshold) prevBright++;
      if (candData[i] > brightThreshold) candBright++;
    }

    const prevBrightRatio = prevBright / prevData.length;
    const candBrightRatio = candBright / candData.length;
    const brightnessDiff = Math.abs(candBrightRatio - prevBrightRatio);

    console.log(`[LOCAL STRUCTURAL] Edge similarity: ${(edgeSimilarity * 100).toFixed(1)}%, Brightness diff: ${(brightnessDiff * 100).toFixed(1)}%`);

    // Structural integrity check: edges should be >85% similar
    const structuralOk = edgeSimilarity > 0.85;
    
    // Allow brightness changes for enhancement but flag major shifts (>30% could indicate new openings)
    const brightnessOk = brightnessDiff < 0.30;

    if (!structuralOk) {
      return { ok: false, reason: `Major structural changes detected (${(edgeSimilarity * 100).toFixed(1)}% edge similarity)`, metrics: { edgeSimilarity, brightnessDiff } };
    }

    if (!brightnessOk) {
      return { ok: false, reason: `Significant brightness shift detected (${(brightnessDiff * 100).toFixed(1)}% change) - possible new openings`, metrics: { edgeSimilarity, brightnessDiff } };
    }

    return { ok: true, metrics: { edgeSimilarity, brightnessDiff } };

  } catch (error) {
    console.error("[LOCAL STRUCTURAL] Validation failed:", error);
    return { ok: false, reason: "Structural validation error", metrics: { edgeSimilarity: 0, brightnessDiff: 0 } };
  }
}

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
  // If candidate dimensions differ from prev, resize a copy to match prev
  // so that local geometric checks operate on aligned grids. This avoids
  // blanket failures when the model outputs a different absolute size.
  async function normalizeCandidateDims(prevPath: string, candPath: string): Promise<{ usedPath: string; resized: boolean; }> {
    try {
      const [pm, cm] = await Promise.all([sharp(prevPath).metadata(), sharp(candPath).metadata()]);
      if (!pm.width || !pm.height || !cm.width || !cm.height) return { usedPath: candPath, resized: false };
      if (pm.width === cm.width && pm.height === cm.height) return { usedPath: candPath, resized: false };

      // Compute scale by width; keep aspect ratio. If resulting height is off by a few px, pad/crop centrally.
      const tmpOut = path.join(path.dirname(candPath), path.basename(candPath).replace(/(\.[a-z0-9]+)$/i, "-normalized.webp"));
      let img = sharp(candPath).rotate();
      img = img.resize({ width: pm.width });
      const buf = await img.webp({ quality: 95 }).toBuffer({ resolveWithObject: true });
      let resized = sharp(buf.data);
      const rm = buf.info;
      if (rm.height !== pm.height) {
        const delta = pm.height - (rm.height || 0);
        if (Math.abs(delta) <= 2) {
          // Pad or crop by up to 2px to match exact height
          if (delta > 0) {
            resized = resized.extend({ top: Math.floor(delta/2), bottom: delta - Math.floor(delta/2), background: { r: 0, g: 0, b: 0, alpha: 1 } });
          } else if (delta < 0) {
            const crop = Math.abs(delta);
            resized = resized.extract({ left: 0, top: Math.floor(crop/2), width: pm.width!, height: pm.height! });
          }
        } else {
          // If mismatch is large (aspect ratio change), fall back to contain with padding
          resized = sharp(candPath).resize({ width: pm.width, height: pm.height, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } });
        }
      }
      await resized.webp({ quality: 95 }).toFile(tmpOut);
      return { usedPath: tmpOut, resized: true };
    } catch {
      return { usedPath: candPath, resized: false };
    }
  }
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

  // Normalize candidate dims for local checks if needed
  const { usedPath: candNormPath, resized: candWasResized } = await normalizeCandidateDims(prev.path, cand.path);

  const reasons: string[] = [];
  const metrics: Record<string, number> = {};
  let score = 0;
  let totalW = 0;
  if (candWasResized) {
    metrics.resizedForValidation = 1;
    console.log(`[VALIDATOR] Candidate resized for validation to match original dimensions`);
  }

  // ===== LOCAL CHECKS (NO GEMINI CALLS) =====
  
  // 1) Structural integrity check using Sharp (edge detection + brightness analysis)
  console.log("[VALIDATOR] Running local structural checks...");
  try {
    const structural = await validateStructuralIntegrityLocal(prev.path, candNormPath);
    metrics.structuralEdges = structural.metrics.edgeSimilarity;
    metrics.brightnessDiff = structural.metrics.brightnessDiff;
    
    if (!structural.ok) {
      console.error(`[VALIDATOR] CRITICAL: ${structural.reason}`);
      reasons.push(structural.reason!);
      // Hard fail on major structural violations
      return {
        ok: false,
        score: 0,
        reasons: [structural.reason!],
        metrics
      };
    }
    console.log("[VALIDATOR] ✅ Local structural check passed");
  } catch (e) {
    console.warn("[VALIDATOR] Local structural check error:", e);
    reasons.push("structural check error");
  }

  // ===== GEMINI CHECKS (ONLY FOR COMPLEX SEMANTIC VALIDATION) =====
  // Only run Gemini checks for Stage 2 (staging) - semantic furniture/realism validation
  const useGeminiValidation = cand.stage === "2" && process.env.ENABLE_GEMINI_SEMANTIC_VALIDATION !== "0";

  // ===== LOCAL WINDOW MASK COMPARISON (IoU/Area/Centroid/Occlusion) =====
  try {
    const W_IOU_MIN = Number(process.env.WINDOW_IOU_MIN || 0.75);
    const W_AREA_DELTA_MAX = Number(process.env.WINDOW_AREA_DELTA_MAX || 0.15);
    const W_CENTROID_SHIFT_MAX = Number(process.env.WINDOW_CENTROID_SHIFT_MAX || 0.05);
    const W_OCCLUSION_MAX = Number(process.env.WINDOW_OCCLUSION_MAX || 0.25);

    const [origDet, enhDet, origRaw, enhRaw] = await Promise.all([
      detectWindowsLocal(prev.path),
      detectWindowsLocal(candNormPath),
      sharp(prev.path).greyscale().raw().toBuffer({ resolveWithObject: true }),
      sharp(candNormPath).greyscale().raw().toBuffer({ resolveWithObject: true }),
    ]);

    const W = origDet.width;
    const H = origDet.height;
    const diag = Math.sqrt(W * W + H * H);
    const origBuf = new Uint8Array(origRaw.data.buffer, origRaw.data.byteOffset, origRaw.data.byteLength);
    const enhBuf = new Uint8Array(enhRaw.data.buffer, enhRaw.data.byteOffset, enhRaw.data.byteLength);

    // Greedy matching by IoU (sufficient here given small counts)
    const used = new Set<number>();
    for (let i = 0; i < origDet.windows.length; i++) {
      const ow = origDet.windows[i];
      let bestIdx = -1;
      let bestIou = 0;
      for (let j = 0; j < enhDet.windows.length; j++) {
        if (used.has(j)) continue;
        const iou = iouMasks(ow.mask, enhDet.windows[j].mask);
        if (iou > bestIou) {
          bestIou = iou;
          bestIdx = j;
        }
      }

      if (bestIdx === -1) {
        const msg = `Window ${i + 1} disappeared entirely`;
        console.error(`[WINDOW LOCAL] ${msg}`);
        return { ok: false, score: 0, reasons: [msg], metrics };
      }
      used.add(bestIdx);

      const nw = enhDet.windows[bestIdx];
      const iou = bestIou;
      const areaDelta = Math.abs(nw.area - ow.area) / Math.max(1, ow.area);
      const occluded = (() => {
        // Brightness drop inside original mask
        let oSum = 0, eSum = 0, c = 0;
        for (let p = 0; p < ow.mask.length; p++) {
          if (ow.mask[p]) {
            oSum += origBuf[p];
            eSum += enhBuf[p];
            c++;
          }
        }
        const drop = c ? Math.max(0, (oSum / c - eSum / c) / Math.max(1, oSum / c)) : 0;
        return drop;
      })();
      const occlusionOk = occluded <= W_OCCLUSION_MAX;

      const { cx: ox, cy: oy } = centroidFromMask(ow.mask, W);
      const { cx: nx, cy: ny } = centroidFromMask(nw.mask, W);
      const cshift = Math.hypot(nx - ox, ny - oy) / Math.max(1, diag);

      if (iou < W_IOU_MIN || areaDelta > W_AREA_DELTA_MAX || cshift > W_CENTROID_SHIFT_MAX || !occlusionOk) {
        const rsn = `Window ${i + 1}: IoU=${iou.toFixed(2)} (<${W_IOU_MIN}), areaΔ=${(areaDelta * 100).toFixed(1)}% (>${
          W_AREA_DELTA_MAX * 100
        }%), centroidΔ=${(cshift * 100).toFixed(2)}% (>${W_CENTROID_SHIFT_MAX * 100}%), occlusion=${(occluded * 100).toFixed(
          1
        )}% (>${W_OCCLUSION_MAX * 100}%)`;
        console.error(`[WINDOW LOCAL] ${rsn}`);
        return { ok: false, score: 0, reasons: [rsn], metrics };
      }
    }
    console.log(`[WINDOW LOCAL] Passed: ${origDet.windows.length} windows preserved.`);
  } catch (e) {
    console.warn('[WINDOW LOCAL] check failed, continuing with remaining validators:', e);
  }

  if (useGeminiValidation) {
    console.log("[VALIDATOR] Running Gemini semantic checks for Stage 2...");

    // 1) Perspective stability - semantic check for staging
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
      totalW += weights.perspective;
    }

    // 2) Furniture scale and placement - Stage 2 only
    try {
      const furn = await validateFurnitureScale(ai as any, prevB64, candB64);
      const ok = !!furn.ok;
      const s = ok ? 1 : 0;
      metrics.furniture = s;
      if (!ok) reasons.push(furn.reason || "furniture scale/placement issue");
      const w = weights.furniture;
      score += s * w; totalW += w;
    } catch (e) {
      metrics.furniture = 0;
      reasons.push("furniture check failed");
      totalW += weights.furniture;
    }

    // 3) Realism check
    try {
      const { validateRealism } = await import("../validators/realism");
      const realism = await validateRealism(cand.path);
      if (!realism.ok) {
        reasons.push(...(realism.notes || ["realism violation detected"]));
      }
    } catch (e) {
      reasons.push("realism check failed");
    }
  } else {
    console.log("[VALIDATOR] Skipping Gemini semantic checks (Stage 1 or disabled)");
    // For Stage 1, just use local structural checks
    score = 1;
    totalW = 1;
  }

  // Local structural/egress check for Stage 2
  if (cand.stage === "2") {
    try {
      const { validateStructure } = await import("../validators/structural");
      const struct = await validateStructure(prev.path, candNormPath);
      if (!struct.ok) {
        reasons.push(...(struct.notes || ["egress/fixture blocking detected"]));
      }
    } catch (e) {
      reasons.push("egress/fixture blocking check failed");
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
