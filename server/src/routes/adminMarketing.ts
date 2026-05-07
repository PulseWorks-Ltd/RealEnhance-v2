import { Router, type Request, type Response } from "express";
import { getRedis } from "@realenhance/shared/redisClient.js";
import { pool } from "../db/index.js";
import { getUserById } from "../services/users.js";
import type { UserRecord } from "@realenhance/shared/types.js";

const router = Router();

const CACHE_TTL_MS = 45_000;

type MarketingUserRecord = {
  userId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  identityStatus: "complete" | "partial" | "unknown";
  contactable: boolean;
  agencyId: string | null;
  agencyName: string | null;
  role: string | null;
  planTier: string | null;
  subscriptionStatus: string | null;
  usage: number;
  usageTier: "low" | "medium" | "high";
  priorityScore: number;
  lastActivity: string | null;
  lastActivityDaysAgo: number | null;
  hasUsedRecently: boolean;
};

type RedisUserIdentity = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  agencyId: string | null;
  role: string | null;
  createdAt: string | null;
  displayName: string | null;
};

type RedisAgencyIdentity = {
  agencyId: string;
  agencyName: string | null;
  planTier: string | null;
  subscriptionStatus: string | null;
  billingCountry: string | null;
  billingCurrency: string | null;
};

type UsageRow = {
  user_id: string;
  agency_id: string | null;
  total_jobs: string | number;
  last_activity: string | null;
};

let marketingUsersCache:
  | {
      expiresAt: number;
      data: MarketingUserRecord[];
    }
  | null = null;

function deriveIdentityStatus(params: {
  email: string | null;
  agencyName: string | null;
}): "complete" | "partial" | "unknown" {
  const hasEmail = Boolean(normalizeNullable(params.email));
  const hasAgencyName = Boolean(normalizeNullable(params.agencyName));

  if (hasEmail && hasAgencyName) return "complete";
  if (hasEmail || hasAgencyName) return "partial";
  return "unknown";
}

async function requireAuth(req: Request, res: Response, next: Function) {
  const sessUser = (req.session as any)?.user;
  if (!sessUser) return res.status(401).json({ error: "Authentication required" });
  const fullUser = await getUserById(sessUser.id);
  if (!fullUser) return res.status(401).json({ error: "Authentication required" });
  (req as any).user = fullUser;
  next();
}

function requireSiteAdmin(req: Request, res: Response, next: Function) {
  const user = (req as any).user as UserRecord | undefined;
  if (!user?.email) return res.status(401).json({ error: "Authentication required" });

  const adminEmails = (process.env.REALENHANCE_ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (!adminEmails.includes(user.email.toLowerCase())) {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
}

function normalizeNullable(value: string | null | undefined): string | null {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed : null;
}

function hasValidEmail(email: string | null | undefined): boolean {
  const normalized = normalizeNullable(email);
  return normalized ? /^\S+@\S+\.\S+$/.test(normalized) : false;
}

function deriveDisplayName(user: Pick<RedisUserIdentity, "email" | "firstName" | "lastName" | "name">): string | null {
  const normalizedEmail = normalizeNullable(user.email)?.toLowerCase() || null;
  const fullName = [user.firstName, user.lastName]
    .map((part) => normalizeNullable(part))
    .filter(Boolean)
    .join(" ")
    .trim();
  if (fullName && fullName.toLowerCase() !== normalizedEmail) return fullName;

  const legacyName = normalizeNullable(user.name);
  if (legacyName && legacyName.toLowerCase() !== normalizedEmail) {
    return legacyName;
  }

  return null;
}

function deriveUsageTier(usage: number): "low" | "medium" | "high" {
  if (usage <= 10) return "low";
  if (usage <= 50) return "medium";
  return "high";
}

function deriveLastActivityDaysAgo(lastActivity: string | null): number | null {
  const normalized = normalizeNullable(lastActivity);
  if (!normalized) return null;

  const activityTime = Date.parse(normalized);
  if (!Number.isFinite(activityTime)) return null;

  const diffMs = Date.now() - activityTime;
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

function derivePriorityScore(params: {
  usageTier: "low" | "medium" | "high";
  lastActivityDaysAgo: number | null;
  contactable: boolean;
}): number {
  const usageScore = params.usageTier === "high" ? 45 : params.usageTier === "medium" ? 28 : 12;

  let recencyScore = 0;
  if (params.lastActivityDaysAgo === null) {
    recencyScore = 0;
  } else if (params.lastActivityDaysAgo <= 3) {
    recencyScore = 35;
  } else if (params.lastActivityDaysAgo <= 14) {
    recencyScore = 24;
  } else if (params.lastActivityDaysAgo <= 30) {
    recencyScore = 14;
  } else {
    recencyScore = 6;
  }

  const contactBonus = params.contactable ? 20 : 0;
  return Math.max(0, Math.min(100, usageScore + recencyScore + contactBonus));
}

async function listRedisKeys(pattern: string): Promise<string[]> {
  const client = getRedis() as any;
  const uniqueKeys = new Set<string>();

  if (typeof client.scanIterator === "function") {
    for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 200 })) {
      if (typeof key === "string" && key) uniqueKeys.add(key);
    }
    return [...uniqueKeys];
  }

  // Fallback for smaller datasets or mock Redis clients without SCAN support.
  const keys = await client.keys(pattern);
  for (const key of keys as string[]) {
    if (typeof key === "string" && key) uniqueKeys.add(key);
  }
  return [...uniqueKeys];
}

async function fetchUsersFromRedis(): Promise<RedisUserIdentity[]> {
  const client = getRedis() as any;
  const keys = await listRedisKeys("user:*");
  const users: RedisUserIdentity[] = [];

  for (const key of keys) {
    try {
      if (typeof client.type === "function") {
        const keyType = await client.type(key);
        if (keyType !== "hash") continue;
      }

      const data = await client.hGetAll(key);
      const id = normalizeNullable(data?.id);
      const email = normalizeNullable(data?.email);
      if (!id) continue;

      const user: RedisUserIdentity = {
        id,
        email,
        firstName: normalizeNullable(data.firstName),
        lastName: normalizeNullable(data.lastName),
        name: normalizeNullable(data.name),
        agencyId: normalizeNullable(data.agencyId),
        role: normalizeNullable(data.role),
        createdAt: normalizeNullable(data.createdAt),
        displayName: null,
      };
      user.displayName = deriveDisplayName(user);
      users.push(user);
    } catch {
      // Skip malformed or non-hash keys such as email indexes.
    }
  }

  return users;
}

async function fetchAgenciesFromRedis(agencyIds: Iterable<string>): Promise<Map<string, RedisAgencyIdentity>> {
  const client = getRedis();
  const uniqueAgencyIds = [...new Set([...agencyIds].map((agencyId) => String(agencyId || "").trim()).filter(Boolean))];
  const agencies = await Promise.all(
    uniqueAgencyIds.map(async (agencyId) => {
      try {
        const data = await client.hGetAll(`agency:${agencyId}`);
        if (!data || !data.agencyId) return null;
        const record: RedisAgencyIdentity = {
          agencyId,
          agencyName: normalizeNullable(data.name),
          planTier: normalizeNullable(data.planTier),
          subscriptionStatus: normalizeNullable(data.subscriptionStatus),
          billingCountry: normalizeNullable(data.billingCountry),
          billingCurrency: normalizeNullable(data.billingCurrency),
        };
        return [agencyId, record] as const;
      } catch {
        return null;
      }
    })
  );

  return new Map(agencies.filter((entry): entry is readonly [string, RedisAgencyIdentity] => entry !== null));
}

async function fetchUsageFromPostgres(): Promise<Map<string, { agencyId: string | null; usage: number; lastActivity: string | null }>> {
  const result = await pool.query<UsageRow>(
    `SELECT
       user_id,
       agency_id,
       COUNT(*) AS total_jobs,
       MAX(created_at) AS last_activity
     FROM job_reservations
     GROUP BY user_id, agency_id`
  );

  const usageMap = new Map<string, { agencyId: string | null; usage: number; lastActivity: string | null }>();
  for (const row of result.rows) {
    const userId = normalizeNullable(row.user_id);
    if (!userId) continue;

    const usage = Number(row.total_jobs || 0);
    const lastActivity = normalizeNullable(row.last_activity);
    const agencyId = normalizeNullable(row.agency_id);
    const existing = usageMap.get(userId);

    if (!existing) {
      usageMap.set(userId, { agencyId, usage, lastActivity });
      continue;
    }

    const nextLastActivity = [existing.lastActivity, lastActivity]
      .filter(Boolean)
      .sort((left, right) => Date.parse(String(right)) - Date.parse(String(left)))[0] || null;

    usageMap.set(userId, {
      agencyId: existing.agencyId || agencyId,
      usage: existing.usage + usage,
      lastActivity: nextLastActivity,
    });
  }

  return usageMap;
}

async function resolveMarketingUsers(): Promise<MarketingUserRecord[]> {
  const users = await fetchUsersFromRedis();
  const usageMap = await fetchUsageFromPostgres();
  const agencies = await fetchAgenciesFromRedis(
    users.map((user) => user.agencyId).filter((agencyId): agencyId is string => Boolean(agencyId))
  );

  const merged = users.map<MarketingUserRecord>((user) => {
    const usage = usageMap.get(user.id);
    const agencyId = user.agencyId || usage?.agencyId || null;
    const agency = agencyId ? agencies.get(agencyId) : undefined;
    const totalUsage = usage?.usage || 0;
    const lastActivity = usage?.lastActivity || null;
    const contactable = hasValidEmail(user.email);
    const usageTier = deriveUsageTier(totalUsage);
    const lastActivityDaysAgo = deriveLastActivityDaysAgo(lastActivity);

    return {
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      displayName: user.displayName,
      identityStatus: deriveIdentityStatus({
        email: user.email,
        agencyName: agency?.agencyName || null,
      }),
      contactable,
      agencyId,
      agencyName: agency?.agencyName || null,
      role: user.role,
      planTier: agency?.planTier || null,
      subscriptionStatus: agency?.subscriptionStatus || null,
      usage: totalUsage,
      usageTier,
      priorityScore: derivePriorityScore({
        usageTier,
        lastActivityDaysAgo,
        contactable,
      }),
      lastActivity,
      lastActivityDaysAgo,
      hasUsedRecently: lastActivityDaysAgo !== null && lastActivityDaysAgo <= 3,
    };
  });

  merged.sort((left, right) => {
    if (right.priorityScore !== left.priorityScore) return right.priorityScore - left.priorityScore;
    if (right.usage !== left.usage) return right.usage - left.usage;
    const leftTime = left.lastActivity ? Date.parse(left.lastActivity) : 0;
    const rightTime = right.lastActivity ? Date.parse(right.lastActivity) : 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return (left.email || "").localeCompare(right.email || "");
  });

  return merged;
}

async function getCachedMarketingUsers(): Promise<MarketingUserRecord[]> {
  if (marketingUsersCache && marketingUsersCache.expiresAt > Date.now()) {
    return marketingUsersCache.data;
  }

  const data = await resolveMarketingUsers();
  marketingUsersCache = {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  return data;
}

router.get("/marketing/users", requireAuth, requireSiteAdmin, async (_req: Request, res: Response) => {
  try {
    const users = await getCachedMarketingUsers();
    res.setHeader("Cache-Control", "private, max-age=45");
    return res.json(users);
  } catch (error) {
    console.error("[ADMIN_MARKETING] users resolver error:", error);
    return res.status(500).json({ error: "Failed to fetch marketing users" });
  }
});

export default router;