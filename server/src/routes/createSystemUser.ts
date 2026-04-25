import { Router } from "express";
import { pool } from "../db/index.js";

const router = Router();

router.get("/create-system-user", async (req, res) => {
  try {
    const result = await pool.query(`
      INSERT INTO agency_accounts (email, name)
      VALUES ('marketing@realenhance.system', 'RealEnhance Marketing System')
      ON CONFLICT (email) DO NOTHING
      RETURNING id;
    `);

    // If already exists, fetch it
    let id;

    if (result.rows.length > 0) {
      id = result.rows[0].id;
    } else {
      const existing = await pool.query(`
        SELECT id FROM agency_accounts
        WHERE email = 'marketing@realenhance.system'
        LIMIT 1;
      `);
      id = existing.rows[0]?.id;
    }

    res.json({
      message: "System user ready",
      id,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create system user" });
  }
});

export default router;