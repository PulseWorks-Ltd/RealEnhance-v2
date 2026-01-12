import fs from "fs";
import path from "path";
import { pool } from "./index.js";

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

async function main() {
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
  await pool.end();
}

main().catch((err) => {
  console.error("[migrate] fatal", err);
  process.exit(1);
});
