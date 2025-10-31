// server/src/index.ts
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import morgan from "morgan";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import { createClient as createRedisClient } from "redis";
import connectRedis from "connect-redis";
import { createSessionStore } from "./sessionStore.js";

import { attachGoogleAuth } from "./auth/google.js";
import { authUserRouter } from "./routes/authUser.js";

const {
  NODE_ENV,
  PORT = "8080",
  SESSION_SECRET = "dev-secret",
  REDIS_URL = "redis://localhost:6379",
  PUBLIC_ORIGIN = "http://localhost:3000",
} = process.env;

const IS_PROD = NODE_ENV === "production";
const CLIENT_ORIGIN = process.env.PUBLIC_ORIGIN!;

app.set("trust proxy", 1);

async function main() {
  // --- Express app
  const app = express();
  app.set("trust proxy", 1);

  // --- Infra middleware
  app.use(morgan("dev"));
  app.use(helmet());
  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // --- CORS (allow client origin + cookies)
  app.use(
    cors({
      origin: CLIENT_ORIGIN,     // or (origin, cb) => cb(null, true) if you need wider
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );

  // --- Redis sessions (connect-redis v7)
  const redisClient = createRedisClient({ url: REDIS_URL });
  await redisClient.connect();

  // create class and instantiate
  const RedisStore = connectRedis(session);
  const store = await createSessionStore(); // returns a connect-redis store
  app.use(
    session({
      store,
      name: "realsess",
      secret: process.env.SESSION_SECRET!,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        // 🔴 CRITICAL for cross-site fetches:
        sameSite: IS_PROD ? "none" : "lax",
        secure: IS_PROD,             // Railway is HTTPS, so this is fine
        maxAge: 1000 * 60 * 60 * 24 * 7,
      },
    })
  );


  app.use(
    session({
      store,
      name: "realsess",
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: IS_PROD ? "none" : "lax",
        secure: IS_PROD,
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      },
    })
  );

  // --- Health
  app.get("/health", (_req, res) => {
    res.json({ ok: true, env: NODE_ENV ?? "dev", time: new Date().toISOString() });
  });

  // --- Auth + API
  attachGoogleAuth(app);
  app.use("/api/auth-user", authUserRouter());

  // --- Start
  app.listen(Number(PORT), () => {
    console.log(`[server] listening on port ${PORT}`);
  });

  // --- Graceful shutdown
  process.on("SIGTERM", async () => {
    try { await redisClient.quit(); } finally { process.exit(0); }
  });
}

main().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});

