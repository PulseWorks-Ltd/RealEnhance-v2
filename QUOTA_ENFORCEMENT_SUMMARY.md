# Hard Quota Enforcement Implementation Summary

## Overview
Successfully implemented SQL-backed reservation system for hard quota enforcement with add-on balance carry-forward, staging cost rules, and retry/edit caps.

## Database Schema

### Migration 001: Core Tables
- **agency_accounts**: Per-agency add-on balance and included image limits
- **agency_month_usage**: Monthly usage tracking with stage breakdowns
- **job_reservations**: Per-job allowance reservations with stage allocation details
- **addon_purchases**: Add-on purchase history (carry-forward balance)

### Migration 002: User Attribution
- Added `user_id` column to job_reservations for per-user rollups
- Added `stage12_consumed` and `stage2_consumed` boolean flags for accurate usage tracking
- Added index on (agency_id, yyyymm, user_id) for fast per-user queries

## Cost Rules

### Stage Costs
- **Stage 1+2 (enhance only)**: 1 image from allowance
- **Stage 1+2 + Stage 2 (enhance + staging)**: 2 images from allowance
- **Staging-only retry**: 1 image from allowance (Stage 1 result reused)
- **Retries**: No additional allowance consumed (capped at 3 per job)
- **Edits**: No additional allowance consumed (capped at 3 per job)

### Allowance Priority
1. Included monthly images (per plan tier)
2. Add-on balance (purchased and carried forward)
3. Quota exhausted if both depleted

## Server Implementation

### Upload Flow (`server/src/routes/upload.ts`)
1. Pre-generate job ID with crypto
2. Calculate required images (1 or 2 based on staging flag)
3. Call `reserveAllowance` (atomic SQL transaction)
4. On success: enqueue job with pre-assigned job ID
5. On quota exceeded: return 402 with snapshot, release all reservations
6. On error: release all pending reservations

### Retry Enforcement (`server/src/routes/retry.ts`)
- Call `incrementRetry` before accepting retry
- Return 429 if retry count reaches 3 (amendments locked)

### Edit Enforcement (`server/src/routes/edit.ts`)
- Call `incrementEdit` if base job ID provided
- Return 429 if edit count reaches 3 (amendments locked)

### Usage API (`server/src/routes/usage.ts`)
- Return snapshot with included/add-on breakdown
- Return top 10 users by consumption this month
- Return staging note: "Virtual staging uses an additional image from your allowance"

## Worker Implementation

### Reservation Finalization (`worker/src/worker.ts`)
1. Track `stage12Success` and `stage2Success` boolean flags
2. Mark stage12 success after Stage 1 publish
3. Mark stage2 success after Stage 2 publish
4. Call `finalizeReservationFromWorker` with actual completion status
5. Ledger refunds unconsumed reservations, tracks per-stage usage

### Legacy Billing Removed
- Removed `chargeForStage1` and `chargeForStage2` calls
- Removed `usageBilling` imports from enhance handler
- Kept usage tracking for analytics only

## Client Implementation

### Usage Display (`client/src/components/usage-bar.tsx`)
- Show single "Enhanced Images" bar with combined usage
- Display "Virtual staging uses an additional image from your allowance" note
- Display top 10 users this month with name and usage count

### Usage Hook (`client/src/hooks/use-usage.ts`)
- Added `stagingNote` and `topUsers` fields to UsageSummary interface

## Testing Checklist (Not Yet Implemented)
- [ ] Concurrency: Two jobs reserving last slot simultaneously (only one succeeds)
- [ ] Stage costs: Verify 1 image for enhance-only, 2 for enhance+staging
- [ ] Staging-only retry: Verify 1 image consumed when Stage 1 reused
- [ ] Retry cap: Verify retries stop at 3, no allowance consumed
- [ ] Edit cap: Verify edits stop at 3, no allowance consumed
- [ ] Add-on balance: Verify carry-forward and sequential consumption
- [ ] Partial refund: Job requests 2, Stage 1 succeeds, Stage 2 fails → refund 1
- [ ] Amendments lock: Verify retry/edit operations locked after 3 attempts
- [ ] View/download: Verify no allowance consumption

## Key Files Modified
- `server/src/db/index.ts` - PG pool + withTransaction helper
- `server/src/db/migrate.ts` - Migration runner
- `server/src/db/migrations/001_init.sql` - Core schema
- `server/src/db/migrations/002_add_user_and_flags.sql` - User attribution
- `server/src/services/usageLedger.ts` - Reservation logic
- `server/src/routes/upload.ts` - Submission gating
- `server/src/routes/retry.ts` - Retry enforcement
- `server/src/routes/edit.ts` - Edit enforcement
- `server/src/routes/usage.ts` - Usage summary API
- `server/src/services/jobs.ts` - Accept jobId override
- `worker/src/worker.ts` - Reservation finalization
- `worker/src/utils/reservations.ts` - Worker finalize helper
- `client/src/components/usage-bar.tsx` - UI updates
- `client/src/hooks/use-usage.ts` - Hook interface updates
- `client/src/pages/home.tsx` - Pass new props to usage display

## Deployment Steps
1. Ensure DATABASE_URL environment variable is set in server
2. Run migrations automatically on server start (already configured)
3. Restart server and worker services
4. Monitor logs for reservation/finalization messages
5. Verify usage summary displays correctly in UI

## Future Enhancements
- Admin dashboard for add-on purchases
- Grace period before hard blocking on quota exhaustion
- Email notifications at 80%, 95%, 100% usage
- Agency owner alerts for top users approaching limits
- CSV export of per-user usage history
