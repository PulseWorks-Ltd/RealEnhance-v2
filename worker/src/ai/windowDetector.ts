// server/ai/windowDetector.ts
import type { GoogleGenAI } from "@google/genai";

export interface WindowDetection {
  windowCount: number;
  windows: Array<{
    id: string;
    bbox: [number, number, number, number]; // [x, y, width, height]
    confidence: number;
  }>;
  detectionFailed?: boolean; // Indicates if detection failed (vs legitimately 0 windows)
}

export async function detectWindows(ai: GoogleGenAI, imageB64: string): Promise<WindowDetection> {
  try {
    const resp = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        { inlineData: { mimeType: "image/png", data: imageB64 } },
        { 
          text: `Analyze this image and detect ALL distinct window openings. Return only a JSON response with this exact format:
{
  "windowCount": <number>,
  "windows": [
    {
      "id": "window_1",
      "bbox": [x, y, width, height],
      "confidence": <0.0-1.0>
    }
  ]
}

CRITICAL RULES FOR COUNTING:
- Count each PHYSICALLY SEPARATE window opening (separated by walls/structure) as ONE window
- A single window with multiple panes/glass panels = 1 window
- Two windows side-by-side with a wall/frame between them = 2 windows
- Sliding doors with multiple glass panels = count as distinct openings only if separated by structural frames
- DO NOT split a single window opening into multiple counts
- Include ALL visible windows including partially visible ones
- Provide bounding box coordinates as [x, y, width, height]
- Include confidence score (0.0-1.0)
- Return ONLY the JSON, no explanation text`
        }
      ]
    });

    const parts: any[] = resp.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((x: any) => x.text);
    if (!textPart) throw new Error("No text response from window detection");

    const rawText = textPart.text;
    
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/) || rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[WINDOW DETECTOR] No JSON found in response:", rawText.substring(0, 200));
      throw new Error("No JSON found in response");
    }
    
    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const detection = JSON.parse(jsonStr.trim()) as WindowDetection;
    
    console.log(`[WINDOW DETECTOR] Detected ${detection.windowCount} windows`);
    return detection;
    
  } catch (error) {
    console.error("[WINDOW DETECTOR] Failed to detect windows:", error);
    // Return detectionFailed flag so validator knows this is a failure, not "0 windows"
    return { windowCount: 0, windows: [], detectionFailed: true };
  }
}

export async function validateWindowPreservation(
  ai: GoogleGenAI,
  originalB64: string,
  editedB64: string,
  userProvidedOriginalCount?: number
): Promise<{ ok: boolean; reason?: string }> {
  try {
    let originalCount: number;
    let originalBoxes: Array<[number, number, number, number]> = [];
    
    // If user provided original count, use it directly (skip AI detection on original)
    if (userProvidedOriginalCount !== undefined) {
      originalCount = userProvidedOriginalCount;
      console.log(`[WINDOW VALIDATOR] Using user-provided original count: ${originalCount} windows`);
    } else {
      // Otherwise detect windows in original image
      const originalWindows = await detectWindows(ai, originalB64);
      
      // If detection failed, hard fail to trigger strict retry
      if (originalWindows.detectionFailed) {
        return { ok: false, reason: "Window detection failed on original image" };
      }
      
      originalCount = originalWindows.windowCount;
      originalBoxes = (originalWindows.windows || []).map(w => w.bbox);
      console.log(`[WINDOW VALIDATOR] AI-detected original count: ${originalCount} windows`);
    }
    
    // Always detect windows in edited image
    const editedWindows = await detectWindows(ai, editedB64);
    
    // If edited detection failed, hard fail to trigger strict retry
    if (editedWindows.detectionFailed) {
      return { ok: false, reason: "Window detection failed on enhanced image" };
    }

    // Simple validation: Window count must match exactly
    // Trusts the prompt to preserve window positioning correctly
    if (originalCount !== editedWindows.windowCount) {
      console.log(`[WINDOW VALIDATOR] Window count mismatch: ${originalCount} → ${editedWindows.windowCount}`);
      
      // Provide user-friendly error message
      const countSource = userProvidedOriginalCount !== undefined ? "you indicated" : "detected";
      return {
        ok: false,
        reason: `Retry created ${editedWindows.windowCount} window opening${editedWindows.windowCount !== 1 ? 's' : ''}, but ${countSource} ${originalCount} in the original image`
      };
    }

    // STRICT: Validate bounding boxes didn't move/resize materially
    const editedBoxes: Array<[number, number, number, number]> = (editedWindows.windows || []).map(w => w.bbox);
    // Calculate image height from max y+height of all windows if not provided
    const allBoxes = [...originalBoxes, ...editedBoxes];
    const imageHeight = allBoxes.length > 0 ? Math.max(...allBoxes.map(([x, y, w, h]) => y + h)) : 1;
    const iou = (a: [number,number,number,number], b: [number,number,number,number]) => {
      const [ax, ay, aw, ah] = a, [bx, by, bw, bh] = b;
      const ax2 = ax + aw, ay2 = ay + ah;
      const bx2 = bx + bw, by2 = by + bh;
      const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax, bx));
      const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay, by));
      const inter = ix * iy;
      const ua = aw * ah + bw * bh - inter;
      return ua > 0 ? inter / ua : 0;
    };
    // Greedy matching based on IoU
    const used = new Set<number>();
    for (const ob of originalBoxes) {
      let bestIdx = -1; let best = 0;
      for (let j = 0; j < editedBoxes.length; j++) {
        if (used.has(j)) continue;
        const sc = iou(ob, editedBoxes[j]);
        if (sc > best) { best = sc; bestIdx = j; }
      }
      // If no good overlap, check if window is blocked by furniture
      if (bestIdx === -1 || best < 0.50) {
        const [ox, oy, ow, oh] = ob;
        const windowBottom = oy + oh;
        // If bottom 20% of window is blocked (touches floor), allow
        if (windowBottom > imageHeight * 0.80) {
          console.log(`[WINDOW VALIDATOR] Window at (${ox},${oy},${ow},${oh}) blocked by floor-standing furniture (bottom 20%)`);
          continue; // allow
        }
        // Otherwise, fail for wall-mounted block
        console.warn(`[WINDOW VALIDATOR] Window at (${ox},${oy},${ow},${oh}) blocked by wall-mounted item (not floor-standing)`);
        return { ok: false, reason: "Window blocked by wall-mounted item" };
      }
      used.add(bestIdx);
    }

    // Additional check: detect if any structural walls were added between windows
    if (originalCount > 0 && editedWindows.windowCount > originalCount) {
      // More windows in edited than original = likely splitting existing windows with walls
      console.error(`[WINDOW VALIDATOR] CRITICAL: Window count increased from ${originalCount} to ${editedWindows.windowCount} - walls may have been added to split windows`);
      return { ok: false, reason: `Window count increased from ${originalCount} to ${editedWindows.windowCount} - structural wall added between windows` };
    }

    console.log(`[WINDOW VALIDATOR] Window count and bounding boxes preserved (${originalCount} windows)`);
    return { ok: true };
    
  } catch (error) {
    console.error("[WINDOW VALIDATOR] Validation failed:", error);
    // Fail closed to trigger strict retry
    return { ok: false, reason: 'Window validation error' };
  }
}