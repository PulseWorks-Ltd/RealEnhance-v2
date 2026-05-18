import { createClient } from "redis";
import type {
  RoomConsistencyContextV1,
  RoomConsistencyGroupStateV1,
  RoomConsistencyImageEntryV1,
} from "../shared/types.js";

const REDIS_URL = process.env.REDIS_PRIVATE_URL || process.env.REDIS_URL || "redis://localhost:6379";
const redisClient = createClient({ url: REDIS_URL });
redisClient.connect().catch(() => {});

const ROOM_KEY_PREFIX = "roomconsistency:v1:room:";
const IMAGE_KEY_PREFIX = "roomconsistency:v1:image:";

function roomKey(roomId: string): string {
  return `${ROOM_KEY_PREFIX}${roomId}`;
}

function imageKey(imageId: string): string {
  return `${IMAGE_KEY_PREFIX}${imageId}`;
}

export function resolveContinuityGroupStatus(group: RoomConsistencyGroupStateV1): RoomConsistencyGroupStateV1["continuityGroupStatus"] {
  const incompleteSecondaryExists = group.images.some(
    (image) => image.viewRole === "reference" && image.stage2Completed !== true,
  );
  if (group.masterApprovalStatus === "approved") {
    return incompleteSecondaryExists ? "processing_secondaries" : "completed";
  }
  if (group.masterApprovalStatus === "ready") {
    return "master_ready";
  }
  return "pending_master";
}

export function applyRoomConsistencyMasterReady(params: {
  group: RoomConsistencyGroupStateV1;
  masterImageId: string;
  masterJobId?: string | null;
  stagedImageUrl: string;
  now?: string;
}): RoomConsistencyGroupStateV1 {
  const readyAt = params.now || new Date().toISOString();
  const nextGroup: RoomConsistencyGroupStateV1 = {
    ...params.group,
    masterImageId: params.masterImageId,
    masterJobId: params.masterJobId ?? params.group.masterJobId ?? null,
    masterApprovalStatus: "ready",
    pendingMasterApproval: true,
    masterReadyAt: readyAt,
    approvedMasterImageUrl: params.stagedImageUrl,
    approvedMasterImageId: params.masterImageId,
    approvedMasterAttempt: params.masterJobId ?? params.group.masterJobId ?? null,
    updatedAt: readyAt,
    images: params.group.images.map((image) => ({ ...image })),
    continuityGroupStatus: params.group.continuityGroupStatus,
  };
  nextGroup.continuityGroupStatus = resolveContinuityGroupStatus(nextGroup);
  return nextGroup;
}

export function applyRoomConsistencyMasterApproval(params: {
  group: RoomConsistencyGroupStateV1;
  approvedMasterImageUrl: string;
  masterImageId?: string | null;
  masterJobId?: string | null;
  now?: string;
}): RoomConsistencyGroupStateV1 {
  const approvedAt = params.now || new Date().toISOString();
  const nextGroup: RoomConsistencyGroupStateV1 = {
    ...params.group,
    masterImageId: params.masterImageId || params.group.masterImageId,
    masterJobId: params.masterJobId || params.group.masterJobId || null,
    masterApprovalStatus: "approved",
    pendingMasterApproval: false,
    masterApprovedAt: approvedAt,
    approvedMasterImageUrl: params.approvedMasterImageUrl,
    approvedMasterImageId: params.masterImageId ?? params.group.masterImageId,
    approvedMasterAttempt: params.masterJobId ?? params.group.masterJobId ?? null,
    updatedAt: approvedAt,
    images: params.group.images.map((image) =>
      image.viewRole === "reference"
        ? {
            ...image,
            waitingForApproval: false,
            latestApprovedMasterJobId: params.masterJobId ?? params.group.masterJobId ?? null,
          }
        : { ...image },
    ),
    continuityGroupStatus: params.group.continuityGroupStatus,
  };
  nextGroup.continuityGroupStatus = resolveContinuityGroupStatus(nextGroup);
  return nextGroup;
}

export function applyRoomConsistencySecondaryClaim(params: {
  group: RoomConsistencyGroupStateV1;
  imageId: string;
  stage2JobId: string;
  now?: string;
}): RoomConsistencyGroupStateV1 {
  const claimedAt = params.now || new Date().toISOString();
  const nextGroup: RoomConsistencyGroupStateV1 = {
    ...params.group,
    activeSecondaryImageId: params.imageId,
    updatedAt: claimedAt,
    images: params.group.images.map((image) =>
      image.imageId === params.imageId
        ? {
            ...image,
            stage2Released: true,
            latestStage2JobId: params.stage2JobId,
            waitingForApproval: false,
          }
        : { ...image },
    ),
    continuityGroupStatus: params.group.continuityGroupStatus,
  };
  nextGroup.continuityGroupStatus = resolveContinuityGroupStatus(nextGroup);
  return nextGroup;
}

export function applyRoomConsistencySecondaryCompletion(params: {
  group: RoomConsistencyGroupStateV1;
  imageId: string;
  now?: string;
}): RoomConsistencyGroupStateV1 {
  const completedAt = params.now || new Date().toISOString();
  const nextImages = params.group.images.map((image) =>
    image.imageId === params.imageId
      ? {
          ...image,
          stage2Completed: true,
          waitingForApproval: false,
        }
      : { ...image },
  );
  const remaining = nextImages
    .filter((image) => image.viewRole === "reference" && !image.stage2Completed)
    .sort((left, right) => left.sequenceIndex - right.sequenceIndex);
  const nextGroup: RoomConsistencyGroupStateV1 = {
    ...params.group,
    activeSecondaryImageId: null,
    nextSecondarySequenceIndex: remaining[0]?.sequenceIndex ?? Number.MAX_SAFE_INTEGER,
    updatedAt: completedAt,
    images: nextImages,
    continuityGroupStatus: params.group.continuityGroupStatus,
  };
  nextGroup.continuityGroupStatus = resolveContinuityGroupStatus(nextGroup);
  return nextGroup;
}

export async function getRoomConsistencyGroup(roomId: string): Promise<RoomConsistencyGroupStateV1 | null> {
  const normalizedRoomId = String(roomId || "").trim();
  if (!normalizedRoomId) return null;
  try {
    const raw = await redisClient.get(roomKey(normalizedRoomId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function getRoomIdForImage(imageId: string): Promise<string | null> {
  const normalizedImageId = String(imageId || "").trim();
  if (!normalizedImageId) return null;
  try {
    return (await redisClient.get(imageKey(normalizedImageId))) || null;
  } catch {
    return null;
  }
}

async function persistRoomGroup(group: RoomConsistencyGroupStateV1): Promise<void> {
  await redisClient.set(roomKey(group.roomId), JSON.stringify(group));
  for (const image of group.images) {
    await redisClient.set(imageKey(image.imageId), group.roomId);
  }
}

export async function upsertRoomConsistencyGroup(input: {
  roomId: string;
  clientBatchId?: string | null;
  masterImageId: string;
  masterJobId?: string | null;
  images: RoomConsistencyImageEntryV1[];
}): Promise<RoomConsistencyGroupStateV1> {
  const normalizedRoomId = String(input.roomId || "").trim();
  if (!normalizedRoomId) {
    throw new Error("roomId_required");
  }

  const now = new Date().toISOString();
  const existing = await getRoomConsistencyGroup(normalizedRoomId);
  const mergedImages = new Map<string, RoomConsistencyImageEntryV1>();
  for (const image of existing?.images || []) {
    mergedImages.set(image.imageId, image);
  }
  for (const image of input.images) {
    mergedImages.set(image.imageId, {
      ...(mergedImages.get(image.imageId) || {}),
      ...image,
    });
  }

  const secondaries = Array.from(mergedImages.values())
    .filter((image) => image.viewRole === "reference")
    .sort((left, right) => left.sequenceIndex - right.sequenceIndex);

  const group: RoomConsistencyGroupStateV1 = {
    roomId: normalizedRoomId,
    clientBatchId: input.clientBatchId ?? existing?.clientBatchId ?? null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    masterImageId: input.masterImageId || existing?.masterImageId || "",
    masterJobId: input.masterJobId ?? existing?.masterJobId ?? null,
    masterApprovalStatus: existing?.masterApprovalStatus || "pending",
    pendingMasterApproval: existing?.pendingMasterApproval ?? true,
    masterReadyAt: existing?.masterReadyAt ?? null,
    masterApprovedAt: existing?.masterApprovedAt ?? null,
    approvedMasterImageUrl: existing?.approvedMasterImageUrl ?? null,
    approvedMasterImageId: existing?.approvedMasterImageId ?? null,
    approvedMasterAttempt: existing?.approvedMasterAttempt ?? null,
    images: [
      ...Array.from(mergedImages.values()).sort((left, right) => left.sequenceIndex - right.sequenceIndex),
    ],
    nextSecondarySequenceIndex:
      existing?.nextSecondarySequenceIndex ??
      (secondaries[0]?.sequenceIndex ?? 1),
    activeSecondaryImageId: existing?.activeSecondaryImageId ?? null,
    continuityGroupStatus: existing?.continuityGroupStatus ?? "pending_master",
  };

  group.continuityGroupStatus = resolveContinuityGroupStatus(group);

  await persistRoomGroup(group);
  return group;
}

export async function markRoomConsistencyMasterReady(input: {
  roomId: string;
  masterImageId: string;
  masterJobId?: string | null;
  stagedImageUrl: string;
}): Promise<RoomConsistencyGroupStateV1 | null> {
  const group = await getRoomConsistencyGroup(input.roomId);
  if (!group) return null;
  const nextGroup = applyRoomConsistencyMasterReady({
    group,
    masterImageId: input.masterImageId,
    masterJobId: input.masterJobId,
    stagedImageUrl: input.stagedImageUrl,
  });
  await persistRoomGroup(nextGroup);
  return nextGroup;
}

export async function approveRoomConsistencyMaster(input: {
  roomId: string;
  approvedMasterImageUrl: string;
  masterImageId?: string | null;
  masterJobId?: string | null;
}): Promise<RoomConsistencyGroupStateV1 | null> {
  const group = await getRoomConsistencyGroup(input.roomId);
  if (!group) return null;
  const nextGroup = applyRoomConsistencyMasterApproval({
    group,
    approvedMasterImageUrl: input.approvedMasterImageUrl,
    masterImageId: input.masterImageId,
    masterJobId: input.masterJobId,
  });
  await persistRoomGroup(nextGroup);
  return nextGroup;
}

export async function markRoomConsistencyImageWaiting(input: {
  roomId: string;
  imageId: string;
}): Promise<RoomConsistencyGroupStateV1 | null> {
  const group = await getRoomConsistencyGroup(input.roomId);
  if (!group) return null;
  const entry = group.images.find((image) => image.imageId === input.imageId);
  if (!entry) return group;
  entry.waitingForApproval = true;
  group.pendingMasterApproval = true;
  group.updatedAt = new Date().toISOString();
  group.continuityGroupStatus = resolveContinuityGroupStatus(group);
  await persistRoomGroup(group);
  return group;
}

export async function canReleaseRoomConsistencyStage2(input: {
  roomId: string;
  imageId: string;
}): Promise<{
  allowed: boolean;
  reason?: string;
  group: RoomConsistencyGroupStateV1 | null;
  entry: RoomConsistencyImageEntryV1 | null;
}> {
  const group = await getRoomConsistencyGroup(input.roomId);
  if (!group) {
    return { allowed: false, reason: "group_not_found", group: null, entry: null };
  }
  const entry = group.images.find((image) => image.imageId === input.imageId) || null;
  if (!entry) {
    return { allowed: false, reason: "image_not_in_group", group, entry: null };
  }
  if (entry.viewRole === "primary") {
    return { allowed: true, group, entry };
  }
  if (group.masterApprovalStatus !== "approved" || !group.approvedMasterImageUrl) {
    return { allowed: false, reason: "awaiting_master_approval", group, entry };
  }
  if (entry.stage2Completed) {
    return { allowed: false, reason: "already_completed", group, entry };
  }
  if (group.activeSecondaryImageId && group.activeSecondaryImageId !== entry.imageId) {
    return { allowed: false, reason: "secondary_in_progress", group, entry };
  }
  if (entry.sequenceIndex !== group.nextSecondarySequenceIndex) {
    return { allowed: false, reason: "awaiting_turn", group, entry };
  }
  return { allowed: true, group, entry };
}

export async function claimRoomConsistencySecondary(input: {
  roomId: string;
  imageId: string;
  stage2JobId: string;
}): Promise<RoomConsistencyGroupStateV1 | null> {
  const group = await getRoomConsistencyGroup(input.roomId);
  if (!group) return null;
  const entry = group.images.find((image) => image.imageId === input.imageId);
  if (!entry) return group;
  const nextGroup = applyRoomConsistencySecondaryClaim({
    group,
    imageId: input.imageId,
    stage2JobId: input.stage2JobId,
  });
  await persistRoomGroup(nextGroup);
  return nextGroup;
}

export async function completeRoomConsistencySecondary(input: {
  roomId: string;
  imageId: string;
}): Promise<RoomConsistencyGroupStateV1 | null> {
  const group = await getRoomConsistencyGroup(input.roomId);
  if (!group) return null;
  const entry = group.images.find((image) => image.imageId === input.imageId);
  if (!entry) return group;
  const nextGroup = applyRoomConsistencySecondaryCompletion({
    group,
    imageId: input.imageId,
  });
  await persistRoomGroup(nextGroup);
  return nextGroup;
}

export function buildRoomConsistencyContext(params: {
  roomId: string;
  clientBatchId?: string | null;
  viewRole: "primary" | "reference";
  primaryImageId?: string | null;
  primaryJobId?: string | null;
  groupSize: number;
  sequenceIndex: number;
  primarySelection: {
    method: "auto" | "manual";
    score: number;
    reasons: string[];
  };
  roomState?: RoomConsistencyContextV1["roomState"];
}): RoomConsistencyContextV1 {
  return {
    enabled: true,
    roomId: params.roomId,
    clientBatchId: params.clientBatchId ?? undefined,
    viewRole: params.viewRole,
    primaryImageId: params.primaryImageId ?? null,
    primaryJobId: params.primaryJobId ?? null,
    groupSize: params.groupSize,
    sequenceIndex: params.sequenceIndex,
    stage2BlockedUntilMasterApproval: params.viewRole === "reference",
    processingState: params.viewRole === "reference" ? "WAITING_FOR_MASTER_APPROVAL" : undefined,
    primarySelection: params.primarySelection,
    roomState: params.roomState,
  };
}