#!/usr/bin/env tsx
// One-time admin reset helper. Sends the guarded POST /admin/reset request.
// Usage:
//   ADMIN_RESET_TOKEN=... ADMIN_RESET_ENDPOINT=https://www.realenhance.co.nz/admin/reset tsx server/scripts/resetProdData.ts [--purge-s3]

import "dotenv/config";

async function main() {
  const endpoint =
    process.env.ADMIN_RESET_ENDPOINT ||
    process.env.RESET_ENDPOINT ||
    "http://localhost:5000/admin/reset";

  const token = process.env.ADMIN_RESET_TOKEN;
  const purgeS3 = process.argv.includes("--purge-s3") || process.env.PURGE_S3 === "1";

  if (!token) {
    console.error("ADMIN_RESET_TOKEN is required to authenticate the reset request");
    process.exit(1);
  }

  const payload = {
    confirm: "RESET_PROD_DATA",
    purgeS3,
  };

  console.log(`\nPOST ${endpoint}`);
  console.log(`purgeS3: ${purgeS3}`);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ADMIN-RESET-TOKEN": token,
      },
      body: JSON.stringify(payload),
    });

    const text = await resp.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* ignore */
    }

    if (!resp.ok) {
      console.error(`\n❌ Reset failed (${resp.status}):`, parsed || text);
      process.exit(1);
    }

    console.log("\n✅ Reset completed: ", parsed || text);
  } catch (err) {
    console.error("\n❌ Request failed:", err);
    process.exit(1);
  }
}

main();
