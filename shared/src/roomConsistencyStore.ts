import { createClient } from "redis";
import type {
  RoomConsistencyContextV1,
  RoomConsistencyGroupStateV1,
  RoomConsistencyImageEntryV1,
} from "./types.js";

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
    masterReadyAt: existing?.masterReadyAt ?? null,
    masterApprovedAt: existing?.masterApprovedAt ?? null,
    approvedMasterImageUrl: existing?.approvedMasterImageUrl ?? null,
    images: [
      ...Array.from(mergedImages.values()).sort((left, right) => left.sequenceIndex - right.sequenceIndex),
    ],
    nextSecondarySequenceIndex:
      existing?.nextSecondarySequenceIndex ??
      (secondaries[0]?.sequenceIndex ?? 1),
    activeSecondaryImageId: existing?.activeSecondaryImageId ?? null,
  };

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
  group.masterImageId = input.masterImageId;
  group.masterJobId = input.masterJobId ?? group.masterJobId ?? null;
  group.masterApprovalStatus = "ready";
  group.masterReadyAt = new Date().toISOString();
  group.approvedMasterImageUrl = input.stagedImageUrl;
  group.updatedAt = group.masterReadyAt;
  await persistRoomGroup(group);
  return group;
}

export async function approveRoomConsistencyMaster(input: {
  roomId: string;
  approvedMasterImageUrl: string;
  masterImageId?: string | null;
  masterJobId?: string | null;
}): Promise<RoomConsistencyGroupStateV1 | null> {
  const group = await getRoomConsistencyGroup(input.roomId);
  if (!group) return null;
  const approvedAt = new Date().toISOString();
  if (input.masterImageId) group.masterImageId = input.masterImageId;
  if (input.masterJobId) group.masterJobId = input.masterJobId;
  group.masterApprovalStatus = "approved";
  group.masterApprovedAt = approvedAt;
  group.approvedMasterImageUrl = input.approvedMasterImageUrl;
  group.updatedAt = approvedAt;
  for (const image of group.images) {
    if (image.viewRole === "reference") {
      image.waitingForApproval = false;
    }
  }
  await persistRoomGroup(group);
  return group;
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
  group.updatedAt = new Date().toISOString();
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
  entry.stage2Released = true;
  entry.latestStage2JobId = input.stage2JobId;
  group.activeSecondaryImageId = input.imageId;
  group.updatedAt = new Date().toISOString();
  await persistRoomGroup(group);
  return group;
}

export async function completeRoomConsistencySecondary(input: {
  roomId: string;
  imageId: string;
}): Promise<RoomConsistencyGroupStateV1 | null> {
  const group = await getRoomConsistencyGroup(input.roomId);
  if (!group) return null;
  const entry = group.images.find((image) => image.imageId === input.imageId);
  if (!entry) return group;
  entry.stage2Completed = true;
  entry.waitingForApproval = false;
  group.activeSecondaryImageId = null;
  const remaining = group.images
    .filter((image) => image.viewRole === "reference" && !image.stage2Completed)
    .sort((left, right) => left.sequenceIndex - right.sequenceIndex);
  group.nextSecondarySequenceIndex = remaining[0]?.sequenceIndex ?? Number.MAX_SAFE_INTEGER;
  group.updatedAt = new Date().toISOString();
  await persistRoomGroup(group);
  return group;
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
    primarySelection: params.primarySelection,
    roomState: params.roomState,
  };
}