// server/src/session.ts (or sessionStore.ts)

import session from "express-session";
import RedisStore from "connect-redis";
import { createClient as createRedisClient, type RedisClientType } from "redis";
import { REDIS_URL, SESSION_SECRET, NODE_ENV } from "./config.js";

export type SessionBuildResult = {
  middleware: ReturnType<typeof session>;
  redisClient: RedisClientType;
};

export async function buildSessionMiddleware(): Promise<SessionBuildResult> {
  // 1) Create and connect the Redis client (redis@^4)
  const redisClient = createRedisClient({ url: REDIS_URL });
  await redisClient.connect();

  // 2) Create the store (connect-redis@^7 uses 'new RedisStore({...})')
  const store = new RedisStore({
    client: redisClient,
    prefix: "realsess:",
  });

  // 3) Build the express-session middleware
  const middleware = session({
    store,
    name: "realsess",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  });

  return { middleware, redisClient };
}
