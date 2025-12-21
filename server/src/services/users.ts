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
      authProvider: "google",
      passwordHash: undefined,
      credits: 50,
      imageIds: [],
      createdAt: now,
      updatedAt: now
  } as const as UserRecord;
    state[id] = found;
  } else {
    found.name = params.name || found.name;
    found.updatedAt = new Date().toISOString();
    // Link Google account if user originally signed up with email
    if (!found.authProvider || found.authProvider === "email") {
      // Keep authProvider as email if they have a password
      if (!found.passwordHash) {
        found.authProvider = "google";
      }
    }
  }

  saveAll(state);
  return found;
}

export function createUserWithPassword(params: {
  email: string;
  name: string;
  passwordHash: string;
}): UserRecord {
  const state = loadAll();

  // Check if user already exists
  const existing = Object.values(state).find(u => u.email === params.email);
  if (existing) {
    throw new Error("User with this email already exists");
  }

  const id = "user_" + crypto.randomUUID();
  const now = new Date().toISOString();
  const newUser: UserRecord = {
    id,
    email: params.email,
    name: params.name,
    authProvider: "email",
    passwordHash: params.passwordHash,
    credits: 50,
    imageIds: [],
    createdAt: now,
    updatedAt: now
  };

  state[id] = newUser;
  saveAll(state);
  return newUser;
}

export function getUserByEmail(email: string): UserRecord | undefined {
  const state = loadAll();
  return Object.values(state).find(u => u.email === email);
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
      authProvider: "email",
      passwordHash: undefined,
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

// DEPRECATED: Credits are no longer enforced, kept for backward compatibility
export function getCredits(userId: UserId): number {
  return getUserById(userId)?.credits ?? 0;
}

// DEPRECATED: No-op - credits no longer deducted
export function consumeCredits(userId: string, count: number) {
  // No-op: Credits are deprecated, execution is always allowed
  console.log(`[DEPRECATED] consumeCredits called for user ${userId}, count ${count} - ignoring (credits disabled)`);
}

// DEPRECATED: No-op - credits no longer charged
export function chargeForImages(userId: string, numImages: number) {
  // No-op: Credits are deprecated, execution is always allowed
  console.log(`[DEPRECATED] chargeForImages called for user ${userId}, images ${numImages} - ignoring (credits disabled)`);
}
