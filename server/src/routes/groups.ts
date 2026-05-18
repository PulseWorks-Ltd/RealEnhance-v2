import { Router } from "express";
import { createStagingProfile, getRoomGroup, getStagingProfile, listRoomGroups, upsertRoomGroup } from "../services/groups.js";
import { enqueueEnhanceJob, getJob, updateJob } from "../services/jobs.js";
import {
  approveRoomConsistencyMaster,
  claimRoomConsistencySecondary,
  getRoomConsistencyGroup,
} from "../services/roomConsistencyStore.js";

function normalizeStageUrls(raw: Record<string, string | null | undefined> | null | undefined) {
  return {
    stage1A: raw?.stage1A ?? raw?.["1A"] ?? raw?.["1"] ?? null,
    stage1B: raw?.stage1B ?? raw?.["1B"] ?? raw?.["1b"] ?? null,
    stage2: raw?.stage2 ?? raw?.["2"] ?? null,
  };
}

function resolveRoomConsistencyStageUrls(parent: any): Record<string, string | null> {
  return normalizeStageUrls({
    ...((parent?.meta?.stageUrls || {}) as Record<string, string | null | undefined>),
    ...((parent?.stageUrls || {}) as Record<string, string | null | undefined>),
    ...((parent?.payload?.stageUrls || {}) as Record<string, string | null | undefined>),
  });
}

async function enqueueRoomConsistencyFollowupFromParent(params: {
  parentJobId: string;
  roomId: string;
  approvedMasterImageUrl: string;
}) {
  const parentJob = await getJob(params.parentJobId);
  if (!parentJob) return null;
  if (!parentJob.imageId) return null;

  const roomConsistency =
    parentJob?.roomConsistency ||
    parentJob?.meta?.roomConsistency ||
    parentJob?.payload?.options?.roomConsistencyV1 ||
    null;
  if (!roomConsistency?.enabled || roomConsistency?.viewRole !== "reference") {
    return null;
  }

  const stageUrls = resolveRoomConsistencyStageUrls(parentJob);
  const baselineStage = stageUrls.stage1B ? "1B" : stageUrls.stage1A ? "1A" : null;
  const baselineUrl = baselineStage === "1B" ? stageUrls.stage1B : baselineStage === "1A" ? stageUrls.stage1A : null;
  if (!baselineStage || !baselineUrl) {
    return null;
  }

  const payloadOptions = parentJob?.payload?.options || {};
  const approvedAt = new Date().toISOString();
  const followupRoomConsistency = {
    ...roomConsistency,
    primaryImageId: roomConsistency.primaryImageId || parentJob?.imageId || null,
    approvedMasterImageUrl: params.approvedMasterImageUrl,
    stage2BlockedUntilMasterApproval: false,
    processingState: "PROCESSING_STAGE2",
    internalFollowup: true,
    followupParentJobId: params.parentJobId,
    roomState: {
      ...(roomConsistency.roomState || {}),
      roomId: params.roomId,
      primaryImageId: roomConsistency.primaryImageId || parentJob?.imageId || null,
      primaryJobId: roomConsistency.primaryJobId || null,
      processingState: "PROCESSING_STAGE2",
      masterApproved: true,
      masterApprovalStatus: "approved",
      masterStagedImageUrl: params.approvedMasterImageUrl,
      masterApprovedAt: approvedAt,
    },
  };

  const enqueued = await enqueueEnhanceJob({
    userId: parentJob.userId,
    imageId: parentJob.imageId,
    agencyId: parentJob.agencyId || parentJob.payload?.agencyId || null,
    propertyId: parentJob.propertyId || parentJob.payload?.propertyId || null,
    clientBatchId: parentJob.clientBatchId || parentJob.payload?.clientBatchId || null,
    sourceStage: baselineStage,
    baselineStage,
    stageUrls,
    remoteOriginalUrl: parentJob.payload?.remoteOriginalUrl,
    remoteOriginalKey: parentJob.payload?.remoteOriginalKey,
    retryInfo: {
      retryType: "manual_retry",
      sourceStage: baselineStage,
      executionSourceStage: baselineStage,
      sourceUrl: baselineUrl,
      baselineStage,
      baselineUrl,
      requestedStages: ["2"],
      stagesToRun: ["2"],
      parentImageId: parentJob.imageId,
      galleryParentImageId: parentJob.payload?.galleryParentImageId || parentJob.imageId,
      parentJobId: params.parentJobId,
      clientBatchId: parentJob.clientBatchId || parentJob.payload?.clientBatchId || null,
    },
    options: {
      ...payloadOptions,
      virtualStage: true,
      stage2Only: true,
      roomConsistencyV1: followupRoomConsistency,
    },
    stage2OnlyMode: {
      enabled: true,
      baseStage: baselineStage,
      ...(baselineStage === "1B"
        ? {
            base1BUrl: baselineUrl,
            sourceStage: "1B-stage-ready" as const,
            stage1BMode: "stage-ready" as const,
          }
        : {
            base1AUrl: baselineUrl,
            sourceStage: "1A" as const,
          }),
    },
    executionPlan: {
      runStage1A: false,
      runStage1B: false,
      runStage2: true,
      stage2Baseline: baselineStage,
      baselineUrl,
      sourceStage: baselineStage,
    },
  });

  await claimRoomConsistencySecondary({
    roomId: params.roomId,
    imageId: parentJob.imageId,
    stage2JobId: enqueued.jobId,
  });

  const parentRoomConsistency = {
    ...followupRoomConsistency,
    latestStage2JobId: enqueued.jobId,
    stage2BlockedUntilMasterApproval: false,
    currentStatus: "processing_stage2",
  };

  await updateJob(params.parentJobId, {
    status: "processing",
    currentStage: "STAGE_2",
    blockedStage: null,
    fallbackStage: null,
    validationNote: null,
    retryLatestJobId: enqueued.jobId,
    roomConsistency: parentRoomConsistency,
    meta: {
      ...(parentJob?.meta || {}),
      roomConsistency: parentRoomConsistency,
    },
  }).catch(() => {});

  return {
    followupJobId: enqueued.jobId,
    imageId: parentJob.imageId,
    parentJobId: params.parentJobId,
  };
}

export function groupsRouter() {
  const r = Router();

  // Create or update a room group
  r.post("/room-groups", (req, res) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });
    try {
      const { id, batchId, roomType, label, imageIds, confirmedByUser, stagingProfileId } = req.body || {};
      const rec = upsertRoomGroup({ id, batchId, roomType, label, imageIds: imageIds || [], confirmedByUser: !!confirmedByUser, stagingProfileId });
      res.json({ ok: true, data: rec });
    } catch (e:any) {
      res.status(400).json({ ok: false, error: e?.message || "invalid" });
    }
  });

  r.get("/room-groups", (_req, res) => {
    res.json({ ok: true, data: listRoomGroups() });
  });

  // Create staging profile
  r.post("/staging-profiles", (req, res) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });
    try {
      const { roomGroupId, styleName, model, seed, prompt, negativePrompt, furniturePackId, palette } = req.body || {};
      const parsedSeed = seed === undefined || seed === null || seed === ""
        ? undefined
        : Number(seed);
      const rec = createStagingProfile({
        roomGroupId,
        styleName,
        model: model || "staging-v1",
        ...(parsedSeed !== undefined && Number.isFinite(parsedSeed) ? { seed: parsedSeed } : {}),
        prompt: String(prompt || ""),
        negativePrompt,
        furniturePackId,
        palette,
      });
      res.json({ ok: true, data: rec });
    } catch (e:any) {
      res.status(400).json({ ok: false, error: e?.message || "invalid" });
    }
  });

  r.get("/staging-profiles/:id", (req, res) => {
    const rec = getStagingProfile(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, data: rec });
  });

  r.post("/room-consistency/approve-master", async (req, res) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "not_authenticated" });

    try {
      const roomId = String(req.body?.roomId || "").trim();
      console.log("[room-consistency] approve request received", {
        roomGroupId: roomId || null,
      });
      if (!roomId) {
        return res.status(400).json({ ok: false, error: "room_id_required" });
      }

      const existingGroup = await getRoomConsistencyGroup(roomId);
      if (!existingGroup) {
        return res.status(404).json({ ok: false, error: "room_group_not_found" });
      }

      const masterJobId = String(req.body?.masterJobId || existingGroup.masterJobId || "").trim();
      const masterJob = masterJobId ? await getJob(masterJobId) : null;
      const resolvedMasterImageId = String(
        req.body?.masterImageId ||
        masterJob?.imageId ||
        existingGroup.approvedMasterImageId ||
        existingGroup.masterImageId ||
        ""
      ).trim();
      const approvedMasterImageUrl = String(
        req.body?.approvedMasterImageUrl ||
        masterJob?.retryLatestUrl ||
        masterJob?.latestRetryUrl ||
        masterJob?.stageUrls?.stage2 ||
        masterJob?.stageUrls?.["2"] ||
        masterJob?.finalOutputUrl ||
        masterJob?.resultUrl ||
        existingGroup.approvedMasterImageUrl ||
        ""
      ).trim();

      if (!approvedMasterImageUrl) {
        return res.status(400).json({ ok: false, error: "approved_master_image_required" });
      }

      const approvedGroup = await approveRoomConsistencyMaster({
        roomId,
        approvedMasterImageUrl,
        masterImageId: resolvedMasterImageId || existingGroup.masterImageId,
        masterJobId: masterJobId || existingGroup.masterJobId || null,
      });

      if (!approvedGroup) {
        return res.status(404).json({ ok: false, error: "room_group_not_found" });
      }

      if (masterJobId && masterJob) {
        console.log("[ROOM_CONSISTENCY_MASTER_RETRY_APPROVED]", {
          roomId,
          masterJobId,
          masterImageId: resolvedMasterImageId || existingGroup.masterImageId,
        });
        const masterRoomConsistency = {
          ...(masterJob?.roomConsistency || masterJob?.meta?.roomConsistency || masterJob?.payload?.options?.roomConsistencyV1 || {}),
          approvedMasterImageUrl,
          stage2BlockedUntilMasterApproval: false,
          processingState: "MASTER_APPROVED",
          roomState: {
            ...((masterJob?.roomConsistency || masterJob?.meta?.roomConsistency || masterJob?.payload?.options?.roomConsistencyV1 || {})?.roomState || {}),
            roomId,
            processingState: "MASTER_APPROVED",
            masterApproved: true,
            masterApprovalStatus: "approved",
            masterStagedImageUrl: approvedMasterImageUrl,
            masterApprovedAt: approvedGroup.masterApprovedAt || new Date().toISOString(),
          },
        };
        await updateJob(masterJobId, {
          roomConsistency: masterRoomConsistency,
          meta: {
            ...(masterJob?.meta || {}),
            roomConsistency: masterRoomConsistency,
          },
        }).catch(() => {});
      }

      const nextEntry = approvedGroup.images
        .filter((image) => image.viewRole === "reference" && !image.stage2Completed)
        .sort((left, right) => left.sequenceIndex - right.sequenceIndex)
        .find((image) => image.sequenceIndex === approvedGroup.nextSecondarySequenceIndex) || null;

      const started = nextEntry?.initialJobId
        ? await enqueueRoomConsistencyFollowupFromParent({
            parentJobId: nextEntry.initialJobId,
            roomId,
            approvedMasterImageUrl,
          })
        : null;

      console.log("[room-consistency] approve request processed", {
        roomGroupId: roomId,
        masterImageId: resolvedMasterImageId || existingGroup.masterImageId,
        releasedSecondaryJobs: started ? 1 : 0,
      });

      if (started) {
        console.log("[ROOM_CONSISTENCY_SECONDARY_RESUMED]", {
          roomId,
          parentJobId: started.parentJobId,
          followupJobId: started.followupJobId,
          imageId: started.imageId,
        });
      }

      return res.json({
        ok: true,
        roomId,
        approvedMasterImageUrl,
        started,
        group: approvedGroup,
      });
    } catch (e:any) {
      return res.status(400).json({ ok: false, error: e?.message || "invalid" });
    }
  });

  return r;
}
