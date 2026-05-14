# Safe Mode Implementation Proposal
## RealEnhance Agency-Level Processing Ceiling

**Status**: Architecture Investigation Complete  
**Created**: 2026-05-14  
**Scope**: Investigation + Architecture Proposal ONLY (no code changes)  

---

## EXECUTIVE SUMMARY

This document outlines a **clean, minimal-risk implementation approach** for agency-level Safe Mode, a processing ceiling feature that restricts automated Stage 2 (virtual staging) execution while preserving all other functionality including Edit mode.

**Core Principle**: Safe Mode = Hard execution ceiling preventing Stage 2 in automated pipelines (not UI hiding alone).

---

## PART 1: CURRENT ARCHITECTURE ANALYSIS

### 1.1 Processing Pipeline Architecture

#### Stage Definition
- **Stage 1A**: Professional enhancement (tone mapping, lens correction, sky boost)
- **Stage 1B**: Declutter/furniture removal (light or structured-retain modes)
- **Stage 2**: Virtual staging (furniture addition, scene styling)

#### Current Processing Flow

```
User Upload
    ↓
batch-processor.tsx (Client UI)
    ↓ [allowStaging toggle, declutterMode, etc.]
    ↓
/api/upload (Server)
    ↓ [Subscription gate, reservation]
    ↓
enqueueEnhanceJob() [jobs.ts]
    ↓ [Creates requestedStages: ["1A", "1B", "2"]]
    ↓
BullMQ Job Queue
    ↓
Worker [worker.ts]
    ↓ [Reads requestedStages, executes stages]
    ↓
runStage1A() → runStage1B() → runStage2()
    ↓
S3 Output + Image Versioning
```

#### Stage Selection Mechanism

**Request-side** (upload.ts):
```typescript
// Stage 2 is triggered by:
const virtualStage = options.virtualStage // from form allowStaging toggle
const declutterMode = options.declutterMode // "light" | "stage-ready"

// requestedStages is derived from:
// - declutter + virtualStage → determines stages in enqueueEnhanceJob()
// - virtualStage=true → includes "2" in requestedStages array
```

**Execution-side** (worker.ts):
```typescript
// Job payload contains requestedStages: ["1A", "1B", "2"]
// Worker checks each stage and runs accordingly
if (requestedStages.includes("2")) {
  // Run Stage 2 virtual staging
  await runStage2(...)
}
```

### 1.2 Current Settings/Agency Architecture

#### Agency Model
**File**: `shared/src/agencies.ts`

```typescript
interface Agency {
  agencyId: string;
  name: string;
  planTier?: PlanTier | null;
  subscriptionStatus: SubscriptionStatus;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  billingCountry?: "NZ" | "AU" | "ZA";
  billingCurrency?: "nzd" | "aud" | "zar" | "usd";
  createdAt: string;
  updatedAt?: string;
  // ... billing fields
}
```

**Storage**: Redis hash at `agency:${agencyId}`

**Current Fields Stored**:
- agencyId, name, planTier, subscriptionStatus
- Stripe integration fields
- Billing metadata
- UI flags (upgradeBannerSeen, promoCreditsGranted)

#### Role/Permission Model

**File**: `shared/src/types.ts` (UserRecord)

```typescript
type UserRole = "owner" | "admin" | "member";

interface UserRecord {
  id: string;
  email: string;
  role?: "owner" | "admin" | "member";
  agencyId?: string | null;
  // ... other fields
}
```

**Current Admin Access**:
- Server routes use `requireAgencyAdmin()` middleware
- Checks: `user.role === "owner" || user.role === "admin"`
- **Example**: `/api/agency/create`, billing routes

### 1.3 Current Admin/Settings UI

**Files**: 
- `client/src/pages/admin.tsx` (site admin dashboard)
- `client/src/pages/agency.tsx` (agency admin page)
- `server/src/routes/admin.ts` (site admin API)
- `server/src/routes/agency.ts` (agency management API)

**Current Agency Admin Capabilities**:
- Invite/manage team members
- View usage statistics
- Manage subscription
- View billing history

**Settings Persistence**:
- Agency metadata stored in Redis hash
- User role stored in Redis user hash
- Settings API: GET/POST via agency.ts routes

### 1.4 Batch Processing UI Architecture

**File**: `client/src/components/batch-processor.tsx`

**Current Processing Mode Selection**:
```typescript
// Global batch toggle (applied to all images in batch)
const [allowStaging, setAllowStaging] = useState(true);

// Per-image metadata can override
const perImageMeta: PerImageMetadata = {
  sceneType?: string;
  roomType?: string;
  declutter?: boolean;
  declutterMode?: "light" | "stage-ready";
  virtualStage?: boolean; // Per-image override
  stagingStyle?: string;
  // ... other options
};

// Form sends to /api/upload as:
{
  allowStaging: boolean,        // Global Stage 2 flag
  declutter: boolean,           // Stage 1B flag
  declutterMode: "light" | "stage-ready",
  metaJson: [...]               // Per-image overrides
}
```

**Current UI Structure**:
```
[Enhance ✓]  [Declutter ✓]  [Stage/Full ✓]
```

### 1.5 Retry Architecture

**Files**: `server/src/routes/retrySingle.ts`, `retry-policy.ts`

**Retry Stage Selection**:
```typescript
// Retry allows users to select stages explicitly
// Via effectiveStagesToRun array:
const effectiveStagesToRun: Array<"1A" | "1B" | "2"> = 
  userProvidedStages || defaultStages;

// Stage 2 is included if user selects it or if default includes it
// retryInfo.requestedStages propagates from parent job
```

**Key Point**: Retries can independently select Stage 2 unless blocked upstream.

### 1.6 Edit Function Isolation

**File**: `server/src/routes/edit.ts`, `worker/src/pipeline/editApply.ts`

**Key Isolation Facts**:
- Edit creates separate job type: `RegionEditJobPayload` (not EnhanceJobPayload)
- Edit pipeline: `applyEdit()` → image manipulation → save
- Edit does NOT run Stage 2 staging
- Edit history tracked separately in image versions
- Edit-only images save as version label "edit"

**Safe Mode Impact**: Edit completely unaffected. This is intentional.

---

## PART 2: REQUIRED CHANGES ANALYSIS

### 2.1 Schema & Data Model Changes

#### 2.1.1 Agency Schema Enhancement

**New Field to Add to Agency Model** (`shared/src/auth/types.ts`):
```typescript
interface Agency {
  // ... existing fields ...
  
  // NEW: Safe Mode setting
  processingMode?: "full" | "safe"; // Defaults to "full" for backwards compatibility
  updatedAt?: string;
}
```

**Storage Location**: Redis hash `agency:${agencyId}`
- New field: `processingMode: "full" | "safe"`
- Backwards compatible: Missing field defaults to "full"

#### 2.1.2 Job Metadata Enhancement (Optional but Recommended)

**File**: `shared/src/types/jobMetadata.ts`

```typescript
interface RequestedStages {
  stage1A: boolean;
  stage1B: boolean;
  stage2: boolean;
  // NEW: Capture agency processing mode at job creation time
  agencyProcessingMode?: "full" | "safe";
}
```

**Purpose**: Audit trail + retry consistency (retries respect agency ceiling at job-creation time).

---

### 2.2 Backend Enforcement Points

#### 2.2.1 Primary Enforcement: `enqueueEnhanceJob()` (CRITICAL)

**File**: `server/src/services/jobs.ts` (lines ~403-600)

**Current Logic**:
```typescript
export async function enqueueEnhanceJob(params: {
  // ... existing params ...
  options: {
    declutter: boolean;
    virtualStage: boolean;  // ← Currently allows Stage 2
    // ...
  };
}) {
  // Derive requestedStages from options
  const requestedStages: RequestedStages = {
    stage1A: true,
    stage1B: !!options.declutter,
    stage2: !!options.virtualStage,  // ← No gating here
  };
}
```

**Required Change**:
```typescript
// ADD THIS CHECK BEFORE CREATING REQUESTEDSTAGES:

// Load agency settings
const agency = params.agencyId ? await getAgency(params.agencyId) : null;
const agencySafeMode = agency?.processingMode === "safe";

// HARD GATE: Prevent Stage 2 if Safe Mode enabled
if (agencySafeMode && options.virtualStage) {
  console.warn(`[SAFE_MODE] Stage 2 blocked for agency ${params.agencyId}`, {
    reason: "agency_safe_mode_enabled",
    userId: params.userId,
    imageId: params.imageId,
  });
  // Silently demote virtualStage to false
  options = { ...options, virtualStage: false };
}

const requestedStages: RequestedStages = {
  stage1A: true,
  stage1B: !!options.declutter,
  stage2: !!options.virtualStage,  // Now respects Safe Mode ceiling
  agencyProcessingMode: agencySafeMode ? "safe" : "full",
};
```

**Impact**: All Stage 2 requests are blocked server-side, regardless of UI.

#### 2.2.2 Secondary Enforcement: Retry Routes

**File**: `server/src/routes/retrySingle.ts` (lines ~856-920)

**Current Logic**:
```typescript
// User selects stages to retry
const effectiveStagesToRun = userSelectedStages || defaultStages;
const runStage2 = effectiveStagesToRun.includes("2");
```

**Required Change**:
```typescript
// Check agency Safe Mode ceiling
const agency = user.agencyId ? await getAgency(user.agencyId) : null;
const agencySafeMode = agency?.processingMode === "safe";

if (agencySafeMode && effectiveStagesToRun.includes("2")) {
  console.warn(`[SAFE_MODE] Retry Stage 2 blocked for agency ${user.agencyId}`, {
    reason: "agency_safe_mode_enabled",
    userId: user.id,
    imageId: req.body.imageId,
    attemptedStages: effectiveStagesToRun,
  });
  
  // Remove Stage 2 from effective stages
  effectiveStagesToRun = effectiveStagesToRun.filter(s => s !== "2");
}

const runStage2 = effectiveStagesToRun.includes("2");
```

**Impact**: Retry API respects Safe Mode ceiling.

#### 2.2.3 Tertiary Enforcement: Worker-Side Guard (Defense in Depth)

**File**: `worker/src/worker.ts` (Optional but recommended)

```typescript
// At job processing start, validate that requestedStages respects
// agency ceiling. This is defensive against logic bugs upstream.

const jobMetadata = await getJobMetadata(jobId);
const agencyProcessingMode = jobMetadata?.requestedStages?.agencyProcessingMode;

if (agencyProcessingMode === "safe" && jobMetadata?.requestedStages?.stage2) {
  console.warn(`[SAFE_MODE_WORKER_GUARD] Stage 2 should not be in requestedStages for safe-mode agency`, {
    jobId,
    agencyId: payload.agencyId,
  });
  // Defensive: Force stage2 off if somehow it made it here
  payload.options.virtualStage = false;
}
```

---

### 2.3 Frontend Changes Required

#### 2.3.1 Stage Option Visibility

**File**: `client/src/components/batch-processor.tsx`

**Current UI** (lines ~2331-2390):
```typescript
// Always shows "Stage/Full" option if interior and allowStaging=true
if (allowStaging && (sceneType !== "exterior")) {
  // Show staging options
}
```

**Required Change**:
```typescript
// Check agency Safe Mode setting (loaded from user context or API)
const isAgencySafeMode = useContext(AgencySettingsContext)?.processingMode === "safe";

// Conditionally show Stage 2 option
if (allowStaging && (sceneType !== "exterior") && !isAgencySafeMode) {
  // Show Stage/Full option
} else if (isAgencySafeMode && allowStaging && (sceneType !== "exterior")) {
  // Show disabled/grayed Stage option with tooltip
  // "Virtual staging is restricted in your agency's Safe Mode"
}
```

**User Experience**:
- Normal mode: All current options visible
- Safe Mode: Stage/Full option disabled with explanation
- Declutter still fully available in Safe Mode

#### 2.3.2 Upload Payload Adjustment (No change needed)

The `/api/upload` endpoint already receives `allowStaging` flag. Safe Mode enforcement happens server-side in `enqueueEnhanceJob()`, so upload form doesn't need modification.

#### 2.3.3 Retry UI

**File**: `client/src/components/retry-dialog.tsx` (hypothetical)

**Current**: Users can select any stage for retry.

**Required Change**:
```typescript
// When Safe Mode is active, disable Stage 2 selection
if (isAgencySafeMode) {
  availableStages = ["1A", "1B"];  // Exclude "2"
}
```

---

### 2.4 Admin Settings UI

#### 2.4.1 Agency Settings Page Modification

**File**: `client/src/pages/agency.tsx`

**New Section to Add**:
```tsx
<SettingsSection title="Processing Restrictions">
  <div className="setting-item">
    <label>Safe Mode</label>
    <p className="description">
      When enabled, team members cannot run Stage 2 (virtual staging).
      Edit mode remains available.
    </p>
    
    <ToggleSwitch
      checked={processingMode === "safe"}
      onChange={(enabled) => updateProcessingMode(enabled ? "safe" : "full")}
      label={enabled ? "Safe Mode ON" : "Safe Mode OFF"}
    />
  </div>
</SettingsSection>
```

#### 2.4.2 Admin API Endpoint

**File**: `server/src/routes/agency.ts`

**New Endpoint**:
```typescript
router.patch("/settings/processing-mode", requireAuth, requireAgencyAdmin, async (req, res) => {
  const user = (req as any).user;
  if (!user.agencyId) return res.status(403).json({ error: "no_agency" });

  const { processingMode } = req.body;
  if (!["full", "safe"].includes(processingMode)) {
    return res.status(400).json({ error: "invalid_processing_mode" });
  }

  const agency = await getAgency(user.agencyId);
  if (!agency) return res.status(404).json({ error: "agency_not_found" });

  // Update agency setting
  agency.processingMode = processingMode;
  await updateAgency(agency);

  console.log(`[SAFE_MODE_ADMIN] Agency ${user.agencyId} set processingMode=${processingMode}`);

  return res.json({
    ok: true,
    processingMode: agency.processingMode,
  });
});
```

---

## PART 3: IMPLEMENTATION ARCHITECTURE

### 3.1 Enforcement Points (Priority Order)

| Priority | Location | Type | Impact |
|----------|----------|------|--------|
| **CRITICAL** | `enqueueEnhanceJob()` | Server | Blocks all automated Stage 2 for safe-mode agencies |
| **HIGH** | Retry routes | Server | Prevents Stage 2 retries |
| **MEDIUM** | Batch processor UI | Client | Visual feedback, disable options |
| **LOW** | Worker-side guard | Worker | Defensive validation |
| **ADMIN** | Agency admin API | Server | Settings management |

### 3.2 Data Flow for Safe Mode Enforcement

```
┌─────────────────────────────────────────────────────────┐
│ User submits batch with virtualStage=true               │
└─────────────────────────────────────┬───────────────────┘
                                      ↓
┌─────────────────────────────────────────────────────────┐
│ /api/upload endpoint                                    │
│ - Reads allowStaging flag                               │
│ - Passes to enqueueEnhanceJob()                          │
└─────────────────────────────────────┬───────────────────┘
                                      ↓
┌─────────────────────────────────────────────────────────┐
│ enqueueEnhanceJob() [ENFORCEMENT POINT 1]               │
│ - Loads agency via user.agencyId                        │
│ - Checks agency.processingMode === "safe"              │
│ ─ IF SAFE MODE + virtualStage=true:                     │
│   ✓ Set virtualStage = false                            │
│   ✓ Log warning                                          │
│ - Creates requestedStages with stage2=false            │
└─────────────────────────────────────┬───────────────────┘
                                      ↓
┌─────────────────────────────────────────────────────────┐
│ Job enqueued with:                                      │
│ requestedStages = {                                      │
│   stage1A: true,                                         │
│   stage1B: true,                                         │
│   stage2: false,  ← Blocked by Safe Mode                │
│   agencyProcessingMode: "safe"                          │
│ }                                                        │
└─────────────────────────────────────┬───────────────────┘
                                      ↓
┌─────────────────────────────────────────────────────────┐
│ Worker processes job                                    │
│ - Runs Stage 1A ✓                                        │
│ - Runs Stage 1B ✓                                        │
│ - Skips Stage 2 (requestedStages.stage2=false)         │
│ - Output: Enhanced + decluttered image (no staging)    │
└─────────────────────────────────────────────────────────┘
```

### 3.3 Retry Flow with Safe Mode

```
User initiates retry of Stage 2 → Retry dialog → User selects Stages
                                                            ↓
                                        retrySingle route [ENFORCEMENT POINT 2]
                                                            ↓
                                  Check agency Safe Mode setting
                                                            ↓
                                  IF safe + user selected "2":
                                  - Remove "2" from stages
                                  - Log warning
                                  - Return allowed stages ["1A", "1B"]
                                                            ↓
                                  Enqueue retry with safe stages
```

---

## PART 4: PERSISTENCE & STORAGE

### 4.1 Agency Safe Mode Setting

**Storage**: Redis hash
```
Key: agency:${agencyId}
Fields:
  agencyId: string
  name: string
  planTier: string
  processingMode: "full" | "safe"  ← NEW
  subscriptionStatus: string
  ... other fields
```

**Initialization**: 
- New agencies default to `processingMode: "full"` (backwards compatible)
- Existing agencies: missing field treated as "full"

**Update Path**:
- Admin calls `PATCH /api/agency/settings/processing-mode`
- Server updates Redis hash via `updateAgency()`

### 4.2 Job Metadata (Optional Audit Trail)

**File**: `shared/src/types/jobMetadata.ts`

```typescript
interface RequestedStages {
  stage1A: boolean;
  stage1B: boolean;
  stage2: boolean;
  agencyProcessingMode?: "full" | "safe"; // NEW: For audit
}
```

**Saved in**: Job metadata store (Redis or image history)

---

## PART 5: ROLLOUT RISK ASSESSMENT

### 5.1 Low-Risk Aspects

✅ **UI is purely indicative**: Safe Mode enforcement is 100% server-side  
✅ **No data migration needed**: New field defaults safely  
✅ **Edit mode unaffected**: Completely separate pipeline  
✅ **Backwards compatible**: Missing setting = "full" mode  
✅ **No breaking changes**: Only blocks Stage 2 (expected behavior)  

### 5.2 Potential Risks

⚠️ **User confusion**: Users expect UI to reflect restrictions  
   - *Mitigation*: Clear messaging in batch processor UI

⚠️ **Retry experience**: Users see Stage 2 option disabled after retry  
   - *Mitigation*: Tooltip explaining Safe Mode restriction

⚠️ **Agency settings propagation**: Settings need to reach all request paths  
   - *Mitigation*: Single source of truth (enqueueEnhanceJob check)

⚠️ **Performance**: Loading agency settings on every job  
   - *Mitigation*: Negligible (single Redis hash lookup)

### 5.3 Testing Requirements

- [ ] Unit: enqueueEnhanceJob() blocks Stage 2 for safe agencies
- [ ] Integration: Full upload flow with Safe Mode enabled
- [ ] Integration: Retry respects Safe Mode ceiling
- [ ] UI: Batch processor shows correct option state
- [ ] UI: Retry dialog disables Stage 2 option
- [ ] API: Admin can toggle Safe Mode on/off
- [ ] Audit: Logs show Safe Mode blocks (audit trail)
- [ ] Backwards compatibility: Missing processingMode defaults to "full"

---

## PART 6: RECOMMENDED IMPLEMENTATION ORDER

### Phase 1: Core Infrastructure (Days 1-2)

1. ✅ Add `processingMode` field to `Agency` type (`shared/src/auth/types.ts`)
2. ✅ Update `getAgency()` / `updateAgency()` to handle new field (`shared/src/agencies.ts`)
3. ✅ Add enforcement in `enqueueEnhanceJob()` (`server/src/services/jobs.ts`)
4. ✅ Add enforcement in retry routes (`server/src/routes/retrySingle.ts`)

**Validation**: Jobs for safe-mode agencies skip Stage 2

### Phase 2: Admin API & Settings (Days 2-3)

5. ✅ Create `PATCH /api/agency/settings/processing-mode` endpoint (`server/src/routes/agency.ts`)
6. ✅ Add middleware for `requireAgencyAdmin` verification
7. ✅ Add audit logging for setting changes

**Validation**: Admin can toggle and setting persists

### Phase 3: Frontend (Days 3-4)

8. ✅ Load agency settings in batch processor context
9. ✅ Conditionally disable Stage option UI based on Safe Mode
10. ✅ Update retry dialog to respect ceiling
11. ✅ Add tooltips/help text

**Validation**: UI reflects setting state

### Phase 4: Testing & Deployment (Days 4-5)

12. ✅ Full integration tests
13. ✅ Backwards compatibility verification
14. ✅ Canary deployment to subset of agencies
15. ✅ Full rollout

---

## PART 7: CONFIGURATION & ENVIRONMENT

### 7.1 Feature Flag (Optional)

Add to environment:
```bash
# Enable Safe Mode feature globally
SAFE_MODE_FEATURE_ENABLED=true

# Log level for Safe Mode enforcement
SAFE_MODE_LOG_LEVEL=warn  # or debug for development
```

### 7.2 No Special Hardcoding Needed

Safe Mode is dynamically loaded from agency settings, not env vars.

---

## PART 8: MONITORING & AUDIT

### 8.1 Audit Logging

Every Safe Mode block should log:
```
[SAFE_MODE] Stage 2 blocked
  agency_id: <agencyId>
  user_id: <userId>
  reason: "agency_safe_mode_enabled"
  requested_virtualStage: true
  job_id: <jobId>
  timestamp: <ISO>
```

### 8.2 Metrics

- Safe Mode agencies count
- Stage 2 blocks per agency per month
- Retry Stage 2 attempts vs. blocks

---

## PART 9: DOCUMENTATION NEEDED

### 9.1 User-Facing

- Admin guide: "How to enable Safe Mode"
- FAQ: "What is Safe Mode? What does it restrict?"
- Help text in UI: Tooltips on disabled options

### 9.2 Developer

- Architecture doc: This proposal
- API docs: New `/agency/settings/processing-mode` endpoint
- Test cases: All test scenarios from Section 5.3

---

## PART 10: FUTURE EXTENSIBILITY

Safe Mode architecture supports future features:

**Example 1: Per-User Override**
```typescript
interface UserRecord {
  processingModeOverride?: "full" | "safe"; // Bypass agency setting
}
```

**Example 2: Staged Rollout**
```typescript
interface Agency {
  processingMode: "full" | "safe" | "beta";
  processingModeRolloutPercent?: number; // Gradual enablement
}
```

**Example 3: Time-Based Restrictions**
```typescript
interface Agency {
  processingModeSchedule?: {
    mon_fri: "full" | "safe";
    sat_sun: "full" | "safe";
  };
}
```

---

## PART 11: SECURITY CONSIDERATIONS

### 11.1 Authorization

✅ Only agency owner/admin can modify Safe Mode  
✅ No user can bypass via API (enforcement server-side)  
✅ No privilege escalation vectors  

### 11.2 Data Integrity

✅ No data loss: Stage 2 just skipped, not deleted  
✅ Image history intact: Phases 1A/1B still saved  
✅ Audit trail: All blocks logged  

### 11.3 Attack Surface

✅ No new endpoints exposed publicly  
✅ All enforcement server-side (not trusting client)  
✅ Single source of truth (enqueueEnhanceJob)  

---

## PART 12: SUMMARY TABLE

| Component | File(s) | Change Type | Complexity | Risk |
|-----------|---------|------------|-----------|------|
| Agency type | `shared/src/auth/types.ts` | Add field | Low | Very Low |
| Agency persistence | `shared/src/agencies.ts` | Update get/set | Low | Very Low |
| Job enqueue (CORE) | `server/src/services/jobs.ts` | Add check | Medium | Medium |
| Retry routes | `server/src/routes/retrySingle.ts` | Add check | Medium | Low |
| Admin API | `server/src/routes/agency.ts` | New endpoint | Medium | Low |
| Batch UI | `client/src/components/batch-processor.tsx` | Conditional render | Low | Low |
| Retry UI | `client/src/components/retry-*.tsx` | Conditional render | Low | Low |
| Worker (optional) | `worker/src/worker.ts` | Defensive check | Low | Very Low |

---

## PART 13: DECISION CHECKPOINTS

Before implementation, confirm:

- [ ] Safe Mode = server-side execution ceiling (not just UI hiding)
- [ ] All three enforcement points required: enqueue, retry, optional worker
- [ ] Edit mode completely untouched (separate pipeline)
- [ ] Agency admin is only role that can change setting
- [ ] Backwards compatible: missing field = "full" mode
- [ ] Logging is in place for audit trail
- [ ] UI clearly communicates restrictions
- [ ] Testing covers all enforcement paths
- [ ] No breaking changes to public API

---

## CONCLUSION

**Safe Mode is implementable as a clean, minimal-risk feature** with:

- **Single source of truth**: Agency setting in Redis
- **Hard enforcement**: Server-side in enqueueEnhanceJob()
- **Multiple checkpoints**: Retry routes + optional worker validation
- **Backwards compatible**: Existing agencies unaffected
- **Clear separation**: Edit mode remains unrestricted
- **Audit trail**: All blocks logged for compliance

**Estimated Implementation Time**: 4-5 days  
**Estimated Testing Time**: 2-3 days  
**Total Risk Level**: **LOW**

The architecture follows proven patterns from existing features (subscription gating, role-based access) and avoids novel complexity.

---

## APPENDIX: KEY FILES REFERENCE

| File | Purpose | Key Lines |
|------|---------|-----------|
| `shared/src/auth/types.ts` | Agency interface | Define processingMode field |
| `shared/src/agencies.ts` | Agency CRUD | get/updateAgency functions |
| `server/src/services/jobs.ts` | Job enqueueing | enqueueEnhanceJob() function |
| `server/src/routes/retrySingle.ts` | Retry logic | effectiveStagesToRun logic |
| `server/src/routes/agency.ts` | Admin endpoints | New settings endpoint |
| `client/src/components/batch-processor.tsx` | Batch UI | allowStaging conditional render |
| `worker/src/worker.ts` | Worker entry | Optional defensive check |

