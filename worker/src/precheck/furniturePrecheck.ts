// Furniture pre-check: runs the furniture detector on a small preview of each
// photo as soon as the user adds it on the website, so the cost (declutter +
// stage = 2 credits, everything else 1) is known and shown before the batch
// is submitted. The answer is stored in Redis; the server reads it at upload
// to reserve the exact credits, and passes it to the job so the main pipeline
// routes the photo the same way (no second detector call — the shown price
// and the routing always agree).
//
// Same detector, same room-empty prefilter and same decision function the
// main pipeline uses (see the furnished gate in worker.ts).

import fs from "fs";
import os from "os";
import path from "path";
import { Worker, Job } from "bullmq";
import { getRedis } from "@realenhance/shared/redisClient.js";
import { runFurnitureDetectionSafe } from "../ai/runFurnitureDetectionSafe";
import { isFurnitureDetectionSuccess, resolveFurnishedGateDecision } from "../ai/furnitureDetector";
import { isRoomEmpty } from "../vision/isRoomEmpty";

// Must match server/src/routes/furniturePrecheck.ts.
export const FURNITURE_PRECHECK_QUEUE_NAME = "furniture-precheck";
export const FURNITURE_PRECHECK_TTL_SECONDS = 24 * 60 * 60;
export function furniturePrecheckKey(id: string) {
  return `furniture-precheck:${id}`;
}

// Room types offered on the website (plus "" = not set). The decision depends
// on room type (e.g. a bedroom without a bed), so it is worked out for each;
// the server picks the one the user chose.
export const PRECHECK_ROOM_TYPES = [
  "",
  "bedroom",
  "living_room",
  "dining_room",
  "kitchen",
  "kitchen_dining",
  "kitchen_living",
  "living_dining",
  "kitchen_living_dining",
  "study",
  "office",
  "bathroom_1",
  "bathroom_2",
  "laundry",
  "garage",
  "basement",
  "attic",
  "hallway",
  "staircase",
  "entryway",
  "closet",
  "pantry",
  "sunroom",
];

// Same normalisation as the main pipeline's furnished gate (worker.ts).
export function normalizePrecheckRoomType(roomType: unknown): string {
  const normalized = String(roomType || "").toLowerCase().replace(/-/g, "_").trim();
  return normalized === "multiple_living_areas" || normalized === "multiple_living" ? "kitchen_living_dining" : normalized;
}

export type FurniturePrecheckRecord = {
  status: "pending" | "done" | "failed";
  userId: string;
  createdAt: string;
  completedAt?: string;
  localEmpty?: boolean;
  // Raw detector result (success or failure object), reused by the main
  // pipeline in place of its own detector call.
  analysis?: any;
  // requiresDeclutter per normalised room type: true = furnished (declutter
  // before staging), false = empty, null = detector failed (treated as
  // furnished: 2 credits reserved, 1 refunded if it turns out empty).
  decisions?: Record<string, boolean | null>;
  error?: string;
};

export function decideRequiresDeclutter(localEmpty: boolean, analysis: any, roomType: string): boolean | null {
  if (localEmpty) return false;
  if (!isFurnitureDetectionSuccess(analysis)) return null;
  const gate = resolveFurnishedGateDecision({ analysis, localEmpty: false, roomType });
  return gate.requiresStage1B === true;
}

export async function runFurniturePrecheck(imageBuffer: Buffer, precheckId: string) {
  const localEmpty = await isRoomEmpty(imageBuffer);
  let analysis: any = null;
  if (!localEmpty) {
    const tmp = path.join(os.tmpdir(), `furniture-precheck-${precheckId}.jpg`);
    fs.writeFileSync(tmp, imageBuffer);
    try {
      const res = await runFurnitureDetectionSafe({
        imagePath: tmp,
        sceneType: "interior",
        logContext: { jobId: `precheck:${precheckId}`, sourceEvent: "FURNITURE_PRECHECK" },
      });
      analysis = res.result;
    } finally {
      fs.promises.unlink(tmp).catch(() => {});
    }
  }
  const decisions: Record<string, boolean | null> = {};
  for (const rt of PRECHECK_ROOM_TYPES) decisions[rt] = decideRequiresDeclutter(localEmpty, analysis, rt);
  return { localEmpty, analysis, decisions };
}

let precheckWorker: Worker | null = null;

export function startFurniturePrecheckWorker(redisUrl: string) {
  if (precheckWorker) return precheckWorker;
  if (String(process.env.FURNITURE_PRECHECK_WORKER || "on").toLowerCase() === "off") {
    console.log("[FURNITURE_PRECHECK] worker disabled (FURNITURE_PRECHECK_WORKER=off)");
    return null;
  }
  precheckWorker = new Worker(
    FURNITURE_PRECHECK_QUEUE_NAME,
    async (job: Job) => {
      const { precheckId, imageBase64 } = job.data as { precheckId: string; imageBase64: string };
      const redis = getRedis();
      const key = furniturePrecheckKey(precheckId);
      const existingRaw = await redis.get(key);
      const existing: FurniturePrecheckRecord | null = existingRaw ? JSON.parse(String(existingRaw)) : null;
      if (!existing) return; // expired or never registered
      const startedAt = Date.now();
      try {
        const result = await runFurniturePrecheck(Buffer.from(imageBase64, "base64"), precheckId);
        const record: FurniturePrecheckRecord = {
          ...existing,
          status: "done",
          completedAt: new Date().toISOString(),
          localEmpty: result.localEmpty,
          analysis: result.analysis,
          decisions: result.decisions,
        };
        await redis.set(key, JSON.stringify(record), { EX: FURNITURE_PRECHECK_TTL_SECONDS } as any);
        console.log(
          `[FURNITURE_PRECHECK] id=${precheckId} done in ${Date.now() - startedAt}ms localEmpty=${result.localEmpty} ` +
            `detector=${result.analysis?.status || (result.localEmpty ? "skipped" : "none")} ` +
            `furnished(default)=${result.decisions[""]}`
        );
      } catch (err: any) {
        const record: FurniturePrecheckRecord = {
          ...existing,
          status: "failed",
          completedAt: new Date().toISOString(),
          error: String(err?.message || err).slice(0, 300),
        };
        await redis.set(key, JSON.stringify(record), { EX: FURNITURE_PRECHECK_TTL_SECONDS } as any);
        console.warn(`[FURNITURE_PRECHECK] id=${precheckId} failed: ${record.error}`);
      }
    },
    {
      connection: { url: redisUrl },
      concurrency: Math.max(1, Number(process.env.FURNITURE_PRECHECK_CONCURRENCY || 6)),
    }
  );
  precheckWorker.on("error", (err) => console.error("[FURNITURE_PRECHECK] worker error", err));
  console.log("[FURNITURE_PRECHECK] worker started");
  return precheckWorker;
}
