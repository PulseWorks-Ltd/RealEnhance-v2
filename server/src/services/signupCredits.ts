import { createImageBundle } from "@realenhance/shared/usage/imageBundles.js";
import { withTransaction } from "../db/index.js";
import { getUserById, updateUser } from "./users.js";

export const SIGNUP_BONUS_CREDITS = 5;

const SIGNUP_BONUS_SOURCE = "signup_bonus";
const SIGNUP_BONUS_BUNDLE_CODE = "SIGNUP_BONUS";
const SIGNUP_BONUS_LABEL = "Signup bonus";

type GrantSignupCreditsParams = {
  userId: string;
  agencyId?: string | null;
  credits?: number;
};

type GrantSignupCreditsResult = {
  granted: boolean;
  duplicated: boolean;
};

async function hasExistingSignupBonus(agencyId: string, userId: string): Promise<boolean> {
  const result = await withTransaction(async (client) => {
    return client.query(
      `SELECT 1
         FROM addon_purchases
        WHERE agency_id = $1
          AND source = $2
          AND metadata ->> 'userId' = $3
        LIMIT 1`,
      [agencyId, SIGNUP_BONUS_SOURCE, userId]
    );
  });

  return (result.rowCount ?? 0) > 0;
}

async function ensureSignupCreditFlag(userId: string): Promise<void> {
  const latestUser = await getUserById(userId);
  if (!latestUser || latestUser.hasReceivedSignupCredits === true) {
    return;
  }

  await updateUser(userId, { hasReceivedSignupCredits: true });
}

export async function grantSignupCreditsOnce(
  params: GrantSignupCreditsParams
): Promise<GrantSignupCreditsResult> {
  const agencyId = typeof params.agencyId === "string" ? params.agencyId.trim() : "";
  const credits = Number.isFinite(Number(params.credits)) ? Number(params.credits) : SIGNUP_BONUS_CREDITS;

  if (!agencyId || !Number.isFinite(credits) || credits <= 0) {
    return { granted: false, duplicated: false };
  }

  const user = await getUserById(params.userId);
  if (!user) {
    throw new Error(`User ${params.userId} not found for signup credit grant`);
  }

  if (await hasExistingSignupBonus(agencyId, user.id)) {
    await ensureSignupCreditFlag(user.id);
    return { granted: false, duplicated: true };
  }

  const paymentIntentId = `${SIGNUP_BONUS_SOURCE}:${user.id}`;
  const bundleResult = await createImageBundle({
    agencyId,
    bundleType: "promo",
    bundleCode: SIGNUP_BONUS_BUNDLE_CODE,
    imagesPurchased: credits,
    stripePaymentIntentId: paymentIntentId,
    stripeSessionId: SIGNUP_BONUS_SOURCE,
  });

  if (!bundleResult.created && bundleResult.reason !== "duplicate") {
    throw new Error(`Failed to create signup bonus bundle: ${bundleResult.reason || "unknown"}`);
  }

  const granted = await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${SIGNUP_BONUS_SOURCE}:${user.id}`]);

    const existing = await client.query(
      `SELECT 1
         FROM addon_purchases
        WHERE agency_id = $1
          AND source = $2
          AND metadata ->> 'userId' = $3
        LIMIT 1`,
      [agencyId, SIGNUP_BONUS_SOURCE, user.id]
    );

    if ((existing.rowCount ?? 0) > 0) {
      return false;
    }

    await client.query(
      `INSERT INTO agency_accounts (agency_id, addon_images_balance)
       VALUES ($1, $2)
       ON CONFLICT (agency_id) DO UPDATE
         SET addon_images_balance = agency_accounts.addon_images_balance + EXCLUDED.addon_images_balance,
             updated_at = NOW();`,
      [agencyId, credits]
    );

    await client.query(
      `INSERT INTO addon_purchases (agency_id, quantity, source, metadata)
       VALUES ($1, $2, $3, $4)`,
      [
        agencyId,
        credits,
        SIGNUP_BONUS_SOURCE,
        JSON.stringify({
          type: SIGNUP_BONUS_SOURCE,
          label: SIGNUP_BONUS_LABEL,
          userId: user.id,
          userEmail: user.email,
          credits,
          bundleId: bundleResult.bundle?.id || null,
          bundleCode: bundleResult.bundle?.bundleCode || SIGNUP_BONUS_BUNDLE_CODE,
          stripePaymentIntentId: paymentIntentId,
          grantedAt: new Date().toISOString(),
          event: "signup_credits_granted",
        }),
      ]
    );

    return true;
  });

  await ensureSignupCreditFlag(user.id);

  if (granted) {
    console.log(`[SIGNUP_CREDITS_GRANTED] userId=${user.id} agencyId=${agencyId} credits=${credits} event=signup_credits_granted`);
  }

  return {
    granted,
    duplicated: !granted,
  };
}