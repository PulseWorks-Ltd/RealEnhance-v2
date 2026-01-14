import { Router, type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { createAgency } from "@realenhance/shared/agencies.js";
import { createUserWithPassword } from "../services/users.js";
import { hashPassword, validateEmail, validatePassword } from "../utils/password.js";
import { getDisplayName } from "@realenhance/shared/users.js";
import { assertEligibleForTrial, normalizeEmail, recordTrialStart, sha256 } from "../services/trials.js";
import type { UserRecord } from "@realenhance/shared/types.js";
import { pool } from "../db/index.js";

const router = Router();

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS_PER_DAY = 3;

function rateLimit(req: Request, res: Response, next: Function) {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (entry && entry.resetAt > now) {
    if (entry.count >= MAX_ATTEMPTS_PER_DAY) {
      return res.status(429).json({ error: "Too many trial attempts. Please try again later." });
    }
    entry.count += 1;
    rateLimitMap.set(ip, entry);
  } else {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 24 * 60 * 60 * 1000 });
  }
  next();
}

router.post("/start", rateLimit, async (req: Request, res: Response) => {
  const { agencyName, email, password, promoCode } = req.body || {};

  if (!agencyName || !agencyName.trim()) {
    return res.status(400).json({ error: "Agency name is required" });
  }
  if (!promoCode || !promoCode.trim()) {
    return res.status(400).json({ error: "Promo code is required" });
  }

  const emailValidation = validateEmail(email);
  if (!emailValidation.valid) {
    return res.status(400).json({ error: emailValidation.error || "Invalid email" });
  }

  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    return res.status(400).json({ error: passwordValidation.error || "Invalid password" });
  }

  const emailNormalized = normalizeEmail(email);
  const emailHash = sha256(emailNormalized);
  let claimRecorded = false;
  let promoId: number | null = null;
  const agencyId = `agency_${uuidv4()}`;

  try {
    // Anti-abuse: block existing accounts or repeat claims
    await assertEligibleForTrial(emailNormalized);

    // Pre-hash sensitive values
    const passwordHash = await hashPassword(password);
    const ipHash = sha256(((req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.ip || "").trim());
    const uaHash = sha256((req.headers["user-agent"] as string) || "");

    // Record trial in Postgres (promo validation + claim)
    const { trial, promo } = await recordTrialStart({
      agencyId,
      emailNormalized,
      promoCode,
      ipHash,
      uaHash,
    });
    claimRecorded = true;
    promoId = promo.id;

    // Create agency in Redis
    const agency = await createAgency({
      agencyId,
      name: agencyName.trim(),
      planTier: "starter",
      ownerId: "trial-owner",
      subscriptionStatus: "TRIAL",
    });

    // Create user + session
    const newUser = await createUserWithPassword({
      email: emailNormalized,
      name: agencyName.trim(),
      firstName: undefined,
      lastName: undefined,
      passwordHash,
      agencyId: agency.agencyId,
      role: "owner",
    });

    const displayName = getDisplayName(newUser);
    const sessionUser: Partial<UserRecord> = {
      id: newUser.id,
      email: newUser.email,
      name: newUser.name,
      firstName: newUser.firstName,
      lastName: newUser.lastName,
      displayName,
      credits: newUser.credits,
      agencyId: newUser.agencyId,
      role: newUser.role || "owner",
    };

    (req.session as any).user = sessionUser;

    return res.status(201).json({
      agency,
      user: sessionUser,
      trial: {
        status: trial.trial_status,
        expiresAt: trial.trial_expires_at,
        creditsTotal: trial.trial_credits_total,
        creditsUsed: trial.trial_credits_used,
        remaining: Math.max(0, (trial.trial_credits_total || 0) - (trial.trial_credits_used || 0)),
      },
    });
  } catch (err: any) {
    console.error("[TRIAL] start error", err);

    // If we failed after we might have created records, attempt to undo the claim + redemptions
    if (claimRecorded) {
      try {
        await pool.query("BEGIN");
        await pool.query(`DELETE FROM trial_claims WHERE email_hash = $1`, [emailHash]);
        if (promoId) {
          await pool.query(
            `UPDATE promo_codes SET redemptions_count = GREATEST(0, redemptions_count - 1) WHERE id = $1`,
            [promoId]
          );
        }
        await pool.query(`DELETE FROM organisations WHERE agency_id = $1`, [agencyId]);
        await pool.query("COMMIT");
      } catch (cleanupErr) {
        try { await pool.query("ROLLBACK"); } catch {}
        console.warn("[TRIAL] cleanup failed", cleanupErr);
      }
    }

    if (err?.code === "EMAIL_EXISTS") {
      return res.status(409).json({ error: "An account already exists for this email. Please log in." });
    }
    if (err?.code === "TRIAL_ALREADY_CLAIMED") {
      return res.status(409).json({ error: "A trial has already been claimed for this email." });
    }
    if (err?.code === "INVALID_PROMO" || err?.code === "PROMO_INACTIVE" || err?.code === "PROMO_EXPIRED" || err?.code === "PROMO_MAXED") {
      return res.status(400).json({ error: err.code });
    }

    return res.status(500).json({ error: "Failed to start trial" });
  }
});

export default function trialRouter() {
  return router;
}
