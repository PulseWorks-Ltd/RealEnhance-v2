// shared/src/invites.ts
// Invite management with seat limit enforcement

import { getRedis } from "./redisClient.js";
import type { UserRole } from "./auth/types.js";
import { v4 as uuidv4 } from "uuid";
import { isAgencyOverSeatLimit } from "./agencies.js";

export interface Invite {
  inviteId: string;
  agencyId: string;
  email: string;
  role: "admin" | "member";
  token: string;
  invitedByUserId: string;
  expiresAt: string;
  createdAt: string;
  acceptedAt?: string;
}

/**
 * Create an invite (with seat limit enforcement)
 */
export async function createInvite(params: {
  agencyId: string;
  email: string;
  role: "admin" | "member";
  invitedByUserId: string;
}): Promise<{ success: boolean; invite?: Invite; error?: string }> {
  try {
    // ENFORCE SEAT LIMIT AT INVITE CREATION
    const seatCheck = await isAgencyOverSeatLimit(params.agencyId);
    if (seatCheck.over) {
      return {
        success: false,
        error: `Seat limit reached (${seatCheck.active}/${seatCheck.maxSeats}). Upgrade your plan to add more users.`,
      };
    }

    const invite: Invite = {
      inviteId: `invite_${uuidv4()}`,
      agencyId: params.agencyId,
      email: params.email.toLowerCase(),
      role: params.role,
      token: uuidv4(), // Secure random token
      invitedByUserId: params.invitedByUserId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
      createdAt: new Date().toISOString(),
    };

    const client = getRedis();
    const key = `invite:${invite.inviteId}`;
    const tokenKey = `invite_token:${invite.token}`;

    await client.hSet(key, {
      inviteId: invite.inviteId,
      agencyId: invite.agencyId,
      email: invite.email,
      role: invite.role,
      token: invite.token,
      invitedByUserId: invite.invitedByUserId,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
    });

    // Create reverse lookup by token
    await client.set(tokenKey, invite.inviteId, { EX: 7 * 24 * 60 * 60 });

    console.log(`[INVITE] Created invite for ${invite.email} to agency ${invite.agencyId}`);
    return { success: true, invite };
  } catch (err) {
    console.error("[INVITE] Failed to create invite:", err);
    return { success: false, error: "Failed to create invite" };
  }
}

/**
 * Get invite by token
 */
export async function getInviteByToken(token: string): Promise<Invite | null> {
  try {
    const client = getRedis();
    const tokenKey = `invite_token:${token}`;

    const inviteId = await client.get(tokenKey);
    if (!inviteId) {
      return null;
    }

    const key = `invite:${inviteId}`;
    const data = await client.hGetAll(key);

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    // Check if expired
    if (new Date(data.expiresAt) < new Date()) {
      return null;
    }

    // Check if already accepted
    if (data.acceptedAt) {
      return null;
    }

    return {
      inviteId: data.inviteId,
      agencyId: data.agencyId,
      email: data.email,
      role: data.role as "admin" | "member",
      token: data.token,
      invitedByUserId: data.invitedByUserId,
      expiresAt: data.expiresAt,
      createdAt: data.createdAt,
      acceptedAt: data.acceptedAt,
    };
  } catch (err) {
    console.error("[INVITE] Failed to get invite:", err);
    return null;
  }
}

/**
 * Mark invite as accepted (with seat limit re-check)
 */
export async function acceptInvite(token: string): Promise<{
  success: boolean;
  invite?: Invite;
  error?: string;
}> {
  try {
    const invite = await getInviteByToken(token);
    if (!invite) {
      return { success: false, error: "Invalid or expired invite" };
    }

    // RE-CHECK SEAT LIMIT AT ACCEPTANCE
    const seatCheck = await isAgencyOverSeatLimit(invite.agencyId);
    if (seatCheck.over) {
      return {
        success: false,
        error: `Seat limit reached (${seatCheck.active}/${seatCheck.maxSeats}). Upgrade your plan to add more users.`,
      };
    }

    // Mark as accepted
    const client = getRedis();
    const key = `invite:${invite.inviteId}`;
    await client.hSet(key, { acceptedAt: new Date().toISOString() });

    invite.acceptedAt = new Date().toISOString();

    console.log(`[INVITE] Accepted invite ${invite.inviteId} for ${invite.email}`);
    return { success: true, invite };
  } catch (err) {
    console.error("[INVITE] Failed to accept invite:", err);
    return { success: false, error: "Failed to accept invite" };
  }
}

/**
 * List pending invites for an agency
 */
export async function listAgencyInvites(agencyId: string): Promise<Invite[]> {
  try {
    const client = getRedis();
    const keys = await client.keys("invite:*");

    const invites: Invite[] = [];
    for (const key of keys) {
      const data = await client.hGetAll(key);
      if (data && data.agencyId === agencyId && !data.acceptedAt) {
        // Only include non-expired, non-accepted invites
        if (new Date(data.expiresAt) >= new Date()) {
          invites.push({
            inviteId: data.inviteId,
            agencyId: data.agencyId,
            email: data.email,
            role: data.role as "admin" | "member",
            token: data.token,
            invitedByUserId: data.invitedByUserId,
            expiresAt: data.expiresAt,
            createdAt: data.createdAt,
          });
        }
      }
    }

    return invites;
  } catch (err) {
    console.error("[INVITE] Failed to list invites:", err);
    return [];
  }
}
