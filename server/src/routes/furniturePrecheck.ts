// Furniture pre-check endpoints. The website sends a small preview of each
// photo as soon as it is added; the worker's furniture detector runs on it in
// a separate fast queue, and the answer (furnished -> declutter + stage = 2
// credits, empty -> 1) is ready by the time the user clicks Process. The
// upload route reads the same stored answer to reserve the exact credits.
// See worker/src/precheck/furniturePrecheck.ts.

import { Router, type Request, type Response } from "express";
import { Queue } from "bullmq";
import * as crypto from "node:crypto";
import { getRedis } from "@realenhance/shared/redisClient.js";

// Must match worker/src/precheck/furniturePrecheck.ts.
const FURNITURE_PRECHECK_QUEUE_NAME = "furniture-precheck";
const FURNITURE_PRECHECK_TTL_SECONDS = 24 * 60 * 60;
const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;
const MAX_PRECHECKS_PER_HOUR = Math.max(1, Number(process.env.FURNITURE_PRECHECK_MAX_PER_HOUR || 600));
const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "redis://localhost:6379";

function precheckKey(id: string) {
  return `furniture-precheck:${id}`;
}

export type FurniturePrecheckRecord = {
  status: "pending" | "done" | "failed";
  userId: string;
  createdAt: string;
  completedAt?: string;
  localEmpty?: boolean;
  analysis?: any;
  decisions?: Record<string, boolean | null>;
  error?: string;
};

// Same normalisation as the worker's furnished gate.
export function normalizePrecheckRoomType(roomType: unknown): string {
  const normalized = String(roomType || "").toLowerCase().replace(/-/g, "_").trim();
  return normalized === "multiple_living_areas" || normalized === "multiple_living" ? "kitchen_living_dining" : normalized;
}

/** Load a pre-check record owned by this user (null if missing/expired/not theirs). */
export async function loadFurniturePrecheck(id: unknown, userId: string): Promise<FurniturePrecheckRecord | null> {
  const precheckId = String(id || "").trim();
  if (!/^[a-f0-9-]{36}$/i.test(precheckId)) return null;
  try {
    const raw = await getRedis().get(precheckKey(precheckId));
    if (!raw) return null;
    const record = JSON.parse(String(raw)) as FurniturePrecheckRecord;
    if (!record || record.userId !== userId) return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * Will declutter run before staging for this photo? true = furnished,
 * false = empty, null = unknown (pre-check missing, pending or failed).
 */
export function precheckRequiresDeclutter(record: FurniturePrecheckRecord | null, roomType: unknown): boolean | null {
  if (!record || record.status !== "done" || !record.decisions) return null;
  const key = normalizePrecheckRoomType(roomType);
  const value = key in record.decisions ? record.decisions[key] : record.decisions[""];
  return typeof value === "boolean" ? value : null;
}

let precheckQueue: Queue | null = null;
function queue(): Queue {
  if (!precheckQueue) {
    precheckQueue = new Queue(FURNITURE_PRECHECK_QUEUE_NAME, { connection: { url: REDIS_URL } });
  }
  return precheckQueue;
}

function stripDataUrl(value: unknown): string {
  const s = String(value || "");
  const comma = s.startsWith("data:") ? s.indexOf(",") : -1;
  return comma >= 0 ? s.slice(comma + 1) : s;
}

export function furniturePrecheckRouter() {
  const router = Router();

  router.post("/precheck/furniture", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser?.id) return res.status(401).json({ error: "not_authenticated" });

    const imageBase64 = stripDataUrl((req.body as any)?.image);
    if (!imageBase64) return res.status(400).json({ error: "image_required" });
    const approxBytes = Math.floor((imageBase64.length * 3) / 4);
    if (approxBytes > MAX_PREVIEW_BYTES) return res.status(413).json({ error: "preview_too_large" });

    try {
      const redis = getRedis();
      const rateKey = `furniture-precheck-rate:${sessUser.id}:${new Date().toISOString().slice(0, 13)}`;
      const count = Number(await (redis as any).incr(rateKey));
      if (count === 1) await redis.expire(rateKey, 3600);
      if (count > MAX_PRECHECKS_PER_HOUR) return res.status(429).json({ error: "precheck_rate_limited" });

      const precheckId = crypto.randomUUID();
      const record: FurniturePrecheckRecord = {
        status: "pending",
        userId: String(sessUser.id),
        createdAt: new Date().toISOString(),
      };
      await redis.set(precheckKey(precheckId), JSON.stringify(record), { EX: FURNITURE_PRECHECK_TTL_SECONDS } as any);
      await queue().add(
        "precheck",
        { precheckId, imageBase64 },
        { removeOnComplete: true, removeOnFail: true, attempts: 1 }
      );
      return res.json({ precheckId });
    } catch (err: any) {
      console.error("[FURNITURE_PRECHECK] enqueue failed", err?.message || err);
      return res.status(503).json({ error: "precheck_unavailable" });
    }
  });

  // GET /api/precheck/furniture?ids=a,b,c -> per-id status and the furnished
  // answer per room type (the raw detector output stays server-side).
  router.get("/precheck/furniture", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser?.id) return res.status(401).json({ error: "not_authenticated" });
    const ids = String((req.query as any)?.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    const results: Record<string, { status: string; decisions?: Record<string, boolean | null> }> = {};
    await Promise.all(
      ids.map(async (id) => {
        const record = await loadFurniturePrecheck(id, String(sessUser.id));
        results[id] = record
          ? { status: record.status, ...(record.decisions ? { decisions: record.decisions } : {}) }
          : { status: "missing" };
      })
    );
    return res.json({ results });
  });

  return router;
}
