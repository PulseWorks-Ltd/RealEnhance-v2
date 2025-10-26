import { Express, Request, Response } from "express";
import { upsertUserFromGoogle } from "../services/users";

/**
 * TODO: Replace this stub with your actual Google OAuth flow.
 *
 * You previously had working logic in google.ts (passport / OAuth2).
 * Port that here, then at the end of callback do:
 *
 *   const user = upsertUserFromGoogle({ email, name });
 *   (req.session as any).user = {
 *     id: user.id,
 *     name: user.name,
 *     email: user.email,
 *     credits: user.credits
 *   };
 *   res.redirect("/"); // or dashboard
 *
 * The attachGoogleAuth() function just mounts those routes.
 */
export function attachGoogleAuth(app: Express) {
  // Example placeholder:
  app.get("/auth/google", (_req: Request, res: Response) => {
    res
      .status(501)
      .send("Google OAuth not yet wired in this refactor. TODO: implement.");
  });

  app.get("/auth/google/callback", (req: Request, res: Response) => {
    // TODO: exchange code -> Google profile -> upsertUserFromGoogle -> set session
    res
      .status(501)
      .send("Google OAuth callback not yet wired. TODO: implement.");
  });

  app.post("/auth/logout", (req: Request, res: Response) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });
}
