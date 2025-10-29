import type { Express, Request, Response, NextFunction } from "express";
import passport, { Profile } from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { upsertUserFromGoogle } from "../services/users.js";

/**
 * Resolve base URL safely (prod vs local)
 */
function getBaseUrl() {
  const base =
    process.env.OAUTH_BASE_URL ||
    process.env.BASE_URL ||
    "http://localhost:5000";

  return base.replace(/\/+$/, ""); // strip trailing slash
}

// Configure Passport's Google Strategy
function initPassport() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
  } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.warn(
      "[auth] Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Google login will fail."
    );
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID || "",
        clientSecret: GOOGLE_CLIENT_SECRET || "",
        callbackURL: `${getBaseUrl()}/auth/google/callback`,
      },
      async (
        accessToken: string,
        refreshToken: string,
        profile: Profile,
        done
      ) => {
        try {
          // Extract basic fields from Google profile
          const email =
            profile.emails && profile.emails[0]
              ? profile.emails[0].value
              : undefined;
          const name = profile.displayName || "Unnamed User";

          if (!email) {
            return done(
              new Error("No email returned from Google profile"),
              undefined
            );
          }

          // upsert user in DB and get normalized user object back
          const user = await upsertUserFromGoogle({
            email,
            name,
          });

          // done(null, user) passes the user to serializeUser below
          return done(null, {
            id: user.id,
            name: user.name,
            email: user.email,
            credits: user.credits,
          });
        } catch (err) {
          return done(err as Error, undefined);
        }
      }
    )
  );

  // Put minimal info into the session
  passport.serializeUser((user: any, done) => {
    done(null, user);
  });

  // Read minimal info back out of the session
  passport.deserializeUser((obj: any, done) => {
    done(null, obj);
  });
}

// Middleware wrapper to make sure passport is initialized before use
function ensurePassportInit(app: Express) {
  // Important: express-session MUST already be mounted before this point
  app.use(passport.initialize());
  app.use(passport.session());
}

export function attachGoogleAuth(app: Express) {
  // 1. Configure passport strategy once
  initPassport();

  // 2. Hook passport into the express app
  ensurePassportInit(app);

  /**
   * Step 1: Kick off Google OAuth
   * Frontend should redirect user to /auth/google
   */
  app.get(
    "/auth/google",
    passport.authenticate("google", {
      scope: ["profile", "email"],
      prompt: "select_account",
    })
  );

  /**
   * Step 2: Google callback
   * Google calls this URL with ?code=...
   * We authenticate, then stuff the user into req.session for our app.
   */
  app.get(
    "/auth/google/callback",
    passport.authenticate("google", {
      failureRedirect: "/login?error=google_oauth_failed",
      session: true,
    }),
    (req: Request, res: Response) => {
      // By this point:
      // - `passport.authenticate` ran our GoogleStrategy verify fn
      // - `done(null, userInfo)` was called
      // - passport.serializeUser stored it in the session
      //
      // We ALSO mirror into req.session.user for your frontend code.
      // (Some frontend code is probably doing /api/auth-user after login.)
      //
      // Types: req.user is set by Passport
      const authedUser = req.user as any;

      // Put the user in session in the shape your UI expects
      (req.session as any).user = {
        id: authedUser.id,
        name: authedUser.name,
        email: authedUser.email,
        credits: authedUser.credits,
      };

      // Redirect somewhere nice ("/" or "/dashboard")
      res.redirect("/");
    }
  );

  /**
   * Logout: destroy session and clear cookie
   */
  app.post("/auth/logout", (req: Request, res: Response, next: NextFunction) => {
    req.logout?.((err) => {
      if (err) return next(err);

      req.session.destroy(() => {
        // Tell browser to drop cookie
        res.clearCookie("connect.sid", {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
        });

        res.json({ ok: true });
      });
    });
  });
}
