import dotenv from "dotenv";
import path from "path";
import { Pool } from "pg";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "../..");
const envPath = path.resolve(serverRoot, ".env");
console.log("[env] Loading .env from:", envPath);
dotenv.config({ path: envPath });

function isRailwayInternalHost(urlValue: string): boolean {
  try {
    return new URL(urlValue).hostname.endsWith(".railway.internal");
  } catch {
    return false;
  }
}

const runningOnRailway = Boolean(
  process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID
);
const databaseUrl = process.env.DATABASE_URL;
const databasePublicUrl = process.env.DATABASE_PUBLIC_URL;

let connectionString = databaseUrl;

if (!runningOnRailway && databaseUrl && isRailwayInternalHost(databaseUrl) && databasePublicUrl) {
  connectionString = databasePublicUrl;
  console.warn("[db] DATABASE_URL points to Railway private host outside Railway; using DATABASE_PUBLIC_URL instead");
}

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is required for database access (or set DATABASE_PUBLIC_URL for local runs)"
  );
}

if (!runningOnRailway && isRailwayInternalHost(connectionString) && !databasePublicUrl) {
  throw new Error(
    "DATABASE_URL points to a Railway private host that is not reachable locally. Set DATABASE_PUBLIC_URL for local commands, or run this command inside Railway with `railway run ...`."
  );
}

// Small helper to share a single pool across the server
export const pool = new Pool({ connectionString, max: 10 });

pool.on("error", (err: Error) => {
  console.error("[db] Unexpected PG pool error", err);
});

export async function withTransaction<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("[db] rollback failed", rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}
