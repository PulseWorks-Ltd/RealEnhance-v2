// server/src/index.ts
import express from "express";
import session from "express-session";
import RedisStore from "connect-redis";
import { createClient as createRedisClient } from "redis";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import dotenv from "dotenv";
import cors from "cors";
import session from "express-session";
import { createSessionStore } from "./sessionStore.js"; // your Redis store factory

const CLIENT_ORIGIN = process.env.PUBLIC_ORIGIN!; // e.g. https://client-production-3021.up.railway.app
const IS_PROD = process.env.NODE_ENV === "production";
import { attachGoogleAuth } from "./auth/google.js";
import { authUserRouter } from "./routes/authUser.js";

app.set("trust proxy", 1);

dotenv.config();

/* Paths */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const clientBuildDir = path.resolve(__dirname, "../../client/dist");

/* Env */
const PORT = process.env.PORT || "8080";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || "http://localhost:3000";

async function main() {
  // Redis client + store (connect-redis v7)
  const redisClient = createRedisClient({ url: REDIS_URL });
  await redisClient.connect();

  const store = new RedisStore({
    client: redisClient,
    prefix: "sess:",
  });

  // App
  const app = express();
  app.set("trust proxy", 1);

  app.use(
    cors({
      origin: CLIENT_ORIGIN,     // or (origin, cb) => cb(null, true) if you need wider
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );

  app.use(helmet());
  app.use(morgan("dev"));
  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Sessions
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

  // Health
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      env: process.env.NODE_ENV || "dev",
      time: new Date().toISOString(),
    });
  });

  // Auth + API
  attachGoogleAuth(app);
  app.use("/api/auth-user", authUserRouter());

  // Start
  app.listen(Number(PORT), () => {
    console.log(`[server] listening on port ${PORT}`);
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    await redisClient.quit();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[server] fatal startup error:", err);
  process.exit(1);
});
