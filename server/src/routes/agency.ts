// server/src/routes/agency.ts
// Agency management routes with seat enforcement

import { Router, type Request, type Response } from "express";
import Stripe from "stripe";
import {
  createAgency,
  getAgency,
  updateAgency,
  listAgencyUsers,
  isAgencyOverSeatLimit,
} from "@realenhance/shared/agencies.js";
import {
  createInvite,
  getInviteByToken,
  acceptInvite,
  listAgencyInvites,
} from "@realenhance/shared/invites.js";
import { getUserById, updateUser, getUserByEmail, createUserWithPassword } from "../services/users.js";
import type { UserRecord } from "@realenhance/shared/types.js";
import { hashPassword } from "../utils/password.js";
import { checkSeatLimitAtLogin } from "../middleware/seatLimitCheck.js";
import { IMAGE_BUNDLES, type BundleCode } from "@realenhance/shared/bundles.js";
import { getBundleHistory } from "@realenhance/shared/usage/imageBundles.js";

const router = Router();

// Initialize Stripe with secret key from environment
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-12-15.clover" })
  : null;

/**
 * Middleware to require authenticated user
 */
function requireAuth(req: Request, res: Response, next: Function) {
  const user = (req as any).user as UserRecord | undefined;
  if (!user) {
    return res.status(401).json({ error: "Authentication required" });
  }
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

    // Create agency
    const agency = await createAgency({
      name: name.trim(),
      planTier: planTier || "starter",
      ownerId: user.id,
    });

    // Update user to be agency owner
    const updatedUser = await updateUser(user.id, {
      agencyId: agency.agencyId,
      role: "owner",
    });

    res.status(201).json({
      agency,
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        name: updatedUser.name,
        agencyId: updatedUser.agencyId,
        role: updatedUser.role,
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

    const seatCheck = await isAgencyOverSeatLimit(user.agencyId);

    res.json({
      agency,
      seatUsage: {
        active: seatCheck.active,
        maxSeats: seatCheck.maxSeats,
        over: seatCheck.over,
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
      name: m.name,
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

    res.status(201).json({
      invite: {
        inviteId: result.invite!.inviteId,
        email: result.invite!.email,
        role: result.invite!.role,
        token: result.invite!.token,
        expiresAt: result.invite!.expiresAt,
      },
    });
  } catch (err) {
    console.error("[AGENCY] Invite error:", err);
    res.status(500).json({ error: "Failed to create invite" });
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
    let user = getUserByEmail(invite.email);

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

      // Check seat limit before creating session
      const seatCheck = await checkSeatLimitAtLogin(user);
      if (!seatCheck.allowed) {
        return res.status(403).json({
          error: "Agency seat limit exceeded",
          message: seatCheck.error,
          code: "SEAT_LIMIT_EXCEEDED",
        });
      }

      // Create session
      (req.session as any).user = {
        id: user.id,
        name: user.name,
        email: user.email,
        credits: user.credits,
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
    user = createUserWithPassword({
      email: invite.email,
      name: name.trim(),
      passwordHash,
      agencyId: invite.agencyId,
      role: invite.role,
    });

    // Check seat limit before creating session
    const seatCheck = await checkSeatLimitAtLogin(user);
    if (!seatCheck.allowed) {
      return res.status(403).json({
        error: "Agency seat limit exceeded",
        message: seatCheck.error,
        code: "SEAT_LIMIT_EXCEEDED",
      });
    }

    // Create session
    (req.session as any).user = {
      id: user.id,
      name: user.name,
      email: user.email,
      credits: user.credits,
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

    const targetUser = getUserById(userId);
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
 * Re-enable a disabled user (admin only, seat limit enforced)
 */
router.post("/users/:userId/enable", requireAuth, requireAgencyAdmin, async (req: Request, res: Response) => {
  try {
    const currentUser = (req as any).user as UserRecord;
    const { userId } = req.params;

    const targetUser = getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // Can only enable users in same agency
    if (targetUser.agencyId !== currentUser.agencyId) {
      return res.status(403).json({ error: "Cannot enable users from other agencies" });
    }

    // Check seat limit before enabling
    const seatCheck = await isAgencyOverSeatLimit(currentUser.agencyId!);
    if (seatCheck.over) {
      return res.status(409).json({
        error: `Cannot enable user - seat limit reached (${seatCheck.active}/${seatCheck.maxSeats})`,
      });
    }

    // Enable user
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
 * POST /api/agency/bundles/checkout
 * Create Stripe checkout session for image bundle purchase (admin only)
 */
router.post("/bundles/checkout", requireAuth, requireAgencyAdmin, async (req: Request, res: Response) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Stripe not configured" });
    }

    const user = (req as any).user as UserRecord;
    const { bundleCode } = req.body;

    if (!bundleCode || !(bundleCode in IMAGE_BUNDLES)) {
      return res.status(400).json({ error: "Invalid bundle code" });
    }

    const bundle = IMAGE_BUNDLES[bundleCode as BundleCode];
    const agency = await getAgency(user.agencyId!);

    if (!agency) {
      return res.status(404).json({ error: "Agency not found" });
    }

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
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
