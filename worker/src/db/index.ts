import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for worker DB access");
}

export const pool = new Pool({ connectionString, max: 5 });

pool.on("error", (err) => {
  console.error("[worker-db] pool error", err);
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
      console.error("[worker-db] rollback failed", rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}
