import sharp from "sharp";
import { nLog } from "../../logger";
import type { ContinuityIntentMetadata, ContinuityRenderMode, NormalizedPoint, PlacementPlan } from "../../continuity/types";
import { VertexSecondaryContinuityError } from "../../continuity/types";
import { toGenAiPart } from "../imageTransport";
import type { SpatialPlannerProvider, SpatialPlannerRequest, SpatialPlannerResponse } from "../types";
import { getVertexGenAiClient } from "./adc";

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

function normalizeTopologyCage(raw: any): PlacementPlan["structuralTopologyCage"] | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const vanishingPoints = Array.isArray(raw.vanishingPoints)
    ? raw.vanishingPoints
      .map((point: any, index: number) => {
        const normalized = normalizePoint(point);
        if (!normalized) return null;
        return {
          id: String(point?.id || `vp-${index + 1}`),
          ...normalized,
        };
      })
      .filter(Boolean)
    : [];
  const majorRoomPlanes = Array.isArray(raw.majorRoomPlanes)
    ? raw.majorRoomPlanes
      .map((plane: any, index: number) => ({
        id: String(plane?.id || `plane-${index + 1}`),
        planeType: String(plane?.planeType || "unknown"),
        polygon: normalizePolygon(plane?.polygon),
      }))
      .filter((plane: any) => plane.polygon.length >= 3)
    : [];
  const cage = {
    vanishingPoints: vanishingPoints.length ? vanishingPoints : undefined,
    floorWallJunctions: normalizePolygon(raw.floorWallJunctions),
    ceilingWallJunctions: normalizePolygon(raw.ceilingWallJunctions),
    majorRoomPlanes: majorRoomPlanes.length ? majorRoomPlanes : undefined,
  };
  return cage.vanishingPoints || cage.floorWallJunctions.length || cage.ceilingWallJunctions.length || cage.majorRoomPlanes
    ? cage
    : undefined;
}

function normalizeAnchorGraph(raw: any): PlacementPlan["relationalAnchorGraph"] | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const anchors = Array.isArray(raw.anchors)
    ? raw.anchors.map((anchor: any, index: number) => ({
      id: String(anchor?.id || `anchor-${index + 1}`),
      anchorType: String(anchor?.anchorType || "anchor"),
      label: anchor?.label ? String(anchor.label) : undefined,
      furnitureZoneId: anchor?.furnitureZoneId ? String(anchor.furnitureZoneId) : undefined,
      planeId: anchor?.planeId ? String(anchor.planeId) : undefined,
    }))
    : [];
  const relationships = Array.isArray(raw.relationships)
    ? raw.relationships.map((relationship: any) => ({
      from: String(relationship?.from || ""),
      relation: String(relationship?.relation || "related_to"),
      to: String(relationship?.to || ""),
    })).filter((relationship) => relationship.from && relationship.to)
    : [];
  return anchors.length || relationships.length
    ? { anchors, relationships }
    : undefined;
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
    structuralTopologyCage: normalizeTopologyCage(raw?.structural_topology_cage),
    relationalAnchorGraph: normalizeAnchorGraph(raw?.relational_anchor_graph),
    furnitureZones: normalizedZones,
  };
}

function buildPlannerModeGuidance(renderMode: ContinuityRenderMode, intent?: ContinuityIntentMetadata): string {
  const normalizedInstruction = String(intent?.userInstruction || "").trim();
  if (renderMode === "full_secondary_continuity") {
    return [
      "Plan furniture occupancy for full secondary-view continuity staging.",
      "Cover visible furnishing volumes that should persist from the approved master without granting full-scene rewrite authority.",
    ].join(" ");
  }
  if (renderMode === "continuity_refresh") {
    return [
      "Plan only localized continuity refresh regions where existing secondary-view furnishing drifts from the approved master.",
      "Prefer small, corrective occupancy regions over broad restaging.",
    ].join(" ");
  }
  if (renderMode === "missing_object_insert") {
    return [
      "Plan only the localized occupancy needed for missing approved furnishing insertion.",
      normalizedInstruction ? `User-constrained insertion request: ${normalizedInstruction}` : "Focus on missing-object insertion only.",
    ].join(" ");
  }
  return [
    "Plan only the localized occupancy needed for constrained continuity repair.",
    normalizedInstruction ? `User-constrained repair request: ${normalizedInstruction}` : "Focus on localized repair only.",
  ].join(" ");
}

function buildPlannerPrompt(params: {
  roomType: string;
  stagingStyle?: string;
  roomConsistencySummary: string;
  renderMode: ContinuityRenderMode;
  intent?: ContinuityIntentMetadata;
}): string {
  const intentLines = [
    params.intent?.operationLabel ? `Operation label: ${params.intent.operationLabel}` : null,
    params.intent?.promptScope ? `Prompt scope: ${params.intent.promptScope}` : null,
    params.intent?.userInstruction ? `User intent: ${params.intent.userInstruction}` : null,
    params.intent?.layoutHints?.length ? `Layout hints: ${params.intent.layoutHints.join("; ")}` : null,
    params.intent?.anchorConstraints?.length ? `Anchor constraints: ${params.intent.anchorConstraints.join("; ")}` : null,
    params.intent?.roomAnchors?.length ? `Room anchors: ${params.intent.roomAnchors.join("; ")}` : null,
  ].filter((value): value is string => !!value);
  const intentBlock = intentLines.length > 0 ? `\nIntent context:\n- ${intentLines.join("\n- ")}` : "";
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
  "structural_topology_cage": {
    "vanishingPoints": [{ "id": "string", "x": 0, "y": 0 }],
    "floorWallJunctions": [{ "x": 0, "y": 0 }],
    "ceilingWallJunctions": [{ "x": 0, "y": 0 }],
    "majorRoomPlanes": [{ "id": "string", "planeType": "string", "polygon": [{ "x": 0, "y": 0 }] }]
  },
  "relational_anchor_graph": {
    "anchors": [{ "id": "string", "anchorType": "string", "label": "string", "furnitureZoneId": "string", "planeId": "string" }],
    "relationships": [{ "from": "string", "relation": "string", "to": "string" }]
  },
  "furnitureZones": [
    {
      "id": "string",
      "furnitureType": "string",
      "normalizedBoundingBox": { "x": 0, "y": 0, "width": 0, "height": 0 },
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
- Furniture zones must represent projected occupancy volumes, not simple floor rectangles.
- Include floor occupancy and wall-contact projection whenever relevant.
- Keep zones localized to likely continuity defects first: bedside tables, chairs, lamps, rugs, decor continuity.
- Prefer omission over hallucination.
- If a furnishing is not naturally visible in the secondary image, omit it.
- Preserve the target image topology and camera perspective.
- Render mode: ${params.renderMode}
- ${buildPlannerModeGuidance(params.renderMode, params.intent)}

Room type: ${params.roomType || "unknown"}
Staging style: ${params.stagingStyle || "unspecified"}
Continuity context: ${params.roomConsistencySummary}
${intentBlock}

Return JSON only.`;
}

export class VertexSpatialPlannerProvider implements SpatialPlannerProvider {
  async plan(request: SpatialPlannerRequest): Promise<SpatialPlannerResponse> {
    const plannerFlag = String(process.env.SECONDARY_CONTINUITY_PLANNER || "gemini25pro").trim().toLowerCase();
    const model = plannerFlag === "gemini25pro" ? "gemini-2.5-pro" : plannerFlag;
    const metadata = request.secondaryImage.localPath
      ? await sharp(request.secondaryImage.localPath).metadata()
      : await sharp(request.masterImage.localPath || "").metadata().catch(() => ({ width: 0, height: 0 }));
    const imageWidth = metadata.width || 0;
    const imageHeight = metadata.height || 0;
    if (!imageWidth || !imageHeight) {
      throw new VertexSecondaryContinuityError(
        "Unable to read secondary image dimensions for planning",
        "planner_missing_dimensions"
      );
    }
    const roomConsistencySummary = [
      request.roomConsistency?.roomState?.furnitureContinuityHints,
      request.roomConsistency?.roomState?.relationalSummary?.placementDirective,
      request.roomConsistency?.roomState?.furnitureMemory?.persistentIdentityGoal,
    ]
      .filter((value): value is string => !!String(value || "").trim())
      .join(" | ") || "preserve master furnishing identity where naturally visible";
    const prompt = buildPlannerPrompt({
      roomType: request.roomType,
      stagingStyle: request.stagingStyle,
      roomConsistencySummary,
      renderMode: request.renderMode,
      intent: request.intent,
    });

    nLog("[VERTEX_CONTINUITY_PLANNER]", {
      phase: "start",
      continuityGroupId: request.continuityGroupId || null,
      imageId: request.imageId,
      jobId: request.jobId,
      renderMode: request.renderMode,
      model,
      sourceTransport: request.secondaryImage.kind,
      masterTransport: request.masterImage.kind,
    });

    const startedAt = Date.now();
    const ai = getVertexGenAiClient();
    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { text: "APPROVED_MASTER_STAGED_IMAGE" },
            toGenAiPart(request.masterImage),
            { text: "SECONDARY_TARGET_IMAGE" },
            toGenAiPart(request.secondaryImage),
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
    const rawText = (response.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("").trim();
    if (!rawText) {
      throw new VertexSecondaryContinuityError("Planner returned no JSON text", "planner_empty_response");
    }
    const parsed = extractJson(rawText);
    const plan = normalizePlan(parsed, imageWidth, imageHeight, request.roomType);
    const latencyMs = Date.now() - startedAt;

    nLog("[VERTEX_CONTINUITY_PLANNER]", {
      phase: "complete",
      continuityGroupId: request.continuityGroupId || null,
      imageId: request.imageId,
      jobId: request.jobId,
      renderMode: request.renderMode,
      latencyMs,
      zoneCount: plan.furnitureZones.length,
      model,
    });

    nLog("[CONTINUITY_TOPOLOGY_CAGE]", {
      continuityGroupId: request.continuityGroupId || null,
      imageId: request.imageId,
      jobId: request.jobId,
      hasTopologyCage: !!plan.structuralTopologyCage,
      vanishingPointCount: plan.structuralTopologyCage?.vanishingPoints?.length || 0,
      planeCount: plan.structuralTopologyCage?.majorRoomPlanes?.length || 0,
    });

    nLog("[CONTINUITY_ANCHOR_GRAPH]", {
      continuityGroupId: request.continuityGroupId || null,
      imageId: request.imageId,
      jobId: request.jobId,
      hasAnchorGraph: !!plan.relationalAnchorGraph,
      anchorCount: plan.relationalAnchorGraph?.anchors.length || 0,
      relationshipCount: plan.relationalAnchorGraph?.relationships.length || 0,
    });

    return { plan, prompt, rawText, model, latencyMs };
  }
}