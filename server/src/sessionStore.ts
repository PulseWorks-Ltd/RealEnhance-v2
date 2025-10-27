import session from "express-session";
import { createClient as createRedisClient } from "redis";
import connectRedisPkg from "connect-redis";
import { REDIS_URL, SESSION_SECRET, NODE_ENV } from "./config.js";

const RedisStore = connectRedisPkg(session);

export async function buildSessionMiddleware() {
  const redisClient = createRedisClient({ url: REDIS_URL });
  await redisClient.connect();

  const store = new (RedisStore as any)({
    client: redisClient,
    prefix: "realsess:"
  });

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
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  });

  return { middleware, redisClient };
}
