import crypto from "node:crypto";
import {
  UserRecord,
  UserId,
  ImageId
} from "@realenhance/shared/dist/types.js";
import { CREDITS_PER_IMAGE } from "@realenhance/shared/dist/constants.js";
import { CREDITS_ENABLED } from "../config.js";
import { readJsonFile, writeJsonFile } from "./jsonStore.js";

type UsersState = Record<UserId, UserRecord>;

function loadAll(): UsersState {
  return readJsonFile<UsersState>("users.json", {});
}

function saveAll(state: UsersState) {
  writeJsonFile("users.json", state);
}

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
    };
    state[id] = found;
  } else {
    found.name = params.name || found.name;
    found.updatedAt = new Date().toISOString();
  }

  saveAll(state);
  return found;
}

export function getUserById(userId: string): UserRecord | undefined {
  const state = loadAll();
  return state[userId];
}

export function addImageToUser(userId: string, imageId: ImageId) {
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

export function getCredits(userId: string): number {
  const u = getUserById(userId);
  return u?.credits ?? 0;
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
