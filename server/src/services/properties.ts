import { pool } from '../db/index.js';

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export async function findOrCreateProperty(params: {
  agencyId: string;
  createdByUserId: string;
  address: string;
}): Promise<{ id: string; address: string; normalizedAddress: string }> {
  const rawAddress = params.address.trim();
  const normalizedAddress = normalizeAddress(rawAddress);

  if (!rawAddress || !normalizedAddress) {
    throw new Error('property_address_required');
  }

  const existing = await pool.query(
    `SELECT id, address, normalized_address
     FROM properties
     WHERE agency_id = $1 AND normalized_address = $2
     LIMIT 1`,
    [params.agencyId, normalizedAddress]
  );

  if (existing.rows.length > 0) {
    return {
      id: existing.rows[0].id,
      address: existing.rows[0].address,
      normalizedAddress: existing.rows[0].normalized_address,
    };
  }

  const inserted = await pool.query(
    `INSERT INTO properties (agency_id, created_by_user_id, address, normalized_address)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (agency_id, normalized_address)
     DO UPDATE SET address = EXCLUDED.address
     RETURNING id, address, normalized_address`,
    [params.agencyId, params.createdByUserId, rawAddress, normalizedAddress]
  );

  return {
    id: inserted.rows[0].id,
    address: inserted.rows[0].address,
    normalizedAddress: inserted.rows[0].normalized_address,
  };
}
