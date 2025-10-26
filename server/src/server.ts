import express, { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import {
  NODE_ENV,
  PORT,
  PUBLIC_ORIGIN
} from "./config";
import type { CorsOptions } from "cors";
import { buildSessionMiddleware } from "./sessionStore";

// routes
import { authUserRouter } from "./routes/authUser";
import { uploadRouter } from "./routes/upload";
import { statusRouter } from "./routes/status";
import { galleryRouter } from "./routes/gallery";
import { editRouter } from "./routes/edit";
import { healthRouter } from "./routes/health";

// google auth (stubbed)
import { attachGoogleAuth } from "./auth/google";

async function main() {
  const app = express();
  app.set("trust proxy", 1);

  // logging
  app.use(morgan(NODE_ENV === "production" ? "combined" : "dev"));

  // security headers
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "script-src": [
            "'self'",
            "https://accounts.google.com"
          ],
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", "data:", "blob:"],
          "connect-src": [
            "'self'",
            ...PUBLIC_ORIGIN,
            "https://accounts.google.com",
            "https://www.googleapis.com"
          ],
          "frame-src": [
            "'self'",
            "https://accounts.google.com"
          ]
        }
      },
      crossOriginEmbedderPolicy: false
    })
  );

  // cors
  const corsOptions: CorsOptions = {
  origin(origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) {
    // you probably had something like:
    // allow localhost + your prod domain
    const allowed = [
      "http://localhost:5173",
      "http://localhost:3000",
      "https://your-production-domain.com"
    ];

    if (!origin || allowed.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error("Not allowed by CORS"));
    }
  },
  credentials: true
};

  app.use(cookieParser());
  app.use(express.json({ limit: "25mb" }));
  app.use(express.urlencoded({ extended: true }));

  // session (redis-backed)
  const { middleware: sessionMw } = await buildSessionMiddleware();
  app.use(sessionMw);

  // attach Google OAuth routes
  attachGoogleAuth(app);

  // API routes
  app.use("/api", authUserRouter());
  app.use("/api", uploadRouter());
  app.use("/api", statusRouter());
  app.use("/api", galleryRouter());
  app.use("/api", editRouter());
  app.use("/api", healthRouter());

  // static frontend
  const clientDistDir = path.join(process.cwd(), "client", "dist", "public");

  if (fs.existsSync(clientDistDir)) {
    app.use(express.static(clientDistDir, { index: false }));
  } else {
    console.warn(
      "[static] client/dist/public not found. Did you run `pnpm --filter client build`?"
    );
  }

  // SPA fallback
  app.get("*", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) {
      return next();
    }
    const indexHtmlPath = path.join(clientDistDir, "index.html");
    if (fs.existsSync(indexHtmlPath)) {
      return res.sendFile(indexHtmlPath);
    }
    return res
      .status(500)
      .send("Frontend build not found. Did you run client build?");
  });

  // error handler
  app.use(
    (
      err: any,
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      console.error("[server error]", err);
      res.status(500).json({
        ok: false,
        error: err?.message ?? "Internal Server Error"
      });
    }
  );

  app.listen(PORT, () => {
    console.log(`[RealEnhance] listening on ${PORT}`);
  });
}

main().catch(err => {
  console.error("Fatal boot error:", err);
  process.exit(1);
});
