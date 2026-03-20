import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./index.js";

async function waitForDatabase(maxRetries = 30, delayMs = 2000) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      await pool.query('SELECT 1');
      console.log('[migrate] Database connection established');
      return;
    } catch (err) {
      console.log(`[migrate] Waiting for database... (attempt ${i}/${maxRetries})`);
      if (i === maxRetries) {
        throw new Error(`Failed to connect to database after ${maxRetries} attempts: ${err}`);
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

async function ensureSchemaTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getApplied(): Promise<Set<string>> {
  const res = await pool.query("SELECT filename FROM schema_migrations");
  return new Set(res.rows.map((r) => r.filename as string));
}

async function applyMigration(filePath: string, filename: string) {
  
  // Wait for database to be ready before running migrations
  await waitForDatabase();
  
  const sql = await fs.promises.readFile(filePath, "utf8");
  console.log(`[migrate] applying ${filename}`);
  await pool.query("BEGIN");
  try {
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations(filename) VALUES ($1)", [filename]);
    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error(`[migrate] failed on ${filename}`, err);
    throw err;
  }
}

export async function runMigrations() {
  const migrationsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "migrations");
  await ensureSchemaTable();
  const applied = await getApplied();
  const files = (await fs.promises.readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const fullPath = path.join(migrationsDir, file);
    await applyMigration(fullPath, file);
  }
  console.log("[migrate] done");
}

async function main() {
  await runMigrations();
  await pool.end();
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error("[migrate] fatal", err);
    process.exit(1);
  });
}
