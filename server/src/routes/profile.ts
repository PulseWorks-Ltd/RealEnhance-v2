import { Router, Request, Response } from "express";
import { getUserById, updateUser } from "../services/users.js";
import { getDisplayName } from "@realenhance/shared/users.js";
import type { UserRecord } from "@realenhance/shared/types.js";

const router = Router();

function buildSessionUser(user: UserRecord) {
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
}

async function requireUser(req: Request, res: Response): Promise<UserRecord | null> {
  const sessUser = (req.session as any)?.user;
  if (!sessUser?.id) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  const user = await getUserById(sessUser.id);
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return null;
  }
  return user;
}

router.post("/update", async (req: Request, res: Response) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const { firstName, lastName } = req.body || {};
    const cleanedFirst = typeof firstName === "string" ? firstName.trim() : "";
    const cleanedLast = typeof lastName === "string" ? lastName.trim() : "";

    if (!cleanedFirst || !cleanedLast) {
      return res.status(400).json({ error: "First and last name are required" });
    }

    const updated = await updateUser(user.id, {
      firstName: cleanedFirst,
      lastName: cleanedLast,
      name: `${cleanedFirst} ${cleanedLast}`.trim(),
    });

    const sessionUser = buildSessionUser(updated);
    (req.session as any).user = sessionUser;

    return res.json({ user: sessionUser });
  } catch (err) {
    console.error("[profile] update error", err);
    return res.status(500).json({ error: "Failed to update profile" });
  }
});

export function profileRouter() {
  return router;
}
