import { Router, Request, Response } from "express";
import { getUserById } from "../services/users.js";
import { getDisplayName } from "@realenhance/shared/users.js";
import { listImagesForUser } from "../services/images.js";

export function authUserRouter() {
  const r = Router();

  // Primary route expected by client: GET /api/auth-user
  r.get("/", async (req: Request, res: Response) => {
    const sessUser = (req.session as any)?.user;
    if (!sessUser) return res.status(401).json({ error: "Unauthorized" });

    const full = await getUserById(sessUser.id);
    if (!full) return res.status(401).json({ error: "Unauthorized" });

    // Ensure the session is hydrated with agency + role for downstream auth checks
    const displayName = getDisplayName(full);

    (req.session as any).user = {
      id: full.id,
      name: full.name ?? null,
      firstName: full.firstName ?? null,
      lastName: full.lastName ?? null,
      displayName,
      email: full.email,
      emailVerified: full.emailVerified === true,
      credits: full.credits,
      agencyId: full.agencyId ?? null,
      role: (full.role as any) ?? "member",
      hasSeenWelcome: full.hasSeenWelcome === false ? false : true,
    };

    const includeImages = String((req.query as any)?.includeImages || "0") === "1";

    // Compute site-admin flag from env allowlist (not stored on user record)
    const adminEmails = (process.env.REALENHANCE_ADMIN_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const isSiteAdmin = full.email ? adminEmails.includes(full.email.toLowerCase()) : false;

    const payload: any = {
      id: full.id,
      name: full.name,
      firstName: full.firstName,
      lastName: full.lastName,
      displayName,
      email: full.email,
      emailVerified: full.emailVerified === true,
      credits: full.credits,
      agencyId: full.agencyId,
      role: full.role,
      hasSeenWelcome: full.hasSeenWelcome === false ? false : true,
      isSiteAdmin,
    };

    if (includeImages) {
      try {
        const imgs = listImagesForUser(full.id);
        payload.images = imgs.map((img: any) => ({
          imageId: img.imageId,
          currentVersionId: img.currentVersionId,
          roomType: img.roomType,
          sceneType: img.sceneType,
          history: Array.isArray(img.history)
            ? img.history.map((v: any) => ({
                versionId: v.versionId,
                stageLabel: v.stageLabel,
                filePath: v.filePath,
                note: v.note,
                createdAt: v.createdAt,
              }))
            : [],
        }));
      } catch (err) {
        console.warn("[auth-user] optional images payload failed:", (err as any)?.message || err);
        payload.images = [];
      }
    }

    res.json(payload);
  });

  // Backwards-compat alias: GET /api/auth-user/auth/user
  r.get("/auth/user", (req: Request, res: Response) => {
    (r as any).handle({ ...req, url: "/" }, res);
  });

  return r;
}
