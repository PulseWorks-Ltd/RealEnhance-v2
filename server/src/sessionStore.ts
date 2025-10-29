// server/src/session.ts (or sessionStore.ts)

import session from "express-session";
import RedisStore from "connect-redis";
import { createClient } from "redis";
import { REDIS_URL, SESSION_SECRET, NODE_ENV } from "./config.js";

export type SessionBuildResult = {
  middleware: ReturnType<typeof session>;
  redisClient: RedisClientType;
};

export async function createSessionStore() {
  const client = createClient({ url: process.env.REDIS_URL! });
  await client.connect();

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

  return new RedisStore({ client: client as any, prefix: "sess:" });
}
