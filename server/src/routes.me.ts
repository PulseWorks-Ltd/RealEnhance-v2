// server/src/routes.me.ts
import type { Express, Request, Response } from "express";

export function registerMeRoutes(app: Express) {
  // --- /api/me ---
  app.get("/api/me", (req: Request, res: Response) => {
    const user =
      (req as any).user || (req.session as any)?.user || null;
    const credits = Number(user?.credits ?? 0);
    const isAuthenticated = !!user;
    res.json({ isAuthenticated, credits, user });
  });

  // --- /api/auth-user ---
  app.get("/api/auth-user", (req: Request, res: Response) => {
    const user =
      (req as any).user || (req.session as any)?.user || null;
    res.json({ user });
  });
}
