// server/src/routes/upload.ts
import { Router, type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createImageRecord } from "../services/images.js";
import { addImageToUser, updateUser } from "../services/users.js";
import { cancelEnqueuedJob, createAwaitingPaymentEnhanceJob, enqueueEnhanceJob, listAwaitingPaymentEnhanceJobs } from "../services/jobs.js";
import { createPresignedUploadUrl, getS3PublicUrl, uploadOriginalToS3 } from "../utils/s3.js";
import { recordUsageEvent } from "@realenhance/shared/usageTracker";
import { getAgency, updateAgency } from "@realenhance/shared/agencies.js";
import { getUserByEmail, getUserById } from "../services/users.js";
import { enforceRetentionLimit } from "../services/imageRetention.js";
import { reserveAllowance, commitReservation, releaseReservation, getUsageSnapshot } from "../services/usageLedger.js";
import { getTrialSummary, releaseTrialReservation, reserveTrialCredits } from "../services/trials.js";
import { estimateBatchCredits } from "@realenhance/shared/billing/rules.js";
import { getAvailableCredits } from "../services/awaitingPayment.js";
import { findOrCreateProperty } from "../services/properties.js";
import * as crypto from "node:crypto";

function timingSafeEqual(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function readBearerToken(req: Request): string | null {
  const raw = String(req.headers.authorization || "").trim();
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

const uploadRoot = path.join(process.cwd(), "server", "uploads");
const UNVERIFIED_PROCESSING_TTL_HOURS = Number(process.env.UNVERIFIED_PROCESSING_TTL_HOURS || 48);
const ENFORCE_UNVERIFIED_PROCESSING_EXPIRY = String(process.env.ENFORCE_UNVERIFIED_PROCESSING_EXPIRY || "true").toLowerCase() !== "false";

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await fs.mkdir(uploadRoot, { recursive: true });
        cb(null, uploadRoot);
      } catch (e) {
        cb(e as Error, uploadRoot);
      }
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || "");
      const base = path.basename(file.originalname || "upload", ext).replace(/[^a-zA-Z0-9._-]/g, "_");
      const uniqueName = `${Date.now()}-${crypto.randomUUID()}-${base}${ext}`;
      cb(null, uniqueName);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

function safeParseOptions(raw: unknown): any[] {
  if (typeof raw !== "string") return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

interface DirectUploadedImage {
  key: string;
}

function safeParseUploadedKeys(raw: unknown): DirectUploadedImage[] {
  const parsed = typeof raw === "string"
    ? (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return [];
      }
    })()
    : raw;

  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((item) => {
      if (typeof item === "string") {
        return { key: item.trim() };
      }
      if (item && typeof item === "object" && typeof (item as any).key === "string") {
        return { key: String((item as any).key).trim() };
      }
      return null;
    })
    .filter((item): item is DirectUploadedImage => Boolean(item?.key));
}

function isMultipartRequest(req: Request): boolean {
  return req.is("multipart/form-data") === "multipart/form-data";
}

const CANONICAL_ROOM_TYPES = new Set([
  "bedroom",
  "living_room",
  "dining_room",
  "kitchen",
  "kitchen_dining",
  "kitchen_living",
  "living_dining",
  "multiple_living",
  "study",
  "office",
  "bathroom",
  "bathroom_1",
  "bathroom_2",
  "laundry",
  "garage",
  "basement",
  "attic",
  "hallway",
  "sunroom",
  "staircase",
  "entryway",
  "closet",
  "pantry",
  "outdoor",
  "exterior",
  "other",
]);

function normalizeRoomType(raw: unknown): string {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  const aliases: Record<string, string> = {
    "bedroom-1": "bedroom",
    "bedroom-2": "bedroom",
    "bedroom-3": "bedroom",
    "bedroom-4": "bedroom",
    "living": "living_room",
    "living-room": "living_room",
    "dining": "dining_room",
    "dining-room": "dining_room",
    "multiple-living-areas": "multiple_living",
    "multiple_living_areas": "multiple_living",
    "multiple-living": "multiple_living",
    "multiple living": "multiple_living",
    "multi-living": "multiple_living",
    "kitchen & dining": "kitchen_dining",
    "kitchen-and-dining": "kitchen_dining",
    "kitchen & living": "kitchen_living",
    "kitchen-and-living": "kitchen_living",
    "living & dining": "living_dining",
    "living-and-dining": "living_dining",
    "bathroom-1": "bathroom_1",
    "bathroom-2": "bathroom_2",
    "sun-room": "sunroom",
  };
  return aliases[value] || value.replace(/-/g, "_");
}

function normalizeStagingStyle(style?: string): string {
  if (!style) return "nz_standard";

  const s = style.trim().toLowerCase();

  if (["nz_standard", "standard_listing", "standard", "default"].includes(s)) {
    return "nz_standard";
  }

  return s;
}

function isTrueFlag(value: unknown): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

type RoomConsistencySelectionPlan = {
  roomId: string;
  primaryIndex: number;
  method: "auto" | "manual";
  groupSize: number;
  scoreByIndex: Record<number, { score: number; reasons: string[] }>;
};

function buildRoomConsistencySelectionPlan(metaByIndex: Record<number, any>, uploadCount: number): Record<string, RoomConsistencySelectionPlan> {
  const groups = new Map<string, Array<{ index: number; score: number; reasons: string[]; explicitPrimary: boolean; angleOrder: number | null }>>();

  const getFeature = (meta: any, keys: string[]): number | null => {
    const features = meta?.scenePrediction?.features;
    if (!features || typeof features !== "object") return null;
    for (const key of keys) {
      const v = Number((features as any)[key]);
      if (Number.isFinite(v)) return v;
    }
    return null;
  };

  for (let i = 0; i < uploadCount; i++) {
    const meta = metaByIndex[i] || {};
    const roomKey = String(meta.roomKey || "").trim();
    if (!roomKey) continue;

    const reasons: string[] = [];
    let score = 0;

    const angleOrderRaw = Number(meta.angleOrder);
    const angleOrder = Number.isFinite(angleOrderRaw) && angleOrderRaw > 0 ? Math.floor(angleOrderRaw) : null;
    const explicitPrimary = meta.manualPrimary === true || angleOrder === 1;
    if (explicitPrimary) {
      score += 500;
      reasons.push("manual_primary_override");
    } else if (angleOrder) {
      const angleScore = Math.max(0, 60 - angleOrder * 8);
      score += angleScore;
      reasons.push(`angle_order_hint:${angleOrder}`);
    }

    const sceneConfidence = Number(meta?.scenePrediction?.confidence);
    if (Number.isFinite(sceneConfidence)) {
      score += Math.max(0, Math.min(1, sceneConfidence)) * 40;
      reasons.push(`scene_confidence:${Math.max(0, Math.min(1, sceneConfidence)).toFixed(3)}`);
    }

    const edgeDensity = getFeature(meta, ["edgeDensity", "edge_density", "edges"]);
    if (edgeDensity !== null) {
      score += Math.max(0, Math.min(1, edgeDensity)) * 20;
      reasons.push(`edge_density:${Math.max(0, Math.min(1, edgeDensity)).toFixed(3)}`);
    }

    const luminance = getFeature(meta, ["luminance", "brightness", "meanLuminance", "luma"]);
    if (luminance !== null) {
      score += Math.max(0, Math.min(1, luminance)) * 20;
      reasons.push(`luminance:${Math.max(0, Math.min(1, luminance)).toFixed(3)}`);
    }

    const darkness = getFeature(meta, ["darknessFactor", "darkness", "dark_ratio"]);
    if (darkness !== null) {
      score += (1 - Math.max(0, Math.min(1, darkness))) * 10;
      reasons.push(`darkness_factor:${Math.max(0, Math.min(1, darkness)).toFixed(3)}`);
    }

    const structuralClarity = getFeature(meta, ["structuralClarity", "clarity", "anchorVisibility"]);
    if (structuralClarity !== null) {
      score += Math.max(0, Math.min(1, structuralClarity)) * 15;
      reasons.push(`structural_clarity:${Math.max(0, Math.min(1, structuralClarity)).toFixed(3)}`);
    }

    const sceneType = String(meta.sceneType || "").trim().toLowerCase();
    if (sceneType === "interior") {
      score += 5;
      reasons.push("interior_scene_bonus");
    }

    const roomType = String(meta.roomType || "").trim().toLowerCase();
    if (roomType && roomType !== "unknown" && roomType !== "auto") {
      score += 4;
      reasons.push("room_type_present");
    }

    const group = groups.get(roomKey) || [];
    group.push({ index: i, score, reasons, explicitPrimary, angleOrder });
    groups.set(roomKey, group);
  }

  const plans: Record<string, RoomConsistencySelectionPlan> = {};
  for (const [roomId, candidates] of groups.entries()) {
    if (!candidates.length) continue;

    const explicitCandidates = candidates.filter((c) => c.explicitPrimary);
    const selected = explicitCandidates.length
      ? explicitCandidates.slice().sort((a, b) => {
          const angleA = a.angleOrder ?? Number.MAX_SAFE_INTEGER;
          const angleB = b.angleOrder ?? Number.MAX_SAFE_INTEGER;
          if (angleA !== angleB) return angleA - angleB;
          if (b.score !== a.score) return b.score - a.score;
          return a.index - b.index;
        })[0]
      : candidates.slice().sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.index - b.index;
        })[0];

    plans[roomId] = {
      roomId,
      primaryIndex: selected.index,
      method: explicitCandidates.length ? "manual" : "auto",
      groupSize: candidates.length,
      scoreByIndex: Object.fromEntries(
        candidates.map((candidate) => [
          candidate.index,
          {
            score: Number(candidate.score.toFixed(3)),
            reasons: candidate.reasons,
          },
        ])
      ),
    };
  }

  return plans;
}

export function uploadRouter() {
  const r = Router();

  r.post("/room-consistency", async (req, res) => {
    const { roomId, currentState } = req.body;
    let roomState: RoomStateV1 = { roomId, masterApproved: false };

    switch (currentState) {
      case RoomStateMachine.PENDING_MASTER:
        roomState = transitionRoomState(roomState, RoomStateMachine.MASTER_GENERATING);
        break;
      case RoomStateMachine.MASTER_GENERATING:
        roomState = transitionRoomState(roomState, RoomStateMachine.MASTER_READY);
        break;
      case RoomStateMachine.MASTER_READY:
        roomState = transitionRoomState(roomState, RoomStateMachine.MASTER_APPROVED);
        break;
      case RoomStateMachine.MASTER_APPROVED:
        roomState = transitionRoomState(roomState, RoomStateMachine.REFERENCE_RENDERING);
        break;
      case RoomStateMachine.REFERENCE_RENDERING:
        roomState = transitionRoomState(roomState, RoomStateMachine.COMPLETE);
        break;
      default:
        return res.status(400).send("Invalid state transition");
    }

    res.json({ roomState });
  });

  return r;
}

// Strict boolean parsing helper (placed at end for minimal intrusion; could be centralized later)
function parseStrictBool(v: any, defaultValue = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (["true","1","yes","y","on"].includes(s)) return true;
    if (["false","0","no","n","off",""].includes(s)) return false;
  }
  return defaultValue;
}

import { RoomStateV1 } from "../shared/types.js";

// Room-level state machine states
const RoomStateMachine = {
  PENDING_MASTER: "PENDING_MASTER",
  MASTER_GENERATING: "MASTER_GENERATING",
  MASTER_READY: "MASTER_READY",
  MASTER_APPROVED: "MASTER_APPROVED",
  REFERENCE_RENDERING: "REFERENCE_RENDERING",
  COMPLETE: "COMPLETE",
} as const;

type RoomStateMachineState = keyof typeof RoomStateMachine;

// Function to transition room state
function transitionRoomState(roomState: RoomStateV1, newState: RoomStateMachineState): RoomStateV1 {
  console.log(`Transitioning room ${roomState.roomId} from ${roomState.masterApproved ? "APPROVED" : "NOT_APPROVED"} to ${newState}`);
  return { ...roomState, masterApproved: newState === RoomStateMachine.MASTER_APPROVED };
}
