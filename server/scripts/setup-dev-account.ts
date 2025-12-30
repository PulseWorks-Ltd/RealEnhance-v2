#!/usr/bin/env tsx
// Quick dev script to set up a user account with an agency

import { getUserByEmail, updateUser } from "@realenhance/shared/users.js";
import { createAgency, getAgency } from "@realenhance/shared/agencies.js";

async function main() {
  const email = process.argv[2];

  if (!email) {
    console.log(`
Usage: tsx server/scripts/setup-dev-account.ts <email>

This script will:
1. Find or create "RealEnhance" agency
2. Assign the user to this agency as admin
3. Set the agency to ACTIVE status

Example:
  tsx server/scripts/setup-dev-account.ts user@example.com
`);
    process.exit(1);
  }

  try {
    // Get the user
    const user = await getUserByEmail(email);

    if (!user) {
      console.error(`❌ User not found: ${email}`);
      console.log("\nPlease sign up first at http://localhost:5173/signup");
      process.exit(1);
    }

    console.log(`\n📋 Found user: ${user.email} (${user.id})`);

    // Check if user already has an agency
    if (user.agencyId) {
      const existing = await getAgency(user.agencyId);
      if (existing) {
        console.log(`\n✅ User is already in agency: ${existing.name} (${existing.agencyId})`);
        console.log(`   Plan: ${existing.planTier}`);
        console.log(`   Status: ${existing.subscriptionStatus}`);
        return;
      }
    }

    // Create or find "RealEnhance" agency
    console.log('\n🏢 Creating "RealEnhance" agency...');

    const agency = await createAgency({
      name: "RealEnhance",
      planTier: "agency", // Studio plan
      ownerId: user.id,
      subscriptionStatus: "ACTIVE", // Active for development
    });

    console.log(`✅ Created agency: ${agency.name} (${agency.agencyId})`);

    // Update user to be part of this agency
    user.agencyId = agency.agencyId;
    user.role = "admin";

    // Save user using new Redis storage
    await updateUser(user);

    console.log(`\n✅ Setup complete!`);
    console.log(`\nAgency Details:`);
    console.log(`   Name: ${agency.name}`);
    console.log(`   ID: ${agency.agencyId}`);
    console.log(`   Plan: ${agency.planTier}`);
    console.log(`   Status: ${agency.subscriptionStatus}`);
    console.log(`\nUser Details:`);
    console.log(`   Email: ${user.email}`);
    console.log(`   Role: admin`);
    console.log(`   Agency: ${agency.agencyId}`);
    console.log(`\n🚀 The user can now log in and access agency features!`);
  } catch (error) {
    console.error(`\n❌ Error:`, error);
    process.exit(1);
  }
}

main();
