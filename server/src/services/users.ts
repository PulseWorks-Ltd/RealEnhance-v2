import * as crypto from "node:crypto";
import type {
  UserRecord,
  UserId,
  ImageId
} from "../shared/types.js";
import { CREDITS_PER_IMAGE } from "../shared/constants.js";
import { CREDITS_ENABLED } from "../config.js";
import { readJsonFile, writeJsonFile } from "./jsonStore.js";

type UsersState = Record<UserId, UserRecord>;

function loadAll(): UsersState {
  return readJsonFile<UsersState>("users.json", {});
}

function saveAll(state: UsersState): void {
  writeJsonFile("users.json", state);
}

type UpsertGoogleParams = Readonly<{ email: string; name: string }>;

export function upsertUserFromGoogle(params: {
  email: string;
  name: string;
}): UserRecord {
  const state = loadAll();

  let found = Object.values(state).find(u => u.email === params.email);

  if (!found) {
    const id = "user_" + crypto.randomUUID();
    const now = new Date().toISOString();
    found = {
      id,
      email: params.email,
      name: params.name,
      credits: 50,
      imageIds: [],
      createdAt: now,
      updatedAt: now
  } as const as UserRecord;
    state[id] = found;
  } else {
    found.name = params.name || found.name;
    found.updatedAt = new Date().toISOString();
  }

  saveAll(state);
  return found;
}

/** Admin utility: set or create a user by email with a fixed credit balance */
export function setCreditsForEmail(email: string, credits: number, name?: string): UserRecord {
  const state = loadAll();
  let found = Object.values(state).find(u => u.email === email);
  const now = new Date().toISOString();
  if (!found) {
    const id = "user_" + (email.split("@")[0].replace(/[^a-z0-9_\-]/ig, "") || "anon");
    found = {
      id,
      email,
      name: name || email.split("@")[0],
      credits,
      imageIds: [],
      createdAt: now,
      updatedAt: now
    } as const as UserRecord;
    (state as any)[id] = found;
  } else {
    found.credits = credits;
    if (name) found.name = name;
    found.updatedAt = now;
  }
  saveAll(state);
  return found;
}

export function getUserById(userId: UserId): UserRecord | undefined {
  const state = loadAll();
  return state[userId];
}

export function addImageToUser(userId: UserId, imageId: ImageId): void {
  const state = loadAll();
  const u = state[userId];
  if (!u) return;

  if (!u.imageIds.includes(imageId)) {
    u.imageIds.push(imageId);
    u.updatedAt = new Date().toISOString();
    saveAll(state);
  }
}

export function getUserGallery(userId: string): ImageId[] {
  const u = getUserById(userId);
  return u?.imageIds ?? [];
}

export function getCredits(userId: UserId): number {
  return getUserById(userId)?.credits ?? 0;
}

export function consumeCredits(userId: string, count: number) {
  if (!CREDITS_ENABLED) return;
  const state = loadAll();
  const u = state[userId];
  if (!u) return;
  u.credits = Math.max(0, u.credits - count);
  u.updatedAt = new Date().toISOString();
  saveAll(state);
}

export function chargeForImages(userId: string, numImages: number) {
  if (!CREDITS_ENABLED) return;
  consumeCredits(userId, numImages * CREDITS_PER_IMAGE);
}
