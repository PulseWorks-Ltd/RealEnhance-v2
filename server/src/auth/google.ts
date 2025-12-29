import type { Express, Request, Response, NextFunction } from "express";
import passport from "passport";
import { Strategy as GoogleStrategy, type StrategyOptions } from "passport-google-oauth20";
import { upsertUserFromGoogle, getUserByEmail } from "../services/users.js";
// Seat limits removed - unlimited users per agency

/** Resolve public base URL safely (prod vs local) */
function getBaseUrl(): string {
  const base =
    process.env.OAUTH_BASE_URL || process.env.BASE_URL || "http://localhost:5000";
  return base.replace(/\/+$/, "");
}

/** Configure Passport Google strategy */
function initPassport() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env as Record<string, string | undefined>;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.warn("[auth] Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Google login will fail.");
  }

  const opts: StrategyOptions = {
    clientID: GOOGLE_CLIENT_ID || "",
    clientSecret: GOOGLE_CLIENT_SECRET || "",
    callbackURL: `${getBaseUrl()}/auth/google/callback`,
  };

  // Helpful startup log to verify redirect URI configuration in prod
  try {
    console.log("[auth] Google OAuth callbackURL:", (opts as any).callbackURL);
    if (process.env.PUBLIC_ORIGIN) {
      console.log("[auth] PUBLIC_ORIGIN:", process.env.PUBLIC_ORIGIN);
    }
  } catch {
    /* noop */
  }

  passport.use(
    new GoogleStrategy(
      opts,
      // (NO req param here → matches StrategyOptions overload)
      async (accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;
          const name = profile.displayName ?? "Unnamed User";
          if (!email) return done(new Error("No email returned from Google profile"));

          const user = await Promise.resolve(
            upsertUserFromGoogle({ email, name })
          );

          const sessionUser = {
            id: (user as any).id,
            name: (user as any).name,
            email: (user as any).email,
            credits: (user as any).credits,
          };

          return done(null, sessionUser as any);
        } catch (err) {
          return done(err as Error);
        }
      }
    )
  );

  // Minimal session payload with broad typing to satisfy TS
  passport.serializeUser((user: any, done) => {
    done(null, user);
  });
  passport.deserializeUser((obj: any, done) => {
    done(null, obj);
  });
}

/** Ensure passport middleware is mounted (after express-session) */
function ensurePassportInit(app: Express) {
  app.use(passport.initialize());
  app.use(passport.session());
}

export function attachGoogleAuth(app: Express) {
  initPassport();
  ensurePassportInit(app);

  // Step 1: start Google OAuth
  app.get(
    "/auth/google",
    passport.authenticate("google", {
      scope: ["profile", "email"],
      prompt: "select_account",
    }) as unknown as (req: any, res: any, next: NextFunction) => void
  );

  // Step 2: callback
  app.get(
    "/auth/google/callback",
    passport.authenticate("google", {
      failureRedirect: "/login?error=google_oauth_failed",
      session: true,
    }) as unknown as (req: any, res: any, next: NextFunction) => void,
    async (req: Request, res: Response) => {
      const authed: any = (req as any).user;

      (req.session as any).user = {
        id: authed.id,
        name: authed.name ?? null,
        email: authed.email,
        credits: authed.credits,
      };

      const clientOrigins = (process.env.PUBLIC_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
      const client = clientOrigins[0] || "http://localhost:3000";
      // Redirect directly to the client origin to complete auth; the client route
      // will signal back to the opener and close the popup, avoiding COOP/CSP issues.
      const toClient = new URL("/auth/complete", client).toString();
      res.redirect(toClient);
    }
  );

  // Logout
  app.post("/auth/logout", (req: Request, res: Response, next: NextFunction) => {
    (req as any).logout?.((err: unknown) => {
      if (err) return next(err as Error);
      req.session.destroy(() => {
        res.clearCookie("connect.sid", {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
        });
        res.json({ ok: true });
      });
    });
  });

  // Note: We previously hosted a server-side /auth/complete shim. We now
  // redirect directly to the client to finish the flow.
}
