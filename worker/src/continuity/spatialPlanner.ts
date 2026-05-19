import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { toBase64 } from "../utils/images";
import { nLog } from "../logger";
import type { PlacementPlan, SpatialPlannerInput, SpatialPlannerResult, NormalizedPoint } from "./types";
import { VertexSecondaryContinuityError } from "./types";

let vertexPlannerClient: GoogleGenAI | null = null;

function getVertexPlannerClient(): GoogleGenAI {
  if (vertexPlannerClient) {
    return vertexPlannerClient;
  }
  const project = String(process.env.GOOGLE_CLOUD_PROJECT || "").trim();
  const location = String(process.env.GOOGLE_CLOUD_LOCATION || "us-central1").trim();
  if (!project) {
    throw new VertexSecondaryContinuityError(
      "GOOGLE_CLOUD_PROJECT is required for Vertex secondary continuity planning",
      "missing_vertex_project"
    );
  }
  vertexPlannerClient = new GoogleGenAI({
    vertexai: true,
    project,
    location,
  });
  return vertexPlannerClient;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    return JSON.parse(fenceMatch[1]);
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  throw new Error("planner_response_missing_json");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizePoint(point: Partial<NormalizedPoint> | undefined): NormalizedPoint | null {
  if (!point) {
    return null;
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return null;
  }
  return {
    x: clamp01(Number(point.x)),
    y: clamp01(Number(point.y)),
  };
}

function normalizePolygon(points: unknown): NormalizedPoint[] {
  if (!Array.isArray(points)) {
    return [];
  }
  return points
    .map((point) => normalizePoint(point as Partial<NormalizedPoint>))
    .filter((point): point is NormalizedPoint => !!point);
}

function normalizePlan(raw: any, imageWidth: number, imageHeight: number, roomType: string): PlacementPlan {
  const furnitureZones = Array.isArray(raw?.furnitureZones) ? raw.furnitureZones : [];
  const normalizedZones = furnitureZones.map((zone: any, index: number) => {
    const bbox = zone?.normalizedBoundingBox || {};
    const x = clamp01(Number(bbox.x));
    const y = clamp01(Number(bbox.y));
    const width = Math.max(0.02, Math.min(1 - x, clamp01(Number(bbox.width || 0.18))));
    const height = Math.max(0.02, Math.min(1 - y, clamp01(Number(bbox.height || 0.18))));
    return {
      id: String(zone?.id || `zone-${index + 1}`),
      furnitureType: String(zone?.furnitureType || "furniture").trim() || "furniture",
      normalizedBoundingBox: { x, y, width, height },
      anchorRelationships: {
        adjacentWall: zone?.anchorRelationships?.adjacentWall ? String(zone.anchorRelationships.adjacentWall) : undefined,
        relativeToBed: zone?.anchorRelationships?.relativeToBed ? String(zone.anchorRelationships.relativeToBed) : undefined,
        floorPlaneAlignment: zone?.anchorRelationships?.floorPlaneAlignment
          ? String(zone.anchorRelationships.floorPlaneAlignment)
          : undefined,
      },
      orientation: {
        yawDegrees: Number.isFinite(zone?.orientation?.yawDegrees) ? Number(zone.orientation.yawDegrees) : 0,
        perspectiveHint: String(zone?.orientation?.perspectiveHint || "match existing camera perspective"),
      },
      maskProjection: {
        floorPolygon: normalizePolygon(zone?.maskProjection?.floorPolygon),
        wallProjectionPolygon: normalizePolygon(zone?.maskProjection?.wallProjectionPolygon),
      },
      continuityReference: {
        derivedFromMaster: zone?.continuityReference?.derivedFromMaster !== false,
        masterFurnitureId: zone?.continuityReference?.masterFurnitureId
          ? String(zone.continuityReference.masterFurnitureId)
          : undefined,
      },
    };
  });

  if (normalizedZones.length === 0) {
    throw new VertexSecondaryContinuityError(
      "Planner returned no furniture zones for secondary continuity",
      "planner_empty_zones"
    );
  }

  return {
    roomType: String(raw?.roomType || roomType || "unknown"),
    imageWidth,
    imageHeight,
    furnitureZones: normalizedZones,
  };
}

function buildPlannerPrompt(params: {
  roomType: string;
  stagingStyle?: string;
  roomConsistencySummary: string;
}): string {
  return `You are a spatial continuity planner for secondary-image staging.

You must analyze two images:
1. APPROVED_MASTER_STAGED_IMAGE: furnishing truth source.
2. SECONDARY_TARGET_IMAGE: geometry, camera, topology, and perspective authority.

Your job is reasoning only.
Do not render an image.
Do not redesign the room.
Do not generate a mask bitmap.
Do not describe the room broadly.

Return JSON only using this exact schema:
{
  "roomType": "string",
  "imageWidth": 0,
  "imageHeight": 0,
  "furnitureZones": [
    {
      "id": "string",
      "furnitureType": "string",
      "normalizedBoundingBox": {
        "x": 0,
        "y": 0,
        "width": 0,
        "height": 0
      },
      "anchorRelationships": {
        "adjacentWall": "string",
        "relativeToBed": "string",
        "floorPlaneAlignment": "string"
      },
      "orientation": {
        "yawDegrees": 0,
        "perspectiveHint": "string"
      },
      "maskProjection": {
        "floorPolygon": [{ "x": 0, "y": 0 }],
        "wallProjectionPolygon": [{ "x": 0, "y": 0 }]
      },
      "continuityReference": {
        "derivedFromMaster": true,
        "masterFurnitureId": "string"
      }
    }
  ]
}

Planner requirements:
- Use normalized coordinates from 0 to 1.
- Furniture zones must represent projected occupancy volumes, not loose decor points.
- Include floor occupancy and wall-contact projection whenever relevant.
- Keep zones localized to likely continuity defects first: bedside tables, chairs, lamps, rugs, decor continuity.
- Prefer omission over hallucination.
- If a furnishing is not naturally visible in the secondary image, omit it.
- Preserve the target image topology and camera perspective.

Room type: ${params.roomType || "unknown"}
Staging style: ${params.stagingStyle || "unspecified"}
Continuity context: ${params.roomConsistencySummary}

Return JSON only.`;
}

export async function planSecondaryContinuity(params: SpatialPlannerInput): Promise<SpatialPlannerResult> {
  const plannerFlag = String(process.env.SECONDARY_CONTINUITY_PLANNER || "gemini25pro").trim().toLowerCase();
  const model = plannerFlag === "gemini25pro" ? "gemini-2.5-pro" : plannerFlag;
  const metadata = await sharp(params.secondaryImagePath).metadata();
  const imageWidth = metadata.width || 0;
  const imageHeight = metadata.height || 0;
  if (!imageWidth || !imageHeight) {
    throw new VertexSecondaryContinuityError(
      "Unable to read secondary image dimensions for planning",
      "planner_missing_dimensions"
    );
  }

  const master = toBase64(params.masterImagePath);
  const secondary = toBase64(params.secondaryImagePath);
  const roomConsistencySummary = [
    params.roomConsistency?.roomState?.furnitureContinuityHints,
    params.roomConsistency?.roomState?.relationalSummary?.placementDirective,
    params.roomConsistency?.roomState?.furnitureMemory?.persistentIdentityGoal,
  ]
    .filter((value): value is string => !!String(value || "").trim())
    .join(" | ") || "preserve master furnishing identity where naturally visible";
  const prompt = buildPlannerPrompt({
    roomType: params.roomType,
    stagingStyle: params.stagingStyle,
    roomConsistencySummary,
  });

  nLog("[VERTEX_CONTINUITY_PLANNER]", {
    phase: "start",
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    model,
  });

  const startedAt = Date.now();
  const ai = getVertexPlannerClient();
  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { text: "APPROVED_MASTER_STAGED_IMAGE" },
          { inlineData: { mimeType: master.mime, data: master.data } },
          { text: "SECONDARY_TARGET_IMAGE" },
          { inlineData: { mimeType: secondary.mime, data: secondary.data } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 0.1,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
    },
  } as any);

  const rawText = (response.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim();
  if (!rawText) {
    throw new VertexSecondaryContinuityError(
      "Planner returned no JSON text",
      "planner_empty_response"
    );
  }

  const parsed = extractJson(rawText);
  const plan = normalizePlan(parsed, imageWidth, imageHeight, params.roomType);
  const latencyMs = Date.now() - startedAt;

  nLog("[VERTEX_CONTINUITY_PLANNER]", {
    phase: "complete",
    continuityGroupId: params.continuityGroupId || null,
    imageId: params.imageId,
    jobId: params.jobId,
    latencyMs,
    zoneCount: plan.furnitureZones.length,
    model,
  });

  return {
    plan,
    prompt,
    rawText,
    model,
    latencyMs,
  };
}