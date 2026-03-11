import crypto from "node:crypto";
import { getRedis } from "@realenhance/shared/redisClient.js";
import { readJsonFile, writeJsonFile } from "./jsonStore.js";

const TOKEN_FILE = "emailVerificationTokens.json";
const TOKEN_SALT = process.env.EMAIL_VERIFICATION_TOKEN_SALT || process.env.SESSION_SECRET || "email_verification_salt";
const DEFAULT_TTL_HOURS = Number(process.env.EMAIL_VERIFICATION_TTL_HOURS || 24);

interface EmailVerificationTokenRecord {
  tokenHash: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

interface TokenFileState {
  tokens: Record<string, EmailVerificationTokenRecord>;
}

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw + TOKEN_SALT).digest("hex");
}

function ttlMs(): number {
  return DEFAULT_TTL_HOURS * 60 * 60 * 1000;
}

async function getRedisIfAvailable() {
  try {
    const client = getRedis();
    // @ts-ignore
    if (typeof client.ping === "function") await client.ping();
    return client;
  } catch {
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

export async function createEmailVerificationToken(userId: string): Promise<{ token: string; expiresAt: string }> {
  const raw = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + ttlMs()).toISOString();
  const createdAt = new Date().toISOString();

  const record: EmailVerificationTokenRecord = {
    tokenHash,
    userId,
    expiresAt,
    createdAt,
  };

  const redis = await getRedisIfAvailable();
  if (redis) {
    try {
      const key = `email_verify:token:${tokenHash}`;
      const payload = JSON.stringify(record);
      // @ts-ignore
      if (typeof (redis as any).setEx === "function") {
        await (redis as any).setEx(key, Math.ceil(ttlMs() / 1000), payload);
      } else {
        await redis.set(key, payload);
        // @ts-ignore
        if (typeof redis.expire === "function") await redis.expire(key, Math.ceil(ttlMs() / 1000));
      }
      return { token: raw, expiresAt };
    } catch (err) {
      console.error("[email-verify-token] redis store failed, falling back to file", err);
    }
  }

  const state = loadFile();
  state.tokens[tokenHash] = record;
  cleanupFile(state);
  saveFile(state);
  return { token: raw, expiresAt };
}

export async function consumeEmailVerificationToken(rawToken: string): Promise<{ userId: string } | null> {
  const tokenHash = hashToken(rawToken);
  const now = Date.now();

  const redis = await getRedisIfAvailable();
  if (redis) {
    try {
      const key = `email_verify:token:${tokenHash}`;
      const raw = await redis.get(key);
      if (raw) {
        await redis.del(key);
        const rec = JSON.parse(raw) as EmailVerificationTokenRecord;
        if (new Date(rec.expiresAt).getTime() > now) {
          return { userId: rec.userId };
        }
      }
    } catch (err) {
      console.error("[email-verify-token] redis consume failed, trying file", err);
    }
  }

  const state = loadFile();
  const rec = state.tokens[tokenHash];
  if (!rec) return null;
  delete state.tokens[tokenHash];
  cleanupFile(state);
  saveFile(state);

  if (new Date(rec.expiresAt).getTime() <= now) return null;
  return { userId: rec.userId };
}
