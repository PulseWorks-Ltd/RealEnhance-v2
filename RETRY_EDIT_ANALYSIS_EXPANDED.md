# RETRY & EDIT FUNCTIONS - EXPANDED CRITICAL ANALYSIS

## 🚨 EXECUTIVE SUMMARY - CRITICAL FINDINGS

**Status**: Both retry and edit functions are **partially working** with **FOUR CRITICAL GAPS** that will cause production failures:

1. **❌ BILLING DOUBLE-CHARGE VULNERABILITY** - Retry creates new job without reservation → free retries bypass quota
2. **❌ REACT STATE RACE CONDITIONS** - setResults() updates can corrupt wrong images due to missing jobId guards  
3. **❌ POLLING SOURCE-OF-TRUTH AMBIGUITY** - 4 different systems with no declared authority → edge-case desync
4. **❌ TIMEOUT MISMATCH** - 60s timeout fires before 2-5min jobs complete → false failures

**Risk Level**: 🔴 **HIGH** - Production deployment without fixes will cause:
- Revenue loss (free unlimited retries)
- User confusion (timeout errors on successful jobs)
- UI corruption (wrong images updated)
- Support burden (desync edge cases)

---

## PART 1: BILLING/CREDIT AUDIT 🔴 CRITICAL

### 1.1 Current Billing Flow (Working)

**Initial Upload** (`/api/upload`):
```typescript
// server/src/routes/upload.ts:485-500
const reservation = await reserveAllowance({
  jobId,
  agencyId,
  userId: sessUser.id,
  requiredImages,              // 1 or 2 credits
  requestedStage12: true,
  requestedStage2: finalVirtualStage,
});
// ✅ Creates job_reservations row
// ✅ Deducts from agency_month_usage.included_used
// ✅ Tracks in reservation_status = "reserved"
```

**Worker Completion**:
```typescript
// worker/src/worker.ts:3802
await finalizeReservationFromWorker({
  jobId: payload.jobId,
  stage12Success: hasStage1AorB,
  stage2Success: hasStage2,
});
// ✅ Updates reservation_status = "consumed"
// ✅ Refunds failed stages
// ✅ Sets charge_finalized = TRUE
```

**Reservation Table Schema**:
```sql
-- server/src/db/migrations/001_init.sql:28-60
CREATE TABLE job_reservations (
  job_id TEXT PRIMARY KEY,
  agency_id TEXT NOT NULL,
  user_id TEXT,
  yyyymm TEXT NOT NULL,
  
  -- Stages requested/consumed
  requested_stage12 BOOLEAN,
  requested_stage2 BOOLEAN,
  stage12_consumed BOOLEAN DEFAULT FALSE,
  stage2_consumed BOOLEAN DEFAULT FALSE,
  
  -- Reservation tracking
  reserved_images INTEGER NOT NULL DEFAULT 0,
  reservation_status TEXT NOT NULL DEFAULT 'reserved',
  
  -- Amendments tracking
  retry_count INTEGER NOT NULL DEFAULT 0,
  edit_count INTEGER NOT NULL DEFAULT 0,
  amendments_locked BOOLEAN NOT NULL DEFAULT FALSE,
  
  -- Billing finalization
  charge_finalized BOOLEAN DEFAULT FALSE,
  charge_amount INTEGER DEFAULT 0,
  charge_computed_at TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

### 1.2 RETRY Billing Flow - 🔴 CRITICAL BUG

**Current Implementation** (`/api/batch/retry-single`):

```typescript
// server/src/routes/retrySingle.ts:292-319
rec = createImageRecord({ userId, originalPath, ... });

const { jobId } = await enqueueEnhanceJob({
  userId: sessUser.id,
  imageId: rec.imageId,  // ❌ NEW imageId created
  options: { ... },
  retryInfo: { retryType: "manual_retry", ... }
});

// ❌ NO reserveAllowance() call
// ❌ NO job_reservations row created
// ❌ NO credit deduction
// ❌ NO quota check (except incrementRetry which is bypassed)
```

**What Actually Happens**:
```
1. User uploads image → pays 1 credit → gets enhanced result
2. User clicks "Retry" → NEW job created
3. Worker processes retry → succeeds
4. NO charge → FREE enhancement
5. Repeat steps 2-4 infinitely
```

**Evidence of Missing Reservation**:
```typescript
// Compare with working upload.ts:485
// UPLOAD (✅ CORRECT):
const reservation = await reserveAllowance({ ... });
await enqueueEnhanceJob({ ... });

// RETRY (❌ BROKEN):
// (no reserveAllowance call)
await enqueueEnhanceJob({ ... });
```

**Quota Enforcement Bypass**:
```typescript
// server/src/routes/retrySingle.ts - NO RETRY COUNT CHECK
// The retry endpoint should call:
//   if (parentJobId) {
//     const retryCheck = await incrementRetry(parentJobId);
//     if (retryCheck.locked) return 429;
//   }
// But this code is MISSING from retrySingle.ts
```

---

### 1.3 EDIT Billing Flow - ⚠️ UNDEFINED

**Current Implementation** (`/api/region-edit`):

```typescript
// server/src/routes/region-edit.ts:156-269
const jobPayload: RegionEditJobPayload = { ... };
const result = await enqueueRegionEditJob(jobPayload);

// ❌ NO reserveAllowance() call
// ❌ NO job_reservations row
// ❌ NO credit deduction
// ✅ Has incrementEdit() cap (3 edits max)
```

**Worker Completion**:
```typescript
// worker/src/worker.ts:4180
await recordRegionEditUsage(regionPayload, agencyId);
// Non-blocking telemetry only, NOT billing
```

**What This Means**:
- ✅ Edit count incremented (cap at 3)
- ❌ No credits charged
- ❌ No reservation created
- ⚠️ **Free edits** (intentional or bug?)

**Decision Required**: Are edits meant to be:
1. **Free** (current behavior) - edit count cap is just rate limiting
2. **Paid** (needs fix) - should create reservation and charge credits

---

### 1.4 DOUBLE-CHARGE ANALYSIS

**Scenario 1: Retry After Full Success**
```
T=0:  Upload → reserve 2 credits → Stage 1B + Stage 2 succeed
      Status: charge_finalized=TRUE, charge_amount=2
T=10: User retries → new job created (NO reservation)
      Status: Original job untouched, NEW job gets FREE processing
Result: ❌ User pays 2 credits, gets 2 full enhancements (1 original + 1 retry)
```

**Scenario 2: Retry After Partial Failure**
```
T=0:  Upload → reserve 2 credits → Stage 1B succeeds, Stage 2 fails
      Status: charge_finalized=TRUE, charge_amount=1 (refund 1 credit)
T=10: User retries → new job created (NO reservation)
      Status: Original job charge_amount=1, NEW job gets FREE Stage 2
Result: ❌ User pays 1 credit, gets full enhancement via free retry
```

**Scenario 3: Edit After Upload**
```
T=0:  Upload → reserve 2 credits → full success
      Status: charge_finalized=TRUE, charge_amount=2, edit_count=0
T=10: User edits → new job created (NO reservation)
      Status: Original job edit_count=1, NEW job gets FREE processing
T=20: User edits again → new job (NO reservation)
      Status: Original job edit_count=2, another FREE processing
T=30: User edits 3rd time → new job (NO reservation)
      Status: Original job edit_count=3, another FREE processing
T=40: User edits 4th time → BLOCKED (amendments_locked=TRUE)
Result: ❌ User pays 2 credits, gets 1 upload + 3 FREE edits
```

---

### 1.5 BILLING FIXES REQUIRED

#### Fix #1: Add Retry Reservation with Type Classification (CRITICAL)
**File**: `server/src/routes/retrySingle.ts`  
**Location**: Lines 290-310 (before enqueueEnhanceJob)

**Retry Type Classification**:
```typescript
// Retry types:
// - "manual_retry": User-initiated retry (BILLABLE)
// - "validator_retry": Auto-retry after false positive validator fail (FREE)
// - "system_retry": Auto-retry after worker crash (FREE)
```

```typescript
// ✅ ADD: Determine retry type (manual vs system/validator)
const retryType = retryInfo?.retryType || "manual_retry";
const isManualRetry = retryType === "manual_retry";

// ✅ ADD: Retry quota enforcement (for all retry types)
if (parentJobId) {
  const retryCheck = await incrementRetry(parentJobId);
  if (retryCheck.locked) {
    return res.status(429).json({ 
      success: false,
      error: "retry_limit_reached", 
      code: "RETRY_LIMIT_REACHED",
      retryCount: retryCheck.retryCount,
      message: "You have reached the maximum allowed retries (2) for this image."
    });
  }
}

// ✅ ADD: Idempotency check (prevent double-submit spam)
const idempotencyKey = `retry:${sessUser.id}:${parentJobId}:${Date.now() - (Date.now() % 30000)}`;
const existingRetry = await redisClient.get(idempotencyKey);
if (existingRetry) {
  return res.status(409).json({
    success: false,
    code: "DUPLICATE_RETRY",
    jobId: existingRetry,
    message: "Retry already in progress for this image."
  });
}

// ✅ ADD: Retry reservation (ONLY for manual retries)
const agencyId = sessUser.agencyId || null;
if (!agencyId) {
  return res.status(400).json({ 
    success: false, 
    error: "missing_agency" 
  });
}

// Charge credits only for manual user retries, not system/validator retries
if (isManualRetry) {
  const requiredImages = effectiveDeclutter && allowStaging ? 2 : 1;
  try {
    const reservation = await reserveAllowance({
      jobId: jobId,  // Use NEW job's ID
      agencyId,
      userId: sessUser.id,
      requiredImages,
      requestedStage12: true,
      requestedStage2: allowStaging,
    });
    console.log(`[retry-single] reserved ${requiredImages} credits for manual retry job ${jobId}`);
  } catch (err: any) {
    if (err?.code === "QUOTA_EXCEEDED") {
      return res.status(402).json({ 
        success: false,
        code: "QUOTA_EXCEEDED", 
        snapshot: err.snapshot 
      });
    }
    return res.status(503).json({ 
      success: false, 
      error: "reservation_failed" 
    });
  }
} else {
  console.log(`[retry-single] FREE retry (type: ${retryType}) - no billing for job ${jobId}`);
}

// Store idempotency key (30 second window)
await redisClient.setex(idempotencyKey, 30, jobId);

// Then enqueue as normal...
const { jobId: enqueuedJobId } = await enqueueEnhanceJob({ 
  // ... existing params,
  retryInfo: {
    ...retryInfo,
    retryType, // Ensure retryType is passed through
  }
});
```

**Required Imports**:
```typescript
import { reserveAllowance, incrementRetry } from "../services/usageLedger.js";
import { redisClient } from "../services/redis.js";
```

**Billing Rules**:
- ✅ **Manual retry** (`retryType === "manual_retry"`) → Charge credits
- ❌ **Validator retry** (`retryType === "validator_retry"`) → FREE (our fault)
- ❌ **System retry** (`retryType === "system_retry"`) → FREE (infra fault)

---

#### Fix #2: Define Edit Billing Policy (DECISION REQUIRED)

**Option A: Keep Edits Free** (simpler)
- Current behavior is intentional
- Edit count cap (3) is just rate limiting
- No code changes needed
- Document in pricing: "First 3 edits per image are free"

**Option B: Charge for Edits** (more complex)
```typescript
// server/src/routes/region-edit.ts:156
// Add before enqueueRegionEditJob():

const agencyId = sessUser.agencyId || null;
if (!agencyId) {
  return res.status(400).json({ error: "missing_agency" });
}

// Check edit quota cap first
if (baseJobId) {
  const editCheck = await incrementEdit(baseJobId);
  if (editCheck.locked) {
    return res.status(429).json({ 
      error: "edit_limit_reached",
      message: "Maximum 3 free edits reached. Additional edits cost 1 credit."
    });
  }
}

// Reserve 1 credit for edit (counts as Stage 2 re-run)
const newJobId = "job_" + crypto.randomUUID();
try {
  await reserveAllowance({
    jobId: newJobId,
    agencyId,
    userId: sessUser.id,
    requiredImages: 1,
    requestedStage12: false,
    requestedStage2: true,
  });
} catch (err: any) {
  if (err?.code === "QUOTA_EXCEEDED") {
    return res.status(402).json({ code: "QUOTA_EXCEEDED", snapshot: err.snapshot });
  }
  return res.status(503).json({ error: "reservation_failed" });
}
```

**Recommendation**: Start with **Option A** (free edits) to reduce friction, monitor usage for 30 days, then decide if charging is needed based on abuse patterns.

---

## PART 2: REACT STATE RACE CONDITIONS 🟡 MEDIUM

### 2.1 Current State Update Pattern

**Vulnerable Code** (`batch-processor.tsx`):
```typescript
// Lines 3392-3410 (retry completion)
setResults(prev => prev.map((r, i) =>
  i === imageIndex ? {
    ...r,
    image: job.imageUrl,
    imageUrl: job.imageUrl,
    version: Date.now(),
    status: "completed"
  } : r
));
```

**Race Condition Scenarios**:

**Scenario 1: Stale Closure**
```
T=0:  Image 0 retry submitted → jobA created
T=1:  Image 1 retry submitted → jobB created
T=2:  User removes Image 0 from results array
      → results.length = 1, imageIndex 0 deleted
T=3:  jobA completes → callback has stale imageIndex=0
      → setResults() writes to index 0 of NEW array
      → WRONG IMAGE updated
```

**Scenario 2: Out-of-Order Updates**
```
T=0:  Image 2 retry submitted → jobX created
T=1:  Image 2 retry submitted AGAIN → jobY created
T=2:  jobY completes first (faster) → updates index 2
T=3:  jobX completes second → overwrites index 2 with OLD result
Result: User sees OLDER image, thinks retry failed
```

**Scenario 3: Index Drift**
```
T=0:  Batch has 5 images [0,1,2,3,4]
      jobIdToIndexRef = { jobA: 0, jobB: 1, jobC: 2, jobD: 3, jobE: 4 }
T=1:  User removes image 1 → array becomes [0,2,3,4]
      jobIdToIndexRef NOT updated
T=2:  jobC completes → looks up index 2 in mapping
      → Updates NEW index 2 (was old index 3)
      → WRONG IMAGE updated
```

---

### 2.2 Missing Guards

**Current Code** (`batch-processor.tsx:3390-3410`):
```typescript
// ❌ NO jobId validation before update
if (job && job.status === "completed" && job.imageUrl) {
  setResults(prev => prev.map((r, i) =>
    i === imageIndex ? {  // ❌ Assumes imageIndex still valid
      ...r,
      image: job.imageUrl,
      // ... update fields
    } : r
  ));
}
```

**What's Missing**:
1. **jobId ownership check** - Verify jobId actually belongs to imageIndex
2. **Version timestamp check** - Reject updates older than current version
3. **Index bounds check** - Verify imageIndex < results.length

---

### 2.3 State Race Fixes Required

#### Fix #1: Add jobId Validation Guard

**File**: `client/src/components/batch-processor.tsx`  
**Location**: Line 3392 (before setResults)

```typescript
// ✅ ADD: Validate jobId ownership before applying result
if (job && job.status === "completed" && job.imageUrl) {
  // Guard #1: Verify jobId still maps to this imageIndex
  const currentMappedIndex = jobIdToIndexRef.current[jobId];
  if (currentMappedIndex === undefined) {
    console.warn('[retry] jobId no longer in mapping, skipping update', { 
      jobId, 
      expectedIndex: imageIndex 
    });
    clearRetryFlags(imageIndex);
    return;
  }
  
  // Guard #2: Verify mapped index matches expected index
  if (currentMappedIndex !== imageIndex) {
    console.warn('[retry] index drift detected', { 
      jobId, 
      expectedIndex: imageIndex, 
      actualIndex: currentMappedIndex 
    });
    // Update using correct index instead
    imageIndex = currentMappedIndex;
  }
  
  // Guard #3: Verify index is within bounds
  if (imageIndex >= results.length || imageIndex < 0) {
    console.error('[retry] index out of bounds', { 
      jobId, 
      imageIndex, 
      resultsLength: results.length 
    });
    clearRetryFlags(imageIndex);
    return;
  }
  
  // Guard #4: Version check to prevent older updates overwriting newer
  const currentResult = results[imageIndex];
  const currentVersion = currentResult?.version || 0;
  const newVersion = Date.now();
  
  // VERSION is primary authority, not jobId
  // (jobId changes during retry/edit flows intentionally)
  if (currentResult?.jobId && currentResult.jobId !== jobId) {
    // Different jobId - check if newer result already present
    console.warn('[retry] jobId mismatch, checking version', {
      currentJobId: currentResult.jobId,
      newJobId: jobId,
      currentVersion,
    });
    
    // ONLY block if BOTH conditions true:
    // 1. Current result is completed
    // 2. Current result has newer timestamp
    if (currentResult.status === 'completed' && currentVersion > newVersion - 5000) {
      console.warn('[retry] skipping stale update - newer result already present');
      clearRetryFlags(imageIndex);
      return;
    }
  }
  
  // ✅ Safe to update now
  setResults(prev => prev.map((r, i) =>
    i === imageIndex ? {
      ...r,
      image: job.imageUrl,
      imageUrl: job.imageUrl,
      version: newVersion,  // ✅ Timestamp for stale detection
      jobId: jobId,         // ✅ Track which job produced this result
      status: "completed",
      // ... rest of updates
    } : r
  ));
}
```

---

#### Fix #2: Add jobIdToIndexRef Maintenance

**File**: `client/src/components/batch-processor.tsx`  
**Location**: Lines 1425, 2742 (where array mutations happen)

```typescript
// When removing images from results array:
const handleRemoveImage = (indexToRemove: number) => {
  // ✅ Clean up jobId mapping before removal
  const resultToRemove = results[indexToRemove];
  if (resultToRemove?.jobId) {
    delete jobIdToIndexRef.current[resultToRemove.jobId];
  }
  
  // Remove from arrays
  setFiles(prev => prev.filter((_, i) => i !== indexToRemove));
  setResults(prev => prev.filter((_, i) => i !== indexToRemove));
  
  // ✅ Rebuild jobId mapping with shifted indices
  Object.keys(jobIdToIndexRef.current).forEach(jid => {
    const oldIndex = jobIdToIndexRef.current[jid];
    if (oldIndex > indexToRemove) {
      jobIdToIndexRef.current[jid] = oldIndex - 1;
    }
  });
};
```

---

## PART 3: POLLING SOURCE-OF-TRUTH AMBIGUITY 🟡 MEDIUM

### 3.1 Current Data Sources

**System 1: Redis Job Status** (`jobs:${jobId}`)
```typescript
// worker/src/worker.ts - writes
await updateJob(payload.jobId, {
  status: "complete",
  imageUrl: pub.url,
  stageUrls: { "1A": pub1AUrl, "2": pub2Url }
});

// server/src/services/jobs.ts - reads
export async function getJob(jobId: string): Promise<JobRecord | undefined> {
  const key = `jobs:${jobId}`;
  const val = await redisClient.get(key);
  return val ? JSON.parse(val) : undefined;
}
```

**System 2: Redis Image History** (`image:url:*`, `image:family:*`)
```typescript
// shared/src/imageStore.ts
await recordEnhancedImageRedis({
  userId,
  imageId,
  publicUrl: pub.url,
  baseKey: extractKey(pub.url),
  versionId: "",
  stage: "region-edit",
});
```

**System 3: PostgreSQL job_reservations**
```sql
-- server/src/db/migrations/001_init.sql
SELECT * FROM job_reservations 
WHERE job_id = $1 
  AND charge_finalized = TRUE;
```

**System 4: PostgreSQL enhanced_images_history**
```typescript
// shared/src/imageHistory.ts (from previous code)
await recordEnhancedImageHistory({
  userId,
  jobId,
  publicUrl,
  thumbnailUrl,
  originalUrl,
  enhancedS3Key,
  stagesCompleted,
});
```

**Problem**: Which system is authoritative for:
- Job completion status?
- Image availability?
- Retry/edit result publishing?
- Billing finalization?

---

### 3.2 Current Polling Flow

```
Client UI
    ↓
GET /api/status/batch?ids=<jobId>
    ↓
server/src/routes/status.ts
    ↓
calls getJob(jobId) → Redis jobs:<jobId>
    ↓
returns { status, imageUrl, stageUrls }
    ↓
Client updates UI
```

**Race Condition**:
```
T=0: Worker updates Redis jobs:<jobId> → status=complete
T=1: GET /api/status/batch → reads Redis → returns status=complete
T=2: Client receives status=complete
T=3: Client tries to display imageUrl
T=4: ❌ imageUrl not yet published to S3 (still uploading)
T=5: Client shows broken image or 403 error
```

---

### 3.3 Source-of-Truth Declaration (REQUIRED)

**Recommended Authority Hierarchy**:

1. **Job Completion**: Redis `jobs:<jobId>` (AUTHORITATIVE)
   - Worker writes status="complete" + imageUrl
   - Status endpoint reads this
   - Client polls this

2. **Image Availability**: S3 pre-signed URL presence (VERIFICATION)
   - Before marking job complete, verify S3 publish succeeded
   - Store S3 versionId for immutability guarantee

3. **Billing Finalization**: PostgreSQL `job_reservations.charge_finalized` (AUDIT TRAIL)
   - Worker finalizes after publish succeeds
   - Async from status updates (non-blocking)

4. **Image History**: PostgreSQL `enhanced_images_history` (LONG-TERM STORAGE)
   - Best-effort recording after publish
   - Not checked during polling (too slow)

**Implementation**:
```typescript
// worker/src/worker.ts - atomic completion gate
async function markJobComplete(jobId: string, imageUrl: string, stageUrls: any) {
  // 1. CONDITIONAL S3 verification (only if DEBUG mode or escalation)
  const shouldVerifyS3 = process.env.DEBUG_PUBLISH_VERIFY === '1' || 
                         payload.escalated === true;
  
  if (shouldVerifyS3) {
    try {
      const headResponse = await fetch(imageUrl, { method: 'HEAD' });
      if (!headResponse.ok) {
        throw new Error(`S3 verification failed: ${headResponse.status}`);
      }
      console.log('[JOB_COMPLETE] S3 verification passed', { jobId, imageUrl });
    } catch (err) {
      console.error('[JOB_COMPLETE_BLOCKED] S3 verification failed', { jobId, imageUrl, err });
      // Mark as failed instead of complete
      await updateJob(jobId, {
        status: "failed",
        error: "Image publish verification failed",
      });
      return;
    }
  } else {
    // Trust publish step result (faster, no extra S3 cost)
    console.log('[JOB_COMPLETE] Trusting publish step result (no HEAD verification)', { jobId });
  }
  
  // 2. Mark complete in Redis (authoritative status)
  await updateJob(jobId, {
    status: "complete",
    imageUrl,
    stageUrls,
    completedAt: new Date().toISOString(),
  });
  
  // 3. Finalize billing (async, non-blocking)
  finalizeReservationFromWorker({ ... }).catch(err => {
    console.error('[BILLING] Finalization failed (non-blocking)', err);
  });
  
  // 4. Record history (async, non-blocking)
  recordEnhancedImageHistory({ ... }).catch(err => {
    console.error('[HISTORY] Recording failed (non-blocking)', err);
  });
}
```

**When to enable S3 verification**:
- Set `DEBUG_PUBLISH_VERIFY=1` during debugging
- Automatically enabled when validator escalation triggered
- Otherwise: trust publish step (faster, cheaper)

---

## PART 4: PHASED IMPLEMENTATION PLAN

### Phase 1: Critical Production Blockers (Week 1) 🔴 MUST SHIP

**Goal**: Stop revenue leak, fix false failures, prevent UI corruption

**Changes**:
1. **Retry billing with type classification** (`retrySingle.ts:290`)
   - Add retry type check (`manual_retry` vs `validator_retry` vs `system_retry`)
   - Reserve allowance ONLY for manual retries
   - Add idempotency key (30-second window)
   - Enforce retry cap (2 max)

2. **Timeout mismatch fix** (`batch-processor.tsx:632`)
   - Increase from 60s → 5min
   - Add spinner message: "Processing — complex staging may take up to 4 minutes"

3. **Race condition guards** (`batch-processor.tsx:3392`)
   - Add jobId ownership validation
   - Add version timestamp checks (primary authority)
   - Add index bounds checks
   - Add jobIdToIndexRef maintenance on removals

4. **Idempotency protection** (NEW)
   - Prevent double-submit spam
   - 30-second deduplication window
   - Applies to both retry and edit endpoints

**Implementation Details**:

**1a. Retry Type Classification**:
```typescript
// server/src/routes/retrySingle.ts
type RetryType = "manual_retry" | "validator_retry" | "system_retry";

interface RetryInfo {
  retryType: RetryType;
  parentJobId?: string;
  reason?: string;
}

// Decision table:
// manual_retry    → CHARGE credits, increment quota
// validator_retry → FREE (our fault), increment quota
// system_retry    → FREE (infra fault), increment quota
```

**1b. Idempotency Key Pattern**:
```typescript
// 30-second window (rounds down to nearest 30s)
const idempotencyKey = `retry:${userId}:${parentJobId}:${Math.floor(Date.now() / 30000)}`;
const existing = await redisClient.get(idempotencyKey);
if (existing) {
  return res.status(409).json({ 
    code: "DUPLICATE_RETRY", 
    jobId: existing 
  });
}
await redisClient.setex(idempotencyKey, 30, newJobId);
```

**Testing**:
- ✅ Manual retry → verify credit charged, quota incremented
- ✅ Validator false-positive retry → verify FREE
- ✅ Worker crash retry → verify FREE
- ✅ Double-click retry → verify 409 response
- ✅ Upload with full pipeline → verify completes in 3-5min without timeout
- ✅ Submit 2 concurrent retries → verify no UI corruption
- ✅ Remove image during retry → verify no crash

**Success Criteria**:
- ✅ Zero free retry exploits (manual retries billed)
- ✅ System/validator retries remain free
- ✅ Zero timeout errors on successful jobs
- ✅ jobId mismatches logged and handled via version check
- ✅ Zero duplicate job spam
- ✅ Zero React errors in console

---

### Phase 2: Edit Stage Integrity (Week 2) ⚠️ MEDIUM

**Goal**: Preserve original stage outputs when editing

**Changes**:
1. Stop overwriting stageUrls during edit (`batch-processor.tsx:5621`)
2. Add edit as separate stage key (`'edit'`, `'region-edit'`)
3. Preserve retry baseline URL for subsequent edits
4. Mark edits as derived stage in lineage
5. **CRITICAL**: Exclude edit stage from retry auto-baseline selection

**Edit Stage URL Structure**:
```typescript
// BEFORE edit:
stageUrls = {
  "1A": url1A,
  "1B": url1B,
  "2": url2
}

// AFTER edit:
stageUrls = {
  "1A": url1A,       // ✅ Preserved
  "1B": url1B,       // ✅ Preserved
  "2": url2,         // ✅ Preserved (original)
  "edit": urlEdit1   // ✅ New edit stage
}

// AFTER second edit:
stageUrls = {
  "1A": url1A,
  "1B": url1B,
  "2": url2,
  "edit": urlEdit2,   // ✅ Latest edit
  "edit-1": urlEdit1  // ✅ Previous edit archived
}
```

**Retry Baseline Selection Guard**:
```typescript
// client/src/components/batch-processor.tsx
function selectRetryBaseline(result: Result): string {
  const { stageUrls } = result;
  
  // ⚠️ EXCLUDE edit stages from auto-baseline
  const retryableStages = Object.entries(stageUrls || {})
    .filter(([stage, url]) => !stage.startsWith('edit')) // ✅ Guard
    .sort((a, b) => stageRank(b[0]) - stageRank(a[0]));
  
  // Prefer highest non-edit stage as retry baseline
  return retryableStages[0]?.[1] || result.imageUrl;
}
```

**Why This Matters**:
- Edit may modify structure (furniture added/removed)
- Using edit as retry baseline would fail structural validation
- Retry should restart from last structural-clean stage (1B or 2)

**Testing**:
- Upload image with full pipeline (1A+1B+2) → takes 3-5min
- Perform region edit → verify stageUrls preserves original stages
- Edit result again → verify edit chain (edit, edit-1, edit-2)
- Retry after edit → verify baseline excludes edit stages
- Switch between stages using selector → all outputs intact

**Success Criteria**:
- ✅ Original Stage 2 output viewable after edit
- ✅ Multiple edits create chain (edit, edit-1, edit-2)
- ✅ Stage selector shows all available outputs
- ✅ Retry excludes edit stages from baseline selection
- ✅ No data loss on edit operations

---

### Phase 3: Edit Policy & Source-of-Truth (Week 3) 🟡 DEFERRED DECISION

**Goal**: Formalize edit billing policy and completion authority

**Changes**:
1. **Edit billing decision: Keep FREE** (Option A)
   - Edit count cap (3) remains as rate limiting only
   - No credit charges for edits
   - Monitor usage for 30 days
   - Re-evaluate based on abuse metrics

2. **Source-of-truth declaration** (documentation)
   - Redis `jobs:<jobId>` = status authority
   - S3 publish = asset authority
   - Postgres `job_reservations` = billing authority
   - History table = archival only

3. **Conditional S3 verification** (optional)
   - Enable via `DEBUG_PUBLISH_VERIFY=1`
   - Or auto-enable on validator escalation
   - Default: trust publish step (faster, cheaper)

4. **Verify no orphaned reservations**
   - Audit query: reservations where `charge_finalized = FALSE` and `created > 1 hour ago`
   - Alert on orphans
   - Reconciliation script for cleanup

**Why Keep Edits Free**:
- Edits are refinement, not full compute pipeline
- Already capped at 3 (rate limiting sufficient)
- Region edit cost << full staging pipeline
- No abuse metrics yet justify charging
- Reduces UX friction during rollout

**Testing**:
- Upload image → edit 3 times → 4th edit blocked (quota cap)
- Verify no credit charges for edits
- Check job_reservations → verify edits don't create rows
- Monitor edit frequency metrics for 30 days
- Check for orphaned reservations (should be zero)

**Success Criteria**:
- ✅ Edit policy documented (free, 3 cap)
- ✅ Edit frequency metrics collected
- ✅ Source-of-truth hierarchy documented
- ✅ Zero orphaned reservations
- ✅ S3 verification conditional (not default)

**Future Review Trigger**:
If edit frequency > 10 per user per month OR abuse detected → revisit pricing

---

### Phase 4: UI Consistency (Week 4) 🟡 LOW

**Goal**: Bulletproof state management against edge cases

**Changes**:
1. Add version timestamp checks (`batch-processor.tsx:3392`)
2. Add jobIdToIndexRef maintenance on removals (`batch-processor.tsx:1425`)
3. Add index bounds checks before all setResults
4. Add stale update detection and logging
5. Add concurrent retry protection (debounce)

**Testing**:
- Submit retry → remove image → verify no crash
- Submit 2 retries quickly → verify newer wins
- Edit during retry → verify no corruption
- Reload page during processing → verify state restored

**Success Criteria**:
- ✅ Zero React errors in console
- ✅ Zero wrong-image updates
- ✅ Stale updates logged and rejected
- ✅ State persistence works correctly

---

## DEPLOYMENT & MONITORING

### Pre-Deployment Checklist

```bash
# 1. Database backup
pg_dump $DATABASE_URL > backup_pre_retry_fix.sql

# 2. Redis backup
redis-cli --rdb dump.rdb

# 3.Enable debug logging
export RETRY_DEBUG=1
export EDIT_DEBUG=1
export BILLING_DEBUG=1

# 4. Deploy to staging first
railway up --service worker --environment staging
railway up --service server --environment staging
railway up --service client --environment staging

# 5. Run integration tests
npm run test:retry-flow
npm run test:edit-flow
npm run test:billing-flow
```

### Monitoring Queries

```sql
-- Retry reservation tracking
SELECT 
  DATE(created_at) as date,
  COUNT(*) as total_retries,
  COUNT(*) FILTER (WHERE reservation_status = 'consumed') as successful,
  COUNT(*) FILTER (WHERE reservation_status = 'released') as failed,
  AVG(reserved_images) as avg_credits_per_retry
FROM job_reservations
WHERE retry_count > 0
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- Orphaned reservations (never finalized)
SELECT 
  job_id,
  agency_id,
  created_at,
  reservation_status,
  charge_finalized,
  retry_count,
  edit_count
FROM job_reservations
WHERE charge_finalized = FALSE
  AND created_at < NOW() - INTERVAL '1 hour'
  AND reservation_status = 'reserved'
ORDER BY created_at DESC
LIMIT 100;

-- Edit usage tracking
SELECT 
  DATE(created_at) as date,
  COUNT(*) as total_edits,
  COUNT(*) FILTER (WHERE edit_count = 1) as first_edits,
  COUNT(*) FILTER (WHERE edit_count = 2) as second_edits,
  COUNT(*) FILTER (WHERE edit_count = 3) as third_edits,
  COUNT(*) FILTER (WHERE amendments_locked = TRUE) as locked_after_3
FROM job_reservations
WHERE edit_count > 0
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

---

## RISK MITIGATION

### Rollback Plan

**If Phase 3 (billing) causes issues:**
```sql
-- Quick disable retry credits (emergency)
UPDATE job_reservations 
SET amendments_locked = TRUE
WHERE retry_count >= 2 
  AND amendments_locked = FALSE;

-- Refund incorrectly charged retries
UPDATE agency_month_usage 
SET included_used = included_used - [refund_count],
    updated_at = NOW()
WHERE agency_id = '[affected_agency]'
  AND yyyymm = '[current_month]';
```

**If Phase 2 (stage preservation) corrupts data:**
```typescript
// Client hotfix - disable edit functionality
localStorage.setItem('EDIT_DISABLED', '1');

// Then user refresh → edit buttons hidden
if (localStorage.getItem('EDIT_DISABLED') === '1') {
  return null; // Don't render edit button
}
```

### Circuit Breaker

```typescript
// server/src/routes/retrySingle.ts
const RETRY_CIRCUIT_BREAKER = process.env.RETRY_ENABLED !== '0';

if (!RETRY_CIRCUIT_BREAKER) {
  return res.status(503).json({
    error: "retry_temporarily_disabled",
    message: "Retry functionality is temporarily disabled for maintenance."
  });
}
```

---

## FINAL VERDICT

### ✅ APPROVED - Proceed with Implementation

**Critical Path (Must Fix Before Wide Production)**:

1. ✅ **Retry billing with type classification** - Revenue leak + quota bypass
   - Charge manual retries only
   - Free validator/system retries
   - Add idempotency key (30s window)
   
2. ✅ **Timeout mismatch fix** - User confusion + false failures
   - 60s → 5min timeout
   - Add progress messaging
   
3. ✅ **Race condition guards** - UI corruption risk
   - Version timestamp as primary authority
   - jobId validation (but not blocking)
   - Index bounds checks
   
4. ✅ **Stage URL preservation** - Data loss on edits
   - Preserve original stageUrls
   - Edit as separate stage key
   - **Exclude edit from retry baseline**

**Estimated Effort**: 3-5 days (Phase 1)

---

### 🟡 Next Sprint (Fix Within 2-4 Weeks)

5. 🟡 **Edit billing policy** - Defer decision
   - **Keep FREE for now** (Option A)
   - Monitor for 30 days
   - Re-evaluate based on abuse metrics
   
6. 🟡 **S3 verification** - Make conditional
   - Enable via `DEBUG_PUBLISH_VERIFY=1`
   - Or auto-enable on escalation
   - **Not default** (adds latency + cost)

**Estimated Effort**: 2-3 days (Phase 2-3)

---

### Key Refinements from Review

**Retry Type Classification**:
```
┌─────────────────┬──────────┬─────────────────────────┐
│ Retry Cause     │ Charge?  │ Reason                  │
├─────────────────┼──────────┼─────────────────────────┤
│ Manual retry    │ ✅ Yes   │ User value action       │
│ Validator retry │ ❌ No    │ Your validator fault    │
│ System retry    │ ❌ No    │ Infra fault             │
└─────────────────┴──────────┴─────────────────────────┘
```

**Race Condition Authority**:
- ✅ **Version timestamp** = primary authority
- ⚠️ **jobId** = secondary (changes during retry/edit)
- Block only if: `status === completed` AND `version > new` AND `jobId !== current`

**S3 Verification**:
- ❌ **Not default** (latency, cost, eventual consistency risk)
- ✅ **Conditional**: DEBUG mode or validator escalation only

**Edit Baseline Exclusion**:
- Edit stages must not be used as retry baseline
- Retry should use last structural-clean stage (1B or 2)
- Guard: `filter(([stage]) => !stage.startsWith('edit'))`

**Idempotency Protection** (NEW):
- Prevent double-submit spam
- 30-second deduplication window
- Redis key pattern: `retry:{userId}:{parentJobId}:{timestamp/30000}`

---

### 🎯 Implementation Order

**Week 1** (Ship ASAP):
1. Retry billing + type classification
2. Idempotency key
3. Timeout fix (60s → 5min)
4. Race condition guards (version-based)
5. Stage URL preservation + baseline exclusion

**Week 2-3** (Next Sprint):
6. Edit policy documentation (free)
7. S3 verification (conditional)
8. Edit frequency metrics
9. Orphaned reservation monitoring

**Week 4** (Polish):
10. Advanced UI consistency guards
11. Stale update detection logging
12. Performance monitoring

---

### 📊 Success Metrics

**Revenue Protection**:
- Zero free manual retries exploited
- System/validator retries = 0 charges
- Retry cap enforced (max 2 per image)

**Reliability**:
- Zero timeout errors on successful 3-5min jobs
- Zero React state corruption errors
- Zero duplicate job spam

**Data Integrity**:
- Zero stage URL overwrites on edit
- Zero retry-from-edit structural failures
- Zero orphaned reservations

---

### ⚠️ Production Monitoring

**Watch for**:
- Retry frequency spike (potential abuse)
- Edit frequency > 10/user/month (pricing review trigger)
- Orphaned reservations (billing leak)
- Idempotency 409 rate (UX issue indicator)

**Alerts**:
```sql
-- Orphaned reservation alert (run hourly)
SELECT COUNT(*) FROM job_reservations
WHERE charge_finalized = FALSE
  AND created_at < NOW() - INTERVAL '1 hour'
  AND reservation_status = 'reserved';
-- Alert if > 10

-- Retry abuse detection (run daily)
SELECT user_id, COUNT(*) as retry_count
FROM job_reservations
WHERE retry_count > 0
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY user_id
HAVING COUNT(*) > 20;
-- Alert if any users > 20 retries/day
```

---

## APPENDIX: BILLING RULES REFERENCE

### Current Pricing (from PLAN_LIMITS)

```typescript
// shared/src/plans.ts
export const PLAN_LIMITS = {
  starter: {
    mainAllowance: 25,        // 25 images/month
    price: 0,                 // Free tier
  },
  professional: {
    mainAllowance: 150,       // 150 images/month
    price: 49,                // $49/month
  },
  agency: {
    mainAllowance: 500,       // 500 images/month
    price: 149,               // $149/month
  }
};
```

### Credit Consumption Rules

**Upload + Full Pipeline**:
- Stage 1A only: 1 credit
- Stage 1A + 1B: 1 credit (bundled)
- Stage 1A + 2: 1 credit (bundled)
- Stage 1A + 1B + 2: 2 credits (1 for 1A+1B, 1 for 2)

**Retry** (proposed):
- Full retry (1A+1B+2): 2 credits (same as original upload)
- Partial retry (1A+2): 1 credit
- Stage 2 only: 1 credit

**Edit** (proposed options):
- Option A: Free (first 3 per image)
- Option B: 1 credit per edit

### Refund Rules

**Partial Failure**:
- Stage 1A fails: Refund all credits
- Stage 1B fails: Refund Stage 2 credit (keep Stage 1 charge)
- Stage 2 fails: Refund Stage 2 credit (keep Stage 1 charge)

**Complete Failure**:
- All stages fail: Refund all credits

---

**END OF EXPANDED ANALYSIS**
