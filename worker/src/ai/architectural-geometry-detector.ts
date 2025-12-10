// server/ai/architectural-geometry-detector.ts
import type { GoogleGenAI } from "@google/genai";

export interface ArchitecturalGeometry {
  // Wall area analysis
  totalWallAreaPercent: number;
  wallSegments: Array<{
    position: string; // "left", "right", "back", "ceiling", "floor"
    areaPercent: number;
  }>;
  
  // Wall corner positions (normalized 0-100 coordinates)
  wallCorners: Array<{
    id: string;
    x: number; // 0-100 (left to right)
    y: number; // 0-100 (top to bottom)
    type: string; // "wall-wall", "wall-ceiling", "wall-floor"
  }>;
  
  // Window measurements
  windows: Array<{
    id: string;
    areaPercent: number; // percentage of total image
    position: string; // "left-wall", "back-wall", etc.
  }>;
  totalWindowCount: number;
  
  detectionFailed?: boolean;
}

export async function analyzeArchitecturalGeometry(
  ai: GoogleGenAI, 
  imageB64: string
): Promise<ArchitecturalGeometry> {
  try {
    const resp = await ai.models.generateContent({
      model: gemini-2.0-flash,
      contents: [
        { inlineData: { mimeType: "image/png", data: imageB64 } },
        { 
          text: `Analyze this interior image's architectural geometry in detail.

Return only a JSON response with this exact format:
{
  "totalWallAreaPercent": <0-100>,
  "wallSegments": [
    {
      "position": "left"|"right"|"back"|"ceiling"|"floor",
      "areaPercent": <0-100>
    }
  ],
  "wallCorners": [
    {
      "id": "corner_1",
      "x": <0-100>,
      "y": <0-100>,
      "type": "wall-wall"|"wall-ceiling"|"wall-floor"
    }
  ],
  "windows": [
    {
      "id": "window_1",
      "areaPercent": <0-100>,
      "position": "left-wall"|"right-wall"|"back-wall"
    }
  ],
  "totalWindowCount": <number>
}

Requirements:
1. WALL AREA: Measure what percentage of the total image is covered by wall surfaces (including ceiling/floor if visible)
2. WALL CORNERS: Identify all visible corners where walls meet each other or ceiling/floor. Use normalized coordinates (0-100 scale where 0,0 is top-left)
3. WINDOWS: Count and measure every window/glass door. Each window's areaPercent is its percentage of the total image area
4. Be precise with measurements - these will be compared between images to detect architectural changes
5. Return ONLY the JSON, no explanation text`
        }
      ]
    });

    const parts: any[] = resp.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((x: any) => x.text);
    if (!textPart) throw new Error("No text response from geometry detection");

    const rawText = textPart.text;
    
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/) || rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[GEOMETRY DETECTOR] No JSON found in response:", rawText.substring(0, 200));
      throw new Error("No JSON found in response");
    }
    
    const jsonStr = jsonMatch[1] || jsonMatch[0];
    const geometry = JSON.parse(jsonStr.trim()) as ArchitecturalGeometry;
    
    console.log(`[GEOMETRY DETECTOR] Wall area: ${geometry.totalWallAreaPercent}%, Corners: ${geometry.wallCorners.length}, Windows: ${geometry.totalWindowCount}`);
    return geometry;
    
  } catch (error) {
    console.error("[GEOMETRY DETECTOR] Failed to analyze geometry:", error);
    return {
      totalWallAreaPercent: 0,
      wallSegments: [],
      wallCorners: [],
      windows: [],
      totalWindowCount: 0,
      detectionFailed: true
    };
  }
}

export async function validateArchitecturalGeometry(
  ai: GoogleGenAI, 
  originalB64: string, 
  editedB64: string
): Promise<{ ok: boolean; reason?: string; details?: string }> {
  try {
    const originalGeometry = await analyzeArchitecturalGeometry(ai, originalB64);
    const editedGeometry = await analyzeArchitecturalGeometry(ai, editedB64);
    
    // FAIL SAFE: If either detection failed, reject the image (don't assume preserved)
    // This prevents bad quality enhancements from being saved as baselines
    if (originalGeometry.detectionFailed || editedGeometry.detectionFailed) {
      console.warn("[GEOMETRY VALIDATOR] ⚠️ Detection failed - rejecting image to trigger retry");
      return { 
        ok: false,
        reason: "Geometry detection failed - unable to verify architectural preservation",
        details: "JSON parsing error or AI returned invalid geometry data"
      };
    }
    
    // 1. WALL AREA CHECK - Allow 10% tolerance for measurement variance
    const wallAreaTolerance = 10;
    const wallAreaDelta = Math.abs(editedGeometry.totalWallAreaPercent - originalGeometry.totalWallAreaPercent);
    
    if (wallAreaDelta > wallAreaTolerance) {
      const direction = editedGeometry.totalWallAreaPercent > originalGeometry.totalWallAreaPercent ? "increased" : "decreased";
      console.log(`[GEOMETRY VALIDATOR] Wall area ${direction}: ${originalGeometry.totalWallAreaPercent}% → ${editedGeometry.totalWallAreaPercent}% (delta: ${wallAreaDelta.toFixed(1)}%)`);
      
      return {
        ok: false,
        reason: `Room dimensions changed - wall area ${direction} by ${wallAreaDelta.toFixed(1)}%`,
        details: `Original: ${originalGeometry.totalWallAreaPercent}%, Enhanced: ${editedGeometry.totalWallAreaPercent}% (tolerance: ±${wallAreaTolerance}%)`
      };
    }
    
    // 2. WALL CORNER CHECK - Verify corner positions haven't shifted significantly
    if (originalGeometry.wallCorners.length !== editedGeometry.wallCorners.length) {
      console.log(`[GEOMETRY VALIDATOR] Corner count changed: ${originalGeometry.wallCorners.length} → ${editedGeometry.wallCorners.length}`);
      
      return {
        ok: false,
        reason: `Wall structure changed - corner count: ${originalGeometry.wallCorners.length} → ${editedGeometry.wallCorners.length}`,
        details: "Wall corners added or removed, indicating structural modification"
      };
    }
    
    // Check if corners moved significantly (±15% position tolerance)
    const cornerTolerance = 15;
    for (let i = 0; i < originalGeometry.wallCorners.length; i++) {
      const origCorner = originalGeometry.wallCorners[i];
      const editCorner = editedGeometry.wallCorners[i];
      
      const xDelta = Math.abs(editCorner.x - origCorner.x);
      const yDelta = Math.abs(editCorner.y - origCorner.y);
      
      if (xDelta > cornerTolerance || yDelta > cornerTolerance) {
        console.log(`[GEOMETRY VALIDATOR] Corner ${i} moved: (${origCorner.x}, ${origCorner.y}) → (${editCorner.x}, ${editCorner.y})`);
        
        return {
          ok: false,
          reason: `Wall corner repositioned - corner ${i} moved ${xDelta.toFixed(1)}% horizontally, ${yDelta.toFixed(1)}% vertically`,
          details: `Original: (${origCorner.x}, ${origCorner.y}), Enhanced: (${editCorner.x}, ${editCorner.y}) (tolerance: ±${cornerTolerance}%)`
        };
      }
    }
    
    // 3. WINDOW COUNT CHECK - Must preserve exact window count
    if (originalGeometry.totalWindowCount !== editedGeometry.totalWindowCount) {
      console.log(`[GEOMETRY VALIDATOR] Window count changed: ${originalGeometry.totalWindowCount} → ${editedGeometry.totalWindowCount}`);
      
      return {
        ok: false,
        reason: `Window count changed: ${originalGeometry.totalWindowCount} → ${editedGeometry.totalWindowCount}`,
        details: "Windows were added or removed"
      };
    }
    
    // 4. WINDOW AREA CHECK - Verify individual window sizes haven't changed significantly
    // Allow 25% tolerance for window area variance (windows can appear slightly different due to lighting/staging)
    const windowAreaTolerance = 25;
    
    for (let i = 0; i < originalGeometry.windows.length; i++) {
      const origWindow = originalGeometry.windows[i];
      const editWindow = editedGeometry.windows[i];
      
      const areaDelta = Math.abs(editWindow.areaPercent - origWindow.areaPercent);
      const relativeChange = (areaDelta / origWindow.areaPercent) * 100;
      
      if (relativeChange > windowAreaTolerance) {
        console.log(`[GEOMETRY VALIDATOR] Window ${i} resized: ${origWindow.areaPercent}% → ${editWindow.areaPercent}% (${relativeChange.toFixed(1)}% change)`);
        
        return {
          ok: false,
          reason: `Window ${i} resized by ${relativeChange.toFixed(1)}%`,
          details: `Original size: ${origWindow.areaPercent}%, Enhanced: ${editWindow.areaPercent}% (tolerance: ±${windowAreaTolerance}%)`
        };
      }
    }
    
    console.log(`[GEOMETRY VALIDATOR] All geometry checks passed - walls, corners, and windows preserved`);
    return { ok: true };
    
  } catch (error) {
    console.error("[GEOMETRY VALIDATOR] Validation failed:", error);
    // On validation failure, fail open (assume preserved)
    return { ok: true };
  }
}
