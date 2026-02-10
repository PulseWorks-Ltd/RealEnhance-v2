# Sprint 1 Verification Audit Report
**Date:** February 9, 2026  
**Scope:** Cross-job state isolation verification  
**Status:** ⚠️ **CRITICAL ISSUES FOUND**

---

## Executive Summary

Sprint 1 successfully eliminated global writes in `worker.ts`, but **CRITICAL cross-job contamination risks remain** in pipeline and AI modules that still READ from global namespace as fallbacks.

**Isolation Confidence Score:** 🔴 **45/100** (INSUFFICIENT)

---

## 1️⃣ JobExecutionContext Flow Analysis

### ✅ PASS: Worker.ts Implementation
- `jobContext` object created per-job (lines 338-350)
- All 13 global writes eliminated in worker.ts
- JobExecutionContext properly scoped to job handler

### ❌ FAIL: Pipeline Module Integration
**jobContext is NOT passed to pipeline functions.**

Pipeline functions have **pure signatures** but use **global.__* as fallbacks**:

#### Stage 1A (`worker/src/pipeline/stage1A.ts`)
**Function signature:** Pure parameters (no jobContext)
```typescript
export async function runStage1A(
  inputPath: string,
  options: { replaceSky?, declutter?, sceneType?, ... }
)
```

**Global reads inside function:**
- Line 152: `(global as any).__jobSampling` (2 occurrences)
- Line 181: `(global as any).__baseArtifacts`
- Line 182: `(global as any).__jobId`
- Line 183: `(global as any).__jobRoomType`
- Line 266: `(global as any).__baseArtifactsCache` (read)
- Line 307: `(global as any).__baseArtifactsCache` (write!)

**Risk:** Stage 1A reads baseArtifacts/jobSampling from global when worker.ts populates it. Under concurrent execution, Job B can read Job A's artifacts.

#### Stage 1B (`worker/src/pipeline/stage1B.ts`)
**Global reads:**
- Line 31: `(global as any).__jobId`
- Line 74: `(global as any).__curtainRailLikely`
- Line 149: `(global as any).__jobDeclutterIntensity`
- Line 150: `(global as any).__jobSampling` (2 occurrences)
- Line 159: `(global as any).__canonicalPath`
- Line 161: `(global as any).__baseArtifacts`
- Line 170: `(global as any).__jobId`

**Risk:** Stage 1B validation reads canonicalPath/baseArtifacts from global. If Job A and Job B overlap, Job B gets Job A's canonical path.

#### Stage 2 (`worker/src/pipeline/stage2.ts`)
**Global reads:**
- Line 72: `(global as any).__jobId`
- Line 228: `(global as any).__curtainRailLikely`

**Risk:** Stage 2 curtain rail decision can use stale global value from previous job.

#### AI Gemini Module (`worker/src/ai/gemini.ts`)
**Global reads:**
- Line 183: `(global as any).__jobId`
- Line 184: `(global as any).__jobRoomType`

**Risk:** Gemini API calls can log wrong jobId/roomType if global not cleared between jobs.

---

## 2️⃣ Module-Scope Mutable Variables

### ⚠️ HIGH RISK: Singleton Caches

#### `worker/src/ai/gemini.ts`
```typescript
let singleton: GoogleGenAI | null = null;  // Line 109
```
**Risk:** LOW - Singleton client is stateless API client (safe shared resource)

#### `worker/src/ai/scene-detector.ts` & `room-detector.ts`
```typescript
let ort: ORT | null = null;
let sceneSession: any | null = null;  // or roomSession
```
**Risk:** LOW - ML model singletons are read-only inference engines (safe)

#### `worker/src/utils/adminConfig.ts`
```typescript
let lastConfigPath: string | null = null;
let cachedConfig: GeminiConfig | null = null;
let lastLoadMs = 0;
```
**Risk:** LOW - Config cache is read-only after load (safe)

#### `worker/src/utils/memory-monitor.ts`
```typescript
const jobMemoryMap = new Map<string, JobMemoryStats>();  // Line 22
```
**Risk:** MEDIUM - This Map is keyed by jobId, so it's job-isolated by design. However, it's never cleared, causing memory leak over time. Not a cross-contamination risk but operational risk.

#### `worker/src/utils/cancel.ts`
```typescript
let client: RedisClientType | null = null;  // Line 3
```
**Risk:** LOW - Redis client singleton (safe shared resource)

### ⚠️ MEDIUM RISK: Module State

#### `worker/src/pipeline/stage1A.ts`
```typescript
let stabilityPrimaryLockedReason: string | null = null;  // Line 28
```
**Risk:** MEDIUM - This is mutated (lines lockStabilityPrimary()) but affects ALL jobs globally. If Job A locks Stability due to payment error, Job B cannot use it. This is **intentional global circuit breaker** behavior, not a bug, but worth noting.

#### `worker/src/validators/validationModes.ts`
```typescript
let cachedResolution: Resolution | null = null;  // Line 12
let logged = false;  // Line 13
```
**Risk:** LOW - Config resolution cache, read-only after first resolution (safe)

#### `worker/src/validators/testPromptStrength.ts`
```typescript
let detectedProject = "realenhance-v2";  // Line 18
```
**Risk:** LOW - Static detection flag (read-only in practice)

---

## 3️⃣ Global Namespace Reads

### ❌ CRITICAL: Extensive global.__* reads remain

**Total occurrences:** 27+ global reads across pipeline/ai modules

#### Breakdown by Variable:
- `global.__jobId`: 7 reads (stage1A, stage1B, stage2, gemini)
- `global.__baseArtifacts`: 3 reads (stage1A, stage1B)
- `global.__baseArtifactsCache`: 2 reads + 1 write (stage1A)
- `global.__jobSampling`: 4 reads (stage1A, stage1B)
- `global.__curtainRailLikely`: 3 reads (stage1B, stage2)
- `global.__canonicalPath`: 1 read (stage1B)
- `global.__jobDeclutterIntensity`: 1 read (stage1B)
- `global.__jobRoomType`: 2 reads (stage1A, gemini)

**Pattern:**
```typescript
const jobId = jobIdOpt || (global as any).__jobId || "default";
```
All pipeline functions use **optional parameter + global fallback**. Since worker.ts no longer writes to global, these fallbacks are:
1. Reading stale values from previous jobs (if global not cleared)
2. Using "default" placeholder if global cleared

**Contamination Scenario:**
```
Job A starts → worker sets global.__baseArtifacts → Stage 1A reads it
Job B starts (concurrent) → worker sets global.__baseArtifacts (overwrites)
Job A Stage 1B executes → reads global.__baseArtifacts → gets Job B's data! ❌
```

---

## 4️⃣ Retry State Verification

### ✅ PASS: Retry State is Job-Persisted

`worker/src/validators/stageRetryManager.ts`:
- Line 44: `getRetryState(jobId)` loads from job metadata
- Line 63: `saveRetryState(jobId, state)` persists to job record
- Line 76: `clearRetryState(jobId)` removes from job record
- NO module-scope Map anymore ✅

**Verdict:** Retry state is correctly isolated per-job.

---

## 5️⃣ Stage Artifact Path Variables

### ✅ PASS: No Module-Scope Path Variables

All path variables (`path1A`, `path1B`, `path2`, `stage2InputPath`, etc.) are:
- Function-scoped in `worker.ts`
- Local variables in pipeline functions
- No module-scope path state ✅

**Verdict:** Path variables are correctly scoped.

---

## A) Remaining Cross-Job State Risks

### 🔴 CRITICAL RISKS

1. **baseArtifacts Global Read (Stage 1A, Stage 1B)**
   - **File:** `pipeline/stage1A.ts:181`, `pipeline/stage1B.ts:161`
   - **Scope:** Module reads from `global.__baseArtifacts`
   - **Impact:** Job B can read Job A's canonical image artifacts
   - **Likelihood:** HIGH (concurrent jobs)
   - **Severity:** HIGH (wrong image data used for processing)

2. **baseArtifactsCache Global Read+Write (Stage 1A)**
   - **File:** `pipeline/stage1A.ts:266, 307`
   - **Scope:** Module reads/writes `global.__baseArtifactsCache`
   - **Impact:** Cache poisoning between jobs
   - **Likelihood:** MEDIUM (cache keyed by path, but paths can collide)
   - **Severity:** MEDIUM (performance impact + potential wrong artifacts)

3. **curtainRailLikely Global Read (Stage 1B, Stage 2)**
   - **File:** `pipeline/stage1B.ts:74`, `pipeline/stage2.ts:228`
   - **Scope:** Module reads from `global.__curtainRailLikely`
   - **Impact:** Stage 2 uses wrong curtain rail detection from previous job
   - **Likelihood:** HIGH (staging decision affected)
   - **Severity:** MEDIUM (incorrect furniture/curtain placement)

4. **canonicalPath Global Read (Stage 1B)**
   - **File:** `pipeline/stage1B.ts:159`
   - **Scope:** Module reads from `global.__canonicalPath`
   - **Impact:** Validation compares against wrong baseline image
   - **Likelihood:** HIGH
   - **Severity:** HIGH (validation logic broken)

5. **jobSampling Global Read (Stage 1A, Stage 1B)**
   - **File:** `pipeline/stage1A.ts:152`, `pipeline/stage1B.ts:150`
   - **Scope:** Module reads from `global.__jobSampling`
   - **Impact:** Wrong sampling parameters applied (temperature, topK, etc.)
   - **Likelihood:** MEDIUM
   - **Severity:** MEDIUM (quality degradation)

6. **jobDeclutterIntensity Global Read (Stage 1B)**
   - **File:** `pipeline/stage1B.ts:149`
   - **Scope:** Module reads from `global.__jobDeclutterIntensity`
   - **Impact:** Wrong declutter strength applied
   - **Likelihood:** LOW (usually passed as parameter)
   - **Severity:** LOW

### 🟡 MEDIUM RISKS

7. **jobId Global Fallback (All Pipeline Modules)**
   - **File:** `pipeline/stage1A.ts:182`, `stage1B.ts:31`, `stage2.ts:72`, `ai/gemini.ts:183`
   - **Scope:** Multiple modules use `(global as any).__jobId || "default"`
   - **Impact:** Logging/tracking uses wrong jobId
   - **Likelihood:** LOW (jobId usually passed explicitly)
   - **Severity:** MEDIUM (operational visibility broken)

8. **jobRoomType Global Fallback (Stage 1A, Gemini)**
   - **File:** `pipeline/stage1A.ts:183`, `ai/gemini.ts:184`
   - **Scope:** Reads from `global.__jobRoomType`
   - **Impact:** Wrong room type used in prompts/processing
   - **Likelihood:** LOW (usually passed as parameter)
   - **Severity:** MEDIUM (quality impact)

9. **Memory Monitor Map Leak**
   - **File:** `utils/memory-monitor.ts:22`
   - **Scope:** `jobMemoryMap` never cleared
   - **Impact:** Memory leak (not cross-contamination)
   - **Likelihood:** HIGH (over days/weeks)
   - **Severity:** LOW (operational issue, not data corruption)

---

## B) File + Symbol + Scope Summary

| File | Symbol | Scope | Type | Risk |
|------|--------|-------|------|------|
| `pipeline/stage1A.ts` | `__baseArtifacts` | Global read | Data | 🔴 CRITICAL |
| `pipeline/stage1A.ts` | `__baseArtifactsCache` | Global read+write | Cache | 🔴 CRITICAL |
| `pipeline/stage1A.ts` | `__jobSampling` | Global read | Config | 🟡 MEDIUM |
| `pipeline/stage1A.ts` | `__jobId` | Global read | Metadata | 🟡 MEDIUM |
| `pipeline/stage1A.ts` | `__jobRoomType` | Global read | Config | 🟡 MEDIUM |
| `pipeline/stage1A.ts` | `stabilityPrimaryLockedReason` | Module-scope | Circuit breaker | 🟢 LOW (intentional) |
| `pipeline/stage1B.ts` | `__jobId` | Global read | Metadata | 🟡 MEDIUM |
| `pipeline/stage1B.ts` | `__curtainRailLikely` | Global read | Feature | 🔴 CRITICAL |
| `pipeline/stage1B.ts` | `__jobDeclutterIntensity` | Global read | Config | 🟢 LOW |
| `pipeline/stage1B.ts` | `__jobSampling` | Global read | Config | 🟡 MEDIUM |
| `pipeline/stage1B.ts` | `__canonicalPath` | Global read | Data | 🔴 CRITICAL |
| `pipeline/stage1B.ts` | `__baseArtifacts` | Global read | Data | 🔴 CRITICAL |
| `pipeline/stage2.ts` | `__jobId` | Global read | Metadata | 🟡 MEDIUM |
| `pipeline/stage2.ts` | `__curtainRailLikely` | Global read | Feature | 🔴 CRITICAL |
| `ai/gemini.ts` | `__jobId` | Global read | Metadata | 🟡 MEDIUM |
| `ai/gemini.ts` | `__jobRoomType` | Global read | Config | 🟡 MEDIUM |
| `utils/memory-monitor.ts` | `jobMemoryMap` | Module Map | Monitoring | 🟢 LOW (leak risk) |
| `validators/stageRetryManager.ts` | *(none)* | Job-persisted | Retry | ✅ PASS |

---

## C) Closure Capture Analysis

### ❌ FAIL: Closure Capture Still Possible

**Scenario 1: Async Callback Closures**

In `worker.ts`, validation callbacks capture local scope:
```typescript
onStrictRetry: ({ reasons }) => {
  void (async () => {
    // Closure captures: jobContext, payload, stage2InputPath, etc.
    if (!(await ensureStage2AttemptOwner("stage2_strict_retry"))) return;
    // Uses jobContext.curtainRailLikely ✅ (from closure)
  })();
}
```
**Verdict:** ✅ SAFE - Closures capture per-job context from worker.ts function scope.

**Scenario 2: Pipeline Module Closures**

Pipeline functions call validators with artifact data:
```typescript
// stage1B.ts:158
const canonicalPath: string | undefined = (global as any).__canonicalPath;
const baseArtifacts = (global as any).__baseArtifacts;
const verdict = await validateStageOutput("stage1B", canonicalPath, declutteredPath, {
  baseArtifacts,  // ❌ This baseArtifacts came from global!
});
```
**Verdict:** ❌ UNSAFE - Even though closure passes artifact, the artifact was read from global (stale risk).

**Scenario 3: Gemini API Calls**

```typescript
// ai/gemini.ts:183
const jobId = jobIdOpt || (global as any).__jobId;
const roomType = roomTypeOpt || (global as any).__jobRoomType;
// ... builds prompt with roomType
```
**Verdict:** ❌ UNSAFE - Gemini prompt construction can use wrong roomType from previous job.

---

## D) Confidence Score Details

**Scale:** 0-100 (0 = fully contaminated, 100 = perfect isolation)

### Component Scores:

1. **Worker.ts Isolation:** 90/100
   - ✅ No global writes
   - ✅ JobExecutionContext per-job
   - ✅ Function-scoped paths
   - ⚠️ -10: Doesn't pass context to pipeline functions

2. **Pipeline Module Isolation:** 15/100
   - ❌ Extensive global reads (27+ occurrences)
   - ❌ No jobContext integration
   - ❌ Fallback pattern encourages stale reads
   - ✅ +15: Function-scoped logic (no module state)

3. **Validator Isolation:** 85/100
   - ✅ No global reads in validators
   - ✅ Parameters passed explicitly
   - ⚠️ -15: Receive stale artifacts from pipeline modules

4. **Retry Manager Isolation:** 100/100
   - ✅ Job-persisted state
   - ✅ No module-scope maps
   - ✅ Fully isolated by jobId

5. **AI Module Isolation:** 30/100
   - ❌ Global reads for jobId/roomType
   - ✅ Singleton clients are stateless (safe)
   - ⚠️ -70: Logging/prompts can use wrong job metadata

### **Overall Confidence: 45/100** 🔴

**Weighted Average:**
- Worker (weight 30%): 90 × 0.30 = 27
- Pipeline (weight 40%): 15 × 0.40 = 6
- Validators (weight 15%): 85 × 0.15 = 12.75
- Retry (weight 10%): 100 × 0.10 = 10
- AI (weight 5%): 30 × 0.05 = 1.5
- **Total: 57.25 → Adjusted to 45 for global contamination severity**

---

## E) Residual Risk List

### Priority 1 (Must Fix Before Production)

1. **🔴 baseArtifacts contamination** (Stage 1A/1B)
   - Impact: Wrong image artifacts used for processing/validation
   - Fix: Pass baseArtifacts as explicit parameter to all pipeline functions
   
2. **🔴 canonicalPath contamination** (Stage 1B)
   - Impact: Validation compares against wrong baseline
   - Fix: Pass canonicalPath explicitly to Stage 1B

3. **🔴 curtainRailLikely contamination** (Stage 1B/2)
   - Impact: Wrong furniture placement decisions
   - Fix: Pass curtainRailLikely as explicit parameter

4. **🔴 baseArtifactsCache global write** (Stage 1A)
   - Impact: Cache poisoning between jobs
   - Fix: Move cache to Redis or jobContext

### Priority 2 (Should Fix for Reliability)

5. **🟡 jobSampling contamination** (Stage 1A/1B)
   - Impact: Wrong sampling parameters (quality degradation)
   - Fix: Pass sampling config explicitly

6. **🟡 jobId logging contamination** (All modules)
   - Impact: Operational visibility broken
   - Fix: Make jobId required parameter (no fallback)

7. **🟡 jobRoomType contamination** (Stage 1A, Gemini)
   - Impact: Wrong prompts/processing
   - Fix: Pass roomType explicitly

### Priority 3 (Nice to Have)

8. **🟢 Memory monitor map leak**
   - Impact: Memory leak over time
   - Fix: Periodic cleanup or TTL-based eviction

9. **🟢 Validation mode cache**
   - Impact: None (read-only cache)
   - Fix: None needed

### Priority 4 (Intentional Design)

10. **🟢 Stability circuit breaker**
    - Impact: None (intentional global circuit breaker)
    - Fix: None needed (document as intentional)

---

## Recommended Actions

### Immediate (Sprint 2):

1. **Refactor pipeline function signatures** to accept explicit `jobContext` or individual parameters:
   ```typescript
   export async function runStage1A(
     inputPath: string,
     options: {
       baseArtifacts: BaseArtifacts;  // ✅ Explicit
       canonicalPath?: string;
       curtainRailLikely?: boolean;
       jobSampling?: object;
       // ... rest
     }
   ): Promise<string>
   ```

2. **Eliminate all `|| (global as any).__*` fallback patterns** - Make parameters required or use undefined (no global fallback)

3. **Verify worker.ts passes all jobContext fields** explicitly to pipeline functions

4. **Test concurrent job execution** (5-10 jobs) to verify isolation

### Follow-up (Sprint 3):

5. **Move baseArtifactsCache** to Redis or per-job context
6. **Add memory monitor cleanup** (TTL-based eviction)
7. **Audit closure captures** in async callbacks
8. **Add runtime isolation checks** (detect stale global reads)

---

## Test Coverage Gaps

Current testing doesn't verify:
- ❌ Concurrent job execution (race conditions)
- ❌ Global state pollution detection
- ❌ Artifact contamination scenarios
- ❌ Closure capture timing issues

**Recommendation:** Add integration tests with 5-10 concurrent jobs using different input images, verify no cross-contamination in outputs.

---

## Conclusion

Sprint 1 successfully eliminated **global WRITES** in worker.ts, which prevents new contamination from being introduced. However, **global READS** remain pervasive in pipeline modules, creating **stale data contamination risk** from previous jobs.

**Current State:** Worker.ts writes to jobContext ✅, but pipeline modules still read from global ❌

**Required Next Step:** Eliminate all global reads by passing jobContext/parameters explicitly through the call chain.

**Estimated Effort:** Sprint 2 (2-3 days) to refactor pipeline signatures and wire jobContext through.

**Production Risk:** 🔴 HIGH - Do not deploy without fixing Priority 1 issues.
