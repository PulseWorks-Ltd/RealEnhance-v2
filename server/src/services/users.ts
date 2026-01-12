// server/src/services/users.ts
// User management - delegates to shared Redis storage

import type { UserRecord, UserId, ImageId } from "../shared/types.js";
import {
  createUser,
  getUserById as getUser,
  getUserByEmail as getUserByEmailShared,
  updateUser as updateUserShared,
  upsertUserFromGoogle as upsertGoogleShared,
  upsertUserFromEmail as upsertEmailShared,
} from "@realenhance/shared/users.js";

/**
 * Upsert user from Google OAuth
 */
export function upsertUserFromGoogle(params: {
  email: string;
  name: string;
  firstName?: string;
  lastName?: string;
}): Promise<UserRecord> {
  return upsertGoogleShared(params);
}

/**
 * Create user with email/password
 */
export async function createUserWithPassword(params: {
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  passwordHash: string;
  agencyId?: string | null;
  role?: "owner" | "admin" | "member";
}): Promise<UserRecord> {
  // Check if user already exists
  const existing = await getUserByEmailShared(params.email);
  if (existing) {
    throw new Error("User with this email already exists");
  }

  return createUser({
    email: params.email,
    name: params.name,
    firstName: params.firstName,
    lastName: params.lastName,
    authProvider: "email",
    passwordHash: params.passwordHash,
    agencyId: params.agencyId || undefined,
    role: params.role || "member",
  });
}

/**
 * Get user by email
 */
export async function getUserByEmail(email: string): Promise<UserRecord | undefined> {
  const user = await getUserByEmailShared(email);
  return user || undefined;
}

/**
 * Get user by ID
 */
export async function getUserById(userId: UserId): Promise<UserRecord | undefined> {
  const user = await getUser(userId);
  return user || undefined;
}

/**
 * Admin utility: set or create a user by email with a fixed credit balance
 */
export async function setCreditsForEmail(
  email: string,
  credits: number,
  name?: string
): Promise<UserRecord> {
  let user = await getUserByEmailShared(email);

  if (!user) {
    // Create new user with specified credits
    const id = "user_" + (email.split("@")[0].replace(/[^a-z0-9_\-]/gi, "") || "anon");
    user = await createUser({
      email,
      name: name || email.split("@")[0],
      authProvider: "email",
    });
    user.credits = credits;
    await updateUserShared(user);
  } else {
    // Update existing user
    user.credits = credits;
    if (name) user.name = name;
    await updateUserShared(user);
  }

  return user;
}

/**
 * Update user fields
 */
export async function updateUser(userId: UserId, updates: Partial<UserRecord>): Promise<UserRecord> {
  const user = await getUser(userId);
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  // Apply updates
  Object.assign(user, updates);
  await updateUserShared(user);
  return user;
}

/**
 * Add image to user's gallery
 */
export async function addImageToUser(userId: UserId, imageId: ImageId): Promise<void> {
  const user = await getUser(userId);
  if (!user) return;

  if (!user.imageIds.includes(imageId)) {
    user.imageIds.push(imageId);
    await updateUserShared(user);
  }
}

/**
 * Get user's image gallery
 */
export async function getUserGallery(userId: string): Promise<ImageId[]> {
  const user = await getUser(userId);
  return user?.imageIds ?? [];
}

// DEPRECATED: Credits are no longer enforced, kept for backward compatibility
export async function getCredits(userId: UserId): Promise<number> {
  const user = await getUser(userId);
  return user?.credits ?? 0;
}

// DEPRECATED: No-op - credits no longer deducted
export function consumeCredits(userId: string, count: number) {
  // No-op: Credits are deprecated, execution is always allowed
  console.log(
    `[DEPRECATED] consumeCredits called for user ${userId}, count ${count} - ignoring (credits disabled)`
  );
}

// DEPRECATED: No-op - credits no longer charged
export function chargeForImages(userId: string, numImages: number) {
  // No-op: Credits are deprecated, execution is always allowed
  console.log(
    `[DEPRECATED] chargeForImages called for user ${userId}, images ${numImages} - ignoring (credits disabled)`
  );
}
