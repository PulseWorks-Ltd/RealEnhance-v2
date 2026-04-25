import { Router } from "express";
import {
  createUser,
  getUserByEmail,
  getUserById,
  updateUser,
} from "@realenhance/shared/users.js";
import type { UserRecord } from "@realenhance/shared/types.js";
import { pool } from "../db/index.js";

const router = Router();

const SYSTEM_USER_EMAIL = "marketing@realenhance.system";
const SYSTEM_USER_NAME = "RealEnhance Marketing System";
const DEFAULT_SYSTEM_AGENCY_ID = "agency_internal_system";
const RELEVANT_TABLES = ["agency_accounts", "organisations", "job_reservations", "enhanced_images", "addon_purchases"] as const;

type RelevantTable = (typeof RELEVANT_TABLES)[number];
type SchemaMap = Map<RelevantTable, Set<string>>;

async function inspectRelevantSchema(): Promise<SchemaMap> {
  const result = await pool.query(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position
    `,
    [RELEVANT_TABLES]
  );

  const schema: SchemaMap = new Map();
  for (const tableName of RELEVANT_TABLES) {
    schema.set(tableName, new Set<string>());
  }

  for (const row of result.rows as Array<{ table_name: RelevantTable; column_name: string }>) {
    schema.get(row.table_name)?.add(String(row.column_name));
  }

  return schema;
}

function hasColumn(schema: SchemaMap, tableName: RelevantTable, columnName: string): boolean {
  return schema.get(tableName)?.has(columnName) === true;
}

function hasAgencyTable(schema: SchemaMap): boolean {
  return hasColumn(schema, "agency_accounts", "agency_id") || hasColumn(schema, "organisations", "agency_id");
}

function getSchemaDebug(schema: SchemaMap): Record<string, string[]> {
  return Object.fromEntries(
    RELEVANT_TABLES.map((tableName) => [
      tableName,
      Array.from(schema.get(tableName) ?? []).sort(),
    ])
  );
}

async function findExistingAgencyId(schema: SchemaMap): Promise<string | null> {
  for (const tableName of ["organisations", "agency_accounts"] as const) {
    if (!hasColumn(schema, tableName, "agency_id")) {
      continue;
    }

    const result = await pool.query(
      `SELECT agency_id FROM ${tableName} WHERE agency_id IS NOT NULL AND btrim(agency_id) <> '' LIMIT 1`
    );

    const agencyId = String(result.rows[0]?.agency_id || "").trim();
    if (agencyId) {
      return agencyId;
    }
  }

  return null;
}

async function ensureAgencyRows(schema: SchemaMap, agencyId: string): Promise<void> {
  if (!agencyId) {
    throw new Error("system_agency_id_missing");
  }

  if (!hasAgencyTable(schema)) {
    throw new Error("system_agency_schema_missing");
  }

  if (hasColumn(schema, "agency_accounts", "agency_id")) {
    await pool.query(
      `
        INSERT INTO agency_accounts (agency_id)
        VALUES ($1)
        ON CONFLICT (agency_id) DO NOTHING
      `,
      [agencyId]
    );
  }

  if (hasColumn(schema, "organisations", "agency_id")) {
    await pool.query(
      `
        INSERT INTO organisations (agency_id)
        VALUES ($1)
        ON CONFLICT (agency_id) DO NOTHING
      `,
      [agencyId]
    );
  }
}

async function resolveAgencyId(schema: SchemaMap): Promise<string> {
  if (!hasAgencyTable(schema)) {
    throw new Error("system_agency_schema_missing");
  }

  const configuredAgencyId = String(process.env.INTERNAL_API_AGENCY_ID || "").trim();
  if (configuredAgencyId) {
    await ensureAgencyRows(schema, configuredAgencyId);
    return configuredAgencyId;
  }

  const configuredUserId = String(process.env.INTERNAL_API_USER_ID || "").trim();
  if (configuredUserId) {
    const configuredUser = await getUserById(configuredUserId as any);
    const agencyId = String(configuredUser?.agencyId || "").trim();
    if (agencyId) {
      await ensureAgencyRows(schema, agencyId);
      return agencyId;
    }
  }

  const existingSystemUser = await getUserByEmail(SYSTEM_USER_EMAIL);
  const existingUserAgencyId = String(existingSystemUser?.agencyId || "").trim();
  if (existingUserAgencyId) {
    await ensureAgencyRows(schema, existingUserAgencyId);
    return existingUserAgencyId;
  }

  const existingAgencyId = await findExistingAgencyId(schema);
  if (existingAgencyId) {
    return existingAgencyId;
  }

  await ensureAgencyRows(schema, DEFAULT_SYSTEM_AGENCY_ID);
  return DEFAULT_SYSTEM_AGENCY_ID;
}

async function ensureSystemUserRecord(agencyId: string): Promise<UserRecord> {
  const configuredUserId = String(process.env.INTERNAL_API_USER_ID || "").trim();
  let user = configuredUserId ? await getUserById(configuredUserId as any) : null;

  if (!user) {
    user = await getUserByEmail(SYSTEM_USER_EMAIL);
  }

  if (!user) {
    user = await createUser({
      email: SYSTEM_USER_EMAIL,
      name: SYSTEM_USER_NAME,
      authProvider: "email",
      agencyId,
    });
  }

  const needsUpdate =
    user.isSystemUser !== true
    || String(user.agencyId || "").trim() !== agencyId
    || user.isActive === false;

  if (!needsUpdate) {
    return user;
  }

  const updatedUser: UserRecord = {
    ...user,
    agencyId,
    isActive: true,
    isSystemUser: true,
  };

  await updateUser(updatedUser);
  return updatedUser;
}

router.get("/create-system-user", async (req, res) => {
  try {
    const schema = await inspectRelevantSchema();
    const agencyId = await resolveAgencyId(schema);
    const user = await ensureSystemUserRecord(agencyId);

    res.json({
      message: "System user ready",
      id: user.id,
    });
  } catch (err) {
    try {
      const schema = await inspectRelevantSchema();
      console.error("[create-system-user] failed", {
        error: err,
        schema: getSchemaDebug(schema),
      });
    } catch (schemaErr) {
      console.error("[create-system-user] failed", err, schemaErr);
    }

    res.status(500).json({ error: "Failed to create system user" });
  }
});

export default router;