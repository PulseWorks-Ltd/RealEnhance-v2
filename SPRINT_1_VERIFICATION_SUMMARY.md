# Sprint 1 Verification: Quick Reference

## 🎯 Isolation Confidence: 45/100 🔴

```
COMPONENT ISOLATION STATUS:
├── Worker.ts           ✅ 90/100  (No writes, JobContext created)
├── Pipeline Modules    ❌ 15/100  (27+ global reads remaining)
├── Validators          ✅ 85/100  (Clean, but receive stale data)
├── Retry Manager       ✅ 100/100 (Job-persisted, fully isolated)
└── AI Modules          ⚠️  30/100  (Global reads for jobId/roomType)
```

---

## 🔴 CRITICAL RISKS (Must Fix)

### Global Read Contamination Map

```
worker.ts (FIXED) ──┐
                     │ writes to jobContext ✅
                     │ NO writes to global ✅
                     │
                     ├─> runStage1A() ──┐
                     │                   │ reads global.__baseArtifacts ❌
                     │                   │ reads global.__jobSampling ❌
                     │                   │ writes global.__baseArtifactsCache ❌
                     │                   └─> Job A/B collision risk 🔴
                     │
                     ├─> runStage1B() ──┐
                     │                   │ reads global.__canonicalPath ❌
                     │                   │ reads global.__baseArtifacts ❌
                     │                   │ reads global.__curtainRailLikely ❌
                     │                   │ reads global.__jobSampling ❌
                     │                   └─> Job A/B collision risk 🔴
                     │
                     └─> runStage2() ────┐
                                         │ reads global.__jobId ❌
                                         │ reads global.__curtainRailLikely ❌
                                         └─> Job A/B collision risk 🔴
```

---

## 📊 Global Contamination Matrix

| Variable | Writer | Readers | Risk | Severity |
|----------|--------|---------|------|----------|
| `__baseArtifacts` | ~~worker.ts~~ (removed) | stage1A, stage1B | 🔴 CRITICAL | HIGH |
| `__baseArtifactsCache` | stage1A ❌ | stage1A | 🔴 CRITICAL | MEDIUM |
| `__curtainRailLikely` | ~~worker.ts~~ (removed) | stage1B, stage2 | 🔴 CRITICAL | MEDIUM |
| `__canonicalPath` | ~~worker.ts~~ (removed) | stage1B | 🔴 CRITICAL | HIGH |
| `__jobSampling` | ~~worker.ts~~ (removed) | stage1A, stage1B | 🟡 MEDIUM | MEDIUM |
| `__jobId` | ~~worker.ts~~ (removed) | stage1A/B/2, gemini | 🟡 MEDIUM | LOW |
| `__jobRoomType` | ~~worker.ts~~ (removed) | stage1A, gemini | 🟡 MEDIUM | MEDIUM |
| `__jobDeclutterIntensity` | ~~worker.ts~~ (removed) | stage1B | 🟢 LOW | LOW |

**Pattern:** Worker.ts stopped writing ✅, but pipeline modules still reading stale values ❌

---

## 🔄 Contamination Flow Example

### Scenario: 2 Concurrent Jobs

```
Timeline:
T0: Job A starts → worker.ts creates jobContext.baseArtifacts = "imageA.webp artifacts"
T1: Job A → runStage1A() reads undefined from global.__baseArtifacts (OK)
T2: Job B starts → worker.ts creates jobContext.baseArtifacts = "imageB.webp artifacts"
T3: Job B → runStage1A() reads undefined from global.__baseArtifacts (OK)
                                                                      ↓
                     BUT WHAT IF GLOBAL NOT CLEARED?
                                                                      ↓
T3: Job B → runStage1A() reads OLD imageA artifacts from global ❌
    → Wrong image data used for Stage 1A processing
    → Validation uses wrong baseline
    → Output corruption
```

**Root Cause:** Pipeline functions have **defensive fallback** pattern:
```typescript
const baseArtifacts = (global as any).__baseArtifacts;  // ❌ Reads stale data
```

Since worker.ts NO LONGER WRITES to global, this reads:
1. **undefined** (if global cleared) → Breaks processing
2. **Stale previous job data** (if global not cleared) → Cross-contamination

---

## 🛠️ Fix Summary (Sprint 2 Required)

### Step 1: Refactor Pipeline Signatures ✅

**Before:**
```typescript
export async function runStage1A(
  inputPath: string,
  options: { replaceSky?, declutter?, ... }  // ❌ Missing critical fields
)
```

**After:**
```typescript
export async function runStage1A(
  inputPath: string,
  options: {
    replaceSky?,
    declutter?,
    baseArtifacts: BaseArtifacts,      // ✅ Explicit
    canonicalPath?: string,            // ✅ Explicit
    curtainRailLikely?: boolean,       // ✅ Explicit
    jobSampling?: SamplingConfig,      // ✅ Explicit
    jobId: string,                     // ✅ Required
    roomType?: string,
    ...
  }
)
```

### Step 2: Update Worker.ts Calls ✅

**Before:**
```typescript
path1A = await runStage1A(canonicalPath, {
  replaceSky: safeReplaceSky,
  sceneType: sceneLabel,
  jobId: payload.jobId,  // ✅ Already passing
  roomType: payload.options.roomType,
});
```

**After:**
```typescript
path1A = await runStage1A(canonicalPath, {
  replaceSky: safeReplaceSky,
  sceneType: sceneLabel,
  jobId: payload.jobId,
  roomType: payload.options.roomType,
  baseArtifacts: jobContext.baseArtifacts,       // ✅ Add
  canonicalPath: jobContext.canonicalPath,       // ✅ Add
  curtainRailLikely: jobContext.curtainRailLikely, // ✅ Add
  jobSampling: jobContext.jobSampling,           // ✅ Add
});
```

### Step 3: Remove Global Reads in Pipeline ✅

**Before:**
```typescript
const baseArtifacts = (global as any).__baseArtifacts;  // ❌ Remove
```

**After:**
```typescript
const baseArtifacts = options.baseArtifacts;  // ✅ Use parameter
if (!baseArtifacts) throw new Error("baseArtifacts required");  // ✅ Fail fast
```

### Step 4: Test Concurrent Execution ✅

```bash
# Run 10 concurrent jobs with different images
for i in {1..10}; do
  curl -X POST /api/enhance -d @job${i}.json &
done
wait

# Verify outputs:
# - No cross-image artifacts
# - Correct room detection per job
# - No validation errors using wrong baseline
```

---

## 📋 Sprint 2 Checklist

- [ ] Refactor `runStage1A()` signature (8 parameters to add)
- [ ] Refactor `runStage1B()` signature (6 parameters to add)
- [ ] Refactor `runStage2()` signature (1 parameter already passed ✅)
- [ ] Update all `runStage1A()` calls in worker.ts (1 call)
- [ ] Update all `runStage1B()` calls in worker.ts (2+ calls - main + retry)
- [ ] Remove all `(global as any).__*` reads in pipeline/stage1A.ts (7 occurrences)
- [ ] Remove all `(global as any).__*` reads in pipeline/stage1B.ts (8 occurrences)
- [ ] Remove all `(global as any).__*` reads in pipeline/stage2.ts (2 occurrences)
- [ ] Remove all `(global as any).__*` reads in ai/gemini.ts (2 occurrences)
- [ ] Move `baseArtifactsCache` from global to Redis or jobContext
- [ ] Test single job execution
- [ ] Test 5-10 concurrent jobs
- [ ] Verify no cross-contamination in logs
- [ ] Build verification (TypeScript)

**Estimated Effort:** 2-3 days

---

## 🎓 Key Learnings

1. **Eliminating writes ≠ Eliminating reads**
   - Worker.ts stopped writing ✅
   - But pipeline modules still reading ❌
   - Result: Stale data contamination risk

2. **Fallback patterns are dangerous**
   - `const x = param || global.__x || "default";`
   - Creates hidden dependencies
   - Makes isolation incomplete

3. **Pure function signatures are misleading**
   - Functions look pure (no global in signature)
   - But implementation reads global inside
   - Need to pass everything explicitly

4. **Testing gaps**
   - Single job tests pass ✅
   - Concurrent job tests would fail ❌
   - Need both for confidence

---

## 🚦 Go/No-Go Decision

**Production Deployment:** 🔴 **NO GO**

**Blockers:**
1. baseArtifacts contamination (data corruption risk)
2. canonicalPath contamination (validation broken)
3. curtainRailLikely contamination (wrong output decisions)

**Required Before Deploy:**
- Complete Sprint 2 fixes
- Pass concurrent job tests
- Verify isolation confidence > 85%

**Current Risk Level:** 🔴 HIGH
**Target Risk Level:** 🟢 LOW
**Gap:** Sprint 2 implementation required
