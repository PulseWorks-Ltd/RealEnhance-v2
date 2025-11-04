import { readJsonFile, writeJsonFile } from "./jsonStore.js";
import { randomUUID } from "node:crypto";

export type RoomGroupId = string;
export type StagingProfileId = string;

export interface RoomGroup {
  id: RoomGroupId;
  batchId?: string;
  roomType: string;
  label: string;
  imageIds: string[];
  confirmedByUser: boolean;
  stagingProfileId?: StagingProfileId;
  createdAt: string;
  updatedAt: string;
}

export interface StagingProfile {
  id: StagingProfileId;
  roomGroupId: RoomGroupId;
  styleName: string;
  model: "staging-v1";
  seed: number;
  prompt: string;
  negativePrompt?: string;
  furniturePackId?: string;
  palette?: string[];
  createdAt: string;
  updatedAt: string;
}

type GroupsState = Record<RoomGroupId, RoomGroup>;
type ProfilesState = Record<StagingProfileId, StagingProfile>;

function loadGroups(): GroupsState {
  return readJsonFile<GroupsState>("roomGroups.json", {});
}
function saveGroups(s: GroupsState) {
  writeJsonFile("roomGroups.json", s);
}
function loadProfiles(): ProfilesState {
  return readJsonFile<ProfilesState>("stagingProfiles.json", {});
}
function saveProfiles(s: ProfilesState) {
  writeJsonFile("stagingProfiles.json", s);
}

export function upsertRoomGroup(partial: Partial<RoomGroup> & Pick<RoomGroup, "label"|"roomType"|"imageIds"|"confirmedByUser">): RoomGroup {
  const all = loadGroups();
  const id = partial.id ?? ("rg_" + randomUUID());
  const now = new Date().toISOString();
  const existing = all[id];
  const rec: RoomGroup = {
    id,
    batchId: partial.batchId ?? existing?.batchId,
    roomType: partial.roomType,
    label: partial.label,
    imageIds: partial.imageIds,
    confirmedByUser: !!partial.confirmedByUser,
    stagingProfileId: partial.stagingProfileId ?? existing?.stagingProfileId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  all[id] = rec;
  saveGroups(all);
  return rec;
}

export function listRoomGroups(): RoomGroup[] {
  const all = loadGroups();
  return Object.values(all);
}

export function getRoomGroup(id: RoomGroupId): RoomGroup | undefined {
  const all = loadGroups();
  return all[id];
}

export function createStagingProfile(input: Omit<StagingProfile, "id"|"createdAt"|"updatedAt">): StagingProfile {
  const all = loadProfiles();
  const id = "sp_" + randomUUID();
  const now = new Date().toISOString();
  const rec: StagingProfile = { id, ...input, createdAt: now, updatedAt: now };
  all[id] = rec;
  saveProfiles(all);

  // back-link to group
  const groups = loadGroups();
  const g = groups[input.roomGroupId];
  if (g) {
    groups[input.roomGroupId] = { ...g, stagingProfileId: id, updatedAt: now };
    saveGroups(groups);
  }
  return rec;
}

export function getStagingProfile(id: StagingProfileId): StagingProfile | undefined {
  const all = loadProfiles();
  return all[id];
}
