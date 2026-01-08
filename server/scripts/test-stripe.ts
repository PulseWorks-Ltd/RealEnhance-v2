// Test script to verify Stripe API connection
import Stripe from "stripe";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from server/.env
dotenv.config({ path: join(__dirname, "../.env") });

async function testStripe() {
  console.log("🔍 Testing Stripe Integration\n");

  // Check environment variables
  console.log("1️⃣ Checking environment variables...");
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secretKey) {
    console.log("❌ STRIPE_SECRET_KEY not found");
    return;
  }
  console.log("✅ STRIPE_SECRET_KEY:", secretKey.substring(0, 20) + "...");

  if (!publishableKey) {
    console.log("⚠️  STRIPE_PUBLISHABLE_KEY not found");
  } else {
    console.log("✅ STRIPE_PUBLISHABLE_KEY:", publishableKey.substring(0, 20) + "...");
  }

  if (!webhookSecret) {
    console.log("⚠️  STRIPE_WEBHOOK_SECRET not found");
  } else {
    console.log("✅ STRIPE_WEBHOOK_SECRET:", webhookSecret.substring(0, 20) + "...");
  }

  // Initialize Stripe
  console.log("\n2️⃣ Initializing Stripe client...");
  const stripe = new Stripe(secretKey, {
    apiVersion: "2025-12-15.clover",
  });
  console.log("✅ Stripe client initialized");

  // Test API connection
  console.log("\n3️⃣ Testing API connection...");
  try {
    const account = await stripe.accounts.retrieve();
    console.log("✅ Connected to Stripe account");
    console.log("   Account ID:", account.id);
    console.log("   Country:", account.country);
    console.log("   Email:", account.email || "Not set");
    console.log("   Charges enabled:", account.charges_enabled);
    console.log("   Payouts enabled:", account.payouts_enabled);
  } catch (error: any) {
    console.log("❌ Failed to connect to Stripe");
    console.log("   Error:", error.message);
    return;
  }

  // List products
  console.log("\n4️⃣ Checking products...");
  try {
    const products = await stripe.products.list({ limit: 10 });
    console.log(`✅ Found ${products.data.length} products`);

    if (products.data.length > 0) {
      console.log("\n   Products:");
      for (const product of products.data) {
        console.log(`   • ${product.name} (${product.id})`);

        // Get prices for this product
        const prices = await stripe.prices.list({ product: product.id, limit: 5 });
        if (prices.data.length > 0) {
          console.log("     Prices:");
          for (const price of prices.data) {
            const amount = price.unit_amount ? `${(price.unit_amount / 100).toFixed(2)}` : "N/A";
            const interval = price.recurring?.interval || "one-time";
            console.log(`     - ${amount} ${price.currency.toUpperCase()} (${interval}) [${price.id}]`);
          }
        }
      }
    } else {
      console.log("⚠️  No products found. You need to create products in Stripe Dashboard.");
    }
  } catch (error: any) {
    console.log("❌ Failed to list products");
    console.log("   Error:", error.message);
  }

  // Check webhooks
  console.log("\n5️⃣ Checking webhook endpoints...");
  try {
    const webhooks = await stripe.webhookEndpoints.list({ limit: 10 });
    console.log(`✅ Found ${webhooks.data.length} webhook endpoint(s)`);

    if (webhooks.data.length > 0) {
      console.log("\n   Endpoints:");
      for (const webhook of webhooks.data) {
        console.log(`   • ${webhook.url}`);
        console.log(`     Status: ${webhook.status}`);
        console.log(`     Events: ${webhook.enabled_events.join(", ")}`);
      }
    } else {
      console.log("⚠️  No webhook endpoints configured.");
      console.log("   Create one at: https://dashboard.stripe.com/webhooks");
    }
  } catch (error: any) {
    console.log("❌ Failed to list webhooks");
    console.log("   Error:", error.message);
  }

  // Test mode check
  console.log("\n6️⃣ Mode check...");
  if (secretKey.startsWith("sk_test_")) {
    console.log("✅ Running in TEST MODE");
    console.log("   Use test cards: https://stripe.com/docs/testing");
  } else if (secretKey.startsWith("sk_live_")) {
    console.log("⚠️  Running in LIVE MODE");
    console.log("   Real payments will be processed!");
  }

  console.log("\n✨ Stripe test complete!\n");
}

testStripe().catch((error) => {
  console.error("💥 Test failed:", error);
  process.exit(1);
});
