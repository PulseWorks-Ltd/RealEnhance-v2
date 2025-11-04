import { Worker, Job } from "bullmq";
import { JOB_QUEUE_NAME } from "@realenhance/shared/dist/constants";
import {
  AnyJobPayload,
  EnhanceJobPayload,
  EditJobPayload
} from "@realenhance/shared/dist/types";

import fs from "fs";

import { runStage1A } from "./pipeline/stage1A";
import { runStage1B } from "./pipeline/stage1B";
import { runStage2 } from "./pipeline/stage2";
import { applyEdit } from "./pipeline/editApply";

import { detectSceneFromImage } from "./ai/scene-detector";
import { detectRoomType } from "./ai/room-detector";
import { classifyScene } from "./validators/scene-classifier";

import {
  updateJob,
  pushImageVersion,
  readImageRecord,
  getVersionPath,
  getOriginalPath
} from "./utils/persist";
import { getGeminiClient } from "./ai/gemini";
import { checkCompliance } from "./ai/compliance";
import { toBase64 } from "./utils/images";
import { isCancelled } from "./utils/cancel";
import { getStagingProfile } from "./utils/groups";

// handle "enhance" pipeline
async function handleEnhanceJob(payload: EnhanceJobPayload) {
  const rec = readImageRecord(payload.imageId);
  if (!rec) {
    updateJob(payload.jobId, { status: "error", errorMessage: "image not found" });
    return;
  }

  const timings: Record<string, number> = {};
  const t0 = Date.now();

  // Auto detection: primary scene (interior/exterior) + room type
  let detectedRoom: string | undefined;
  let sceneLabel = (payload.options.sceneType as any) || "auto";
  let scenePrimary: any = undefined;
  const tScene = Date.now();
  try {
    const origPath = getOriginalPath(rec);
    const buf = fs.readFileSync(origPath);
    // Primary scene (ONNX + heuristic fallback)
    const primary = await detectSceneFromImage(buf);
    scenePrimary = primary;
    // Room type (ONNX + heuristic fallback; fallback again to legacy heuristic)
    let room = await detectRoomType(buf).catch(async () => null as any);
    if (!room) {
      const heur = await classifyScene(origPath);
      room = { label: heur.label, confidence: heur.confidence } as any;
    }
    detectedRoom = room.label as string;
    if (sceneLabel === "auto" || !sceneLabel) sceneLabel = room.label as any;
    // store interim meta (non-fatal if write fails)
    updateJob(payload.jobId, { meta: { ...(rec as any).meta, scenePrimary: primary, scene: { label: room.label as any, confidence: room.confidence } } });
  } catch {
    if (sceneLabel === "auto" || !sceneLabel) sceneLabel = "other" as any;
  }
  timings.sceneDetectMs = Date.now() - tScene;

  if (await isCancelled(payload.jobId)) {
    updateJob(payload.jobId, { status: "error", errorMessage: "cancelled" });
    return;
  }

  // STAGE 1A
  const t1A = Date.now();
  const path1A = await runStage1A(getOriginalPath(rec));
  timings.stage1AMs = Date.now() - t1A;

  if (await isCancelled(payload.jobId)) {
    updateJob(payload.jobId, { status: "error", errorMessage: "cancelled" });
    return;
  }

  // STAGE 1B (optional declutter)
  const t1B = Date.now();
  const path1B = payload.options.declutter ? await runStage1B(path1A) : path1A;
  timings.stage1BMs = Date.now() - t1B;

  if (await isCancelled(payload.jobId)) {
    updateJob(payload.jobId, { status: "error", errorMessage: "cancelled" });
    return;
  }

  // STAGE 2 (optional virtual staging via Gemini)
  const t2 = Date.now();
  const profileId = (payload as any)?.options?.stagingProfileId as string | undefined;
  const profile = profileId ? getStagingProfile(profileId) : undefined;
  const angleHint = (payload as any)?.options?.angleHint as any; // "primary" | "secondary" | "other"
  const path2 = payload.options.virtualStage
    ? await runStage2(path1B, { roomType: payload.options.roomType || String(detectedRoom || "living_room"), profile, angleHint })
    : path1B;
  timings.stage2Ms = Date.now() - t2;

  if (await isCancelled(payload.jobId)) {
    updateJob(payload.jobId, { status: "error", errorMessage: "cancelled" });
    return;
  }

  // COMPLIANCE VALIDATION (best-effort)
  let compliance: any = undefined;
  const tVal = Date.now();
  try {
    const ai = getGeminiClient();
    const base1A = toBase64(path1A);
    const baseFinal = toBase64(path2);
    compliance = await checkCompliance(ai as any, base1A.data, baseFinal.data);
    if (compliance && compliance.ok === false) {
      updateJob(payload.jobId, {
        status: "error",
        errorMessage: (compliance.reasons || ["Compliance check failed"]).join("; "),
        meta: { ...(rec as any).meta, scene: { label: sceneLabel as any, confidence: 0.5 }, scenePrimary, compliance }
      });
      return;
    }
  } catch (e) {
    // proceed if Gemini not configured or any error
    // console.warn("[worker] compliance check skipped:", (e as any)?.message || e);
  }
  timings.validateMs = Date.now() - tVal;

  // record versions
  pushImageVersion({
    imageId: payload.imageId,
    userId: payload.userId,
    stageLabel: "1A",
    filePath: path1A,
    note: "Quality enhanced"
  });

  if (payload.options.declutter) {
    pushImageVersion({
      imageId: payload.imageId,
      userId: payload.userId,
      stageLabel: "1B",
      filePath: path1B,
      note: "Decluttered / depersonalized"
    });
  }

  const finalPathVersion = pushImageVersion({
    imageId: payload.imageId,
    userId: payload.userId,
    stageLabel: payload.options.virtualStage ? "2" : "1B/1A",
    filePath: path2,
    note: payload.options.virtualStage ? "Virtual staging" : "Final enhanced"
  });

  const meta = {
      scene: { label: sceneLabel as any, confidence: 0.5 },
      scenePrimary,
      timings: { ...timings, totalMs: Date.now() - t0 },
      ...(compliance ? { compliance } : {})
    };

  updateJob(payload.jobId, {
    status: "complete",
    stageOutputs: {
      "1A": path1A,
      "1B": payload.options.declutter ? path1B : undefined,
      "2": payload.options.virtualStage ? path2 : undefined
    },
    resultVersionId: finalPathVersion.versionId,
    meta
  });

  // Return value for BullMQ status consumers
  return {
    ok: true,
    imageId: payload.imageId,
    jobId: payload.jobId,
    finalPath: path2,
    meta
  } as any;
}

// handle "edit" pipeline
async function handleEditJob(payload: EditJobPayload) {
  const rec = readImageRecord(payload.imageId);
  if (!rec) {
    updateJob(payload.jobId, { status: "error", errorMessage: "image not found" });
    return;
  }

  const basePath = getVersionPath(rec, payload.baseVersionId);
  if (!basePath) {
    updateJob(payload.jobId, { status: "error", errorMessage: "base version not found" });
    return;
  }

  let restoreFromPath: string | undefined;
  if (payload.mode === "Restore") {
    // previous version in history before baseVersionId
    const idx = rec.history.findIndex(v => v.versionId === payload.baseVersionId);
    restoreFromPath = idx > 0 ? rec.history[idx - 1]?.filePath : basePath;
  }

  const editedPath = await applyEdit({
    baseImagePath: basePath,
    mask: payload.mask,
    mode: payload.mode,
    instruction: payload.instruction,
    restoreFromPath
  });

  const newVersion = pushImageVersion({
    imageId: payload.imageId,
    userId: payload.userId,
    stageLabel: "edit",
    filePath: editedPath,
    note: `${payload.mode}: ${payload.instruction}`
  });

  updateJob(payload.jobId, { status: "complete", resultVersionId: newVersion.versionId });
}

// BullMQ worker
const worker = new Worker(
  JOB_QUEUE_NAME,
  async (job: Job) => {
    const payload = job.data as AnyJobPayload;

    updateJob((payload as any).jobId, { status: "processing" });

    try {
      if (payload.type === "enhance") {
        return await handleEnhanceJob(payload as any);
      } else if (payload.type === "edit") {
        return await handleEditJob(payload as any);
      } else {
        updateJob((payload as any).jobId, { status: "error", errorMessage: "unknown job type" });
      }
    } catch (err: any) {
      console.error("[worker] job failed", err);
      updateJob((payload as any).jobId, { status: "error", errorMessage: err?.message || "unhandled worker error" });
      throw err;
    }
  },
  {
    connection: { url: process.env.REDIS_URL || "redis://localhost:6379" },
    concurrency: Number(process.env.WORKER_CONCURRENCY || 2)
  }
);

worker.on("completed", job => {
  console.log(`[worker] completed job ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] failed job ${job?.id}`, err);
});
