/**
 * Account administration shared by the admin dashboard, the agency Team page
 * and scripts/change-owner-email.ts:
 *  - changeUserLoginEmail: move an account to a new login email (e.g. a staff
 *    member who owned an agency account has left).
 *  - transferAgencyOwnership: make another team member the agency's owner.
 */
import crypto from "crypto";
import { getUserById, getUserByEmail, updateUser } from "@realenhance/shared/users.js";
import { getAgency, updateAgency, listAgencyUsers } from "@realenhance/shared/agencies.js";
import { getRedis } from "@realenhance/shared/redisClient.js";
import type { UserRecord } from "@realenhance/shared/types.js";
import { hashPassword } from "../utils/password.js";
import { invalidateSessionsForUser, updateSessionsForUser } from "./sessionStore.js";

export class AccountAdminError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ChangeEmailResult = {
  userId: string;
  oldEmail: string;
  newEmail: string;
  role: string | null;
  agencyId: string | null;
  sessionsLoggedOut: number;
  billingEmailUpdated: boolean;
  oldEmailStillFindsAccount: boolean;
};

/**
 * Changes the login email, marks it unverified, replaces the password with a
 * random unknown one (kept, not removed: "Forgot password" only works for
 * accounts with a password) and unlinks Google, removes the old email's
 * lookup, logs the user out everywhere, and updates the agency billing email
 * if it was the old address. Agency, role, photos, credits and subscription
 * are kept.
 */
export async function changeUserLoginEmail(params: { userId: string; newEmail: string; actor: string }): Promise<ChangeEmailResult> {
  const newEmail = String(params.newEmail || "").trim().toLowerCase();
  if (!EMAIL_RE.test(newEmail)) throw new AccountAdminError(400, "INVALID_EMAIL", "Enter a valid email address.");
  const user = await getUserById(params.userId);
  if (!user) throw new AccountAdminError(404, "USER_NOT_FOUND", "User not found.");
  const oldEmail = String(user.email || "").toLowerCase();
  if (oldEmail === newEmail) throw new AccountAdminError(400, "SAME_EMAIL", "That is already this account's email.");
  const clash = await getUserByEmail(newEmail);
  if (clash && clash.id !== user.id) {
    throw new AccountAdminError(409, "EMAIL_IN_USE", `${newEmail} is already used by another account.`);
  }
  const agency = user.agencyId ? await getAgency(user.agencyId) : null;
  const billingMatches = !!agency?.billingEmail && agency.billingEmail.toLowerCase() === oldEmail;

  await updateUser({
    ...user,
    email: newEmail,
    emailVerified: false,
    passwordHash: await hashPassword(crypto.randomBytes(32).toString("base64url")),
    googleId: undefined,
    authProvider: "email",
  });
  // The old address must no longer find this account (updateUser removes it
  // too; done here as well so it holds regardless).
  const oldKey = `user:email:${oldEmail}`;
  const client = getRedis();
  if ((await client.get(oldKey)) === user.id) await client.del(oldKey);
  const sessionsLoggedOut = await invalidateSessionsForUser(user.id);
  if (agency && billingMatches) await updateAgency({ ...agency, billingEmail: newEmail });

  const stillFinds = !!(await getUserByEmail(oldEmail));
  console.log("[ACCOUNT_ADMIN] login email changed", JSON.stringify({
    actor: params.actor, userId: user.id, oldEmail, newEmail, agencyId: user.agencyId || null, role: user.role || null,
    sessionsLoggedOut, billingEmailUpdated: billingMatches, at: new Date().toISOString(),
  }));
  return {
    userId: user.id, oldEmail, newEmail, role: user.role || null, agencyId: user.agencyId || null,
    sessionsLoggedOut, billingEmailUpdated: billingMatches, oldEmailStillFindsAccount: stillFinds,
  };
}

export type TransferOwnershipResult = {
  agencyId: string;
  newOwnerId: string;
  newOwnerEmail: string;
  previousOwnerIds: string[];
};

/**
 * Makes another active member of the agency its owner. The previous owner(s)
 * become admins (they can be disabled afterwards from the Team page). Billing
 * and the subscription belong to the agency and are unchanged.
 */
export async function transferAgencyOwnership(params: { agencyId: string; newOwnerId: string; actor: string }): Promise<TransferOwnershipResult> {
  const agency = await getAgency(params.agencyId);
  if (!agency) throw new AccountAdminError(404, "AGENCY_NOT_FOUND", "Agency not found.");
  const target = await getUserById(params.newOwnerId);
  if (!target || target.agencyId !== agency.agencyId) {
    throw new AccountAdminError(404, "USER_NOT_IN_AGENCY", "That person isn't a member of this agency.");
  }
  if (target.isActive === false) throw new AccountAdminError(400, "USER_DISABLED", "Enable this team member before making them the owner.");
  if ((target as any).isSystemUser) throw new AccountAdminError(400, "SYSTEM_USER", "A system account can't own an agency.");
  if (target.role === "owner") throw new AccountAdminError(400, "ALREADY_OWNER", "This person is already the owner.");

  const members: UserRecord[] = await listAgencyUsers(agency.agencyId);
  const previousOwners = members.filter((u) => u.role === "owner" && u.id !== target.id);
  await updateUser({ ...target, role: "owner" });
  for (const prev of previousOwners) await updateUser({ ...prev, role: "admin" });
  await updateSessionsForUser(target.id, { role: "owner" });
  for (const prev of previousOwners) await updateSessionsForUser(prev.id, { role: "admin" });

  console.log("[ACCOUNT_ADMIN] agency ownership transferred", JSON.stringify({
    actor: params.actor, agencyId: agency.agencyId, newOwnerId: target.id, newOwnerEmail: target.email,
    previousOwnerIds: previousOwners.map((u) => u.id), at: new Date().toISOString(),
  }));
  return { agencyId: agency.agencyId, newOwnerId: target.id, newOwnerEmail: target.email, previousOwnerIds: previousOwners.map((u) => u.id) };
}
