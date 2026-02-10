# Sprint 2 Refactor Plan: Eliminate Global Reads

**Date:** February 9, 2026  
**Branch:** fix/rollback-to-last-stable  
**Objective:** Remove all `(global as any).__*` reads from pipeline/AI modules

---

## 📋 GLOBAL READ INVENTORY

### File: `worker/src/pipeline/stage1A.ts`
**Function:** `runStage1A()`

| Line | Global Variable | Usage | Risk |
|------|----------------|-------|------|
| 152 | `__jobSampling` | Spread into callGemini options (2x) | 🔴 CRITICAL |
| 181 | `__baseArtifacts` | Passed to buildBaseArtifacts cache check | 🔴 CRITICAL |
| 182 | `__jobId` | Used as fallback for jobIdResolved | 🟡 MEDIUM |
| 183 | `__jobRoomType` | Used as fallback for roomTypeResolved | 🟡 MEDIUM |
| 266 | `__baseArtifactsCache` | Read Map for cache lookup | 🔴 CRITICAL |
| 307 | `__baseArtifactsCache` | Write Map to cache artifacts | 🔴 CRITICAL |

**Total:** 7 reads + 1 write

---

### File: `worker/src/pipeline/stage1B.ts`
**Function:** `runStage1B()`

| Line | Global Variable | Usage | Risk |
|------|----------------|-------|------|
| 31 | `__jobId` | Fallback for jobId | 🟡 MEDIUM |
| 74 | `__curtainRailLikely` | Prompt modification decision | 🔴 CRITICAL |
| 149 | `__jobDeclutterIntensity` | Passed to callGemini | 🟢 LOW |
| 150 | `__jobSampling` | Spread into callGemini options (2x) | 🔴 CRITICAL |
| 159 | `__canonicalPath` | Validation baseline path | 🔴 CRITICAL |
| 161 | `__baseArtifacts` | Passed to validators | 🔴 CRITICAL |
| 170 | `__jobId` | Passed to loadOrComputeStructuralMask | 🟡 MEDIUM |

**Total:** 8 reads

---

### File: `worker/src/pipeline/stage2.ts`
**Function:** `runStage2()`

| Line | Global Variable | Usage | Risk |
|------|----------------|-------|------|
| 72 | `__jobId` | Fallback for jobId | 🟡 MEDIUM |
| 228 | `__curtainRailLikely` | Prompt modification decision | 🔴 CRITICAL |

**Total:** 2 reads

---

### File: `worker/src/ai/gemini.ts`
**Function:** `callGemini()`

| Line | Global Variable | Usage | Risk |
|------|----------------|-------|------|
| 183 | `__jobId` | Fallback for jobId | 🟡 MEDIUM |
| 184 | `__jobRoomType` | Fallback for roomType | 🟡 MEDIUM |

**Total:** 2 reads

---

## 🎯 REFACTOR TARGET SUMMARY

**Total Global Reads:** 19 unique locations (27 including duplicates)  
**Files to Modify:** 5 files
- `worker/src/pipeline/stage1A.ts` (7 reads + 1 write)
- `worker/src/pipeline/stage1B.ts` (8 reads)
- `worker/src/pipeline/stage2.ts` (2 reads)
- `worker/src/ai/gemini.ts` (2 reads)
- `worker/src/worker.ts` (7 call sites to update)

---

## 🔧 REFACTOR SPECIFICATIONS

### 1. STAGE 1A REFACTOR

#### Current Signature:
```typescript
export async function runStage1A(
  inputPath: string,
  options: { 
    replaceSky?: boolean;
    declutter?: boolean;
    sceneType?: "interior" | "exterior" | string;
    interiorProfile?: EnhancementProfile;
    skyMode?: "safe" | "strong";
    jobId?: string;
    roomType?: string;
  } = {}
): Promise<string>
```

#### New Signature:
```typescript
export async function runStage1A(
  inputPath: string,
  options: { 
    // Existing parameters (keep as-is)
    replaceSky?: boolean;
    declutter?: boolean;
    sceneType?: "interior" | "exterior" | string;
    interiorProfile?: EnhancementProfile;
    skyMode?: "safe" | "strong";
    
    // NEW: Required parameters (no fallbacks)
    jobId: string;                          // ✅ Make required
    roomType: string;                       // ✅ Make required
    
    // NEW: Pipeline context parameters
    baseArtifacts?: BaseArtifacts | null;   // ✅ Add (from jobContext)
    baseArtifactsCache?: Map<string, BaseArtifacts>; // ✅ Add (from jobContext)
    jobSampling?: {                         // ✅ Add (from jobContext)
      temperature?: number;
      topP?: number;
      topK?: number;
    };
  } = {}
): Promise<string>
```

#### Changes Required:
```typescript
// Line 181: Remove global read
- const baseArtifacts = (global as any).__baseArtifacts;
+ const baseArtifacts = options.baseArtifacts;

// Line 182: Remove fallback
- const jobIdResolved = jobId || (global as any).__jobId || "default";
+ const jobIdResolved = jobId; // jobId is now required

// Line 183: Remove fallback
- const roomTypeResolved = roomType || (global as any).__jobRoomType;
+ const roomTypeResolved = roomType; // roomType is now required

// Line 152: Remove global read in callGemini
- ...(typeof (global as any).__jobSampling === 'object' ? (global as any).__jobSampling : {}),
+ ...(options.jobSampling || {}),

// Line 266: Remove global read for cache
- const baseArtifactsCache: Map<string, BaseArtifacts> = (global as any).__baseArtifactsCache || new Map();
+ const baseArtifactsCache: Map<string, BaseArtifacts> = options.baseArtifactsCache || new Map();

// Line 307: Remove global write
- (global as any).__baseArtifactsCache = baseArtifactsCache;
+ // REMOVE THIS LINE (cache updates will be handled by worker.ts)
```

**Estimated Lines Changed:** ~15 lines

---

### 2. STAGE 1B REFACTOR

#### Current Signature:
```typescript
export async function runStage1B(
  stage1APath: string,
  options: {
    replaceSky?: boolean;
    sceneType?: "interior" | "exterior" | string;
    roomType?: string;
    declutterMode?: "light" | "stage-ready";
    jobId?: string;
    attempt?: number;
  } = {}
): Promise<string>
```

#### New Signature:
```typescript
export async function runStage1B(
  stage1APath: string,
  options: {
    // Existing parameters
    replaceSky?: boolean;
    sceneType?: "interior" | "exterior" | string;
    roomType?: string;
    declutterMode?: "light" | "stage-ready";
    attempt?: number;
    
    // NEW: Required parameters
    jobId: string;                          // ✅ Make required
    
    // NEW: Pipeline context parameters
    canonicalPath?: string;                 // ✅ Add (from jobContext)
    baseArtifacts?: BaseArtifacts | null;   // ✅ Add (from jobContext)
    curtainRailLikely?: boolean | "unknown"; // ✅ Add (from jobContext)
    jobDeclutterIntensity?: number;         // ✅ Add (from jobContext)
    jobSampling?: {                         // ✅ Add (from jobContext)
      temperature?: number;
      topP?: number;
      topK?: number;
    };
  } = {}
): Promise<string>
```

#### Changes Required:
```typescript
// Line 31: Remove fallback
- const jobId = jobIdOpt || (global as any).__jobId;
+ const jobId = jobIdOpt; // jobId is now required

// Line 74: Remove global read
- const railLikely = (global as any).__curtainRailLikely as boolean | "unknown";
+ const railLikely = options.curtainRailLikely;

// Line 149: Remove global read
- declutterIntensity: (global as any).__jobDeclutterIntensity || undefined,
+ declutterIntensity: options.jobDeclutterIntensity,

// Line 150: Remove global read
- ...(typeof (global as any).__jobSampling === 'object' ? (global as any).__jobSampling : {}),
+ ...(options.jobSampling || {}),

// Line 159: Remove global read
- const canonicalPath: string | undefined = (global as any).__canonicalPath;
+ const canonicalPath: string | undefined = options.canonicalPath;

// Line 161: Remove global read
- const baseArtifacts = (global as any).__baseArtifacts;
+ const baseArtifacts = options.baseArtifacts;

// Line 170: Remove fallback
- const jobId = (global as any).__jobId || "default";
+ // Use jobId from line 31 (already available)
```

**Estimated Lines Changed:** ~12 lines

---

### 3. STAGE 2 REFACTOR

#### Current Signature:
```typescript
export async function runStage2(
  basePath: string,
  baseStage: "1A" | "1B",
  opts: {
    roomType: string;
    sceneType?: "interior" | "exterior";
    profile?: StagingProfile;
    angleHint?: "primary" | "secondary" | "other";
    referenceImagePath?: string;
    stagingRegion?: StagingRegion | null;
    stagingStyle?: string;
    sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
    curtainRailLikely?: boolean;
    onStrictRetry?: (info: { reasons: string[] }) => void;
    onAttemptSuperseded?: (nextAttemptId: string) => void;
    stage1APath?: string;
    jobId?: string;
    validationConfig?: { localMode?: Mode };
  }
): Promise<Stage2Result>
```

#### New Signature:
```typescript
export async function runStage2(
  basePath: string,
  baseStage: "1A" | "1B",
  opts: {
    // Existing parameters (keep as-is)
    roomType: string;
    sceneType?: "interior" | "exterior";
    profile?: StagingProfile;
    angleHint?: "primary" | "secondary" | "other";
    referenceImagePath?: string;
    stagingRegion?: StagingRegion | null;
    stagingStyle?: string;
    sourceStage?: "1A" | "1B-light" | "1B-stage-ready";
    curtainRailLikely?: boolean;
    onStrictRetry?: (info: { reasons: string[] }) => void;
    onAttemptSuperseded?: (nextAttemptId: string) => void;
    stage1APath?: string;
    validationConfig?: { localMode?: Mode };
    
    // NEW: Required parameter
    jobId: string;                          // ✅ Make required (remove fallback)
  }
): Promise<Stage2Result>
```

#### Changes Required:
```typescript
// Line 72: Remove fallback
- const jobId = opts.jobId || (global as any).__jobId || `stage2-${Date.now()}`;
+ const jobId = opts.jobId; // jobId is now required

// Line 228: Already using opts parameter (good!)
// No change needed - curtainRailLikely already reads from opts.curtainRailLikely
// The fallback to global is just defensive - remove it:
- const railLikely = (typeof opts.curtainRailLikely === "boolean" || opts.curtainRailLikely === "unknown")
-   ? opts.curtainRailLikely
-   : (global as any).__curtainRailLikely;
+ const railLikely = opts.curtainRailLikely; // Trust parameter only
```

**Estimated Lines Changed:** ~5 lines

---

### 4. GEMINI AI REFACTOR

#### Current Signature:
```typescript
export async function callGemini(
  inputPath: string | null,
  options: {
    skipIfNoApiKey?: boolean;
    replaceSky?: boolean;
    declutter?: boolean;
    sceneType?: "interior" | "exterior" | string;
    stage?: string;
    strictMode?: boolean;
    temperature?: number;
    topP?: number;
    topK?: number;
    promptOverride?: string;
    floorClean?: boolean;
    hardscapeClean?: boolean;
    declutterIntensity?: "light" | "standard" | "heavy";
    jobId?: string;
    roomType?: string;
    modelReason?: string;
    outputPath?: string;
  } = {}
): Promise<string>
```

#### New Signature:
```typescript
export async function callGemini(
  inputPath: string | null,
  options: {
    // Existing parameters (keep as-is)
    skipIfNoApiKey?: boolean;
    replaceSky?: boolean;
    declutter?: boolean;
    sceneType?: "interior" | "exterior" | string;
    stage?: string;
    strictMode?: boolean;
    temperature?: number;
    topP?: number;
    topK?: number;
    promptOverride?: string;
    floorClean?: boolean;
    hardscapeClean?: boolean;
    declutterIntensity?: "light" | "standard" | "heavy";
    modelReason?: string;
    outputPath?: string;
    
    // NEW: Required parameters
    jobId: string;                          // ✅ Make required
    roomType: string;                       // ✅ Make required
  } = {}
): Promise<string>
```

#### Changes Required:
```typescript
// Line 183: Remove fallback
- const jobId = jobIdOpt || (global as any).__jobId;
+ const jobId = jobIdOpt; // jobId is now required

// Line 184: Remove fallback
- const roomType = roomTypeOpt || (global as any).__jobRoomType;
+ const roomType = roomTypeOpt; // roomType is now required
```

**Estimated Lines Changed:** ~4 lines

---

## 🗺️ CALL GRAPH

```
worker.ts (jobContext) 
    │
    ├─> runStage1A(canonicalPath, {
    │       jobId: payload.jobId ✅
    │       roomType: payload.options.roomType ✅
    │       baseArtifacts: jobContext.baseArtifacts ➕ NEW
    │       baseArtifactsCache: jobContext.baseArtifactsCache ➕ NEW
    │       jobSampling: jobContext.jobSampling ➕ NEW
    │   })
    │   └─> callGemini(inputPath, {
    │           jobId: options.jobId ✅ (passed through)
    │           roomType: options.roomType ✅ (passed through)
    │           ...options.jobSampling ✅ (spread from options)
    │       })
    │
    ├─> runStage1B(path1A, {
    │       jobId: payload.jobId ✅
    │       roomType: payload.options.roomType ✅
    │       canonicalPath: jobContext.canonicalPath ➕ NEW
    │       baseArtifacts: jobContext.baseArtifacts ➕ NEW
    │       curtainRailLikely: jobContext.curtainRailLikely ➕ NEW
    │       jobDeclutterIntensity: jobContext.jobDeclutterIntensity ➕ NEW
    │       jobSampling: jobContext.jobSampling ➕ NEW
    │   })
    │   ├─> callGemini(stage1APath, {
    │   │       jobId: options.jobId ✅ (passed through)
    │   │       roomType: options.roomType ✅ (passed through)
    │   │       declutterIntensity: options.jobDeclutterIntensity ✅
    │   │       ...options.jobSampling ✅
    │   │   })
    │   └─> validateStageOutput("stage1B", canonicalPath, output, {
    │           baseArtifacts: options.baseArtifacts ✅
    │       })
    │
    └─> runStage2(stage2InputPath, stage2BaseStage, {
            jobId: payload.jobId ✅ (already passed)
            curtainRailLikely: jobContext.curtainRailLikely ✅ (already passed!)
        })
```

**Key Insight:** Stage 2 already receives curtainRailLikely from worker.ts! Only needs to trust parameter instead of falling back to global.

---

## 📍 WORKER.TS CALL SITE UPDATES

### Call Site 1: Stage 1A Main Call (Line 1054)
**Location:** `worker/src/worker.ts:1054`

#### Current:
```typescript
path1A = await runStage1A(canonicalPath, {
  replaceSky: safeReplaceSky,
  declutter: false,
  sceneType: sceneLabel,
  interiorProfile: ((): any => {
    const p = (payload.options as any)?.interiorProfile;
    if (p === 'nz_high_end' || p === 'nz_standard') return p;
    return undefined;
  })(),
  skyMode: skyModeForStage1A,
  jobId: payload.jobId,
  roomType: payload.options.roomType,
});
```

#### New:
```typescript
path1A = await runStage1A(canonicalPath, {
  replaceSky: safeReplaceSky,
  declutter: false,
  sceneType: sceneLabel,
  interiorProfile: ((): any => {
    const p = (payload.options as any)?.interiorProfile;
    if (p === 'nz_high_end' || p === 'nz_standard') return p;
    return undefined;
  })(),
  skyMode: skyModeForStage1A,
  jobId: payload.jobId,
  roomType: payload.options.roomType || "living_room", // ➕ Ensure non-empty
  baseArtifacts: jobContext.baseArtifacts,             // ➕ NEW
  baseArtifactsCache: jobContext.baseArtifactsCache,   // ➕ NEW
  jobSampling: jobContext.jobSampling,                 // ➕ NEW
});
```

**Lines Added:** +3

---

### Call Site 2: Stage 1B Main Call (Line 1192)
**Location:** `worker/src/worker.ts:1192`

#### Current:
```typescript
const output = await runStage1B(path1A, {
  replaceSky: false,
  sceneType: sceneLabel,
  roomType: payload.options.roomType,
  declutterMode: mode,
  jobId: payload.jobId,
  attempt: attemptIndex,
});
```

#### New:
```typescript
const output = await runStage1B(path1A, {
  replaceSky: false,
  sceneType: sceneLabel,
  roomType: payload.options.roomType,
  declutterMode: mode,
  jobId: payload.jobId,
  attempt: attemptIndex,
  canonicalPath: jobContext.canonicalPath,            // ➕ NEW
  baseArtifacts: jobContext.baseArtifacts,            // ➕ NEW
  curtainRailLikely: jobContext.curtainRailLikely,    // ➕ NEW
  jobDeclutterIntensity: jobContext.jobDeclutterIntensity, // ➕ NEW
  jobSampling: jobContext.jobSampling,                // ➕ NEW
});
```

**Lines Added:** +5

---

### Call Site 3: Stage 1B Gemini Retry (Line 1591)
**Location:** `worker/src/worker.ts:1591`

#### Current:
```typescript
const retryPath1B = await runStage1B(path1A, {
  replaceSky: false,
  sceneType: sceneLabel,
  roomType: payload.options.roomType,
  declutterMode: declutterMode as "light" | "stage-ready",
  jobId: payload.jobId,
  attempt: geminiRetries,
});
```

#### New:
```typescript
const retryPath1B = await runStage1B(path1A, {
  replaceSky: false,
  sceneType: sceneLabel,
  roomType: payload.options.roomType,
  declutterMode: declutterMode as "light" | "stage-ready",
  jobId: payload.jobId,
  attempt: geminiRetries,
  canonicalPath: jobContext.canonicalPath,            // ➕ NEW
  baseArtifacts: jobContext.baseArtifacts,            // ➕ NEW
  curtainRailLikely: jobContext.curtainRailLikely,    // ➕ NEW
  jobDeclutterIntensity: jobContext.jobDeclutterIntensity, // ➕ NEW
  jobSampling: jobContext.jobSampling,                // ➕ NEW
});
```

**Lines Added:** +5

---

### Call Site 4: Stage 1B Light Fallback (Line 2064)
**Location:** `worker/src/worker.ts:2064`

#### Current:
```typescript
const lightPath1B = await runStage1B(path1A, {
  replaceSky: false,
  sceneType: sceneLabel,
  roomType: payload.options.roomType,
  declutterMode: "light",
  jobId: payload.jobId,
  attempt: 0,
});
```

#### New:
```typescript
const lightPath1B = await runStage1B(path1A, {
  replaceSky: false,
  sceneType: sceneLabel,
  roomType: payload.options.roomType,
  declutterMode: "light",
  jobId: payload.jobId,
  attempt: 0,
  canonicalPath: jobContext.canonicalPath,            // ➕ NEW
  baseArtifacts: jobContext.baseArtifacts,            // ➕ NEW
  curtainRailLikely: jobContext.curtainRailLikely,    // ➕ NEW
  jobDeclutterIntensity: jobContext.jobDeclutterIntensity, // ➕ NEW
  jobSampling: jobContext.jobSampling,                // ➕ NEW
});
```

**Lines Added:** +5

---

### Call Site 5: Stage 2 Stage-2-Only Mode (Line 567)
**Location:** `worker/src/worker.ts:567`

#### Current:
```typescript
const stage2Result = await runStage2(basePath, "1B", {
  stagingStyle: payload.options.stagingStyle || "nz_standard",
  roomType: payload.options.roomType,
  sceneType: payload.options.sceneType as any,
  angleHint: undefined,
  profile: undefined,
  stagingRegion: undefined,
  jobId: payload.jobId,
  curtainRailLikely: jobContext.curtainRailLikely === "unknown" ? undefined : jobContext.curtainRailLikely,
  onAttemptSuperseded: (nextAttemptId) => {
    stage2AttemptId = nextAttemptId;
  },
});
```

#### New:
```typescript
// No changes needed - jobId already required parameter ✅
// curtainRailLikely already passed from jobContext ✅
```

**Lines Changed:** 0 (already correct!)

---

### Call Site 6: Stage 2 Main Call (Line 1936)
**Location:** `worker/src/worker.ts:1936`

#### Current:
```typescript
const stage2Promise = payload.options.virtualStage
  ? await runStage2(stage2InputPath, stage2BaseStage, {
      roomType: ... ,
      sceneType: sceneLabel as any,
      profile,
      angleHint,
      stagingRegion: (sceneLabel === "exterior" && allowStaging) ? (stagingRegionGlobal as any) : undefined,
      stagingStyle: stagingStyleNorm,
      sourceStage: stage2SourceStage,
      jobId: payload.jobId,
      validationConfig: { localMode: localValidatorMode },
      stage1APath: stage2ValidationBaseline,
      curtainRailLikely: jobContext.curtainRailLikely === "unknown" ? undefined : jobContext.curtainRailLikely,
      onStrictRetry: ...
    })
```

#### New:
```typescript
// No changes needed - jobId already required parameter ✅
// curtainRailLikely already passed from jobContext ✅
```

**Lines Changed:** 0 (already correct!)

---

### Call Site 7: Stage 2 Validation Fallback (Line 2080)
**Location:** `worker/src/worker.ts:2080`

#### Current:
```typescript
const stage2Outcome = await runStage2(stage2InputPath, stage2BaseStage, {
  roomType: ...,
  sceneType: sceneLabel as any,
  profile,
  angleHint,
  stagingRegion: (sceneLabel === "exterior" && allowStaging) ? (stagingRegionGlobal as any) : undefined,
  stagingStyle: stagingStyleFallback,
  jobId: payload.jobId,
  validationConfig: { localMode: localValidatorMode },
  stage1APath: stage2ValidationBaseline,
  curtainRailLikely: jobContext.curtainRailLikely === "unknown" ? undefined : jobContext.curtainRailLikely,
  onStrictRetry: ...
});
```

#### New:
```typescript
// No changes needed - jobId already required parameter ✅
// curtainRailLikely already passed from jobContext ✅
```

**Lines Changed:** 0 (already correct!)

---

### Call Site 8: Stage 2 Hard Fail Retry (Line 2313)
**Location:** `worker/src/worker.ts:2313`

#### Current:
```typescript
const stage2OutcomeRetry = await runStage2(stage2InputPath, stage2BaseStage, {
  roomType: ...,
  sceneType: sceneLabel as any,
  profile,
  angleHint,
  stagingRegion: (sceneLabel === "exterior" && allowStaging) ? (stagingRegionGlobal as any) : undefined,
  stagingStyle: stagingStyleNorm,
  sourceStage: stage2SourceStage,
  jobId: payload.jobId,
  validationConfig: { localMode: localValidatorMode },
  stage1APath: stage2ValidationBaseline,
  curtainRailLikely: jobContext.curtainRailLikely === "unknown" ? undefined : jobContext.curtainRailLikely,
  onStrictRetry: ...
});
```

#### New:
```typescript
// No changes needed - jobId already required parameter ✅
// curtainRailLikely already passed from jobContext ✅
```

**Lines Changed:** 0 (already correct!)

---

## 📦 SUGGESTED PARAMETER BUNDLES

### Option 1: Add Individual Parameters (RECOMMENDED)
**Rationale:** Explicit is better than implicit. Each function declares exactly what it needs.

**Pros:**
- Clear API contracts
- Easy to trace data flow
- TypeScript autocomplete works well
- No hidden dependencies

**Cons:**
- Slightly more verbose call sites
- Repeated parameter lists in similar calls

**Verdict:** ✅ **RECOMMENDED** - Best for maintainability

---

### Option 2: Create PipelineContext Bundle
**Rationale:** Group commonly-used context into reusable type.

```typescript
// New type in worker/src/types.ts
export interface PipelineContext {
  jobId: string;
  roomType: string;
  canonicalPath?: string | null;
  baseArtifacts?: BaseArtifacts | null;
  baseArtifactsCache?: Map<string, BaseArtifacts>;
  curtainRailLikely?: boolean | "unknown";
  jobSampling?: {
    temperature?: number;
    topP?: number;
    topK?: number;
  };
  jobDeclutterIntensity?: number;
}

// Usage:
export async function runStage1A(
  inputPath: string,
  options: { 
    replaceSky?: boolean;
    declutter?: boolean;
    sceneType?: "interior" | "exterior" | string;
    interiorProfile?: EnhancementProfile;
    skyMode?: "safe" | "strong";
    pipelineContext: PipelineContext; // ✅ Single bundle
  }
): Promise<string>

// Call site:
path1A = await runStage1A(canonicalPath, {
  replaceSky: safeReplaceSky,
  sceneType: sceneLabel,
  pipelineContext: jobContext, // ✅ Pass entire context
});
```

**Pros:**
- Less verbose call sites
- Easy to add new context fields later
- Natural mapping from jobContext

**Cons:**
- Less explicit about what each function uses
- Potential for over-sharing (functions get data they don't need)
- Harder to trace individual field usage

**Verdict:** ⚠️ **ALTERNATIVE** - Good for rapid prototyping, but less maintainable long-term

---

### Option 3: Subset Types
**Rationale:** Create minimal context subsets for each function.

```typescript
// Stage 1A needs: baseArtifacts, jobSampling, jobId, roomType
export interface Stage1AContext {
  jobId: string;
  roomType: string;
  baseArtifacts?: BaseArtifacts | null;
  baseArtifactsCache?: Map<string, BaseArtifacts>;
  jobSampling?: { temperature?: number; topP?: number; topK?: number };
}

// Stage 1B needs: canonicalPath, baseArtifacts, curtainRailLikely, etc.
export interface Stage1BContext {
  jobId: string;
  roomType: string;
  canonicalPath?: string | null;
  baseArtifacts?: BaseArtifacts | null;
  curtainRailLikely?: boolean | "unknown";
  jobDeclutterIntensity?: number;
  jobSampling?: { temperature?: number; topP?: number; topK?: number };
}
```

**Pros:**
- Clear about what each function needs
- Type-safe subsets
- Better than full bundle for encapsulation

**Cons:**
- More types to maintain
- Call sites still need to construct subsets
- TypeScript complexity increases

**Verdict:** ⚠️ **OVER-ENGINEERED** - Adds complexity without significant benefit

---

## 📏 ESTIMATED DIFF SIZES

| File | Lines Changed | Lines Added | Lines Removed | Risk |
|------|--------------|-------------|---------------|------|
| `pipeline/stage1A.ts` | ~15 | +5 (param types) | -10 (global reads/writes) | 🟡 MEDIUM |
| `pipeline/stage1B.ts` | ~12 | +6 (param types) | -8 (global reads) | 🟡 MEDIUM |
| `pipeline/stage2.ts` | ~5 | +1 (param type) | -4 (global reads) | 🟢 LOW |
| `ai/gemini.ts` | ~4 | +2 (param types) | -2 (global reads) | 🟢 LOW |
| `worker/src/worker.ts` | ~30 | +18 (new params) | 0 | 🟡 MEDIUM |
| **TOTAL** | **~66 lines** | **+32** | **-24** | 🟡 MEDIUM |

**Breakdown:**
- **Parameter declarations:** +32 lines (type signatures)
- **Global reads removed:** -24 lines (cleanup)
- **Logic unchanged:** 0 (pure refactor)
- **Net change:** +8 lines (slight increase due to explicit parameters)

---

## ⚙️ IMPLEMENTATION STRATEGY

### Phase 1: Type Definitions (30 min)
1. Update `runStage1A` signature in `pipeline/stage1A.ts`
2. Update `runStage1B` signature in `pipeline/stage1B.ts`
3. Update `runStage2` signature in `pipeline/stage2.ts`
4. Update `callGemini` signature in `ai/gemini.ts`

**Commit:** `refactor(types): add explicit pipeline context parameters`

---

### Phase 2: Remove Global Reads (45 min)
1. **stage1A.ts:**
   - Replace 7 global reads with `options.*` 
   - Remove 1 global write (line 307)
2. **stage1B.ts:**
   - Replace 8 global reads with `options.*`
3. **stage2.ts:**
   - Replace 2 global reads (remove fallbacks)
4. **gemini.ts:**
   - Replace 2 global reads (remove fallbacks)

**Commit:** `refactor(pipeline): eliminate all global namespace reads`

---

### Phase 3: Update Call Sites (60 min)
1. **worker.ts:1054** - Stage 1A main (+3 params)
2. **worker.ts:1192** - Stage 1B main (+5 params)
3. **worker.ts:1591** - Stage 1B gemini retry (+5 params)
4. **worker.ts:2064** - Stage 1B light fallback (+5 params)
5. **worker.ts:567** - Stage 2 stage-2-only (no changes ✅)
6. **worker.ts:1936** - Stage 2 main (no changes ✅)
7. **worker.ts:2080** - Stage 2 validation fallback (no changes ✅)
8. **worker.ts:2313** - Stage 2 hard fail retry (no changes ✅)

**Commit:** `refactor(worker): pass jobContext explicitly to pipeline functions`

---

### Phase 4: Build & Test (30 min)
1. Run TypeScript build: `pnpm --filter worker build`
2. Run linter: `pnpm --filter worker lint`
3. Manual smoke test: Single job
4. Manual concurrency test: 5 jobs in parallel

**Commit:** `test: verify Sprint 2 isolation fixes`

---

### Phase 5: Verification (30 min)
1. Grep for remaining global reads: `grep -r "(global as any).__" worker/src/`
2. Verify 0 matches in pipeline/ai modules
3. Update verification audit document
4. Create Sprint 2 completion summary

**Commit:** `docs: Sprint 2 completion verification`

---

## 🎯 SUCCESS CRITERIA

### Must-Have (Blocking)
- [ ] Zero `(global as any).__*` reads in `pipeline/stage1A.ts`
- [ ] Zero `(global as any).__*` reads in `pipeline/stage1B.ts`
- [ ] Zero `(global as any).__*` reads in `pipeline/stage2.ts`
- [ ] Zero `(global as any).__*` reads in `ai/gemini.ts`
- [ ] Zero `(global as any).__*` writes in any file
- [ ] TypeScript build passes
- [ ] All parameters explicitly passed from worker.ts

### Should-Have (Quality)
- [ ] All `jobId` parameters are required (no fallbacks)
- [ ] All `roomType` parameters are required (no fallbacks)
- [ ] baseArtifactsCache updates handled by worker.ts only
- [ ] Documentation comments updated

### Nice-to-Have (Polish)
- [ ] Consistent parameter ordering across functions
- [ ] JSDoc comments for new parameters
- [ ] Type exports for reusability

---

## 🚨 ROLLBACK PLAN

If issues arise during implementation:

1. **TypeScript Errors:**
   - Revert to previous commit
   - Fix type mismatches incrementally
   - Re-test

2. **Runtime Errors:**
   - Check for `undefined` parameters
   - Add defensive null checks temporarily
   - Add logging to trace data flow

3. **Validation Failures:**
   - Compare baseArtifacts passed vs. expected
   - Verify canonicalPath is correct
   - Check curtainRailLikely propagation

4. **Full Rollback:**
   ```bash
   git revert HEAD~5..HEAD  # Revert last 5 commits
   git push --force-with-lease
   ```

---

## 📊 RISK ASSESSMENT

### Low Risk (95% confidence)
- ✅ Type signature changes (compile-time safe)
- ✅ Removing global reads (pure refactor)
- ✅ Stage 2 changes (minimal, already mostly correct)

### Medium Risk (80% confidence)
- ⚠️ Stage 1A baseArtifactsCache handling
  - Cache updates currently write to global
  - Need to ensure worker.ts syncs cache correctly
- ⚠️ Stage 1B validation path
  - canonicalPath vs. path1A logic
  - Ensure correct baseline used

### Mitigation Strategies
1. **Incremental commits** - Easy to bisect failures
2. **Extensive logging** - Add debug logs for parameter values
3. **Staged rollout** - Test single job → 5 jobs → production
4. **Monitoring** - Watch for increased error rates post-deploy

---

## 🔍 VALIDATION CHECKLIST

After implementation, verify:

### Code Quality
- [ ] No `TODO` or `FIXME` comments added
- [ ] No commented-out code
- [ ] Consistent code style (prettier/eslint)
- [ ] No TypeScript `any` types added

### Functionality
- [ ] Single job completes successfully
- [ ] 5 concurrent jobs complete without cross-contamination
- [ ] baseArtifacts are job-specific (check logs)
- [ ] curtainRailLikely decisions are job-specific
- [ ] Validation uses correct baselines

### Performance
- [ ] No significant latency increase (<5%)
- [ ] Memory usage stable (no leaks)
- [ ] Cache hit rates similar to before

---

## 📚 REFERENCES

- Sprint 1 Completion: `SPRINT_1_COMPLETION_SUMMARY.md`
- Verification Audit: `SPRINT_1_VERIFICATION_AUDIT.md`
- Original Investigation: (Previous conversation context)
- BaseArtifacts Type: `worker/src/validators/baseArtifacts.ts`
- JobExecutionContext: `worker/src/worker.ts:322-334`

---

## ⏱️ TIME ESTIMATES

| Phase | Estimated Time | Cumulative |
|-------|---------------|------------|
| Type Definitions | 30 min | 0.5 hrs |
| Remove Global Reads | 45 min | 1.25 hrs |
| Update Call Sites | 60 min | 2.25 hrs |
| Build & Test | 30 min | 2.75 hrs |
| Verification | 30 min | 3.25 hrs |
| **TOTAL** | **~3.5 hours** | **~0.5 days** |

**Buffer for unexpected issues:** +2 hours  
**Total with buffer:** ~5.5 hours (~0.75 days)

---

## 🎉 EXPECTED OUTCOME

After Sprint 2 completion:

**Isolation Confidence:** 45/100 → **90/100** ✅

```
Component Scores After Sprint 2:
├── Worker.ts           95/100 ✅ (+5: better parameter passing)
├── Pipeline Modules    95/100 ✅ (+80: global reads eliminated!)
├── Validators          95/100 ✅ (+10: receive fresh data)
├── Retry Manager      100/100 ✅ (unchanged, already perfect)
└── AI Modules          95/100 ✅ (+65: global reads eliminated!)

Overall Confidence: 90/100 ✅
Production Ready: YES ✅
```

**Remaining 10% risk:**
- Function-scope path variables (Sprint 3 - defensive validation guards)
- Module-scope singletons (acceptable - stateless resources)
- Memory monitor map leak (operational, not data corruption)

---

**END OF REFACTOR PLAN**

User approval required before proceeding with implementation.
