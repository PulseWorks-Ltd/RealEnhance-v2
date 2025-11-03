import type { Express, Request, Response, NextFunction } from "express";
import passport from "passport";
import { Strategy as GoogleStrategy, type StrategyOptions } from "passport-google-oauth20";
import { upsertUserFromGoogle } from "../services/users.js";

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
    (req: Request, res: Response) => {
      const authed: any = (req as any).user;
      (req.session as any).user = {
        id: authed.id,
        name: authed.name ?? null,
        email: authed.email,
        credits: authed.credits,
      };

      const clientOrigins = (process.env.PUBLIC_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
      const client = clientOrigins[0] || "http://localhost:3000";
      const to = new URL("/auth/complete", `${req.protocol}://${req.get("host")}`).toString() +
        `?to=${encodeURIComponent(client)}`;
      res.redirect(to);
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

  // Finalization page: posts a message back to opener then redirects to client
  app.get("/auth/complete", (_req: Request, res: Response) => {
    // Allow opener access from a different origin for this one-off page
    res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
    // No inline scripts here to satisfy strict CSP. We'll load an external script from same origin.
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Signing you in…</title>
  </head>
  <body>
    <p>Signing you in…</p>
    <script src="/auth/complete.js" defer></script>
    <noscript>
      <p><a id="redir" href="#">Continue</a></p>
      <script>
        // This <noscript> is decorative – if JS is disabled there's nothing we can do.
      </script>
    </noscript>
  </body>
 </html>`);
  });

  // External JS used by /auth/complete to avoid inline-script CSP issues
  app.get("/auth/complete.js", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    // Allow cross-origin opener so we can access window.opener for postMessage
    res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
    const fallbackClient = (process.env.PUBLIC_ORIGIN || "http://localhost:3000").split(",")[0];
    // Small JS bundle (string-literal) – safe and simple
    res.send(`(function(){
  try {
    var url = new URL(window.location.href);
    var client = url.searchParams.get('to') || ${JSON.stringify(fallbackClient)};
    try {
      if (window.opener && typeof window.opener.postMessage === 'function') {
        window.opener.postMessage({ type: 'auth:success' }, client);
      }
    } catch (e) { /* ignore */ }
    setTimeout(function(){ try { window.location.replace(client); } catch(_) { window.location.href = client; } }, 50);
  } catch (e) {
    // As a last resort, navigate to fallback client
    try { window.location.replace(${JSON.stringify(fallbackClient)}); } catch(_) {}
  }
})();`);
  });
}
