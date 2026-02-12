# ✅ APPROVED IMPLEMENTATION PLAN — Retry & Edit Fixes

**Status**: Ready to implement  
**Priority**: Critical production blockers  
**Estimated Effort**: 3-5 days (Phase 1)

---

## 🔴 PHASE 1 — Critical Production Blockers (Ship ASAP)

### 1. Retry Billing with Type Classification

**File**: `server/src/routes/retrySingle.ts`  
**Lines**: 290-310  

**Problem**: Retry creates new job without reservation → unlimited free retries

**Solution**: Add retry type classification and conditional billing

```typescript
type RetryType = "manual_retry" | "validator_retry" | "system_retry";

// Billing decision table:
// manual_retry    → ✅ CHARGE credits
// validator_retry → ❌ FREE (our validator fault)
// system_retry    → ❌ FREE (infra fault)
```

**Key Changes**:
- ✅ Check `retryType` from `retryInfo`
- ✅ Call `incrementRetry()` for quota enforcement (all types)
- ✅ Call `reserveAllowance()` ONLY for `manual_retry`
- ✅ Add idempotency key (30-second window)
- ✅ Return 409 on duplicate retry

**Imports**:
```typescript
import { reserveAllowance, incrementRetry } from "../services/usageLedger.js";
import { redisClient } from "../services/redis.js";
```

---

### 2. Idempotency Protection (NEW)

**Files**: 
- `server/src/routes/retrySingle.ts`
- `server/src/routes/region-edit.ts`

**Problem**: Double-click/tap creates duplicate jobs + duplicate billing

**Solution**: Redis-based deduplication with 30-second window

```typescript
// Pattern: retry:{userId}:{parentJobId}:{timestamp/30000}
const idempotencyKey = `retry:${userId}:${parentJobId}:${Math.floor(Date.now() / 30000)}`;
const existingJob = await redisClient.get(idempotencyKey);

if (existingJob) {
  return res.status(409).json({ 
    code: "DUPLICATE_RETRY", 
    jobId: existingJob,
    message: "Retry already in progress" 
  });
}

// Store new job
await redisClient.setex(idempotencyKey, 30, newJobId);
```

**Why 30 seconds**:
- Long enough to catch double-clicks
- Short enough to allow legitimate retries
- Rounds timestamp to prevent drift

---

### 3. Timeout Mismatch Fix

**File**: `client/src/components/batch-processor.tsx`  
**Line**: ~632

**Problem**: 60-second timeout fires before 2-5 minute jobs complete

**Solution**: Increase timeout + add progress messaging

```typescript
// Change from:
const RETRY_TIMEOUT = 60000; // 60 seconds

// To:
const RETRY_TIMEOUT = 300000; // 5 minutes
const POLLING_MAX_DURATION = 600000; // 10 minutes

// Add UI messaging:
<Spinner>
  Processing — complex staging may take up to 4 minutes
</Spinner>
```

**Impact**: Eliminates false timeout errors on successful jobs

---

### 4. Race Condition Guards

**File**: `client/src/components/batch-processor.tsx`  
**Line**: ~3392

**Problem**: `setResults()` updates can corrupt wrong images due to index drift

**Solution**: Multi-layered guards with version timestamp authority

```typescript
// Guard #1: Verify jobId still mapped
const currentIdx = jobIdToIndexRef.current[jobId];
if (currentIdx === undefined) {
  console.warn('[retry] jobId unmapped, skipping');
  return;
}

// Guard #2: Verify index match
if (currentIdx !== imageIndex) {
  console.warn('[retry] index drift', { expected: imageIndex, actual: currentIdx });
  imageIndex = currentIdx; // Use current
}

// Guard #3: Bounds check
if (imageIndex >= results.length || imageIndex < 0) {
  console.error('[retry] index out of bounds');
  return;
}

// Guard #4: VERSION CHECK (PRIMARY AUTHORITY)
const currentResult = results[imageIndex];
const currentVersion = currentResult?.version || 0;
const newVersion = Date.now();

if (currentResult?.jobId && currentResult.jobId !== jobId) {
  // Different jobId - check version timestamp
  // ONLY block if current is completed AND has newer timestamp
  if (currentResult.status === 'completed' && currentVersion > newVersion - 5000) {
    console.warn('[retry] skipping stale update');
    return;
  }
}

// ✅ Safe to update
setResults(prev => prev.map((r, i) =>
  i === imageIndex ? {
    ...r,
    imageUrl: job.imageUrl,
    version: newVersion,  // Timestamp for stale detection
    jobId: jobId,         // Track source job
    status: "completed"
  } : r
));
```

**Key Insight**: Version timestamp is PRIMARY authority, not jobId (jobId changes during retry/edit intentionally)

---

### 5. Stage URL Preservation + Baseline Exclusion

**File**: `client/src/components/batch-processor.tsx`

**Problem**: Edit overwrites all `stageUrls` → data loss

**Solution**: Preserve originals, add edit as separate stage

```typescript
// Edit stage structure:
stageUrls = {
  "1A": url1A,       // ✅ Preserved
  "1B": url1B,       // ✅ Preserved
  "2": url2,         // ✅ Preserved (original)
  "edit": urlEdit1   // ✅ New edit stage
}

// On subsequent edit:
stageUrls = {
  ...existing,
  "edit": urlEdit2,   // Latest
  "edit-1": urlEdit1  // Previous archived
}
```

**CRITICAL**: Exclude edit stages from retry baseline selection

```typescript
function selectRetryBaseline(result: Result): string {
  const { stageUrls } = result;
  
  // ⚠️ EXCLUDE edit stages (structural modifications)
  const retryableStages = Object.entries(stageUrls || {})
    .filter(([stage, url]) => !stage.startsWith('edit'))
    .sort((a, b) => stageRank(b[0]) - stageRank(a[0]));
  
  return retryableStages[0]?.[1] || result.imageUrl;
}
```

**Why**: Edit may modify structure → using as retry baseline would fail validation

---

## 🟡 PHASE 2 — Deferred Decisions (Next Sprint)

### 6. Edit Billing Policy: Keep FREE

**Decision**: Option A (free edits with 3-cap)

**Rationale**:
- Edits are refinement, not full compute
- Already capped at 3 (rate limiting sufficient)
- Region edit cost << full staging pipeline
- No abuse metrics yet
- Reduces UX friction

**Action**: Document policy, monitor for 30 days

**Review Trigger**: If edit frequency > 10/user/month OR abuse detected

---

### 7. S3 Verification: Conditional Only

**Decision**: Trust publish step by default, verify only in DEBUG or escalation

**Implementation**:
```typescript
// worker/src/worker.ts
const shouldVerify = process.env.DEBUG_PUBLISH_VERIFY === '1' || 
                     payload.escalated === true;

if (shouldVerify) {
  const headResponse = await fetch(imageUrl, { method: 'HEAD' });
  if (!headResponse.ok) {
    // Mark failed
  }
}
```

**Rationale**:
- Adds latency + S3 cost
- Eventual consistency issues
- Publish step already reliable

---

## 📋 Testing Checklist

### Retry Billing
- [ ] Manual retry → verify credit charged
- [ ] Validator retry → verify FREE
- [ ] System retry → verify FREE
- [ ] Retry cap (2) enforced → verify 429 on 3rd retry
- [ ] Double-click retry → verify 409 duplicate response

### Timeout Fix
- [ ] Upload with full pipeline (1A+1B+2) → verify completes in 3-5min
- [ ] No timeout errors during processing
- [ ] Progress message displays correctly

### Race Conditions
- [ ] Submit 2 concurrent retries → verify no UI corruption
- [ ] Remove image during retry → verify no crash
- [ ] Retry after edit → verify correct version wins
- [ ] Rapid retry/remove/retry → verify stable

### Stage Preservation
- [ ] Edit after Stage 2 → verify original Stage 2 preserved
- [ ] Multiple edits → verify edit chain (edit, edit-1, edit-2)
- [ ] Retry after edit → verify baseline excludes edit stages
- [ ] Stage selector → verify all stages viewable

---

## 📊 Monitoring Queries

### Orphaned Reservations (Run Hourly)
```sql
SELECT COUNT(*) FROM job_reservations
WHERE charge_finalized = FALSE
  AND created_at < NOW() - INTERVAL '1 hour'
  AND reservation_status = 'reserved';
-- Alert if > 10
```

### Retry Abuse Detection (Run Daily)
```sql
SELECT user_id, COUNT(*) as retry_count
FROM job_reservations
WHERE retry_count > 0
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY user_id
HAVING COUNT(*) > 20;
-- Alert if any users > 20 retries/day
```

### Edit Frequency Tracking
```sql
SELECT 
  DATE(created_at) as date,
  COUNT(*) as total_edits,
  COUNT(DISTINCT user_id) as unique_users,
  AVG(edit_count) as avg_edits_per_job
FROM job_reservations
WHERE edit_count > 0
  AND created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

### Idempotency 409 Rate
```bash
# Application logs
grep "DUPLICATE_RETRY" logs/*.log | wc -l
# High rate = UX issue (users spam-clicking)
```

---

## 🚀 Deployment Steps

1. **Database backup**
   ```bash
   pg_dump $DATABASE_URL > backup_pre_retry_fix.sql
   ```

2. **Deploy to staging**
   ```bash
   railway up --service worker --environment staging
   railway up --service server --environment staging
   railway up --service client --environment staging
   ```

3. **Run integration tests**
   ```bash
   npm run test:retry-flow
   npm run test:billing-flow
   npm run test:race-conditions
   ```

4. **Enable debug logging**
   ```bash
   export RETRY_DEBUG=1
   export BILLING_DEBUG=1
   ```

5. **Deploy to production** (after 24hr staging soak)

6. **Monitor for 48 hours**
   - Check orphaned reservations query
   - Check retry abuse query
   - Watch error logs for race conditions
   - Verify no revenue leaks

---

## ✅ Success Criteria

**Revenue Protection**:
- ✅ Zero free manual retries exploited
- ✅ System/validator retries = 0 charges
- ✅ Retry cap enforced (max 2 per image)

**Reliability**:
- ✅ Zero timeout errors on 3-5min jobs
- ✅ Zero React state corruption
- ✅ Zero duplicate job spam

**Data Integrity**:
- ✅ Zero stage URL overwrites
- ✅ Zero retry-from-edit failures
- ✅ Zero orphaned reservations

---

## 🔧 Rollback Plan

If issues arise:

**Billing bypass emergency fix**:
```sql
UPDATE job_reservations 
SET amendments_locked = TRUE
WHERE retry_count >= 2;
```

**Client hotfix (disable retry)**:
```typescript
localStorage.setItem('RETRY_DISABLED', '1');
```

**Circuit breaker**:
```typescript
// server/src/routes/retrySingle.ts
const RETRY_ENABLED = process.env.RETRY_ENABLED !== '0';
if (!RETRY_ENABLED) {
  return res.status(503).json({ error: "retry_temporarily_disabled" });
}
```

---

**END OF APPROVED PLAN**
