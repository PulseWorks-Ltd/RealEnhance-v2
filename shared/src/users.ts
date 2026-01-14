// shared/src/users.ts
// User management with Redis storage and file fallback

import { getRedis } from "./redisClient.js";
import type { UserRecord, UserId } from "./types.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// File fallback path (same as old users.json)
const getUsersFilePath = (): string => {
  const cwd = process.cwd();
  const repoRoot = path.basename(cwd) === "server" ? path.resolve(cwd, "..") : cwd;
  const dataDir = process.env.DATA_DIR || path.resolve(repoRoot, "server", "data");
  return path.join(dataDir, "users.json");
};

type UsersFileState = Record<UserId, UserRecord>;

/**
 * Load users from file (fallback when Redis unavailable)
 */
function loadUsersFromFile(): UsersFileState {
  const filePath = getUsersFilePath();
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as UsersFileState;
  } catch (err) {
    console.error("[USERS] Failed to read users file:", err);
    return {};
  }
}

/**
 * Save users to file (fallback when Redis unavailable)
 */
function saveUsersToFile(state: UsersFileState): void {
  const filePath = getUsersFilePath();
  const dataDir = path.dirname(filePath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Check if Redis is available
 */
async function isRedisAvailable(): Promise<boolean> {
  try {
    const client = getRedis();
    await client.ping();
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Derive a human-friendly display name with legacy compatibility
 */
export function getDisplayName(user: Pick<UserRecord, "email" | "name" | "firstName" | "lastName">): string {
  const parts = [user.firstName?.trim(), user.lastName?.trim()].filter(Boolean);
  if (parts.length) return parts.join(" ");
  if (user.name && user.name.trim()) return user.name.trim();
  return user.email;
}

/**
 * Create a new user
 */
export async function createUser(params: {
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  authProvider?: "google" | "email" | "both";
  passwordHash?: string;
  googleId?: string;
  agencyId?: string;
  role?: "owner" | "admin" | "member";
}): Promise<UserRecord> {
  const userId = `user_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const legacyName = params.name?.trim();
  const combinedName = `${params.firstName?.trim() || ""} ${params.lastName?.trim() || ""}`.trim();
  const fallbackName = legacyName || combinedName || params.email;

  const user: UserRecord = {
    id: userId,
    email: params.email,
    name: fallbackName,
    firstName: params.firstName?.trim(),
    lastName: params.lastName?.trim(),
    authProvider: params.authProvider || "email",
    passwordHash: params.passwordHash,
    googleId: params.googleId,
    agencyId: params.agencyId,
    role: params.role,
    credits: 50, // Default starting credits
    imageIds: [],
    createdAt: now,
    updatedAt: now,
  };

  try {
    if (await isRedisAvailable()) {
      // Store in Redis
      const client = getRedis();
      const key = `user:${userId}`;

      await client.hSet(key, {
        id: user.id,
        email: user.email,
        name: user.name || "",
        firstName: user.firstName || "",
        lastName: user.lastName || "",
        authProvider: user.authProvider || "",
        passwordHash: user.passwordHash || "",
        agencyId: user.agencyId || "",
        role: user.role || "",
        credits: user.credits.toString(),
        imageIds: JSON.stringify(user.imageIds),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });

      // Create email index for lookups
      await client.set(`user:email:${user.email.toLowerCase()}`, userId);

      console.log(`[USERS] Created user ${userId} in Redis`);
    } else {
      // Fallback to file storage
      const state = loadUsersFromFile();
      state[userId] = user;
      saveUsersToFile(state);
      console.log(`[USERS] Created user ${userId} in file (Redis unavailable)`);
    }

    return user;
  } catch (err) {
    console.error("[USERS] Failed to create user:", err);
    throw new Error("Failed to create user");
  }
}

/**
 * Get user by ID
 */
export async function getUserById(userId: UserId): Promise<UserRecord | null> {
  try {
    if (await isRedisAvailable()) {
      // Load from Redis
      const client = getRedis();
      const key = `user:${userId}`;
      const data = await client.hGetAll(key);

      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      return {
        id: data.id,
        email: data.email,
        name: data.name,
        firstName: data.firstName || undefined,
        lastName: data.lastName || undefined,
        authProvider: (data.authProvider as "google" | "email" | "both") || undefined,
        passwordHash: data.passwordHash || undefined,
        googleId: data.googleId || undefined,
        agencyId: data.agencyId || undefined,
        role: (data.role as "owner" | "admin" | "member") || undefined,
        credits: parseInt(data.credits || "0", 10),
        imageIds: data.imageIds ? JSON.parse(data.imageIds) : [],
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    } else {
      // Fallback to file storage
      const state = loadUsersFromFile();
      return state[userId] || null;
    }
  } catch (err) {
    console.error("[USERS] Failed to get user by ID:", err);
    return null;
  }
}

/**
 * Get user by email
 */
export async function getUserByEmail(email: string): Promise<UserRecord | null> {
  try {
    if (await isRedisAvailable()) {
      // Load from Redis using email index
      const client = getRedis();
      const userId = await client.get(`user:email:${email.toLowerCase()}`);

      if (!userId) {
        return null;
      }

      return getUserById(userId);
    } else {
      // Fallback to file storage
      const state = loadUsersFromFile();
      return Object.values(state).find(u => u.email === email) || null;
    }
  } catch (err) {
    console.error("[USERS] Failed to get user by email:", err);
    return null;
  }
}

/**
 * Update user
 */
export async function updateUser(user: UserRecord): Promise<void> {
  try {
    user.updatedAt = new Date().toISOString();

    if (await isRedisAvailable()) {
      // Update in Redis
      const client = getRedis();
      const key = `user:${user.id}`;

      await client.hSet(key, {
        id: user.id,
        email: user.email,
        name: user.name || "",
        firstName: user.firstName || "",
        lastName: user.lastName || "",
        authProvider: user.authProvider || "",
        passwordHash: user.passwordHash || "",
        googleId: user.googleId || "",
        agencyId: user.agencyId || "",
        role: user.role || "",
        credits: user.credits.toString(),
        imageIds: JSON.stringify(user.imageIds),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      });

      // Update email index
      await client.set(`user:email:${user.email.toLowerCase()}`, user.id);

      console.log(`[USERS] Updated user ${user.id} in Redis`);
    } else {
      // Fallback to file storage
      const state = loadUsersFromFile();
      state[user.id] = user;
      saveUsersToFile(state);
      console.log(`[USERS] Updated user ${user.id} in file (Redis unavailable)`);
    }
  } catch (err) {
    console.error("[USERS] Failed to update user:", err);
    throw new Error("Failed to update user");
  }
}

/**
 * Upsert user from Google OAuth
 */
export async function upsertUserFromGoogle(params: {
  email: string;
  name: string;
  firstName?: string;
  lastName?: string;
  googleId?: string;
}): Promise<UserRecord> {
  let user = await getUserByEmail(params.email);

  if (!user) {
    // Create new user
    return createUser({
      email: params.email,
      name: params.name,
      firstName: params.firstName,
      lastName: params.lastName,
      authProvider: "google",
      googleId: params.googleId,
    });
  } else {
    // Update existing user
    user.name = params.name || user.name;
    user.firstName = params.firstName || user.firstName;
    user.lastName = params.lastName || user.lastName;
    user.googleId = params.googleId || user.googleId;

    // Update authProvider based on passwordHash presence
    if (user.passwordHash && user.authProvider === "email") {
      user.authProvider = "both";
    } else if (!user.passwordHash) {
      user.authProvider = "google";
    }

    await updateUser(user);
    return user;
  }
}

/**
 * Upsert user from email/password auth
 */
export async function upsertUserFromEmail(params: {
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  passwordHash: string;
}): Promise<UserRecord> {
  let user = await getUserByEmail(params.email);

  if (!user) {
    // Create new user
    return createUser({
      email: params.email,
      name: params.name,
      firstName: params.firstName,
      lastName: params.lastName,
      authProvider: "email",
      passwordHash: params.passwordHash,
    });
  } else {
    // Update existing user
    user.name = params.name || user.name;
    user.firstName = params.firstName || user.firstName;
    user.lastName = params.lastName || user.lastName;
    user.passwordHash = params.passwordHash;
    user.authProvider = "email";
    await updateUser(user);
    return user;
  }
}

/**
 * Delete user (for cleanup/testing)
 */
export async function deleteUser(userId: UserId): Promise<void> {
  try {
    if (await isRedisAvailable()) {
      // Delete from Redis
      const client = getRedis();

      // Get user first to remove email index
      const user = await getUserById(userId);
      if (user) {
        await client.del(`user:email:${user.email.toLowerCase()}`);
      }

      await client.del(`user:${userId}`);
      console.log(`[USERS] Deleted user ${userId} from Redis`);
    } else {
      // Delete from file
      const state = loadUsersFromFile();
      delete state[userId];
      saveUsersToFile(state);
      console.log(`[USERS] Deleted user ${userId} from file`);
    }
  } catch (err) {
    console.error("[USERS] Failed to delete user:", err);
    throw new Error("Failed to delete user");
  }
}

/**
 * Get all users (for admin/migration purposes)
 */
export async function getAllUsers(): Promise<UserRecord[]> {
  try {
    if (await isRedisAvailable()) {
      // Load all from Redis
      const client = getRedis();
      const keys = await client.keys("user:user_*");

      const users: UserRecord[] = [];
      for (const key of keys) {
        const userId = key.replace("user:", "");
        const user = await getUserById(userId);
        if (user) {
          users.push(user);
        }
      }

      return users;
    } else {
      // Load from file
      const state = loadUsersFromFile();
      return Object.values(state);
    }
  } catch (err) {
    console.error("[USERS] Failed to get all users:", err);
    return [];
  }
}
