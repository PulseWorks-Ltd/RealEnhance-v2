import { Router } from "express";
import { getAllUsers } from "@realenhance/shared/users.js";
import { pool } from "../db/index.js";

const router = Router();

const OWNERSHIP_TABLES = ["organisations", "agency_accounts"] as const;

type OwnershipTable = (typeof OWNERSHIP_TABLES)[number];
type OwnershipSchema = Map<OwnershipTable, Set<string>>;

async function inspectOwnershipSchema(): Promise<OwnershipSchema> {
  const result = await pool.query(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position
    `,
    [OWNERSHIP_TABLES]
  );

  const schema: OwnershipSchema = new Map();
  for (const tableName of OWNERSHIP_TABLES) {
    schema.set(tableName, new Set<string>());
  }

  for (const row of result.rows as Array<{ table_name: OwnershipTable; column_name: string }>) {
    schema.get(row.table_name)?.add(String(row.column_name));
  }

  return schema;
}

function hasAgencyIdColumn(schema: OwnershipSchema, tableName: OwnershipTable): boolean {
  return schema.get(tableName)?.has("agency_id") === true;
}

async function hasExistingAgencyReference(schema: OwnershipSchema, agencyId: string): Promise<boolean> {
  const normalizedAgencyId = String(agencyId || "").trim();
  if (!normalizedAgencyId) {
    return false;
  }

  for (const tableName of OWNERSHIP_TABLES) {
    if (!hasAgencyIdColumn(schema, tableName)) {
      continue;
    }

    const result = await pool.query(
      `SELECT agency_id FROM ${tableName} WHERE agency_id = $1 LIMIT 1`,
      [normalizedAgencyId]
    );

    if (result.rows.length > 0) {
      return true;
    }
  }

  return false;
}

router.get("/get-any-id", async (_req, res) => {
  try {
    const schema = await inspectOwnershipSchema();
    const users = await getAllUsers();

    for (const user of users) {
      const userId = String(user?.id || "").trim();
      const agencyId = String(user?.agencyId || "").trim();
      if (!userId || user.isSystemUser !== true || !agencyId) {
        continue;
      }

      if (await hasExistingAgencyReference(schema, agencyId)) {
        return res.json({ id: userId });
      }
    }

    return res.status(404).json({ error: "No valid internal API user ID found" });
  } catch (err) {
    console.error("[get-any-id] failed", err);
    return res.status(500).json({ error: "Failed to fetch ID" });
  }
});

export default router;