// shared/src/agencyStore.ts
// Minimal agency support for usage tracking and soft plan limits

import { getRedis } from "./redisClient.js";

export interface Agency {
  agencyId: string;
  name: string;
  planName: string;
  monthlyListingLimit?: number;
  monthlyImageLimit?: number;
  warningThresholdPct?: number; // default 0.9
  createdAt: string;
}

/**
 * Get agency by ID (best-effort, returns null on failure)
 */
export async function getAgency(agencyId: string): Promise<Agency | null> {
  try {
    const client = getRedis();
    const key = `agency:${agencyId}`;
    const data = await client.hGetAll(key);

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      agencyId: data.agencyId,
      name: data.name,
      planName: data.planName,
      monthlyListingLimit: data.monthlyListingLimit ? parseInt(data.monthlyListingLimit, 10) : undefined,
      monthlyImageLimit: data.monthlyImageLimit ? parseInt(data.monthlyImageLimit, 10) : undefined,
      warningThresholdPct: data.warningThresholdPct ? parseFloat(data.warningThresholdPct) : 0.9,
      createdAt: data.createdAt,
    };
  } catch (err) {
    console.error("[AGENCY STORE] Failed to get agency:", err);
    return null;
  }
}

/**
 * Create or update an agency (best-effort)
 */
export async function saveAgency(agency: Agency): Promise<void> {
  try {
    const client = getRedis();
    const key = `agency:${agency.agencyId}`;

    const data: Record<string, string> = {
      agencyId: agency.agencyId,
      name: agency.name,
      planName: agency.planName,
      createdAt: agency.createdAt,
      warningThresholdPct: (agency.warningThresholdPct ?? 0.9).toString(),
    };

    if (agency.monthlyListingLimit !== undefined) {
      data.monthlyListingLimit = agency.monthlyListingLimit.toString();
    }
    if (agency.monthlyImageLimit !== undefined) {
      data.monthlyImageLimit = agency.monthlyImageLimit.toString();
    }

    await client.hSet(key, data);
  } catch (err) {
    console.error("[AGENCY STORE] Failed to save agency:", err);
  }
}

/**
 * List all agencies (best-effort)
 */
export async function listAgencies(): Promise<Agency[]> {
  try {
    const client = getRedis();
    const keys = await client.keys("agency:*");

    const agencies: Agency[] = [];
    for (const key of keys) {
      const data = await client.hGetAll(key);
      if (data && Object.keys(data).length > 0) {
        agencies.push({
          agencyId: data.agencyId,
          name: data.name,
          planName: data.planName,
          monthlyListingLimit: data.monthlyListingLimit ? parseInt(data.monthlyListingLimit, 10) : undefined,
          monthlyImageLimit: data.monthlyImageLimit ? parseInt(data.monthlyImageLimit, 10) : undefined,
          warningThresholdPct: data.warningThresholdPct ? parseFloat(data.warningThresholdPct) : 0.9,
          createdAt: data.createdAt,
        });
      }
    }

    return agencies;
  } catch (err) {
    console.error("[AGENCY STORE] Failed to list agencies:", err);
    return [];
  }
}
