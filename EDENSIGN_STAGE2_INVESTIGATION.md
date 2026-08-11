# RealEnhance — EdenSign Stage 2 Architecture Investigation

**Status:** Read-only investigation. No source, config, package, environment, database, route, UI, test, or deployment files were modified. No branch was created. No commits were made. No API test renders were submitted (no EdenSign credentials exist anywhere in this repo or environment — verified by grep).

**Sourcing key used throughout:** `[CODE]` = verified by reading the file directly · `[DOCS]` = verified from EdenSign's public documentation · `[TEST]` = observed by a live test call (none performed — no credentials) · `[INFERENCE]` = reasoned conclusion, not directly stated by either source · `[UNKNOWN]` = not determinable from available sources, requires EdenSign confirmation.

**Structure note:** organized into the 20 numbered sections requested, preceded by an unnumbered Repository State check (requested as "starting point" ahead of the numbered deliverable).

---

## Repository State (starting point)

1. **Current branch:** `testing-grok-imagine` `[CODE — git branch --show-current]`
2. **Current HEAD:** `6df1d78d492238c24820a1de0653f8cf3c0d58f5` — "Vertex Inpainting Investigation Report" (2026-08-11) `[CODE — git rev-parse HEAD / git log -1]`
3. **Working tree:** clean, nothing to commit `[CODE — git status]`
4. **`main` HEAD:** `f54d93656d84fac27b93c12d1286611a7160444a` — "Revert 'Reduced Logs for Production'" (2026-06-23). Confirmed identical to `origin/main` after fetch. `[CODE — git rev-parse main / origin/main]`
5. **Divergence:** merge-base of `testing-grok-imagine` and `main` is `3f48d24d` (2026-06-18). `testing-grok-imagine` has 62 commits not on `main`; `main` has exactly 2 commits not on `testing-grok-imagine` — "Reduced Logs for Production" immediately followed by its own revert, i.e. **net-zero** relative to the merge base. In substance, `testing-grok-imagine` = `main` + 62 additional commits, no conflicting divergence. `[CODE — git log main..testing-grok-imagine / git log testing-grok-imagine..main]`

No branches were checked out, reset, merged, rebased, or committed during this investigation. All `main`-branch code below was read via `git show main:<path>` without touching the working tree.

---

## 1. Executive Summary

RealEnhance's Stage 2 (virtual staging) on `main` renders via **Gemini** (`gemini-2.5-flash-image`, aka "Nano Banana," with `gemini-3-pro-image-preview`/"Nano Banana Pro" available as a configurable alternative) — not Grok. Grok was only ever integrated on a separate branch (`testing-grok-imagine`) worked on this session; `main` has never had Grok. This distinction matters because the investigation was scoped to `main`'s current state, which differs materially from the branch most of this session's other work happened on.

EdenSign's public API contract answers the single most important question definitively: **`config.remove_furniture.mask_url` only constrains furniture *removal*. There is no documented parameter that constrains where *new* furniture may be placed.** `[DOCS]` EdenSign's staging call is, architecturally, the same category of risk as Gemini/Grok full-image generation — an opaque model deciding on its own what to change — just from a different vendor, with no caller-enforced spatial guarantee. This is a materially different (weaker) trust proposition than mask-constrained Vertex inpainting, investigated separately in `VERTEX_INPAINTING_INVESTIGATION.md`, which *does* offer a hard pixel-level containment guarantee. **The two investigations should not be conflated — EdenSign cannot deliver the "structure literally cannot change" guarantee that the Vertex inpainting proposal can.**

Given that, reducing Stage 2 validation to a single lightweight/cheap check is not defensible for EdenSign specifically. The recommendation in §9 is a single validator, but a **semantic** one (AI-based structural comparison), not a cheap pixel-diff — because without a mask, a cheap pixel-diff cannot distinguish "acceptable new furniture" from "unacceptable wall change." A second finding sharpens this into something concrete rather than abstract: §4's validator inventory shows `main` has already, independently, converged on almost exactly this "one real semantic gate" model — see §9 for the specific function to reuse.

---

## 2. Current Main Stage 2 Architecture

| Step | File : Line | What happens |
|---|---|---|
| Job creation | `server/src/routes/upload.ts:993` | Calls `enqueueEnhanceJob(staged.jobPayload, staged.jobId)` |
| Enqueue | `server/src/services/jobs.ts:499` (`enqueueEnhanceJob`) → `:980` (`queue().add(JOB_QUEUE_NAME, payload, ...)`) | BullMQ `Queue`, name from `shared/constants.js` `JOB_QUEUE_NAME` |
| Worker pickup | `worker/src/worker.ts:15770` — `new Worker(JOB_QUEUE_NAME, async (job) => {...}, { concurrency: process.env.WORKER_CONCURRENCY \|\| 2 })` (concurrency at `:16625`) | Dispatch loop; checks job isn't already terminal/awaiting-payment before proceeding |
| Stage 2 orchestration | `worker.ts` imports `runStage2`, `runStage2GenerationAttempt` from `./pipeline/stage2` (`:34-36`) | Main generation + retry loop lives in `worker.ts`; the actual image-generation call lives in `stage2.ts`. `worker.ts` also imports `classifyStructuralConsensusCase` from `./pipeline/stage2StructuralConsensusBackstop` (`:38`), but per §4's validator inventory this function is only ever invoked for Stage 1B (`worker.ts:9951`) on `main` — despite its name, it plays no role in Stage 2 decisions today |
| Retry budget | `worker.ts:11322` — `const MAX_STAGE2_RETRIES = 2;` | Hardcoded, not env-configurable on `main` (up to 3 attempts total: 1 initial + 2 retries) |
| Shared validation orchestrator | `worker.ts:4573` — `async function runStage2ValidationPipeline<...>(...)` | Generic callback-shaped orchestrator (`runSpecialists`/`runUnified`/`runCompliance`) called from more than one code path |
| Output persistence | S3 publish step (same pattern as other stages — image uploaded, signed/public URL attached to job record) `[CODE, pattern confirmed elsewhere in worker.ts; not re-traced line-by-line since unchanged by this investigation]` | |
| Final artifact / UI | Job record's `stageUrls`/`resultUrl` fields, same mechanism as Stage 1A/1B | |

Full validator wiring for the accept/reject decision is in §4.

---

## 3. Current Stage 2 Provider Flow

**Renderer:** Gemini, via `getGeminiClient()` (`worker/src/ai/gemini.ts`) + native SDK call `ai.models.generateContent(...)`. This is fundamentally different plumbing from Grok's REST-based image-edit call used on `testing-grok-imagine` — `main` never touches Grok at all. `[CODE]`

**Model configuration** — `worker/src/ai/runWithImageModelFallback.ts:27-38`:

```ts
export const MODEL_CONFIG = {
  stage1A: { primary: "gemini-2.5-flash-image", fallback: null },
  stage1B: { primary: "gemini-3-pro-image-preview", fallback: "gemini-2.5-flash-image" },
  stage2:  { primary: env("REALENHANCE_MODEL_STAGE2_PRIMARY", "gemini-2.5-flash-image"),
             fallback: env("REALENHANCE_MODEL_STAGE2_FALLBACK", "gemini-2.5-flash-image") },
};
```

So Stage 2 defaults to **"Nano Banana"** (`gemini-2.5-flash-image`) for both primary and fallback — "Nano Banana Pro" (`gemini-3-pro-image-preview`) is available and used by default for Stage 1B, but is only used for Stage 2 if an operator explicitly overrides `REALENHANCE_MODEL_STAGE2_PRIMARY`. `[CODE]`

**Model resolution:** `worker/src/ai/modelResolver.ts` on `main` — `resolveStage2ImageModel(attempt)` always returns `"gemini-2.5-flash-image"` regardless of attempt number (no built-in escalation-to-Pro-on-retry logic on `main`). `[CODE]`

**Call wrapper:** `runWithSelectedImageModel()` (`runWithImageModelFallback.ts:226`) — validates the configured model name contains `"-image"` (`ensureImageCapableModel`, throws `MODEL_CONFIG_INVALID` otherwise), calls `ai.models.generateContent()`, logs usage/telemetry via `logGeminiUsage`, validates the response actually contains inline image data (`isValidImageResponse`), and throws on failure. Called from `stage2.ts` around line 1035. `[CODE]`

**Prompt construction:** `stage2.ts:755` defines `STAGE2_PROMPT_NANO_BANANA`, gated by `USE_NANO_BANANA_PROMPT` (`:814`) against a "legacy" prompt fallback — the same two-variant pattern later extended to three variants (legacy/nano/grok) on `testing-grok-imagine`. `[CODE]`

**Masking:** none in the true inpainting sense. No provider abstraction (`worker/src/providers/` does not exist on `main` — confirmed via `git ls-tree`) — that pattern only exists on the unrelated, unmerged `feature/vertex-secondary-inpainting-continuity` branch. `[CODE]`

**Retry/fallback:** on generation failure or invalid response, `runWithSelectedImageModel` throws; the Stage 2 retry loop in `worker.ts` (bounded by `MAX_STAGE2_RETRIES = 2`) handles re-attempting, with `resolveStage2GenerationPlanForAttempt` (`stage2.ts:322`) adjusting temperature per attempt (`resolveStage2Temperature`, `:296` region — attempt 1 = 0.40, later attempts hold or adjust based on retry reason).

**What must be replaced if EdenSign becomes the renderer:** the `getGeminiClient()` + `runWithSelectedImageModel()` call inside `stage2.ts`'s generation-attempt function, and the `MODEL_CONFIG.stage2` entry. Everything upstream (job creation, queueing, worker dispatch, retry-loop *structure* if not its content) and downstream (persistence, UI) is provider-agnostic and does not need to change.

---

## 4. Current Validator Flow

All entries below `[CODE]`, verified against `main` HEAD `f54d9365` via a dedicated read-only pass.

| Validator | File | Function | Stage 2? | Blocking? | Advisory? | What it detects | Approx. cost/latency |
|---|---|---|---|---|---|---|---|
| Envelope Validator | `worker/src/validators/envelopeValidator.ts` | `runEnvelopeValidator` (L168) | yes (specialist) | Partial — feeds pre-Unified `categoricalBlock` gate (`worker.ts:13659`), but envelope-only signals are filtered unless `hardFail===true` or corroborated by an opening signal | Yes, otherwise | Wall moved/added/removed/reshaped, room footprint change | Gemini API call, several seconds |
| Opening Validator | `worker/src/validators/openingValidator.ts` | `runOpeningValidator` (L1382) | yes (specialist) | Yes — whitelisted issue types (opening removed/infilled/sealed) trip `categoricalBlock` | For non-whitelisted findings | Window/door/closet opening removal, resize, relocation | 1-2 Gemini calls (baseline extraction + compare), several seconds |
| Fixture Validator | `worker/src/validators/fixtureValidator.ts` | `runFixtureValidator` (L272) | yes (specialist) | Partial, via `categoricalBlock` whitelist | Yes, otherwise | Built-in fixture changes (lighting, HVAC vents, cabinetry) | Gemini API call, several seconds |
| Floor Integrity Validator | `worker/src/validators/floorIntegrityValidator.ts` | `runFloorIntegrityValidator` (L246) | yes (specialist) | Partial, via `categoricalBlock` whitelist | Yes, otherwise | Floor material/layout class change | Gemini API call, several seconds |
| Specialist Orchestrator | `worker/src/worker.ts` | `orchestrateSpecialistsWithRetry` (L4378) | yes | n/a (infra) | n/a | Runs the 4 specialists above in parallel, per-specialist timeout + 1 retry | ≈ max of the 4 (parallel), each up to `STAGE2_SPECIALIST_EXEC_TIMEOUT_MS` (default 45s; opening gets 2×) |
| Window Validator | `worker/src/validators/windowValidator.ts` | `validateWindows` (L5) | shared (1A/2; disabled 1B) | **No for Stage 2** — downgraded to advisory when Gemini semantic passes (single-authority rule, `runValidation.ts:1892-1987`) | Yes | Window count/placement drift | Local pixel (Sharp), <1s |
| Wall Validator | `worker/src/validators/wallValidator.ts` | `validateWallStructure` (L3) | shared | **No** for Stage 2 (same single-authority downgrade) | Yes | Wall structure/opening drift | Local, <1s |
| Global Edge IoU | `worker/src/validators/globalStructuralValidator.ts` | `runGlobalEdgeMetrics`/`FromBuffers` (L35/47) | shared | **No** for Stage 2 (advisory) | Yes | Overall edge-map IoU | Local (Sobel), <1s |
| Stage2 Structural Mask IoU | `worker/src/validators/stage2StructuralValidator.ts` | `validateStage2Structural` (L117) | yes | **No** for Stage 2 (advisory) | Yes | Masked structural-region IoU vs baseline | Local, <1s |
| Line/Edge Validator | `worker/src/validators/lineEdgeValidator.ts` | `validateLineStructure` (L196) | shared | **No** for Stage 2 (advisory) | Yes | Hough-line shift/loss | Local, <1s |
| Perceptual Diff (SSIM) | `worker/src/validators/perceptualDiff.ts` | `runPerceptualDiff` (L79) | shared | No | Yes — failure forces Gemini escalation | Global SSIM | Local, <1s |
| Stage-Aware Validator | `worker/src/validators/structural/stageAwareValidator.ts` | `validateStructureStageAware` (L197) | yes (Stage2 only) | No directly | Yes | Edge-IoU "risk" wrapper over global edge metrics | Local, <1s |
| Anchor Region Validators | `worker/src/validators/anchorRegionValidators.ts` | `runAnchorRegionValidators` (L692) | yes ("ALWAYS run" for stage2) | No — explicitly "evidence generators, never decisions"; can force Gemini escalation | Yes | Island/HVAC/cabinetry/lighting shift (Sharp CV, no AI) | Local, <1s |
| **Gemini Semantic Validator** | `worker/src/validators/geminiSemanticValidator.ts` | `runGeminiSemanticValidator` (L3018), via `runGeminiWithConsensus` (`runValidation.ts:206`) | shared (1A/1B/2) | **YES — sole primary blocking authority** (`blockSource="gemini"`, `runValidation.ts:1892`) | — | Broad semantic structural comparison (walls, openings, built-ins, camera) | 1 Gemini Flash call always + conditional 2nd Gemini Pro call if confidence low; several seconds |
| Semantic Structure Validator | `worker/src/validators/semanticStructureValidator.ts` | `runSemanticStructureValidator` (L204) | yes, `mode:"log"` | **No** — explicitly log-only | Yes | Window/door count, wall drift (Sharp) | Local, <1s |
| Masked Edge Validator | `worker/src/validators/maskedEdgeValidator.ts` | `runMaskedEdgeValidator` (L330) | yes, `mode:"log"` | **No** — explicitly log-only | Yes | Masked Hough-line drift isolating architecture from furniture | Local, <1s |
| Unified Validator (local signal combiner) | `worker/src/validators/unifiedValidator.ts` | `runUnifiedValidator` (L59) | yes, heuristic precheck | **No** — logged `log-only` | Yes | Combines local drift signals into a PROCEED_TO_GEMINI/severity decision | Local, <1s |
| Compliance Check (Gemini Pro identity) | `worker/src/ai/compliance.ts` | `checkCompliance` (L123) | yes | **No — explicitly log-only telemetry**, verdict never gates acceptance | Yes | Architectural identity vs Stage 1A baseline | 1 `gemini-2.5-pro` call, several seconds |
| **Final Structural Identity Review** | `worker/src/pipeline/stage2.ts` | `runGeminiStructuralReviewPro` (L206) | yes | **YES — final pre-publish gate** (`worker.ts:14122-14170`), on by default (`ENABLE_FINAL_STRUCTURAL_REVIEW`, `worker.ts:161`) | — | Same-room architectural identity (walls, openings, ceiling, camera) | 1 `gemini-2.5-pro` call, several seconds |
| Structural Consensus Backstop | `worker/src/pipeline/stage2StructuralConsensusBackstop.ts` | `classifyStructuralConsensusCase` (L72) | **No, in practice** — despite the filename and being imported by `worker.ts`, on `main` it is only ever invoked with `stage:"1B"` (`worker.ts:9951`) | n/a for Stage 2 | n/a | Not wired into Stage 2 decision-making on `main` today | n/a |
| Opening Preservation Validator | `worker/src/validators/openingPreservationValidator.ts` | `validateOpeningPreservation` (L2833) | No — Stage 1B only (`worker.ts:1979`) | n/a | n/a | Not part of Stage 2 flow on `main` | n/a |
| Edit Openings Validator | `worker/src/validators/editOpeningsValidator.ts` | `runEditOpeningsValidator` (L179) | No — belongs to the separate manual region-edit tool (`worker.ts:16182`), not automatic Stage 2 | Yes, within that tool | — | Opening preservation for manual "Reinstate/Edit" region edits | Local/Gemini mix |
| Curtain Rail Detector | `worker/src/validators/curtainRailDetector.ts` | `detectCurtainRail` (L11) | yes, pre-generation only | n/a (not post-gen) | n/a | Shapes the Stage 2 *prompt* before generation | Local, <1s |

**Accept/reject decision flow:** Stage 2 generation itself (`stage2.ts:runStage2GenerationAttempt`, L593) only retries on hard generation errors (no image returned) — all validation/retry/fallback decision-making lives in `worker.ts`, orchestrated by `runStage2ValidationPipeline` (L4573), called from the main path at **L13884** and a manual-retry path at **L7109**. Per attempt (loop bounded by `MAX_STAGE2_RETRIES = 2`, `worker.ts:11322`):

1. **Specialists** (opening/fixture/floor/envelope) run in parallel (`orchestrateSpecialistsWithRetry`, L4378). A narrow whitelist gate (`categoricalBlock`, L13659) can hard-fail *before* Unified ever runs, only for structural-removal-class issue types.
2. **Unified validation** (`runUnifiedValidation`, `runValidation.ts:547`) runs local heuristics (window/wall/edge/line/mask IoU, anchors) then Gemini semantic. **"SINGLE-AUTHORITY" logic** (`runValidation.ts:1892-1987`) makes the Gemini semantic call the sole blocking signal for Stage 2 — if it passes, every local heuristic failure is demoted to a warning. Checked at `worker.ts:13818`; failure triggers retry or fallback (L13849-13873).
3. **Compliance check** (`checkCompliance`) runs but is purely log-only telemetry (`worker.ts:13884-14022`) — never gates acceptance.
4. **Final structural identity review** (`runGeminiStructuralReviewPro`) runs last as a genuine second blocking gate (`worker.ts:14122-14225`); on `FAIL` triggers retry or fallback identically to step 2.

**This is the single most important fact for §9:** on `main`, real blocking authority *already* rests on just **two Gemini semantic calls** — the Unified validator's Gemini pass and the Final Structural Identity Review — not the four specialists, which are effectively advisory telemetry today despite superficially looking like a "gauntlet." `main`'s own architecture has already converged, independently, on almost exactly the "one semantic validator" model under investigation for EdenSign.

---

## 5. EdenSign API Investigation

**Sources used:** `https://edensign.io/developer` (public marketing/docs page, fetched successfully) and `https://edensign.io/pricing` (fetched successfully). `https://developer.edensign.io` (the presumed full API reference) returned **HTTP 401 Unauthorized** — it requires an authenticated account and could not be read in this environment. No EdenSign API credentials exist anywhere in this repository (`grep -ri edensign` across all `.env*`/`.ts`/`.js`/`.json` returns nothing) `[CODE]`, so **no live API calls were made** — everything below is from public documentation only, per the "do not make production-mutating requests" restriction and the simple fact that no credentials exist to make any request at all, mutating or not.

### Authentication `[DOCS]`
- Bearer token: `Authorization: Bearer YOUR_API_KEY`, key created on an "API Keys" page (behind login, not inspected).
- No sandbox/test-mode credentials documented on the public page.

### `POST /v1/renders` `[DOCS]`
- **Required:** `image_url` (string — URL of the image to process; EdenSign fetches the image itself, it does not accept direct binary upload in this call).
- **Optional:** `variation_count` (default 3, max 20 — `MAX_VARIATIONS_EXCEEDED` / HTTP 416 if exceeded), `config`.
- **`config` object:**
  ```
  config.type: "staging"                              // only documented value
  config.remove_furniture.mode: "on" | "off" | "auto"
  config.remove_furniture.mask_url: <image URL>        // removal-only, see §7
  config.remove_furniture.room_type: living | bed | kitchen | dining | bathroom | home_office | kids_room | outdoor
  config.add_furniture.style: standard | modern | scandinavian | industrial | midcentury | luxury | farmhouse | coastal
  config.add_furniture.room_type: <same 8 room types>
  ```
- **Supported input formats:** JPG, PNG, WebP, AVIF, HEIC (mentioned in the upload section of the docs).
- Max size/resolution, exact aspect-ratio handling: **`[UNKNOWN]`** — not stated on the public page.

### Additional endpoints `[DOCS]`
- `POST /v1/renders/:renderId/variations` — request additional variations on an existing render (up to the 20-per-task cap).
- `GET /v1/renders/:renderId` — retrieve a render and all its variations.
- `GET /v1/renders?limit=10&next=CURSOR` — list/paginate renders.
- `DELETE` endpoints exist for renders/variations (exact paths not confirmed — behind the gated reference).

### Response shape `[DOCS]`
- Render object: `id`, `images`, `variationCount`, `createdAt`, `variations[]`.
- Variation object: `id`, `renderId`, `images`, `type`, `style`, `roomType`, `createdAt`, `completedAt` (null until that variation finishes).

### Timeout / async model `[DOCS]` + `[INFERENCE]`
- "The API enforces a 60-second timeout. If the GPU cannot complete processing within this time, please retry your request."
- The render is created and returns a `renderId` immediately; individual variations complete asynchronously (`completedAt` populates later, independently per variation). **No webhook mechanism is documented.** This means the only way to learn a render finished is **polling** `GET /v1/renders/:renderId` — see §11.

### Not documented anywhere on the public pages `[DOCS — absence noted, not proof of absence]`
Webhooks/callback URLs, idempotency keys, rate limits (req/sec or concurrent), batch endpoints, official SDKs, sandbox/test mode. **`[UNKNOWN]`** for all — the authenticated reference site (`developer.edensign.io`, 401) may document some of these; it could not be checked.

### Errors `[DOCS]`
HTTP 400, 401, 403, 404, 416, 500 with structured JSON error responses; example reason code seen: `MAX_VARIATIONS_EXCEEDED`. Full error taxonomy: **`[UNKNOWN]`**.

---

## 6. EdenSign API Capabilities vs. RealEnhance Requirements

### What EdenSign does for us vs. what RealEnhance must still do

Based on the documented `config` schema, EdenSign's staging call handles, in one request: room-type-aware furniture selection, placement, and styling (`add_furniture.style`/`room_type`), and optionally existing-furniture removal (`remove_furniture.mode`/`mask_url`) — i.e. it can potentially fold what RealEnhance currently does across **Stage 1B (declutter) + Stage 2 (staging)** into a single external call, if `remove_furniture.mode` is used. `[DOCS]` + `[INFERENCE]`

Claims EdenSign's marketing makes about preserving walls/windows/floors/fixtures during staging are **not backed by any API-level enforcement mechanism** found in the documentation — see §9.

**RealEnhance still must, before calling EdenSign:**
- Produce the clean Stage 1A/1B image exactly as today (no change to that responsibility).
- Host that image at a **fetchable URL** — EdenSign's `image_url` field implies EdenSign fetches the image itself rather than accepting a direct upload/multipart body `[DOCS]`, so the existing S3-publish step must complete and be reachable *before* Stage 2 begins, not deferred until after (a real ordering constraint, not a formality).
- Map RealEnhance's room type and staging style onto EdenSign's enums (below) — including deciding what to do for combinations EdenSign has no equivalent for.
- Decide and set `remove_furniture.mode`/`config.type` per job.
- Poll for completion and download the result promptly (URL lifetime is unknown, see §11).
- Run RealEnhance's own validation — EdenSign provides no verification signal back to the caller beyond "here is an image."

### Room / style mapping

**Room types** — RealEnhance's scene labels on `main`: `kitchen, bathroom, bedroom, living_room, dining, office, exterior, other` (`worker/src/ai/room-detector.ts:11-17`) `[CODE]`, plus **compound/open-plan Stage-2-specific types** used only in staging: `kitchen_living, kitchen_dining, living_dining, multiple_living` (`stage2.ts:426-448, 664-669`). `[CODE]`

EdenSign's room types: `living, bed, kitchen, dining, bathroom, home_office, kids_room, outdoor` (8 flat values, no compound/open-plan option). `[DOCS]`

| RealEnhance | EdenSign | Note |
|---|---|---|
| `living_room` | `living` | Direct |
| `bedroom` | `bed` | Direct |
| `kitchen` | `kitchen` | Direct |
| `dining` | `dining` | Direct |
| `bathroom` | `bathroom` | Direct |
| `office` | `home_office` | Direct (naming differs) |
| `exterior` | `outdoor` | Direct, but confirm EdenSign's `outdoor` handles real-estate exterior yards/decks the way RealEnhance's exterior staging does — `[UNKNOWN]` |
| `other` | — | **No mapping.** EdenSign has no catch-all/other category. `[DOCS — absence noted]` |
| `kitchen_living`, `kitchen_dining`, `living_dining`, `multiple_living` (open-plan) | — | **No compound/open-plan category exists in EdenSign's API.** `[DOCS — absence noted]` |
| (kids room, implied by the investigation's own list but not found as a distinct `main` room-detector label) | `kids_room` | RealEnhance would need to add/confirm this as a selectable room type if not already present elsewhere in the UI layer (not traced in this investigation — UI/routing for room-type selection was out of scope) |

**Unsupported mappings must not be silently substituted.** For `other` and every open-plan compound type, recommend: either (a) require the caller to pick a single dominant EdenSign room type explicitly (lossy — EdenSign will only stage/consider one room-type context, e.g. it may not stage both the kitchen and living zones coherently as one open-plan scene), or (b) refuse to route that job to EdenSign and fall back to the existing Gemini/Grok pipeline, which does have compound-room prompt handling. **(b) is the safer default for an experiment.**

**Staging styles** — RealEnhance: `standard_listing, family_home, urban_apartment, high_end_luxury, country_lifestyle, lived_in_rental` (default `standard_listing`) (`worker/src/ai/stagingStyles.ts`) `[CODE]`. EdenSign: `standard, modern, scandinavian, industrial, midcentury, luxury, farmhouse, coastal` `[DOCS]`.

| RealEnhance | Proposed EdenSign mapping | Confidence |
|---|---|---|
| `standard_listing` | `standard` | High — both are explicitly the neutral/safe default |
| `high_end_luxury` | `luxury` | High |
| `urban_apartment` | `modern` | Medium — reasoned, not verified |
| `country_lifestyle` | `farmhouse` or `coastal` | Low — ambiguous, needs a product decision |
| `family_home` | `standard` or `farmhouse` | Low — ambiguous |
| `lived_in_rental` | `standard` | Medium |

No RealEnhance style has zero plausible EdenSign counterpart, but three of six are genuine judgment calls, not verified equivalences — this table is `[INFERENCE]`, not `[DOCS]`, for those rows, and should be confirmed empirically (render the same room under each candidate mapping and compare) before shipping, not assumed correct.

---

## 7. Critical Mask / Placement Constraint Finding

This is the single most important finding in this report, and it is **conclusive, not inferred**, from the public documentation:

> `config.remove_furniture.mask_url` is documented **exclusively inside the `remove_furniture` block**. Its stated purpose is to control which existing furniture gets removed. **There is no equivalent field inside `config.add_furniture`, and no other documented parameter anywhere in the API (mask, region, bounding box, polygon, or otherwise) that constrains where new furniture is placed.** `[DOCS]`

Evaluated against the four possibilities the investigation was asked to resolve:

1. ~~Mask is only used to remove existing furniture~~ — **this is correct**, per the documented schema.
2. ~~Mask can also constrain furniture placement/addition~~ — **no evidence of this; not supported as documented.**
3. Another documented/undocumented parameter for constrained staging/inpainting — **none found in public docs.** Cannot be fully ruled out at `developer.edensign.io` (401, inaccessible), so this residual is marked `[UNKNOWN — REQUIRES EDENSIGN CONFIRMATION]`, not closed.
4. **EdenSign's staging API takes the source image and autonomously decides furniture placement — this is the conclusion supported by the evidence.** `[DOCS]` + `[INFERENCE]`

**Consequence:** do not design the experimental architecture around an assumed placement-constraint capability. EdenSign staging is, in terms of structural risk, the same category of black-box full-image AI edit as Gemini or Grok — a different vendor's model making its own decisions about what pixels to touch, with no API-level guarantee that walls/windows/floors are untouched. Any confidence in EdenSign's structural preservation rests on the vendor's own model quality and marketing claims (see §9), not on anything the API contract enforces.

---

## 8. Proposed EdenSign Stage 2 Architecture

```text
main
 │
 └── feature/stage2-edensign-experiment   ← proposed, NOT created
          │
          ├── Stage 1A  (unchanged)
          │
          ├── Stage 1B  (unchanged)
          │
          └── Stage 2
                │
          ┌─────┴──────────────────┐
   STAGE2_RENDER_PROVIDER=gemini   STAGE2_RENDER_PROVIDER=edensign   (default: gemini — production path untouched)
          │                                  │
          ▼                                  ▼
   existing Gemini path              EdenSignProvider
   + full specialist                        │
   validator gauntlet                       ▼
          │                          POST /v1/renders → poll → download
          │                                  │
          │                                  ▼
          │                    runGeminiStructuralReviewPro (reused as-is from
          │                    stage2.ts:206 — §9; semantic, NOT a cheap
          │                    structural-only check)
          │                                  │
          │                          ┌───────┴───────┐
          │                        PASS             FAIL
          │                          │                │
          │                          ▼                ▼
          │                      Output      fallback to existing Gemini
          │                                   Stage 2 path (§13), or reject
          ▼                                   if fallback also exhausted
   Output (unchanged)
```

This differs from the originally sketched diagram only in making the fallback-on-failure path explicit and in naming the validator "semantic" rather than leaving it unqualified — both changes are direct consequences of §7's finding that EdenSign offers no placement-constraining guarantee.

**Variation strategy:** given per-variation API cost is `[UNKNOWN]` (§12) and EdenSign's own variation cap is 20/render with a default of 3, and given the validator (§9) is a real semantic AI call (non-trivial cost/latency, not free) — **recommend requesting 2 variations, validating the first, and using the second only if the first fails validation.** This bounds worst-case cost to 2× render + up to 2× validator calls, versus a full-set-ranking approach (multiplies validator cost by however many variations are requested) or a single-shot approach (no resilience if EdenSign's one attempt has a structural issue). This is a qualitative recommendation — it cannot be cost-optimized without real per-variation pricing.

---

## 9. Proposed Single-Validator Architecture

This is the question the investigation prompt asked to be handled "ruthlessly," and the finding in §7 makes the answer sharper than it might otherwise be.

**What EdenSign's API contract guarantees:** almost nothing about structural preservation. The contract guarantees a `staging` operation exists, that `remove_furniture` can be masked for *removal*, and that room-type/style hints steer the output. **It does not guarantee, enforce, or even offer a mechanism to guarantee that walls, windows, floors, or fixtures remain unchanged during furniture *addition*.**

**What EdenSign merely claims:** EdenSign's marketing positions its model as trained on real architectural photography with strong preservation characteristics. This is a training/tuning claim about typical output quality, not an API-level guarantee — indistinguishable, from an engineering-risk standpoint, from "Gemini/Grok are prompted not to alter structure and are pretty good at it, most of the time." This session's own earlier work (documented in `VERTEX_INPAINTING_INVESTIGATION.md`) was directly motivated by a real, observed failure of exactly this kind — a full-generation model removing a wall corner despite an explicit, strongly-worded prompt not to. There is no evidence available that EdenSign is structurally immune to the same class of failure; it is simply untested here.

**What RealEnhance must still independently verify:** the same class of thing it verifies today for Gemini/Grok — that architecture, openings, floors, and fixed features are unchanged between the Stage 1A/1B input and the Stage 2 output. Nothing about switching vendors removes this need; if anything, an *unbenchmarked* vendor deserves more scrutiny during the trial period, not less.

**Recommendation — be precise about what "one validator" should mean:**

- **Not zero validators.** Given §7, this would be actively unsafe — there is no structural mechanism preventing EdenSign from making the same kind of error Gemini/Grok can make.
- **Not a cheap/structural-only/pixel-diff validator**, unlike what would be defensible for the *mask-constrained Vertex inpainting* proposal (`VERTEX_INPAINTING_INVESTIGATION.md`, §7 of that report). That recommendation worked specifically because inpainting provides a hard guarantee outside the mask, so a cheap "did anything change outside the mask" pixel-diff directly tests the actual invariant. **EdenSign has no mask for placement, so there is no "outside the mask" region to diff against — a pixel-diff between input and output would flag every legitimate piece of new furniture as a "change," making it useless as a structural-only signal.**
- **A single semantic validator — specifically, something functionally equivalent to the existing Unified Validator's Gemini-semantic comparison** (input vs. output, checking whether walls/windows/doors/floors/fixtures changed) is the minimum defensible layer. It is "one validator" in the sense the proposed architecture wants, but it must be one that actually looks at and reasons about the image semantically — not a cheap deterministic check — because nothing upstream of it constrains the problem space the way a mask would.
- The existing specialist battery (opening/fixture/floor/envelope, run as a group) can reasonably be **bypassed** for this experiment specifically because a single well-scoped semantic validator covering the same ground is a reasonable amount of risk to accept *for an experiment*, provided the fallback-on-failure behaviour in §13 is in place. This is different from recommending they be deleted or bypassed in production.

**§4's validator inventory makes this recommendation concrete rather than abstract, and reveals something worth stating plainly: `main` has already, independently, arrived at almost the same architecture proposed here for EdenSign.** Despite superficially having a full "gauntlet" (opening/fixture/floor/envelope specialists + half a dozen local heuristic checks), the accept/reject decision for Stage 2 on `main` today rests on exactly **two** Gemini semantic calls: the Unified Validator's Gemini pass (`runGeminiSemanticValidator`, sole blocking authority per the "SINGLE-AUTHORITY" rule at `runValidation.ts:1892-1987`) and the Final Structural Identity Review (`runGeminiStructuralReviewPro`, `stage2.ts:206`, the last gate before publish). Every specialist and every local pixel/edge heuristic is advisory telemetry that can escalate scrutiny but cannot independently block, outside a narrow removed/infilled-opening whitelist. This is the same lesson this session's `testing-grok-imagine` work ran into independently while restoring that branch's specialist validators — a large battery of specialist checks accumulates cost and noise without adding much real blocking power once a decent semantic pass exists.

**Concrete recommendation:** for the EdenSign experimental path, reuse `runGeminiStructuralReviewPro` (`worker/src/pipeline/stage2.ts:206` on `main`) directly, called with the Stage 1A/1B baseline as one input and the downloaded EdenSign output as the other — this is not a new validator to design and build, it is the exact function `main` already trusts as its final gate for Gemini/Grok-generated images, applied unchanged to a differently-sourced image. This keeps the experiment's validation logic consistent with the reasoning already battle-tested in production, rather than inventing new semantic-comparison logic and its own untested failure modes at the same time as testing a new renderer.

---

## 10. Current Code Reuse / Bypass / New Code Map

| Category | File | Purpose | Current role | Proposed role | Reason |
|---|---|---|---|---|---|
| **KEEP AS-IS** | `server/src/routes/upload.ts` | Job intake | Creates jobs, enqueues | Unchanged | Provider-agnostic |
| KEEP AS-IS | `server/src/services/jobs.ts` | Queueing | BullMQ producer | Unchanged | Provider-agnostic |
| KEEP AS-IS | `worker/src/worker.ts` job-dispatch loop (`:15770` onward, outer structure) | Worker entry | Job pickup, status guards | Unchanged | Provider-agnostic |
| KEEP AS-IS | Stage 1A/1B pipeline (`worker/src/pipeline/stage1A.ts`, `stage1B.ts`) | Upstream enhancement | Unchanged | Unchanged | EdenSign consumes their output, doesn't replace them |
| KEEP AS-IS | All existing specialist validator modules (`worker/src/validators/*`) | Structural validation | Active on the production (Gemini) path | Remain in repo, untouched — just not invoked on the EdenSign experimental path | Must not regress the production path; needed if the experiment fails |
| **ADAPT** | `worker/src/pipeline/stage2.ts` | Stage 2 generation | Calls Gemini directly | Add a provider branch/selector | Minimal-surface-area insertion point |
| ADAPT | `worker/src/ai/runWithImageModelFallback.ts` / `modelResolver.ts` | Model config | Gemini-only | Add EdenSign case or bypass for that path | Keep existing config shape intact for the default path |
| ADAPT | `worker/src/ai/stagingStyles.ts`, `worker/src/ai/room-detector.ts` | Room/style enums | RealEnhance-native values | Add a mapping layer (§6), do not modify the enums themselves | Avoid touching values the production path depends on |
| **BYPASS FOR EDENSIGN TEST** | `worker/src/validators/*` specialist battery | Structural validation | Blocking on production path | Not invoked when `STAGE2_RENDER_PROVIDER=edensign` (§15) | Replaced experimentally by the single validator in §9 — code remains, just not called |
| **NEW** | e.g. `worker/src/providers/edensign/` (new directory) | EdenSign API client | — | Auth, `POST /v1/renders`, polling `GET /v1/renders/:id`, response parsing | No EdenSign code exists anywhere in this repo today |
| NEW | Room/style mapping table (§6) | — | — | Small pure-function module | Isolated, testable, no side effects |
| NEW (thin wrapper only) | Small adapter around `runGeminiStructuralReviewPro` (`worker/src/pipeline/stage2.ts:206`, unchanged) | — | — | Call the existing function directly with (Stage1A/1B baseline, downloaded EdenSign output) — do not reimplement semantic comparison logic | §9: `main` already trusts this exact function as its final Stage 2 gate; reuse it rather than building new comparison logic |
| NEW | Feature flag plumbing (§15) | — | — | Env-var-driven provider + validator-mode selection | Must default to today's behaviour with zero env changes |
| **DELETE EVENTUALLY** (only if EdenSign fully proves out — not part of this experiment) | Nothing recommended for deletion at this stage | — | — | — | Premature — no evidence yet justifies removing anything |

---

## 11. Queue / Async / Webhook Architecture

`[DOCS]` confirms: no webhooks, render creation returns immediately, completion is signaled only by `completedAt` becoming non-null on each variation when polled via `GET /v1/renders/:renderId`.

**Recommended architecture** (the originally proposed diagram, confirmed correct given the evidence, with the polling detail made explicit):

```text
RealEnhance job (existing BullMQ job, existing worker, existing concurrency=2)
    ↓
Stage 1A/1B completes → image published to S3 (fetchable URL required first)
    ↓
POST /v1/renders  { image_url, variation_count, config }
    ↓
poll GET /v1/renders/:renderId  (bounded interval, e.g. every 3-5s, with a max wait budget)
    ↓
first variation with completedAt != null AND non-empty images[]
    ↓
download image, persist to RealEnhance's own S3 (do not rely on EdenSign's URL long-term — lifetime unknown)
    ↓
single Stage 2 validator (§9)
    ↓
PASS → final Stage 2 artifact          FAIL → retry/fallback (§13)
```

**No new queue or dedicated consumer worker is needed** — unlike the Vertex continuity investigation (which needed one because it was waiting on an async *human* "master approved" step), this is a bounded, synchronous-from-the-caller's-perspective poll loop that fits inside the existing per-job worker execution. This is a genuine simplification versus the Vertex proposal's architecture. `[INFERENCE]`, but a low-risk one given BullMQ jobs already tolerate multi-second/multi-minute execution elsewhere in this codebase (Gemini calls with retries already take tens of seconds per the logs reviewed earlier this session).

The 60-second timeout is almost certainly about the render-creation/GPU-processing window, not a hard ceiling on total job time — the response shape (immediate `renderId`, later `completedAt`) implies the create call itself returns fast and processing happens after. **`[UNKNOWN — confirm with EdenSign]`** exactly what "retry your request" means operationally (retry the POST? retry the specific variation?).

### Output handling

| Question | Answer | Source |
|---|---|---|
| Returned image URL lifetime | `[UNKNOWN]` | Not stated in public docs |
| Signed / expiring URLs | `[UNKNOWN]` | Not stated |
| Immediate download required | **Recommend treating as yes**, given lifetime is unknown | `[INFERENCE]` |
| MIME types returned | `[UNKNOWN]` (input formats documented — JPG/PNG/WebP/AVIF/HEIC — output format not explicitly stated) | `[DOCS]` (input only) |
| Dimensions/aspect ratio preserved, cropped, or padded | `[UNKNOWN]` | Not stated |
| Metadata retention | `[UNKNOWN]` | Not stated |
| Can output URLs be stored permanently | **No — do not rely on this.** Download and re-host on RealEnhance's own S3 immediately upon completion, exactly as the existing pipeline already does for every other stage's output. | `[INFERENCE]`, but this is standard practice and consistent with how every other provider (Gemini, Grok) is already handled in this codebase |

**Recommendation:** persist EdenSign output through the exact same S3 publish path already used for Stage 1A/1B/Stage 2 outputs today — no new storage mechanism needed, just a new source URL to download from.

---

## 12. Cost and Performance Analysis

| Provider | Approx cost/image | Typical latency | Variations | Notes |
|---|---:|---:|---|---|
| Current Stage 2 (`gemini-2.5-flash-image`) | **~$0.039/image** `[approx, public Google pricing via web search — not verified against RealEnhance's own billing]` | Not separately benchmarked in this investigation; empirically multi-second per attempt based on logs reviewed earlier this session | N/A (single image per call; RealEnhance's own retry loop can call up to 3×) | **This model is scheduled for retirement by Google on 2026-10-02** — relevant to this decision regardless of EdenSign, since `main`'s current default Stage 2 model has an expiration date already `[public pricing/deprecation pages, not RealEnhance-specific]` |
| Current Stage 2 fallback (`gemini-3-pro-image-preview`) | **~$0.134/image** (1-2K output) `[same sourcing caveat]` | Not benchmarked here | N/A | Available today only if `REALENHANCE_MODEL_STAGE2_PRIMARY` is overridden |
| EdenSign | **UNKNOWN** | **UNKNOWN** | up to 20/render, default 3 | **API access is Enterprise-tier only, "Custom"/"Tailored pricing" — not available on Starter ($20/mo, $1.33/photo), Pro ($45/mo, $0.90/photo), or Premium ($117/mo, $0.78/photo) consumer plans** `[DOCS — /pricing page]`. Those consumer per-photo figures are **not confirmed to apply to API usage** and should not be used as a cost proxy without EdenSign sales confirmation. |

**No defensible cost comparison can be produced today.** The consumer-tier $0.78-$1.33/photo range is the only public number available and is explicitly gated away from API access on EdenSign's own pricing page — using it as a stand-in for API cost would be exactly the kind of unlabeled assumption this investigation was told not to make. **Marked UNKNOWN, not estimated.**

### Throughput and scaling

| Question | Answer | Source |
|---|---|---|
| EdenSign rate limits (req/sec) | `[UNKNOWN]` | Not documented publicly |
| Concurrent render limits | `[UNKNOWN]` | Not documented publicly |
| Timeout | 60s (render/GPU processing) | `[DOCS]` |
| Batch limits | Up to 20 variations/render task (only documented limit) | `[DOCS]` |
| Idempotency keys | `[UNKNOWN]` (not mentioned) | — |
| Parallel request guidance | `[UNKNOWN]` | — |

**Current RealEnhance:** BullMQ, `WORKER_CONCURRENCY` default 2 (`worker.ts:16625`) `[CODE]`.

**Recommendation:** for the experimental branch, call EdenSign synchronously inside the existing per-job worker execution (§11) at the existing concurrency level (2), and treat any rate-limit-related errors as a hard blocker to confirm with EdenSign before increasing concurrency or moving to a dedicated queue. Do not build a dedicated EdenSign queue for the experiment — it adds operational complexity (a lesson directly visible in this repo: the Vertex continuity branch built exactly that, and it remains unmerged/unused nearly two months later) without a documented reason (no rate limit is published that would require it, and no webhook exists that would need a dedicated consumer).

---

## 13. Failure and Retry Strategy

Conceptual — not implemented.

| Failure mode | Recommended experimental behaviour |
|---|---|
| EdenSign API failure (5xx/network) | Bounded retry with backoff (e.g. 2 attempts), then fall back to existing Gemini Stage 2 path, do not hard-fail the job |
| EdenSign timeout (poll budget exceeded) | Treat as failure; same fallback as above |
| Incomplete render (variation never reaches `completedAt`) | Same fallback |
| Image fails the single validator (§9) | If additional variations were requested and not yet checked, validate the next one before giving up; otherwise fall back to existing Gemini Stage 2 path — **do not** ship an unvalidated image and do not hard-fail the whole job while a working fallback exists |
| Validator itself errors (e.g. its own API call fails) | Fail closed — treat as a validation failure, not a pass, and fall back |

**Rationale:** during an experiment, protecting the existing production path and user experience matters more than proving EdenSign works on the first try — every EdenSign-specific failure mode should degrade to "use the pipeline we already trust," not to a failed job, as long as budget/time allows.

---

## 14. Security / Image Handling

| Question | Answer |
|---|---|
| Does EdenSign fetch images from a public URL, or require upload? | Fetches from `image_url` `[DOCS]` — implies the URL must be reachable by EdenSign's servers at call time |
| Can signed URLs be used? | `[UNKNOWN]` — not stated whether EdenSign's fetcher respects signed-URL query params or requires a fully public object |
| How long must the URL remain accessible? | `[UNKNOWN]` — at minimum through the render's processing window; recommend generating a signed URL with generous expiry (e.g. 1 hour) rather than assuming instant fetch |
| Does EdenSign store uploaded images? Retention policy? | `[UNKNOWN]` |
| Are images used for model training? | `[UNKNOWN]` — **this specifically needs confirmation before any real customer property photos are sent**, given NZ Fair Trading Act / privacy considerations already relevant to this codebase (see existing `VALIDATOR_ENV_VARS.md`/compliance-related docs in this repo) |
| API key handling | Standard bearer-token handling — store as a Railway env var/secret, same pattern as `GEMINI_API_KEY`/`XAI_API_KEY` today; no special mechanism implied by the docs |

**Flag clearly for EdenSign sales/support before any production use:** image retention duration, training-data usage policy, and output URL signing/expiry. None of these were answerable from public documentation.

---

## 15. Feature Flag / Provider Routing

`main` has **no existing provider-interface abstraction** for Stage 2 rendering (`worker/src/providers/` does not exist on `main` — confirmed via `git ls-tree`) `[CODE]`. Provider selection today is inline env-var + conditional branching inside `stage2.ts`/`runWithImageModelFallback.ts`, not an interface-based pattern — routing design (below) should introduce one, but minimally (full detail in §18).

Recommend two independent env vars, so provider choice and validator strategy can be tested independently (e.g., test EdenSign *with* the full existing validator gauntlet first, before also testing the reduced single-validator path):

```bash
STAGE2_RENDER_PROVIDER=gemini      # default — current production behaviour, zero change with this unset
STAGE2_RENDER_PROVIDER=edensign    # experimental

STAGE2_VALIDATOR_MODE=full         # default — existing specialist gauntlet
STAGE2_VALIDATOR_MODE=single       # experimental — §9's single semantic validator only
```

Both must default to today's exact behaviour when unset, so the production path requires zero env changes to keep working.

---

## 16. Benchmark Plan

**Test set** (per the investigation's own required list, all should be represented): occupied rooms, empty rooms, rooms with windows, sliding doors, fireplaces, cabinetry, wardrobes, tiled walls, kitchens, bathrooms, bedrooms, awkward/wide-angle perspectives, rooms with multiple openings, rooms with existing furniture requiring removal, partial/already-staged rooms, difficult/mixed lighting. Recommend 3-5 real (anonymized/consented) images per category, run through both the current Gemini pipeline and the EdenSign experimental path for direct comparison.

**Metrics:**

*Structural correctness* (pass/fail per image, ideally scored by a human reviewer blind to which provider produced it, not just the automated validator being tested): doors preserved, windows preserved, walls preserved, floors preserved, ceilings preserved, fixed cabinetry preserved, overall room geometry/proportions preserved.

*Staging quality*: furniture realism, placement sensibility, scale accuracy, perspective correctness, lighting/shadow consistency, overall composition — subjective, recommend a simple 1-5 rubric per image, human-scored.

*Operational*: processing time (submission to downloaded final image), failure rate, retry rate, validator rejection rate, cost/image (once EdenSign pricing is known).

**Compare directly against the current Gemini Stage 2 pipeline on the same test set**, not against an abstract quality bar — the decision is relative (is EdenSign at least as good, cheaper, or faster, net of its own failure modes), not absolute.

---

## 17. Risks and Unknowns

- EdenSign real API pricing — **UNKNOWN**, Enterprise/custom only.
- EdenSign rate limits / concurrency limits — **UNKNOWN**.
- EdenSign image retention / training-data usage — **UNKNOWN**, needs confirmation before real customer photos are sent.
- EdenSign output URL lifetime / signing — **UNKNOWN**.
- Whether a truly undocumented placement-mask parameter exists (the gated `developer.edensign.io` reference was not accessible) — **UNKNOWN**, low probability given the public docs are otherwise thorough, but not fully closed.
- Whether EdenSign's model is *empirically* more structurally reliable than Gemini/Grok in practice — **UNKNOWN**, this is exactly what the benchmark plan (§16) is for.
- `gemini-2.5-flash-image` (current default Stage 2 model) is scheduled for retirement 2026-10-02 by Google — a real forcing function on `main`'s Stage 2 provider decision independent of the EdenSign question.
- Open-plan/compound room types have no EdenSign equivalent (§6) — a real, not cosmetic, capability gap.

---

## 18. Recommended Implementation Plan

### Provider abstraction

Introduce a minimal interface at the `stage2.ts` generation-call site specifically — not a deep `worker.ts` rewrite:

```ts
interface Stage2RendererProvider {
  render(request: Stage2RenderRequest): Promise<Stage2RenderResult>;
}
// implementations: GeminiRendererProvider (wraps existing runWithSelectedImageModel logic)
//                  EdenSignRendererProvider (new)
```

This is conceptually similar to (and can borrow interface-shape inspiration from) `worker/src/providers/types.ts` on the unrelated `feature/vertex-secondary-inpainting-continuity` branch — but that branch's code should not be merged wholesale; it solves a different problem (multi-angle continuity) with different concerns (GCS transport, mask compilation) that don't apply here. Build a new, EdenSign/Gemini-scoped interface, not a port of that one.

**Do not** destroy or restructure the existing Gemini call path to fit a new abstraction — wrap it, don't rewrite it. The goal is an additive branch point, minimizing risk to the production path.

### Suggested phases

1. Build the `Stage2RendererProvider` interface + `EdenSignRendererProvider` (auth, `POST /v1/renders`, polling, response download) as new, isolated code (§10 "NEW" rows).
2. Build the room/style mapping module (§6) as a small, independently testable pure function.
3. Wire the thin `runGeminiStructuralReviewPro` adapter (§9) for the EdenSign path.
4. Add `STAGE2_RENDER_PROVIDER` / `STAGE2_VALIDATOR_MODE` env-var routing (§15), defaulting to today's behaviour.
5. Wire the failure/fallback chain (§13) so any EdenSign-side failure degrades to the existing Gemini path rather than failing the job.
6. Run the benchmark plan (§16) before considering any production traffic shift.

### Logging and observability

Per job/render, minimum recommended fields: `jobId`, `imageId`, `provider` (`gemini`/`edensign`), EdenSign `renderId`, EdenSign variation `id`, submission timestamp, completion timestamp, duration, requested `room_type`/`style` (both RealEnhance's and the mapped EdenSign value — log both sides of the mapping for auditability), poll attempt count, API status/error, retry count, which validator ran (`full`/`single`), validator result + reason, final artifact URL/path, and whether a fallback to Gemini occurred and why. This mirrors the logging density already present for the Gemini/Grok paths elsewhere in this codebase (structured `console.log`/`logger.info` calls with consistent field shapes) — no new logging *pattern* needs inventing, just new fields on the existing pattern.

---

## 19. Exact Proposed Branch Scope

**Recommended branch name:** `feature/stage2-edensign-experiment` — accurate and consistent with this repo's existing branch-naming conventions. **Not created.**

**Files/components that would change:**
`worker/src/pipeline/stage2.ts` (new provider branch), `worker/src/ai/runWithImageModelFallback.ts`/`modelResolver.ts` (EdenSign case or bypass), new `worker/src/providers/edensign/*` module (client, auth, polling), new room/style mapping module, new single-validator wrapper module, new env vars (§15), minimal `worker.ts` wiring for provider/validator-mode selection.

**Files/components that should NOT change:**
`server/src/routes/upload.ts`, `server/src/services/jobs.ts`, the outer worker dispatch loop, Stage 1A/1B pipeline code, all existing specialist validator modules (kept intact, just conditionally not invoked on the experimental path), database schema, deployment configuration, and — critically — the default (unset-env-var) behavior of every file touched, which must remain byte-for-byte identical to today's production path.

---

## 20. Final GO / NO-GO Recommendation

### 1. Feasibility
**CONDITIONAL.** Technically straightforward to integrate as an additive, flagged, fallback-protected experimental path. Not feasible as originally sketched if "feasible" means "safely reduce to one validator because EdenSign is structurally trustworthy by design" — that premise is not supported by the API contract (§7).

### 2. Biggest technical risk
EdenSign provides **no placement-constraining mask** — structural preservation during furniture addition is an unenforced vendor claim, not an API guarantee. Switching to EdenSign does not structurally solve the class of problem (walls/corners altered) that motivated this whole investigation; it only *might* reduce its frequency, unverified.

### 3. Biggest architectural advantage
Offloads Stage 2 (and potentially Stage 1B declutter, via `remove_furniture`) generation-model maintenance — prompt engineering, retry/escalation logic, provider contract wrangling — to a vendor specialized in exactly this task, reducing RealEnhance's own AI-orchestration surface area.

### 4. Biggest unknown
Real EdenSign API pricing (Enterprise/custom only, no published rate) — the cost comparison in §12 could not be completed, and this is likely the fastest thing to resolve (one sales conversation) before further engineering investment.

### 5. Recommended implementation architecture
See §8 diagram — provider selected via `STAGE2_RENDER_PROVIDER`, poll-based (no new queue), single **semantic** validator (not cheap/structural-only), explicit fallback to the existing Gemini path on any EdenSign or validator failure.

### 6. Recommended branch name
`feature/stage2-edensign-experiment` — see §19. **Not created.**

### 7. Files/components that would change
See §19.

### 8. Files/components that should NOT change
See §19.

### 9. Validator recommendation
One validator, but a **semantic** one, and it doesn't need to be built from scratch: reuse `runGeminiStructuralReviewPro` (`worker/src/pipeline/stage2.ts:206` on `main`) directly, unchanged, called against (Stage 1A/1B baseline, downloaded EdenSign output). §4's inventory shows this function — plus the Unified Validator's Gemini pass — is already the *only* real blocking authority in `main`'s current "full gauntlet," with the four specialists and every local heuristic reduced to advisory telemetry. Bypass the specialist battery for this experiment; do not build a new deterministic/pixel-diff check (unlike the Vertex inpainting proposal, EdenSign has no mask to make that check meaningful — see §7). Full reasoning in §9.

### 10. Go / No-Go
**GO — AFTER API CONFIRMATION.** Specifically blocking, before writing implementation code: (a) real Enterprise API pricing, (b) documented or confirmed rate limits, (c) direct confirmation from EdenSign that no placement/inpainting mask exists (close the residual `[UNKNOWN]` from §7), (d) image retention and training-data-usage policy, (e) output URL signing/expiry behavior. None of these are blocking for *standing up the flagged, fallback-protected branch and beginning the benchmark plan (§16) in parallel* with those vendor conversations — but they are blocking for any production rollout decision.
