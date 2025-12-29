// server/src/middleware/seatLimitCheck.ts
// Middleware to enforce agency seat limits at login

import type { Request, Response, NextFunction } from "express";
import { isAgencyOverSeatLimit } from "@realenhance/shared/agencies.js";
import type { UserRecord } from "@realenhance/shared/types.js";

/**
 * Enforce seat limit at login/session refresh
 *
 * Rule: If user belongs to agency AND agency is over limit:
 * - Allow owner/admin to log in (so they can fix it)
 * - Block members from logging in
 */
export async function checkSeatLimitAtLogin(
  user: UserRecord
): Promise<{ allowed: boolean; error?: string }> {
  // If user has no agency, allow login
  if (!user.agencyId) {
    return { allowed: true };
  }

  // Check if agency is over seat limit
  const seatCheck = await isAgencyOverSeatLimit(user.agencyId);

  if (!seatCheck.over) {
    // Under limit, allow login
    return { allowed: true };
  }

  // Over limit - check user role
  const userRole = user.role || "member";

  if (userRole === "owner" || userRole === "admin") {
    // Allow owners/admins to log in even when over limit
    console.log(`[SEAT LIMIT] Allowing ${userRole} ${user.email} to log in despite being over limit`);
    return { allowed: true };
  }

  // Block members when over limit
  console.log(`[SEAT LIMIT] Blocking member ${user.email} - agency over limit (${seatCheck.active}/${seatCheck.maxSeats})`);
  return {
    allowed: false,
    error: `Your agency is over its seat limit (${seatCheck.active}/${seatCheck.maxSeats}). Please contact your administrator to upgrade or remove users.`,
  };
}

/**
 * Express middleware to check seat limits for authenticated users
 */
export function seatLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user as UserRecord | undefined;

  if (!user) {
    // No user in session, continue (will be handled by auth middleware)
    return next();
  }

  checkSeatLimitAtLogin(user)
    .then((result) => {
      if (!result.allowed) {
        return res.status(403).json({
          error: "Agency seat limit exceeded",
          message: result.error,
          code: "SEAT_LIMIT_EXCEEDED",
        });
      }
      next();
    })
    .catch((err) => {
      console.error("[SEAT LIMIT] Error checking seat limit:", err);
      // Fail open - allow login if check fails
      next();
    });
}
