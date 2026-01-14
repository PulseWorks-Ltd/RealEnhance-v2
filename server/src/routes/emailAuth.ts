import { Router, Request, Response } from "express";
import { createUserWithPassword, getUserByEmail, getUserById, updateUser } from "../services/users.js";
import { hashPassword, comparePassword, validatePassword, validateEmail } from "../utils/password.js";
import { createResetToken, consumeResetToken, checkResetThrottle } from "../services/passwordResetTokens.js";
import { sendPasswordResetEmail } from "../services/email.js";
import { getDisplayName } from "@realenhance/shared/users.js";
import type { UserRecord } from "@realenhance/shared/types.js";
// Seat limits removed - unlimited users per agency

export function emailAuthRouter() {
  const r = Router();

  const genericResetMessage = {
    message: "If an account exists for that email, we've sent a reset link.",
  } as const;

  const buildSessionUser = (user: UserRecord) => {
    const displayName = getDisplayName(user);
    return {
      id: user.id,
      name: user.name ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      displayName,
      email: user.email,
      credits: user.credits,
      agencyId: user.agencyId ?? null,
      role: user.role ?? "member",
    };
  };

  const requireAuthedUser = async (req: Request, res: Response): Promise<UserRecord | null> => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser?.id) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    const full = await getUserById(sessUser.id);
    if (!full) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }

    if (full.isActive === false) {
      res.status(403).json({ error: "USER_DISABLED", message: "Account is disabled" });
      return null;
    }
    return full;
  };

  // POST /api/auth/signup - Create new user with email+password
  r.post("/signup", async (req: Request, res: Response) => {
    try {
      const { email, password, firstName, lastName, name } = req.body;

      // Validate email format
      const emailValidation = validateEmail(email);
      if (!emailValidation.valid) {
        return res.status(400).json({ error: emailValidation.error });
      }

      // Validate password strength
      const passwordValidation = validatePassword(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }

      const cleanedFirst = firstName?.trim();
      const cleanedLast = lastName?.trim();
      const cleanedLegacyName = name?.trim();
      const combinedName = `${cleanedFirst || ""} ${cleanedLast || ""}`.trim();

      if (!cleanedFirst || !cleanedLast) {
        if (!cleanedLegacyName) {
          return res.status(400).json({ error: "First and last name are required" });
        }
      }

      // Check if user already exists
      const existingUser = await getUserByEmail(email);
      if (existingUser) {
        return res.status(409).json({ error: "User with this email already exists" });
      }

      // Hash password
      const passwordHash = await hashPassword(password);

      // Create user
      const newUser = await createUserWithPassword({
        email: email.toLowerCase().trim(),
        name: cleanedLegacyName || combinedName || email.toLowerCase().trim(),
        firstName: cleanedFirst,
        lastName: cleanedLast,
        passwordHash
      });

      const sessionUser = buildSessionUser(newUser);

      // Create session (same as Google OAuth)
      (req.session as any).user = sessionUser;

      // Return user (without password fields)
      res.status(201).json(sessionUser);

    } catch (error) {
      console.error("[emailAuth] Signup error:", error);
      res.status(500).json({ error: "Failed to create account" });
    }
  });

  // POST /api/auth/login - Login with email+password
  r.post("/login", async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;

      // Validate inputs
      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }

      // Find user by email
      const user = await getUserByEmail(email.toLowerCase().trim());
      if (!user) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      if (user.isActive === false) {
        return res.status(403).json({ error: "Account disabled", code: "USER_DISABLED" });
      }

      // Check if this is an OAuth-only user (no password set)
      if (!user.passwordHash) {
        return res.status(400).json({
          error: "This account has no password set. Sign in with Google, then you can set a password in Settings.",
          code: "AUTH_NO_PASSWORD",
          isOAuthOnly: true,
          authProvider: user.authProvider
        });
      }

      // Verify password
      const isValidPassword = await comparePassword(password, user.passwordHash);
      if (!isValidPassword) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const sessionUser = buildSessionUser(user);
      (req.session as any).user = sessionUser;

      // Return user (without password fields)
      res.json(sessionUser);

    } catch (error) {
      console.error("[emailAuth] Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // POST /api/auth/request-reset - non-enumerating
  r.post("/request-reset", async (req: Request, res: Response) => {
    const emailRaw = (req.body?.email || "").toString().trim().toLowerCase();
    const requesterIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip;

    try {
      if (!emailRaw) return res.status(200).json(genericResetMessage);

      const throttle = await checkResetThrottle(emailRaw, requesterIp);
      if (!throttle.allowed) {
        console.warn(`[reset] throttled for ${emailRaw} ip=${requesterIp} counts`, throttle);
        return res.status(200).json(genericResetMessage);
      }

      const user = await getUserByEmail(emailRaw);
      if (user && user.isActive === false) {
        console.warn(`[reset] disabled user requested reset ${emailRaw}`);
        return res.status(200).json(genericResetMessage);
      }
      if (!user || !user.passwordHash) {
        return res.status(200).json(genericResetMessage);
      }

      const { token, expiresAt } = await createResetToken(user.id, user.email);
      const ttlMinutes = Number(process.env.RESET_TOKEN_TTL_MINUTES || 30);

      const baseEnv = process.env.RESET_BASE_URL?.replace(/\/+$/, "");
      const originHeader = (req.headers.origin as string | undefined)?.replace(/\/+$/, "");
      const hostDerived = `${req.protocol}://${req.get("host")}`.replace(/\/+$/, "");
      const base = baseEnv || originHeader || hostDerived;
      const resetLink = `${base}/reset-password?token=${encodeURIComponent(token)}`;

      const emailResult = await sendPasswordResetEmail({
        toEmail: user.email,
        resetLink,
        displayName: getDisplayName(user),
        ttlMinutes,
      });

      if (!emailResult.ok) {
        console.warn(`[reset] failed to send email to ${user.email}:`, emailResult.error);
      } else {
        console.log(`[reset] email queued for ${user.email}, expires ${expiresAt}`);
      }
    } catch (err) {
      console.error("[reset] request-reset error", err);
    }

    return res.status(200).json(genericResetMessage);
  });

  // POST /api/auth/confirm-reset
  r.post("/confirm-reset", async (req: Request, res: Response) => {
    try {
      const { token, newPassword } = req.body;

      if (!token || !newPassword) {
        return res.status(400).json({ error: "Invalid or expired link." });
      }

      const passwordValidation = validatePassword(newPassword);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }

      const tokenResult = await consumeResetToken(token);
      if (!tokenResult) {
        return res.status(400).json({ error: "Invalid or expired link." });
      }

      const user = await getUserById(tokenResult.userId);
      if (!user || user.email.toLowerCase() !== tokenResult.email.toLowerCase()) {
        return res.status(400).json({ error: "Invalid or expired link." });
      }

      if (user.isActive === false) {
        return res.status(403).json({ error: "Account is disabled", code: "USER_DISABLED" });
      }

      if (user.passwordHash) {
        const same = await comparePassword(newPassword, user.passwordHash);
        if (same) {
          return res.status(400).json({ error: "New password must be different from the old password" });
        }
      }

      const passwordHash = await hashPassword(newPassword);
      await updateUser(user.id, { passwordHash });

      console.log(`[reset] password reset for user ${user.id}`);
      return res.json({ ok: true });
    } catch (err) {
      console.error("[reset] confirm-reset error", err);
      return res.status(400).json({ error: "Invalid or expired link." });
    }
  });

  // POST /api/auth/change-password (authenticated)
  r.post("/change-password", async (req: Request, res: Response) => {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: "Current and new passwords are required" });
      }

      const user = await requireAuthedUser(req, res);
      if (!user) return;

      if (!user.passwordHash) {
        return res.status(400).json({ error: "Password not set for this account" });
      }

      const matches = await comparePassword(currentPassword, user.passwordHash);
      if (!matches) {
        return res.status(400).json({ error: "Current password is incorrect" });
      }

      const passwordValidation = validatePassword(newPassword);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }

      const same = await comparePassword(newPassword, user.passwordHash);
      if (same) {
        return res.status(400).json({ error: "New password must be different from the old password" });
      }

      const passwordHash = await hashPassword(newPassword);
      const updated = await updateUser(user.id, { passwordHash });

      // Refresh session
      (req.session as any).user = buildSessionUser(updated);

      return res.json({ ok: true });
    } catch (err) {
      console.error("[auth] change-password error", err);
      return res.status(500).json({ error: "Failed to change password" });
    }
  });

  // POST /api/auth/set-password - Set password for OAuth-only users (authenticated)
  r.post("/set-password", async (req: Request, res: Response) => {
    try {
      const { newPassword } = req.body;

      if (!newPassword) {
        return res.status(400).json({ error: "Password is required" });
      }

      const user = await requireAuthedUser(req, res);
      if (!user) return;

      // Check if user already has a password
      if (user.passwordHash) {
        return res.status(400).json({
          error: "Password already set. Use 'Change Password' instead.",
          code: "PASSWORD_ALREADY_SET"
        });
      }

      // Validate password strength
      const passwordValidation = validatePassword(newPassword);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }

      // Hash and set password
      const passwordHash = await hashPassword(newPassword);
      user.passwordHash = passwordHash;

      // Update authProvider to "both" if was Google-only
      if (user.authProvider === "google") {
        user.authProvider = "both";
      }

      const updated = await updateUser(user.id, { passwordHash, authProvider: user.authProvider });

      // Refresh session
      (req.session as any).user = buildSessionUser(updated);

      console.log(`[auth] Password set for OAuth user ${user.id}`);
      return res.json({
        ok: true,
        message: "Password set successfully. You can now log in with email and password."
      });
    } catch (err) {
      console.error("[auth] set-password error", err);
      return res.status(500).json({ error: "Failed to set password" });
    }
  });

  return r;
}
