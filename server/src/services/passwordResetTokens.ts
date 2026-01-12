import crypto from "node:crypto";
import { getRedis } from "@realenhance/shared/redisClient.js";
import { readJsonFile, writeJsonFile } from "./jsonStore.js";

const TOKEN_FILE = "resetTokens.json";
const TOKEN_SALT = process.env.RESET_TOKEN_SALT || process.env.SESSION_SECRET || "reset_salt";
const DEFAULT_TTL_MINUTES = Number(process.env.RESET_TOKEN_TTL_MINUTES || 30);

interface TokenRecord {
  tokenHash: string;
  userId: string;
  email: string;
  expiresAt: string;
  createdAt: string;
}

interface TokenFileState {
  tokens: Record<string, TokenRecord>;
}

const inMemoryRates: Map<string, { count: number; expiresAt: number }> = new Map();

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw + TOKEN_SALT).digest("hex");
}

function ttlMs(): number {
  return DEFAULT_TTL_MINUTES * 60 * 1000;
}

async function getRedisIfAvailable() {
  try {
    const client = getRedis();
    // ping may not exist on mock; guard
    // @ts-ignore
    if (typeof client.ping === "function") await client.ping();
    return client;
  } catch (err) {
    return null;
  }
}

function loadFile(): TokenFileState {
  return readJsonFile<TokenFileState>(TOKEN_FILE, { tokens: {} });
}

function saveFile(state: TokenFileState) {
  writeJsonFile(TOKEN_FILE, state);
}

function cleanupFile(state: TokenFileState) {
  const now = Date.now();
  for (const [hash, rec] of Object.entries(state.tokens)) {
    if (new Date(rec.expiresAt).getTime() <= now) {
      delete state.tokens[hash];
    }
  }
}

export async function createResetToken(userId: string, email: string): Promise<{ token: string; expiresAt: string }> {
  const raw = crypto.randomBytes(32).toString("base64url");
  const hashed = hashToken(raw);
  const expiresAt = new Date(Date.now() + ttlMs()).toISOString();
  const createdAt = new Date().toISOString();
  const record: TokenRecord = { tokenHash: hashed, userId, email, expiresAt, createdAt };

  const redis = await getRedisIfAvailable();
  if (redis) {
    try {
      const key = `reset:token:${hashed}`;
      const payload = JSON.stringify(record);
      // @ts-ignore - mock client may not have setEx
      if (typeof (redis as any).setEx === "function") {
        await (redis as any).setEx(key, Math.ceil(ttlMs() / 1000), payload);
      } else {
        await redis.set(key, payload);
        // @ts-ignore
        if (typeof redis.expire === "function") await redis.expire(key, Math.ceil(ttlMs() / 1000));
      }
      return { token: raw, expiresAt };
    } catch (err) {
      console.error("[reset-token] redis store failed, falling back to file", err);
    }
  }

  const state = loadFile();
  state.tokens[hashed] = record;
  cleanupFile(state);
  saveFile(state);
  return { token: raw, expiresAt };
}

export async function consumeResetToken(rawToken: string): Promise<{ userId: string; email: string } | null> {
  const hashed = hashToken(rawToken);
  const now = Date.now();

  const redis = await getRedisIfAvailable();
  if (redis) {
    try {
      const key = `reset:token:${hashed}`;
      const raw = await redis.get(key);
      if (raw) {
        await redis.del(key);
        const rec = JSON.parse(raw) as TokenRecord;
        if (new Date(rec.expiresAt).getTime() > now) {
          return { userId: rec.userId, email: rec.email };
        }
      }
    } catch (err) {
      console.error("[reset-token] redis consume failed, trying file", err);
    }
  }

  const state = loadFile();
  const rec = state.tokens[hashed];
  if (!rec) return null;
  delete state.tokens[hashed];
  cleanupFile(state);
  saveFile(state);
  if (new Date(rec.expiresAt).getTime() <= now) return null;
  return { userId: rec.userId, email: rec.email };
}

// ---------------- Rate Limiting ----------------

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function memoryIncrement(key: string, ttlSeconds: number): number {
  const existing = inMemoryRates.get(key);
  const now = Date.now();
  if (!existing || existing.expiresAt <= now) {
    const expiresAt = now + ttlSeconds * 1000;
    inMemoryRates.set(key, { count: 1, expiresAt });
    return 1;
  }
  existing.count += 1;
  return existing.count;
}

async function incrementWithRedis(key: string, ttlSeconds: number): Promise<number | null> {
  const redis = await getRedisIfAvailable();
  if (!redis) return null;
  try {
    const currentRaw = await redis.get(key);
    const current = currentRaw ? Number(currentRaw) : 0;
    const next = current + 1;
    await redis.set(key, String(next));
    // @ts-ignore
    if (typeof redis.expire === "function") await redis.expire(key, ttlSeconds);
    return next;
  } catch (err) {
    console.error(`[reset-rate] redis increment failed for ${key}:`, err);
    return null;
  }
}

async function incrementCounter(key: string, ttlSeconds: number): Promise<number> {
  const viaRedis = await incrementWithRedis(key, ttlSeconds);
  if (viaRedis !== null) return viaRedis;
  return memoryIncrement(key, ttlSeconds);
}

export type ResetThrottleResult = {
  allowed: boolean;
  emailKeyCount: number;
  ipKeyCount: number;
};

export async function checkResetThrottle(email: string, ip: string | undefined): Promise<ResetThrottleResult> {
  const emailHourKey = `reset:rate:email:${email}:h`;
  const emailMinKey = `reset:rate:email:${email}:m`;
  const ipHourKey = ip ? `reset:rate:ip:${ip}:h` : null;
  const ipMinKey = ip ? `reset:rate:ip:${ip}:m` : null;

  const [emailHour, emailMin, ipHour, ipMin] = await Promise.all([
    incrementCounter(emailHourKey, 60 * 60),
    incrementCounter(emailMinKey, 60),
    ipHourKey ? incrementCounter(ipHourKey, 60 * 60) : Promise.resolve(0),
    ipMinKey ? incrementCounter(ipMinKey, 60) : Promise.resolve(0),
  ]);

  const emailHourLimit = 3;
  const emailMinLimit = 1;
  const ipHourLimit = 10;
  const ipMinLimit = 3;

  const emailAllowed = emailHour <= emailHourLimit && emailMin <= emailMinLimit;
  const ipAllowed = (!ipHourKey || ipHour <= ipHourLimit) && (!ipMinKey || ipMin <= ipMinLimit);

  return {
    allowed: emailAllowed && ipAllowed,
    emailKeyCount: emailHour,
    ipKeyCount: ipHour,
  };
}
