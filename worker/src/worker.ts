import { Worker, Job } from "bullmq";
import { JOB_QUEUE_NAME } from "@realenhance/shared/dist/constants";
import {
  AnyJobPayload,
  EnhanceJobPayload,
  EditJobPayload
} from "@realenhance/shared/dist/types";

import { runStage1A } from "./pipeline/stage1A";
import { runStage1B } from "./pipeline/stage1B";
import { runStage2 } from "./pipeline/stage2";
import { applyEdit } from "./pipeline/editApply";

import { validateStructure } from "./validators/structural";
import { validateRealism } from "./validators/realism";

import {
  updateJob,
  pushImageVersion,
  readImageRecord,
  getVersionPath,
  getOriginalPath
} from "./utils/persist";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// handle "enhance" pipeline
async function handleEnhanceJob(payload: EnhanceJobPayload) {
  const rec = readImageRecord(payload.imageId);
  if (!rec) {
    updateJob(payload.jobId, {
      status: "error",
      errorMessage: "image not found"
    });
    return;
  }

  // STAGE 1A
  const path1A = await runStage1A(getOriginalPath(rec));

  // STAGE 1B
  const path1B = payload.options.declutter
    ? await runStage1B(path1A, { sceneType: payload.options.sceneType })
    : path1A;

  // STAGE 2
  const path2 = payload.options.virtualStage
    ? await runStage2(path1B, { roomType: payload.options.roomType })
    : path1B;

  // VALIDATE FINAL
  const structural = await validateStructure(path1A, path2);
  const realism = await validateRealism(path2);

  if (!structural.ok || !realism.ok) {
    updateJob(payload.jobId, {
      status: "error",
      errorMessage: "validation_failed"
    });
    return;
  }

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

  updateJob(payload.jobId, {
    status: "complete",
    stageOutputs: {
      "1A": path1A,
      "1B": payload.options.declutter ? path1B : undefined,
      "2": payload.options.virtualStage ? path2 : undefined
    },
    resultVersionId: finalPathVersion.versionId
  });
}

// handle "edit" pipeline
async function handleEditJob(payload: EditJobPayload) {
  const rec = readImageRecord(payload.imageId);
  if (!rec) {
    updateJob(payload.jobId, {
      status: "error",
      errorMessage: "image not found"
    });
    return;
  }

  const basePath = getVersionPath(rec, payload.baseVersionId);
  if (!basePath) {
    updateJob(payload.jobId, {
      status: "error",
      errorMessage: "base version not found"
    });
    return;
  }

  let restoreFromPath: string | undefined;
  if (payload.mode === "Restore") {
    // previous version in history before baseVersionId
    const idx = rec.history.findIndex(v => v.versionId === payload.baseVersionId);
    if (idx > 0) {
      restoreFromPath = rec.history[idx - 1]?.filePath;
    } else {
      restoreFromPath = basePath;
    }
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

  updateJob(payload.jobId, {
    status: "complete",
    resultVersionId: newVersion.versionId
  });
}

// BullMQ worker
const worker = new Worker(
  JOB_QUEUE_NAME,
  async (job: Job) => {
    const payload = job.data as AnyJobPayload;

    updateJob(payload.jobId, { status: "processing" });

    try {
      if (payload.type === "enhance") {
        await handleEnhanceJob(payload as any);
      } else if (payload.type === "edit") {
        await handleEditJob(payload as any);
      } else {
        updateJob(payload.jobId, {
          status: "error",
          errorMessage: "unknown job type"
        });
      }
    } catch (err: any) {
      console.error("[worker] job failed", err);
      updateJob(payload.jobId, {
        status: "error",
        errorMessage: err?.message || "unhandled worker error"
      });
    }
  },
  {
    connection: { url: REDIS_URL }
  }
);

worker.on("completed", job => {
  console.log(`[worker] completed job ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] failed job ${job?.id}`, err);
});
