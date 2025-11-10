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
import { setVersionPublicUrl } from "./utils/persist";
import { getGeminiClient } from "./ai/gemini";
import { checkCompliance } from "./ai/compliance";
import { toBase64 } from "./utils/images";
import { isCancelled } from "./utils/cancel";
import { getStagingProfile } from "./utils/groups";
import { publishImage } from "./utils/publish";
import { downloadToTemp } from "./utils/remote";

// handle "enhance" pipeline
async function handleEnhanceJob(payload: EnhanceJobPayload) {
  console.log(`========== PROCESSING JOB ${payload.jobId} ==========`);
  const rec = readImageRecord(payload.imageId);
  if (!rec) {
    updateJob(payload.jobId, { status: "error", errorMessage: "image not found" });
    return;
  }

  const timings: Record<string, number> = {};
  const t0 = Date.now();

  // Publish original so client can render before/after across services
  let origPath = getOriginalPath(rec);
  // If the record path isn't accessible or remoteOriginalUrl provided in payload, prefer remote
  const remoteUrl: string | undefined = (payload as any).remoteOriginalUrl;
  if (remoteUrl) {
    try {
      process.stdout.write(`[WORKER] Remote original detected, downloading: ${remoteUrl}\n`);
      origPath = await downloadToTemp(remoteUrl, payload.jobId);
      process.stdout.write(`[WORKER] Remote original downloaded to: ${origPath}\n`);
    } catch (e) {
      process.stderr.write(`[WORKER] Remote download failed, falling back to local path (${origPath}): ${(e as any)?.message || e}\n`);
    }
  } else {
    process.stderr.write("[WORKER] WARN: Job lacks remoteOriginalUrl. This means the server didn't upload the original to S3.\n");
    process.stderr.write("[WORKER] In production, server should run with REQUIRE_S3=1 so uploads fail fast instead of enqueueing unusable jobs.\n");
  }
  process.stdout.write(`\n[WORKER] ═══════════ Publishing original image ═══════════\n`);
  const publishedOriginal = await publishImage(origPath);
  process.stdout.write(`[WORKER] Original published: kind=${publishedOriginal?.kind} url=${(publishedOriginal?.url||'').substring(0, 80)}...\n\n`);
  // surface early so UI can show before/after immediately
  updateJob(payload.jobId, { stage: "upload-original", progress: 10, originalUrl: publishedOriginal?.url });

  // Auto detection: primary scene (interior/exterior) + room type
  let detectedRoom: string | undefined;
  let sceneLabel = (payload.options.sceneType as any) || "auto";
  let scenePrimary: any = undefined;
  const tScene = Date.now();
  try {
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
  const path1A = await runStage1A(origPath);
  timings.stage1AMs = Date.now() - t1A;
  // Record 1A version and try to publish
  const v1A = pushImageVersion({ imageId: payload.imageId, userId: payload.userId, stageLabel: "1A", filePath: path1A, note: "Quality enhanced" });
  let pub1AUrl: string | undefined = undefined;
  try {
    const pub1A = await publishImage(path1A);
    pub1AUrl = pub1A.url;
    setVersionPublicUrl(payload.imageId, v1A.versionId, pub1A.url);
  } catch (e) {
    console.warn('[worker] failed to publish 1A', e);
  }
  updateJob(payload.jobId, { stage: "1A", progress: 35, stageUrls: { "1A": pub1AUrl } });
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
  updateJob(payload.jobId, { stage: payload.options.virtualStage ? "2" : (payload.options.declutter ? "1B" : "1A"), progress: payload.options.virtualStage ? 75 : (payload.options.declutter ? 55 : 45) });

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

  // stage 1B publishing was deferred until here; attach URL and surface progress
  let pub1BUrl: string | undefined = undefined;
  if (payload.options.declutter) {
    const v1B = pushImageVersion({ imageId: payload.imageId, userId: payload.userId, stageLabel: "1B", filePath: path1B, note: "Decluttered / depersonalized" });
    try {
      const pub1B = await publishImage(path1B);
      pub1BUrl = pub1B.url;
      setVersionPublicUrl(payload.imageId, v1B.versionId, pub1B.url);
      updateJob(payload.jobId, { stage: "1B", progress: 55, stageUrls: { "1B": pub1BUrl } });
    } catch (e) {
      console.warn('[worker] failed to publish 1B', e);
    }
  }

  const finalPathVersion = pushImageVersion({
    imageId: payload.imageId,
    userId: payload.userId,
    stageLabel: payload.options.virtualStage ? "2" : "1B/1A",
    filePath: path2,
    note: payload.options.virtualStage ? "Virtual staging" : "Final enhanced"
  });

  // Publish final for client consumption and attach to version
  let publishedFinal: any = null;
  let pubFinalUrl: string | undefined = undefined;
  try {
    process.stdout.write(`\n[WORKER] ═══════════ Publishing final enhanced image ═══════════\n`);
    publishedFinal = await publishImage(path2);
    pubFinalUrl = publishedFinal?.url;
    if (!pubFinalUrl) {
      throw new Error('publishImage returned no URL');
    }
    setVersionPublicUrl(payload.imageId, finalPathVersion.versionId, pubFinalUrl);
    process.stdout.write(`[WORKER] Final published: kind=${publishedFinal?.kind} url=${(pubFinalUrl||'').substring(0, 80)}...\n\n`);
  } catch (e) {
    process.stderr.write(`[WORKER] CRITICAL: Failed to publish final image: ${e}\n`);
    process.stderr.write(`[WORKER] publishedFinal: ${JSON.stringify(publishedFinal)}\n`);
  }
  updateJob(payload.jobId, { stage: "upload-final", progress: 90, resultUrl: pubFinalUrl });

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
    meta,
    originalUrl: publishedOriginal?.url,
    resultUrl: pubFinalUrl,
    stageUrls: {
      "1A": pub1AUrl,
      "1B": pub1BUrl,
      "2": pubFinalUrl
    }
  });

  // Return value for BullMQ status consumers
  const returnValue = {
    ok: true,
    imageId: payload.imageId,
    jobId: payload.jobId,
    finalPath: path2,
    originalUrl: publishedOriginal?.url || null,
    resultUrl: pubFinalUrl || null,
    stageUrls: {
      "1A": pub1AUrl || null,
      "1B": pub1BUrl || null,
      "2": pubFinalUrl || null
    },
    meta
  };
  
  // Log the return value for debugging
  process.stdout.write('\n[WORKER] ═══════════ JOB RETURN VALUE ═══════════\n');
  process.stdout.write(`[WORKER] imageId: ${returnValue.imageId}\n`);
  process.stdout.write(`[WORKER] originalUrl: ${returnValue.originalUrl ? (String(returnValue.originalUrl).substring(0, 80) + '...') : 'NULL'}\n`);
  process.stdout.write(`[WORKER] resultUrl: ${returnValue.resultUrl ? (String(returnValue.resultUrl).substring(0, 80) + '...') : 'NULL'}\n`);
  process.stdout.write(`[WORKER] stageUrls.2: ${returnValue.stageUrls["2"] ? (String(returnValue.stageUrls["2"]).substring(0, 80) + '...') : 'NULL'}\n`);
  process.stdout.write('═══════════════════════════════════════════════\n\n');
  
  return returnValue;
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

// Determine Redis URL with preference for private/internal in hosted environments
const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "redis://localhost:6379";

// DEPLOYMENT VERIFICATION
const BUILD_VERSION = "2025-11-07_16:00_S3_VERBOSE_LOGS";
console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║                   WORKER STARTING                              ║');
console.log('╚════════════════════════════════════════════════════════════════╝');
console.log(`[WORKER] BUILD: ${BUILD_VERSION}`);
console.log(`[WORKER] Queue: ${JOB_QUEUE_NAME}`);
console.log(`[WORKER] Redis: ${REDIS_URL}`);
process.stdout.write('\n'); // Force flush

// Log S3 configuration on startup
console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║                   S3 CONFIGURATION                             ║');
console.log('╚════════════════════════════════════════════════════════════════╝');
console.log('  S3_BUCKET:', process.env.S3_BUCKET || '❌ NOT SET');
console.log('  AWS_REGION:', process.env.AWS_REGION || '❌ NOT SET');
console.log('  AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID ? `✅ SET (${process.env.AWS_ACCESS_KEY_ID.substring(0, 8)}...)` : '❌ NOT SET');
console.log('  AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY ? '✅ SET' : '❌ NOT SET');
console.log('  S3_PUBLIC_BASEURL:', process.env.S3_PUBLIC_BASEURL || 'NOT SET (will use S3 direct URLs)');
const s3Enabled = !!(process.env.S3_BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
console.log('  📊 Status:', s3Enabled ? '✅ ENABLED - Images will upload to S3' : '❌ DISABLED - Will use data URLs');
console.log('╚════════════════════════════════════════════════════════════════╝');
process.stdout.write('\n'); // Force flush

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
    connection: { url: REDIS_URL },
    concurrency: Number(process.env.WORKER_CONCURRENCY || 2)
  }
);

// Show readiness (optional in BullMQ v5)
(async () => {
  try {
    // @ts-ignore
    await worker.waitUntilReady?.();
    console.log("[worker] ready and listening");
  } catch (e) {
    console.error("[worker] failed to initialize", e);
  }
})();

worker.on("completed", (job, result: any) => {
  const url = (result && (result as any).resultUrl) ? String((result as any).resultUrl).slice(0, 120) : undefined;
  console.log(`[worker] completed job ${job.id}${url ? ` → ${url}` : ""}`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] failed job ${job?.id}`, err);
});
