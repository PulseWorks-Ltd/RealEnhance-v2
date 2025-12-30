#!/usr/bin/env tsx
// server/scripts/migrate-users-to-redis.ts
// Migrate users from JSON file to Redis

import * as fs from "node:fs";
import * as path from "node:path";
import { getRedis } from "@realenhance/shared/redisClient.js";
import type { UserRecord, UserId } from "@realenhance/shared/types.js";

// Get users file path
const cwd = process.cwd();
const repoRoot = path.basename(cwd) === "server" ? path.resolve(cwd, "..") : cwd;
const dataDir = process.env.DATA_DIR || path.resolve(repoRoot, "server", "data");
const usersFilePath = path.join(dataDir, "users.json");

type UsersFileState = Record<UserId, UserRecord>;

async function migrateUsers() {
  console.log("🔄 Starting user migration from JSON to Redis...\n");

  // Check if users.json exists
  if (!fs.existsSync(usersFilePath)) {
    console.log("❌ No users.json file found at:", usersFilePath);
    console.log("Nothing to migrate.");
    process.exit(0);
  }

  // Load users from file
  let users: UsersFileState;
  try {
    const fileContent = fs.readFileSync(usersFilePath, "utf8");
    users = JSON.parse(fileContent) as UsersFileState;
    console.log(`📄 Found ${Object.keys(users).length} users in users.json`);
  } catch (err) {
    console.error("❌ Failed to read users.json:", err);
    process.exit(1);
  }

  // Check Redis connection
  let client;
  try {
    client = getRedis();
    await client.ping();
    console.log("✅ Connected to Redis\n");
  } catch (err) {
    console.error("❌ Failed to connect to Redis:", err);
    console.error("\nMake sure Redis is running and REDIS_URL is set correctly.");
    process.exit(1);
  }

  // Migrate each user
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const [userId, user] of Object.entries(users)) {
    try {
      const key = `user:${userId}`;

      // Check if user already exists in Redis
      const existing = await client.exists(key);
      if (existing) {
        console.log(`⏭️  Skipping ${user.email} (already in Redis)`);
        skipped++;
        continue;
      }

      // Store user in Redis
      await client.hSet(key, {
        id: user.id,
        email: user.email,
        name: user.name,
        authProvider: user.authProvider || "",
        passwordHash: user.passwordHash || "",
        agencyId: user.agencyId || "",
        role: user.role || "",
        credits: user.credits?.toString() || "0",
        imageIds: JSON.stringify(user.imageIds || []),
        createdAt: user.createdAt || new Date().toISOString(),
        updatedAt: user.updatedAt || new Date().toISOString(),
      });

      // Create email index
      await client.set(`user:email:${user.email.toLowerCase()}`, userId);

      console.log(`✅ Migrated ${user.email} (${userId})`);
      if (user.agencyId) {
        console.log(`   └─ Agency: ${user.agencyId}, Role: ${user.role || "member"}`);
      }

      migrated++;
    } catch (err) {
      console.error(`❌ Failed to migrate ${userId}:`, err);
      errors++;
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 Migration Summary:");
  console.log("=".repeat(60));
  console.log(`✅ Migrated: ${migrated}`);
  console.log(`⏭️  Skipped:  ${skipped}`);
  console.log(`❌ Errors:   ${errors}`);
  console.log("=".repeat(60));

  if (migrated > 0) {
    console.log("\n💡 Next steps:");
    console.log("1. Verify users in Redis: redis-cli KEYS 'user:*'");
    console.log("2. Check a user: redis-cli HGETALL user:user_pulseworkslimited");
    console.log("3. Backup users.json and keep as fallback");
    console.log("4. Users will now automatically use Redis when available!");
  }

  await client.quit();
  process.exit(errors > 0 ? 1 : 0);
}

// Run migration
migrateUsers().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
