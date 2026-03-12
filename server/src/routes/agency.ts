// server/src/routes/agency.ts
// Agency management routes (unlimited users per agency)

import { Router, type Request, type Response } from "express";
import Stripe from "stripe";
import {
  createAgency,
  getAgency,
  updateAgency,
  listAgencyUsers,
  countActiveAgencyUsers,
} from "@realenhance/shared/agencies.js";
import { getStripePlan } from "@realenhance/shared/billing/stripePlans.js";
import {
  createInvite,
  getInviteByToken,
  acceptInvite,
  listAgencyInvites,
} from "@realenhance/shared/invites.js";
import { getUserById, updateUser, getUserByEmail, createUserWithPassword } from "../services/users.js";
import type { UserRecord } from "@realenhance/shared/types.js";
import { hashPassword } from "../utils/password.js";
import { IMAGE_BUNDLES, getBundleStripePriceId, type BundleCode } from "@realenhance/shared/bundles.js";
import { createImageBundle, getBundleHistory } from "@realenhance/shared/usage/imageBundles.js";
import { AGENCY_SIGNUP_PROMO_CREDITS } from "@realenhance/shared/plans.js";
import { sendInvitationEmail } from "../services/email.js";
import { getDisplayName } from "@realenhance/shared/users.js";
import { invalidateSessionsForUser } from "../services/sessionStore.js";
import { getTrialSummary } from "../services/trials.js";
import { getUsageSnapshot } from "../services/usageLedger.js";
import type { PlanTier } from "@realenhance/shared/auth/types.js";
import { INITIAL_FREE_CREDITS } from "../config.js";
import { withTransaction } from "../db/index.js";

const router = Router();

// Initialize Stripe with secret key from environment
// Allow override via STRIPE_API_VERSION; fallback to Stripe default when unset
const stripeApiVersion = process.env.STRIPE_API_VERSION as Stripe.StripeConfig["apiVersion"] | undefined;
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: stripeApiVersion })
  : null;

const PROMO_SIGNUP_SOURCE = "promo_signup";
const PROMO_SIGNUP_BUNDLE_CODE: BundleCode = "BUNDLE_20";

export async function grantSignupPromoCreditsOnce(agencyId: string, credits: number): Promise<boolean> {
  if (!Number.isFinite(credits) || credits <= 0) return false;

  const existingPromo = await withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT 1 FROM addon_purchases WHERE agency_id = $1 AND source = $2 LIMIT 1`,
      [agencyId, PROMO_SIGNUP_SOURCE]
    );
    return (existing.rowCount ?? 0) > 0;
  });

  if (existingPromo) return false;

  const promoIntentId = `${PROMO_SIGNUP_SOURCE}:${agencyId}`;
  const bundleResult = await createImageBundle({
    agencyId,
    bundleType: "promo",
    bundleCode: PROMO_SIGNUP_BUNDLE_CODE,
    imagesPurchased: credits,
    stripePaymentIntentId: promoIntentId,
    stripeSessionId: PROMO_SIGNUP_SOURCE,
  });

  if (!bundleResult.created && bundleResult.reason !== "duplicate") {
    throw new Error(`Failed to create promo bundle: ${bundleResult.reason || "unknown"}`);
  }

  const granted = await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [agencyId]);

    const existing = await client.query(
      `SELECT 1 FROM addon_purchases WHERE agency_id = $1 AND source = $2 LIMIT 1`,
      [agencyId, PROMO_SIGNUP_SOURCE]
    );
    if ((existing.rowCount ?? 0) > 0) return false;

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
        PROMO_SIGNUP_SOURCE,
        JSON.stringify({
          type: "signup_promo",
          reason: "new_agency_promotion",
          bundleCode: PROMO_SIGNUP_BUNDLE_CODE,
          credits,
          stripePaymentIntentId: promoIntentId,
          grantedAt: new Date().toISOString(),
        }),
      ]
    );

    return true;
  });

  if (granted) {
    console.log(`[AGENCY_PROMO_CREDITS_GRANTED] agencyId=${agencyId} credits=${credits}`);
  }

  return granted;
}

/**
 * Middleware to require authenticated user
 * Maps session user to req.user for consistency
 */
async function requireAuth(req: Request, res: Response, next: Function) {
  const sessUser = (req.session as any)?.user;
  if (!sessUser) {
    return res.status(401).json({ error: "Authentication required" });
  }

  // Load full user record from database
  const fullUser = await getUserById(sessUser.id);
  if (!fullUser) {
    return res.status(401).json({ error: "User not found" });
  }

  // Attach to request for downstream middleware
  (req as any).user = fullUser;
  next();
}

/**
 * Middleware to require agency admin/owner
 */
function requireAgencyAdmin(req: Request, res: Response, next: Function) {
  const user = (req as any).user as UserRecord | undefined;
  if (!user || !user.agencyId) {
    return res.status(403).json({ error: "Agency membership required" });
  }

  const userRole = user.role || "member";
  if (userRole !== "owner" && userRole !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
}

/**
 * POST /api/agency/create
 * Create a new agency and assign current user as owner
 */
router.post("/create", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user as UserRecord;
    const { name, planTier } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: "Agency name is required" });
    }

    // Check if user already belongs to an agency
    if (user.agencyId) {
      return res.status(409).json({ error: "User already belongs to an agency" });
    }

    const normalizedPlanTier =
      planTier === "starter" || planTier === "pro" || planTier === "agency"
        ? (planTier as PlanTier)
        : null;

    // Create agency
    const agency = await createAgency({
      name: name.trim(),
      planTier: normalizedPlanTier,
      ownerId: user.id,
    });

    // Update user to be agency owner and ensure starter credits are granted once
    const updatePayload: Partial<UserRecord> = {
      agencyId: agency.agencyId,
      role: "owner",
    };

    const initialCredits = Number.isFinite(INITIAL_FREE_CREDITS) ? INITIAL_FREE_CREDITS : 50;
    if ((user.credits ?? 0) < initialCredits) {
      updatePayload.credits = initialCredits;
    }

    const updatedUser = await updateUser(user.id, updatePayload);

    await grantSignupPromoCreditsOnce(agency.agencyId, AGENCY_SIGNUP_PROMO_CREDITS);

    // Refresh session payload so subsequent requests immediately see the new agency/role
    const displayName = getDisplayName(updatedUser as any);
    (req.session as any).user = {
      id: updatedUser.id,
      email: updatedUser.email,
      name: updatedUser.name ?? null,
      firstName: updatedUser.firstName ?? null,
      lastName: updatedUser.lastName ?? null,
      displayName,
      emailVerified: updatedUser.emailVerified === true,
      credits: updatedUser.credits,
      agencyId: updatedUser.agencyId,
      role: updatedUser.role || "owner",
      hasSeenWelcome: updatedUser.hasSeenWelcome === false ? false : true,
    };

    res.status(201).json({
      agency,
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        name: updatedUser.name,
        agencyId: updatedUser.agencyId,
        role: updatedUser.role,
        displayName,
        credits: updatedUser.credits,
      },
    });
  } catch (err) {
    console.error("[AGENCY] Create error:", err);
    res.status(500).json({ error: "Failed to create agency" });
  }
});

/**
 * GET /api/agency/info
 * Get current user's agency information
 */
router.get("/info", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user as UserRecord;

    if (!user.agencyId) {
      return res.status(404).json({ error: "No agency found" });
    }

    const agency = await getAgency(user.agencyId);
    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    const activeUsers = await countActiveAgencyUsers(user.agencyId);
    const trial = await getTrialSummary(user.agencyId);
    const usage = await getUsageSnapshot(user.agencyId);
    const planTier = agency.planTier ?? null;
    const plan = planTier ? getStripePlan(planTier as PlanTier) : null;
    const now = Date.now();
    const trialActive =
      trial.status === "active" &&
      (!trial.expiresAt || Number.isNaN(Date.parse(trial.expiresAt)) || Date.parse(trial.expiresAt) > now);
    const trialRemaining = trialActive ? Math.max(0, Number(trial.remaining || 0)) : 0;
    const trialIncluded = trialActive ? Math.max(0, Number(trial.creditsTotal || 0)) : 0;
    const trialUsed = trialActive ? Math.max(0, Number(trial.creditsUsed || 0)) : 0;

    const effectiveIncluded = trialActive ? Math.max(Number(usage.includedLimit || 0), trialIncluded) : Number(usage.includedLimit || 0);
    const effectiveUsed = trialActive ? Math.max(Number(usage.includedUsed || 0), trialUsed) : Number(usage.includedUsed || 0);
    const effectiveRemaining = Math.max(0, Number(usage.remaining || 0)) + trialRemaining;

    const planName = plan
      ? plan.displayName
      : trialActive
      ? "Starter (Trial)"
      : "No Plan";

    res.json({
      agency,
      activeUsers, // For informational purposes only - no limits
      trial,
      subscription: {
        planTier,
        planName,
        status: agency.subscriptionStatus,
        currentPeriodEnd: agency.currentPeriodEnd,
        billingCurrency: agency.billingCurrency,
        billingCountry: agency.billingCountry,
        allowance: {
          monthlyIncluded: effectiveIncluded,
          monthlyUsed: effectiveUsed,
          monthlyRemaining: effectiveRemaining,
          totalRemaining: effectiveRemaining,
          addonBalance: usage.addonBalance,
          monthKey: usage.monthKey,
        },
      },
    });
  } catch (err) {
    console.error("[AGENCY] Get info error:", err);
    res.status(500).json({ error: "Failed to get agency info" });
  }
});

/**
 * GET /api/agency/members
 * List all members of the agency (admin only)
 */
router.get("/members", requireAuth, requireAgencyAdmin, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user as UserRecord;

    const members = await listAgencyUsers(user.agencyId!);

    // Return safe user data (no password hashes)
    const safeMembers = members.map((m) => ({
      id: m.id,
      email: m.email,
      emailVerified: m.emailVerified === true,
      name: m.name,
      firstName: m.firstName,
      lastName: m.lastName,
      displayName: getDisplayName(m),
      role: m.role || "member",
      isActive: m.isActive !== false,
      createdAt: m.createdAt,
    }));

    res.json({ members: safeMembers });
  } catch (err) {
    console.error("[AGENCY] List members error:", err);
    res.status(500).json({ error: "Failed to list members" });
  }
});

/**
 * POST /api/agency/invite
 * Invite a new member (admin only, seat limit enforced)
 */
router.post("/invite", requireAuth, requireAgencyAdmin, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user as UserRecord;
    const { email, role } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ error: "Email is required" });
    }

    if (role && role !== "admin" && role !== "member") {
      return res.status(400).json({ error: "Role must be 'admin' or 'member'" });
    }

    // Create invite (seat limit enforced inside)
    const result = await createInvite({
      agencyId: user.agencyId!,
      email: email.trim().toLowerCase(),
      role: role || "member",
      invitedByUserId: user.id,
    });

    if (!result.success) {
      return res.status(409).json({ error: result.error });
    }

    // Send invitation email
    const agency = await getAgency(user.agencyId!);
    const baseUrl = process.env.CLIENT_URL || "http://localhost:5173";
    const acceptUrl = `${baseUrl}/accept-invite?token=${result.invite!.token}`;

    const emailResult = await sendInvitationEmail({
      toEmail: email.trim().toLowerCase(),
      inviterName: getDisplayName(user),
      agencyName: agency?.name || "RealEnhance Agency",
      role: role || "member",
      inviteToken: result.invite!.token,
      acceptUrl,
    });

    if (!emailResult.ok) {
      console.error(`[INVITE] Failed to send email to ${email}:`, emailResult.error);
      // Still return success - invite was created even if email failed
    } else {
      console.log(`[INVITE] Email sent successfully to ${email}`);
    }

    res.status(201).json({
      invite: {
        inviteId: result.invite!.inviteId,
        email: result.invite!.email,
        role: result.invite!.role,
        token: result.invite!.token,
        expiresAt: result.invite!.expiresAt,
      },
      emailSent: emailResult.ok,
    });
  } catch (err) {
    console.error("[AGENCY] Invite error:", err);
    res.status(500).json({ error: "Failed to create invite" });
  }
});

/**
 * POST /api/agency/team-members
 * Create an agency team member directly (admin only)
 */
router.post("/team-members", requireAuth, requireAgencyAdmin, async (req: Request, res: Response) => {
  try {
    const adminUser = (req as any).user as UserRecord;
    const { fullName, email, password, role } = req.body || {};

    const cleanedName = typeof fullName === "string" ? fullName.trim() : "";
    const cleanedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    const cleanedPassword = typeof password === "string" ? password : "";
    const incomingRole = typeof role === "string" ? role.trim().toUpperCase() : "";
    const mappedRole = incomingRole === "OWNER" ? "owner" : incomingRole === "ADMIN" ? "admin" : incomingRole === "USER" ? "member" : "";

    if (!cleanedName) return res.status(400).json({ error: "Full name is required" });
    if (!cleanedEmail) return res.status(400).json({ error: "Email is required" });
    if (!cleanedPassword || cleanedPassword.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    if (!mappedRole) {
      return res.status(400).json({ error: "Role must be OWNER, ADMIN, or USER" });
    }

    // Non-owners cannot create owners
    if (mappedRole === "owner" && adminUser.role !== "owner") {
      return res.status(403).json({ error: "Only owners can create owner accounts" });
    }

    const existing = await getUserByEmail(cleanedEmail);
    if (existing) {
      return res.status(409).json({ error: "User with this email already exists" });
    }

    const [firstName, ...rest] = cleanedName.split(/\s+/).filter(Boolean);
    const lastName = rest.join(" ") || undefined;
    const passwordHash = await hashPassword(cleanedPassword);

    const created = await createUserWithPassword({
      email: cleanedEmail,
      name: cleanedName,
      firstName,
      lastName,
      passwordHash,
      agencyId: adminUser.agencyId!,
      role: mappedRole as "owner" | "admin" | "member",
    });

    const normalized = {
      id: created.id,
      email: created.email,
      emailVerified: created.emailVerified === true,
      name: created.name,
      firstName: created.firstName,
      lastName: created.lastName,
      displayName: getDisplayName(created),
      role: created.role || "member",
      isActive: created.isActive !== false,
      createdAt: created.createdAt,
    };

    return res.status(201).json({ user: normalized });
  } catch (err) {
    console.error("[AGENCY] Create team member error:", err);
    return res.status(500).json({ error: "Failed to create team member" });
  }
});

/**
 * GET /api/agency/invites
 * List pending invites (admin only)
 */
router.get("/invites", requireAuth, requireAgencyAdmin, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user as UserRecord;

    const invites = await listAgencyInvites(user.agencyId!);

    res.json({ invites });
  } catch (err) {
    console.error("[AGENCY] List invites error:", err);
    res.status(500).json({ error: "Failed to list invites" });
  }
});

/**
 * GET /api/agency/invite/info
 * Get invite information without accepting (for prefilling signup form)
 */
router.get("/invite/info", async (req: Request, res: Response) => {
  try {
    const { token } = req.query;

    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "Invite token is required" });
    }

    const invite = await getInviteByToken(token);

    if (!invite) {
      return res.status(404).json({ error: "Invite not found or expired" });
    }

    if (invite.acceptedAt) {
      return res.status(400).json({ error: "Invite already accepted" });
    }

    // Get agency info to show agency name
    const agency = await getAgency(invite.agencyId);

    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    res.json({
      email: invite.email,
      agencyName: agency.name,
      role: invite.role,
    });
  } catch (err) {
    console.error("[AGENCY] Get invite info error:", err);
    res.status(500).json({ error: "Failed to get invite information" });
  }
});

/**
 * POST /api/agency/invite/accept
 * Accept an invite and join the agency
 */
router.post("/invite/accept", async (req: Request, res: Response) => {
  try {
    const { token, password, name } = req.body;

    if (!token) {
      return res.status(400).json({ error: "Invite token is required" });
    }

    // Get invite
    const invite = await getInviteByToken(token);
    if (!invite) {
      return res.status(404).json({ error: "Invalid or expired invite" });
    }

    // Check if user already exists
    let user = await getUserByEmail(invite.email);

    if (user) {
      // Existing user - just link to agency
      if (user.agencyId) {
        return res.status(409).json({ error: "User already belongs to an agency" });
      }

      // Accept invite (seat limit re-checked inside)
      const acceptResult = await acceptInvite(token);
      if (!acceptResult.success) {
        return res.status(409).json({ error: acceptResult.error });
      }

      // Update user with agency info
      user = await updateUser(user.id, {
        agencyId: invite.agencyId,
        role: invite.role,
      });

      // Create session
      (req.session as any).user = {
        id: user.id,
        name: user.name,
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        displayName: getDisplayName(user),
        email: user.email,
        emailVerified: user.emailVerified === true,
        credits: user.credits,
        agencyId: user.agencyId ?? null,
        role: user.role || "member",
        hasSeenWelcome: user.hasSeenWelcome === false ? false : true,
      };

      return res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          agencyId: user.agencyId,
        },
      });
    }

    // New user - create account
    if (!password || !name) {
      return res.status(400).json({ error: "Password and name are required for new users" });
    }

    // Accept invite first (seat limit re-checked inside)
    const acceptResult = await acceptInvite(token);
    if (!acceptResult.success) {
      return res.status(409).json({ error: acceptResult.error });
    }

    // Create new user with password
    const passwordHash = await hashPassword(password);
    user = await createUserWithPassword({
      email: invite.email,
      name: name.trim(),
      passwordHash,
      agencyId: invite.agencyId,
      role: invite.role,
    });

    // Create session
    (req.session as any).user = {
      id: user.id,
      name: user.name,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      displayName: getDisplayName(user),
      email: user.email,
      emailVerified: user.emailVerified === true,
      credits: user.credits,
      agencyId: user.agencyId ?? null,
      role: user.role || "member",
      hasSeenWelcome: user.hasSeenWelcome === false ? false : true,
    };

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        agencyId: user.agencyId,
      },
    });
  } catch (err) {
    console.error("[AGENCY] Accept invite error:", err);
    res.status(500).json({ error: "Failed to accept invite" });
  }
});

/**
 * POST /api/agency/users/:userId/disable
 * Disable a user (admin only)
 */
router.post("/users/:userId/disable", requireAuth, requireAgencyAdmin, async (req: Request, res: Response) => {
  try {
    const currentUser = (req as any).user as UserRecord;
    const { userId } = req.params;

    const targetUser = await getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // Can only disable users in same agency
    if (targetUser.agencyId !== currentUser.agencyId) {
      return res.status(403).json({ error: "Cannot disable users from other agencies" });
    }

    // Cannot disable yourself
    if (targetUser.id === currentUser.id) {
      return res.status(400).json({ error: "Cannot disable yourself" });
    }

    // Cannot disable agency owner
    if (targetUser.role === "owner") {
      return res.status(403).json({ error: "Cannot disable agency owner" });
    }

    // Disable user
    const updatedUser = await updateUser(userId, { isActive: false });

    const clearedSessions = await invalidateSessionsForUser(userId);
    if (clearedSessions > 0) {
      console.log(`[AGENCY] Cleared ${clearedSessions} active session(s) for disabled user ${userId}`);
    }

    res.json({
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        isActive: updatedUser.isActive,
      },
    });
  } catch (err) {
    console.error("[AGENCY] Disable user error:", err);
    res.status(500).json({ error: "Failed to disable user" });
  }
});

/**
 * POST /api/agency/users/:userId/enable
 * Re-enable a disabled user (admin only, no seat limits)
 */
router.post("/users/:userId/enable", requireAuth, requireAgencyAdmin, async (req: Request, res: Response) => {
  try {
    const currentUser = (req as any).user as UserRecord;
    const { userId } = req.params;

    const targetUser = await getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // Can only enable users in same agency
    if (targetUser.agencyId !== currentUser.agencyId) {
      return res.status(403).json({ error: "Cannot enable users from other agencies" });
    }

    // Enable user (no seat limits)
    const updatedUser = await updateUser(userId, { isActive: true });

    res.json({
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        isActive: updatedUser.isActive,
      },
    });
  } catch (err) {
    console.error("[AGENCY] Enable user error:", err);
    res.status(500).json({ error: "Failed to enable user" });
  }
});

/**
 * PATCH /api/agency/profile
 * Update agency profile fields (admin only)
 */
router.patch("/profile", requireAuth, requireAgencyAdmin, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user as UserRecord;
    const agency = await getAgency(user.agencyId!);
    if (!agency) return res.status(404).json({ error: "Agency not found" });

    const { name, country, billingEmail } = req.body || {};
    const nextName = typeof name === "string" ? name.trim() : agency.name;
    const nextCountry = typeof country === "string" ? country.trim().toUpperCase() : agency.billingCountry;
    const nextBillingEmail = typeof billingEmail === "string" ? billingEmail.trim().toLowerCase() : agency.billingEmail;

    if (!nextName) return res.status(400).json({ error: "Agency name is required" });
    if (nextCountry && !["NZ", "AU", "ZA"].includes(nextCountry)) {
      return res.status(400).json({ error: "Country must be NZ, AU, or ZA" });
    }
    if (nextBillingEmail && !/^\S+@\S+\.\S+$/.test(nextBillingEmail)) {
      return res.status(400).json({ error: "Billing email is invalid" });
    }

    agency.name = nextName;
    agency.billingCountry = (nextCountry as any) || undefined;
    agency.billingEmail = nextBillingEmail || undefined;
    await updateAgency(agency);

    return res.json({ agency });
  } catch (err) {
    console.error("[AGENCY] Update profile error:", err);
    return res.status(500).json({ error: "Failed to update agency profile" });
  }
});

/**
 * POST /api/agency/bundles/checkout
 * Create Stripe checkout session for image bundle purchase (admin only)
 */
router.post("/bundles/checkout", requireAuth, requireAgencyAdmin, async (req: Request, res: Response) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Stripe not configured" });
    }

    const user = (req as any).user as UserRecord;
    if (user.emailVerified !== true) {
      return res.status(403).json({
        error: "EMAIL_NOT_VERIFIED",
        message: "Please confirm your email address before purchasing a plan.",
      });
    }
    const { bundleCode } = req.body;

    if (!bundleCode || !(bundleCode in IMAGE_BUNDLES)) {
      return res.status(400).json({ error: "Invalid bundle code" });
    }

    const bundle = IMAGE_BUNDLES[bundleCode as BundleCode];
    const agency = await getAgency(user.agencyId!);

    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    const hasActiveSubscription =
      !!agency.stripeSubscriptionId &&
      (agency.subscriptionStatus === "ACTIVE" || agency.subscriptionStatus === "TRIAL");
    const bundles = await getBundleHistory(user.agencyId!);
    const now = new Date();
    const paidBundleCredits = bundles.reduce((sum, b) => {
      if (b.bundleType !== "paid") return sum;
      if (!b.expiresAt || new Date(b.expiresAt) <= now) return sum;
      return sum + Math.max(0, Number(b.imagesPurchased || 0) - Number(b.imagesUsed || 0));
    }, 0);

    if (!hasActiveSubscription && paidBundleCredits <= 0) {
      console.log(
        `[BUNDLES] Checkout blocked for agency ${user.agencyId}: no active subscription and no paid bundle credits`
      );
      return res.status(403).json({
        code: "BUNDLE_PURCHASE_RESTRICTED",
        error: "Bundle purchase restricted",
        message: "Bundle purchases require an active subscription or existing paid bundle credits.",
      });
    }

    const stripePriceId = getBundleStripePriceId(bundle.code, "nzd");

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: stripePriceId
        ? [{ price: stripePriceId, quantity: 1 }]
        : [
            {
              price_data: {
                currency: "nzd",
                product_data: {
                  name: bundle.name,
                  description: bundle.description,
                },
                unit_amount: bundle.priceNZD * 100, // Convert to cents
              },
              quantity: 1,
            },
          ],
      metadata: {
        agencyId: user.agencyId!,
        bundleCode: bundle.code,
        images: bundle.images.toString(),
        purchasedByUserId: user.id,
        purchasedByEmail: user.email,
      },
      customer_email: user.email,
      success_url: `${process.env.CLIENT_URL || "http://localhost:5173"}/agency?bundle=success`,
      cancel_url: `${process.env.CLIENT_URL || "http://localhost:5173"}/agency?bundle=cancelled`,
    });

    console.log(`[BUNDLES] Created checkout session ${session.id} for agency ${user.agencyId}`);

    res.json({
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (err) {
    console.error("[BUNDLES] Checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

/**
 * GET /api/agency/bundles/history
 * Get bundle purchase history for the agency (admin only)
 */
router.get("/bundles/history", requireAuth, requireAgencyAdmin, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user as UserRecord;

    const bundles = await getBundleHistory(user.agencyId!);

    res.json({ bundles });
  } catch (err) {
    console.error("[BUNDLES] History error:", err);
    res.status(500).json({ error: "Failed to get bundle history" });
  }
});

export default router;
