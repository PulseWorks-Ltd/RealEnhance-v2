import { Pool } from "pg";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    throw new Error("DATABASE_URL is required for database access");
}
// Small helper to share a single pool across the server
export const pool = new Pool({ connectionString, max: 10 });
pool.on("error", (err) => {
    console.error("[db] Unexpected PG pool error", err);
});
export async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    }
    catch (err) {
        try {
            await client.query("ROLLBACK");
        }
        catch (rollbackErr) {
            console.error("[db] rollback failed", rollbackErr);
        }
        throw err;
    }
    finally {
        client.release();
    }
}
