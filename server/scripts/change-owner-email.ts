/**
 * Move an account to a new login email (e.g. a staff member who owned an
 * agency account has left, and the agency wants the account under its own
 * address).
 *
 *   npx tsx scripts/change-owner-email.ts --from old@example.com --to new@example.com          (dry run: shows what would change)
 *   npx tsx scripts/change-owner-email.ts --from old@example.com --to new@example.com --apply  (makes the change)
 *
 * What it does (only with --apply):
 *  1. Changes the user's login email to the new address (marked unverified).
 *  2. Replaces the password with a random one nobody knows, and unlinks
 *     Google sign-in, so the old person can no longer log in. A password is
 *     kept (not removed) because "Forgot password" only works for accounts
 *     that have one — the new owner uses it to set their own.
 *  3. Removes the old email's lookup, so the old address no longer finds
 *     this account (a Google sign-in with it would only start a new, empty
 *     account with none of this agency's photos or credits).
 *  4. Logs the user out of every open session.
 *  5. Updates the agency's billing email if it was the old address.
 * The account keeps its agency, role, photos, credits and subscription.
 * Needs the server's Redis (REDIS_URL), e.g. run inside the Railway server service.
 */
import crypto from "crypto";
import { getUserByEmail, updateUser } from "@realenhance/shared/users.js";
import { getAgency, updateAgency } from "@realenhance/shared/agencies.js";
import { getRedis } from "@realenhance/shared/redisClient.js";
import { hashPassword } from "../src/utils/password.js";
import { invalidateSessionsForUser } from "../src/services/sessionStore.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]).trim() : null;
}

async function main() {
  const from = (arg("from") || "").toLowerCase();
  const to = (arg("to") || "").toLowerCase();
  const apply = process.argv.includes("--apply");
  if (!from || !to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    console.error("Usage: npx tsx scripts/change-owner-email.ts --from old@example.com --to new@example.com [--apply]");
    process.exit(2);
  }
  if (from === to) throw new Error("The new email is the same as the old one.");

  const user = await getUserByEmail(from);
  if (!user) throw new Error(`No account found for ${from}.`);
  const clash = await getUserByEmail(to);
  if (clash && clash.id !== user.id) {
    throw new Error(`${to} is already used by another account (${clash.id}). Nothing was changed.`);
  }
  const agency = user.agencyId ? await getAgency(user.agencyId) : null;
  const billingMatches = !!agency?.billingEmail && agency.billingEmail.toLowerCase() === from;

  console.log("Account found:");
  console.log(`  user id:      ${user.id}`);
  console.log(`  name:         ${user.name || "-"}`);
  console.log(`  role:         ${user.role || "-"}`);
  console.log(`  agency:       ${agency ? `${agency.name} (${agency.agencyId})` : user.agencyId || "none"}`);
  console.log(`  sign-in:      ${user.passwordHash ? "password" : "no password"}${user.googleId ? " + Google" : ""}`);
  console.log(`  credits:      ${user.credits}`);
  console.log(`  billing email on agency: ${agency?.billingEmail || "-"}${billingMatches ? " (will be updated)" : ""}`);
  console.log("");
  console.log(`Will change login email ${from} -> ${to}, set a random unknown password, unlink Google,`);
  console.log("remove the old email's lookup and log the user out everywhere.");

  if (!apply) {
    console.log("\nDry run only. Nothing changed. Add --apply to make the change.");
    return;
  }

  const randomPassword = crypto.randomBytes(32).toString("base64url");
  await updateUser({
    ...user,
    email: to,
    emailVerified: false,
    passwordHash: await hashPassword(randomPassword),
    googleId: undefined,
    authProvider: "email",
  });
  // Belt and braces: the old lookup must be gone even on older code.
  await getRedis().del(`user:email:${from}`);
  const sessions = await invalidateSessionsForUser(user.id);
  if (agency && billingMatches) {
    await updateAgency({ ...agency, billingEmail: to });
  }

  const check = await getUserByEmail(from);
  const now = await getUserByEmail(to);
  console.log("\nDone.");
  console.log(`  old email finds an account: ${check ? "YES (problem!)" : "no"}`);
  console.log(`  new email finds the account: ${now?.id === user.id ? "yes" : "NO (problem!)"}`);
  console.log(`  sessions logged out: ${sessions}`);
  console.log(`  agency billing email updated: ${billingMatches ? "yes" : "no (it wasn't the old email)"}`);
  console.log(`\nNext: the new owner goes to the login page, clicks "Forgot password" and enters ${to}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nFAILED: ${err?.message || err}`);
    process.exit(1);
  });
