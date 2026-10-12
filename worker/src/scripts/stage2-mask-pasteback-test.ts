// Test harness for Stage 2 "stage, trace, paste back". The shared logic lives
// in pipeline/stage2Masked/core.ts (also used by the app); this script adds
// test-only modes, offline replays (FROM_RUN, PAIR_MODE) and comparison sheets.
//
// Per image:
//   1. Stage: the normal Stage 2 generation (runStage2GenerationAttempt) at 2K,
//      one attempt, no validators. Or reuse an existing staged result.
//   2. Trace: Gemini is shown the empty photo and its staged version (same
//      camera position) and returns a black/white mask of the furniture it
//      added. Ported from feature/vertex-secondary-inpainting-continuity's
//      "original extractor" — the approach that produced clean bed/rug
//      outlines there: two passes run side by side (primary furniture, then
//      secondary pieces/decor), temperature 0, merged, tiny specks removed.
//   3. Layered merge, starting from the original photo:
//      - floor furniture (and anything sitting on it): staged pixels, thin edge;
//      - wall art (own trace pass): kept only on plain wall with the wall
//        around it unchanged, otherwise dropped;
//      - shadows around/below furniture: only the staged DARKENING is applied
//        to the original, and only where it looks like a real shadow;
//      - everything else stays original, so window removals, filled openings
//        and added light fittings cannot survive. The staged image's overall
//        brightness/colour is matched to the original first.
//   Framing check: paste-back only works if Gemini kept the room's shape. If
//   it reframed or reshaped the room, the photo is flagged for re-staging.
//
// Gemini settings (GEMINI_API_KEY etc.) are read from worker/.env automatically.
//
// Run from the worker folder:
//   npx tsx src/scripts/stage2-mask-pasteback-test.ts
//   REUSE_STAGED=1 npx tsx src/scripts/stage2-mask-pasteback-test.ts   (reuse Test Images/Stage2_2K_Comparison)
//   ONLY=Bedroom12 npx tsx src/scripts/stage2-mask-pasteback-test.ts
//   PAIR_MODE=1 npx tsx src/scripts/stage2-mask-pasteback-test.ts "baseline.jpg:bedroom|failed_staged.jpg"
//     (no staging: traces the furniture in the failed image and pastes it onto the baseline)
//   MERGE_MODE=all  compares original-first, hybrid and surface side by side (or: surface, hybrid, staged_first, both)
//   MERGE_MODE=both  (or staged_first) also builds the staged-first result: start from the staged image, revert room changes
//   DEBUG_LAYERS_DIR=/some/folder  saves the merge's decision maps (solid, core, zone, take, factor) there
//   FROM_RUN=2026-10-11T05-08-04-943Z npx tsx src/scripts/stage2-mask-pasteback-test.ts   (rebuild from saved traces, free)
//   npx tsx src/scripts/stage2-mask-pasteback-test.ts "C:/photos/lounge.jpg:living_room"
//   npx tsx src/scripts/stage2-mask-pasteback-test.ts "photo.jpg:bedroom|old_failed_attempt.webp"
//     (anything after "|" is an earlier failed result, shown first in the comparison sheet)
//
// Output: Test Images/Stage2_MaskPasteback/<run timestamp>/

import path from "path";
import fs from "fs";
import sharp from "sharp";
import { generateContentViaRest } from "../ai/geminiRestClient";

// The worker package does not depend on `dotenv`. Load worker/.env with the
// same minimal parser as measure-stage1a-pregen.ts so GEMINI_API_KEY (and the
// rest of the worker's Gemini settings) are picked up. Values already set in
// the shell win over the file.
function loadDotEnvIfPresent(envPath: string) {
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnvIfPresent(path.resolve(__dirname, "../../.env"));

const ROOT = path.resolve(__dirname, "../../..");
const T = path.join(ROOT, "Test Images");
// OUT_DIR (optional): results folder, relative to Test Images. A timestamped
// subfolder is always created inside it.
const OUT = path.join(
  process.env.OUT_DIR ? path.resolve(T, process.env.OUT_DIR) : path.join(T, "Stage2_MaskPasteback"),
  new Date().toISOString().replace(/[:.]/g, "-")
);
const PREVIOUS_STAGED_DIR = path.join(T, "Stage2_2K_Comparison");

// Same set as stage2-2k-compare.ts so results can be compared side by side.
const DEFAULT_IMAGES: Array<{ name: string; file: string; roomType: string }> = [
  { name: "Living07", file: "Living (Baseline)/Living 07.jpg", roomType: "living_room" },
  { name: "Living10", file: "Living (Baseline)/Living 10.jpg", roomType: "living_room" },
  { name: "Diningroom01", file: "Living (Baseline)/Diningroom 01.webp", roomType: "dining_room" },
  { name: "Validator_2327860184", file: "Validator Testing Images/2327860184.jpg", roomType: "living_room" },
  { name: "Bedroom14", file: "Validator Testing Images/Bedroom 14.jpg", roomType: "bedroom" },
  { name: "Bedroom12", file: "Validator Testing Images/job_59ac76ce_Bedroom_12_UPLOAD.jpg", roomType: "bedroom" },
];

const STAGE_MODEL = process.env.STAGE_MODEL || "gemini-3.1-flash-image";
const STAGING_STYLE = process.env.STAGING_STYLE || "nz_standard";
const REUSE_STAGED = process.env.REUSE_STAGED === "1";
// PAIR_MODE=1: no staging call. The image after "|" in each argument (an
// already-generated, typically failed, staged result) is used as the staged
// image; only its furniture is traced and pasted onto the baseline. This shows
// whether paste-back would have prevented that failure.
const PAIR_MODE = process.env.PAIR_MODE === "1";
// Rebuild from an earlier run's saved staged image and raw traces — no Gemini
// calls, no cost. Folder name under Test Images/Stage2_MaskPasteback, or a full path.
const FROM_RUN = process.env.FROM_RUN
  ? path.resolve(path.join(T, "Stage2_MaskPasteback"), process.env.FROM_RUN)
  : null;
// MERGE_MODE:
//   original_first (default) — start from the original photo, add furniture,
//     art and shadows from the staged image.
//   staged_first — start from the staged image (natural shadows/lighting) and
//     revert to the original anywhere the room itself changed.
//   both — original-first and staged-first side by side.
//   hybrid — original-first for the room, but Gemini's own pixels (natural
//     shadows/contact shading) around the furniture wherever only shading
//     differs there.
//   surface — decide by whole surfaces using a structure map (one extra
//     Gemini call on the empty room): the whole FLOOR (with rugs, shadows,
//     contact shading) plus furniture/kept art come from the staged image;
//     walls, ceiling, openings and fixtures come entirely from the original.
//     Cuts follow the room's own lines (snapped to the skirting edge).
//   all — original-first, hybrid and surface side by side.
//   harmonise — three phases: (1) furniture traced TIGHTLY (no shadows) and
//     pasted onto the original = a structurally safe image with no shadows;
//     (2) Gemini is asked only to add shadows / blend the lighting of that
//     image; (3) Gemini's result is NEVER published directly — it is only used
//     as a donor for soft darkening near the furniture and for the furniture's
//     lighting. Walls, windows, doors and fixtures always stay the original's.
const MERGE_MODE = (process.env.MERGE_MODE || "original_first").toLowerCase();
const HARMONISE = MERGE_MODE === "harmonise";

// The Stage 2 model is read once when the Stage 2 code first loads, so these
// must be set before anything imports ../ai/gemini or ../pipeline/stage2.
process.env.USE_GEMINI_STAGE2 = "1";
process.env.REALENHANCE_MODEL_STAGE2_PRIMARY = STAGE_MODEL;
process.env.REALENHANCE_STAGE2_IMAGE_SIZE = process.env.REALENHANCE_STAGE2_IMAGE_SIZE || "2K";

// Shared code (also used by the app). Loaded with require AFTER worker/.env
// is read above, so its settings see those values — an import would be
// hoisted and run first.
type DoorOpening = import("../pipeline/stage2Masked/core").DoorOpening;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  APPLIANCE_PASS,
  ART_MAX_BUSY_PATCH,
  ART_MAX_EDGE_PCT,
  ART_MAX_RING_DIFF,
  ART_MAX_WALL_STD,
  BLEND_MAX_REPAIR_PCT,
  CHANGED_TILE_DIFF,
  CHANGE_THRESHOLD,
  CORE_ERODE_PCT,
  DOOR_APPROACH_CHANGED,
  DOOR_CHECK,
  DOOR_CHECK_MODELS,
  DOOR_CHECK_MODEL_SET,
  DOOR_MIN_CLEAR,
  FEATHER_PX,
  HARMONISE_IMAGE_SIZE,
  HARMONISE_MODEL,
  HARM_MAX_SHADOW,
  HARM_ZONE_DOWN_PCT,
  HARM_ZONE_GROW_PCT,
  MAX_RESTAGES,
  OUTPUT_PRICE_PER_M,
  REFRAMED_MEDIAN_DIFF,
  SOLID_GROW_PCT,
  STRUCTURE_LABELS,
  STRUCTURE_PALETTE,
  TRACE_APPLIANCES,
  TRACE_ARTWORK,
  TRACE_IMAGE_SIZE,
  TRACE_MODEL,
  TRACE_PASSES,
  TRACE_REFLECTIONS,
  ZONE_DOWN_PCT,
  ZONE_GROW_PCT,
  approxOutputCost,
  askDoorAccess,
  binarizeTraceResponse,
  buildAppliancePrompt,
  buildApplianceSpacePrompt,
  buildDoorAccessPrompt,
  buildHarmonisePrompt,
  buildMirrorPrompt,
  buildReflectionPrompt,
  buildStructurePrompt,
  buildTracePrompt,
  callGeminiImage,
  callJsonModel,
  checkBlend,
  checkFraming,
  checkStructureRetained,
  classifyStructure,
  compositeHarmonise,
  compositeLayers,
  compositeStagedFirst,
  compositeSurface,
  contactSheet,
  dilate,
  doorwayAppearsBlocked,
  erode,
  evaluateDoorAccess,
  evaluateReflections,
  evaluateWallArt,
  fillChangedGaps,
  fillEnclosedHoles,
  fillFurnitureColumns,
  findDoors,
  growDown,
  imagePart,
  invert,
  labelComponents,
  layersOverlay,
  maskOverlay,
  maskToPng,
  measureOutsideDrift,
  mimeFor,
  ratioOf,
  refineArtRegion,
  removeSmallComponents,
  removeSunPatches,
  snapFloorTop,
  structureOverlay,
  tracePassesFor,
  undoneOverlay,
} = require("../pipeline/stage2Masked/core") as typeof import("../pipeline/stage2Masked/core");
type MaskedContext = import("../pipeline/stage2Masked/pipeline").MaskedContext;
const { traceLayers, harmonise, finalDoorCheck } = require("../pipeline/stage2Masked/pipeline") as typeof import("../pipeline/stage2Masked/pipeline");

// ── Main ─────────────────────────────────────────────────────────────────────

function resolveImages() {
  const args = process.argv.slice(2);
  if (args.length === 0) return DEFAULT_IMAGES.map((img) => ({ ...img, file: path.join(T, img.file) }));
  // "path/to/photo.jpg:room_type" (room type defaults to living_room).
  // "path/to/photo.jpg:room_type|path/to/old_failed_attempt.webp" — room type
  // defaults to living_room; the old attempt is optional.
  return args.map((arg) => {
    const [photoPart, previousPart] = arg.split("|");
    const match = photoPart.match(/^(.*?)(?::([a-z_]+))?$/);
    const file = path.resolve(match?.[1] || photoPart);
    const previousFile = previousPart ? path.resolve(previousPart.trim()) : undefined;
    return { name: path.parse(file).name.replace(/[^A-Za-z0-9_-]+/g, "_"), file, roomType: match?.[2] || "living_room", previousFile };
  });
}

async function stageImage(
  img: { name: string; file: string; roomType: string; previousFile?: string },
  dir: string,
  correctionHints: string[] = [],
  attempt = 1
): Promise<{ staged: Buffer; source: string }> {
  if (PAIR_MODE) {
    if (!img.previousFile || !fs.existsSync(img.previousFile)) {
      throw new Error(`PAIR_MODE: no staged image given after "|" (or file missing): ${img.previousFile || "none"}`);
    }
    return { staged: fs.readFileSync(img.previousFile), source: `pair image ${path.basename(img.previousFile)} (no staging call)` };
  }
  if (FROM_RUN) {
    const previous = path.join(FROM_RUN, img.name, "2_staged_raw.webp");
    if (!fs.existsSync(previous)) throw new Error(`FROM_RUN: no staged image at ${previous}`);
    return { staged: fs.readFileSync(previous), source: `from run ${path.basename(FROM_RUN)}` };
  }
  if (REUSE_STAGED && attempt === 1) {
    const previous = path.join(PREVIOUS_STAGED_DIR, `${img.name}__${STAGE_MODEL}.webp`);
    if (fs.existsSync(previous)) return { staged: fs.readFileSync(previous), source: `reused ${path.relative(T, previous)}` };
    console.warn(`[${img.name}] no previous staged result at ${previous} — staging now`);
  }
  const { runStage2GenerationAttempt } = await import("../pipeline/stage2");
  const input = path.join(dir, `stage2_input${path.extname(img.file)}`);
  fs.copyFileSync(img.file, input);
  const outputPath = path.join(dir, "2_staged_raw.webp");
  await runStage2GenerationAttempt(input, {
    roomType: img.roomType, sceneType: "interior", promptMode: "full", sourceStage: "1A",
    stagingStyle: STAGING_STYLE, jobId: `pasteback_${img.name}`, imageId: img.name, outputPath, attempt,
    retryCorrectionHints: correctionHints.length ? correctionHints : null,
  });
  // STAGE2_PROMPT_VARIANT=grok/grok_skill (from worker/.env) sends staging to
  // Grok's image-edit API instead of Gemini, exactly as in production.
  const variant = String(process.env.STAGE2_PROMPT_VARIANT || "").trim();
  const stagedWith = variant === "grok" || variant === "grok_skill" ? `grok (${process.env.GROK_IMAGE_MODEL || "grok-imagine-image-quality"})` : STAGE_MODEL;
  return { staged: fs.readFileSync(outputPath), source: `staged now (${stagedWith}${variant ? `, STAGE2_PROMPT_VARIANT=${variant}` : ""}${attempt > 1 ? `, attempt ${attempt}` : ""})` };
}

async function runOne(
  img: { name: string; file: string; roomType: string; previousFile?: string },
  // Re-stage attempts (door blocked) get their own folder and compare sheet;
  // the doors found on the first attempt are reused.
  opts: { attempt: number; hints: string[]; doors?: DoorOpening[] | null } = { attempt: 1, hints: [] }
) {
  const t0 = Date.now();
  const runName = opts.attempt > 1 ? `${img.name}_attempt${opts.attempt}` : img.name;
  const dir = path.join(OUT, runName);
  fs.mkdirSync(dir, { recursive: true });
  const original = fs.readFileSync(img.file);
  const meta = await sharp(original).metadata();
  const w = meta.width || 0, h = meta.height || 0;
  const { closestGeminiAspectRatio } = await import("../ai/gemini");
  const aspectRatio = closestGeminiAspectRatio(w, h);
  fs.writeFileSync(path.join(dir, `1_original${path.extname(img.file)}`), original);
  const row: any = { image: runName, roomType: img.roomType, input: `${w}x${h}`, aspectRatio, ...(opts.attempt > 1 ? { attempt: opts.attempt, restageHints: opts.hints } : {}) };
  let staged: Buffer | null = null, traced: Buffer | null = null, undone: Buffer | null = null, final: Buffer | null = null;
  let stagedFirstFinal: Buffer | null = null, stagedFirstReverted: Buffer | null = null, hybridFinal: Buffer | null = null;
  let surfaceFinal: Buffer | null = null, structureView: Buffer | null = null;
  let safeFinal: Buffer | null = null, harmRaw: Buffer | null = null, harmFinal: Buffer | null = null;
  let checkedBlend: Buffer | null = null, checkedBlendView: Buffer | null = null;

  try {
    console.log(`[${img.name}] 1/3 stage`);
    // Doors of the real room, looked up while staging runs (the app gets these
    // free from its structural baseline). Used by the final door check.
    const doorsPromise: Promise<DoorOpening[] | null> =
      !DOOR_CHECK
        ? Promise.resolve(null)
        : opts.doors !== undefined
        ? Promise.resolve(opts.doors)
        : FROM_RUN
        ? Promise.resolve(fs.existsSync(path.join(FROM_RUN, img.name, "0_doors.json")) ? JSON.parse(fs.readFileSync(path.join(FROM_RUN, img.name, "0_doors.json"), "utf8")) : null)
        : findDoors(img.file, img.roomType, img.name).catch((e) => {
            console.warn(`[${img.name}] door lookup failed — skipping the door check: ${String(e?.message || e).slice(0, 200)}`);
            return null;
          });
    const stageRes = await stageImage(img, dir, opts.hints, opts.attempt);
    const doors = (await doorsPromise)?.filter((d) => d.type === "door" || d.type === "walkthrough") ?? null;
    if (doors) fs.writeFileSync(path.join(dir, "0_doors.json"), JSON.stringify(doors, null, 2));
    staged = stageRes.staged;
    row.staging = stageRes.source;
    if (!fs.existsSync(path.join(dir, "2_staged_raw.webp"))) fs.writeFileSync(path.join(dir, "2_staged_raw.webp"), staged);
    const stagedMeta = await sharp(staged).metadata();
    const stagedMime = stagedMeta.format === "jpeg" ? "image/jpeg" : stagedMeta.format === "png" ? "image/png" : "image/webp";
    row.stagedSize = `${stagedMeta.width}x${stagedMeta.height}`;

    console.log(`[${img.name}] 2/3 trace (${FROM_RUN ? "saved traces, no Gemini call" : `${TRACE_MODEL}, ${TRACE_IMAGE_SIZE}, ${tracePassesFor(img.roomType).length} passes`})`);
    // Structure map of the EMPTY room (surface merge only), in parallel with tracing.
    const wantSurface = MERGE_MODE === "surface" || MERGE_MODE === "all";
    const structurePromise: Promise<Buffer | null> = !wantSurface
      ? Promise.resolve(null)
      : FROM_RUN
      ? Promise.resolve(
          fs.existsSync(path.join(FROM_RUN, img.name, "3_structure_raw.png")) ? fs.readFileSync(path.join(FROM_RUN, img.name, "3_structure_raw.png")) : null
        )
      : callGeminiImage({
          model: TRACE_MODEL,
          parts: [{ text: buildStructurePrompt(img.roomType) }, imagePart(original, mimeFor(img.file))],
          imageSize: TRACE_IMAGE_SIZE,
          aspectRatio,
        })
          .then((res) => {
            row.structureCostUsd = approxOutputCost(res.usage);
            return res.image;
          })
          .catch((e) => {
            console.warn(`[${img.name}] structure map call failed: ${String(e?.message || e).slice(0, 200)}`);
            row.structureError = String(e?.message || e).slice(0, 300);
            return null;
          });
    // Shared with the app: pipeline/stage2Masked/pipeline.ts.
    const ctx: MaskedContext = {
      name: img.name,
      original,
      originalPath: img.file,
      originalMime: mimeFor(img.file),
      staged,
      roomType: img.roomType,
      aspectRatio,
      w,
      h,
      tight: HARMONISE,
      offline: Boolean(FROM_RUN),
      dir,
      io: {
        save: (name, data) => fs.writeFileSync(path.join(dir, name), data),
        load: FROM_RUN
          ? (name) => {
              const saved = path.join(FROM_RUN!, img.name, name);
              return fs.existsSync(saved) ? fs.readFileSync(saved) : null;
            }
          : undefined,
      },
      row,
    };
    const layers = await traceLayers(ctx);
    const { tightFloor, solid, zone, core, solidPng } = layers;
    traced = layers.traced;
    undone = layers.undone;

    console.log(`[${img.name}] 3/3 layered merge`);
    const zonePng = await maskToPng(zone, w, h);
    const pasted = await compositeLayers(original, staged, solidPng, await maskToPng(core, w, h), zonePng, w, h);
    final = pasted.buffer;
    fs.writeFileSync(path.join(dir, "5_final_pasteback.webp"), final);
    row.finalSize = `${pasted.width}x${pasted.height}`;
    row.colourGains = pasted.colourGains;
    row.shadowPctOfZone = pasted.shadowPctOfZone;
    row.edgeBandStagedPct = pasted.edgeBandStagedPct;
    if (wantSurface) {
      const structureRaw = await structurePromise;
      if (!structureRaw) {
        console.warn(`[${img.name}] no structure map available — skipping the surface merge`);
      } else {
        fs.writeFileSync(path.join(dir, "3_structure_raw.png"), structureRaw);
        const labels = await classifyStructure(structureRaw, w, h);
        let floorSurface = new Uint8Array(w * h);
        for (let i = 0; i < labels.length; i++) floorSurface[i] = labels[i] === STRUCTURE_LABELS.floor ? 1 : 0;
        const rClose = Math.max(1, Math.round(w * 0.003));
        floorSurface = erode(dilate(floorSurface, w, h, rClose), w, h, rClose);
        floorSurface = removeSmallComponents(floorSurface, w, h, Math.round(w * h * 0.002));
        const snap = await snapFloorTop(floorSurface, original, w, h);
        floorSurface = snap.floor;
        for (let i = 0; i < labels.length; i++) {
          if (labels[i] === STRUCTURE_LABELS.floor && !floorSurface[i]) labels[i] = STRUCTURE_LABELS.wall;
          else if (floorSurface[i]) labels[i] = STRUCTURE_LABELS.floor;
        }
        structureView = await structureOverlay(original, labels, w, h);
        fs.writeFileSync(path.join(dir, "3_structure_overlay.jpg"), structureView);
        const counts = [0, 0, 0, 0, 0, 0];
        for (let i = 0; i < labels.length; i++) counts[labels[i]]++;
        const pct = (n: number) => Number(((n / labels.length) * 100).toFixed(1));
        const sf = await compositeSurface(original, staged, floorSurface, solid, w, h);
        surfaceFinal = sf.buffer;
        fs.writeFileSync(path.join(dir, "8_final_surface.webp"), sf.buffer);
        row.surface = {
          structurePct: { floor: pct(counts[1]), wall: pct(counts[2]), ceiling: pct(counts[3]), opening: pct(counts[4]), fixture: pct(counts[5]), unknown: pct(counts[0]) },
          floorEdgeSnappedColumnsPct: Number(((snap.snappedColumns / w) * 100).toFixed(1)),
          colourGains: sf.colourGains,
          floorCheck: sf.floorCheck,
        };
        if (sf.floorCheck.floorChanged) {
          console.warn(`[${img.name}] Gemini changed the floor itself (colour diff ${sf.floorCheck.colourDiff}, chroma diff ${sf.floorCheck.chromaDiff}) — this photo would need re-staging`);
        }
      }
    }
    if (HARMONISE && tightFloor) {
      const hm = await harmonise(ctx, layers);
      safeFinal = hm.safeFinal;
      harmRaw = hm.harmRaw;
      harmFinal = hm.harmFinal;
      checkedBlend = hm.checkedBlend;
      checkedBlendView = hm.checkedBlendView;
    }
    if (MERGE_MODE === "hybrid" || MERGE_MODE === "all") {
      const hy = await compositeLayers(original, staged, solidPng, await maskToPng(core, w, h), zonePng, w, h, true);
      hybridFinal = hy.buffer;
      fs.writeFileSync(path.join(dir, "7_final_hybrid.webp"), hy.buffer);
      row.hybrid = { stagedAroundFurniturePctOfImage: hy.hybridStagedPctOfImage };
    }
    if (MERGE_MODE === "staged_first" || MERGE_MODE === "both") {
      const sf = await compositeStagedFirst(original, staged, solidPng, w, h);
      stagedFirstFinal = sf.buffer;
      stagedFirstReverted = sf.revertedView;
      fs.writeFileSync(path.join(dir, "6_final_staged_first.webp"), sf.buffer);
      fs.writeFileSync(path.join(dir, "6_staged_first_reverted.jpg"), sf.revertedView);
      row.stagedFirst = { revertedPctOfImage: sf.revertedPct };
    }
    // Final check: can people still walk through the real doorways?
    await finalDoorCheck(ctx, checkedBlend || harmFinal || final, doors);
    // A big average change across the untouched room usually means Gemini
    // re-lit or slightly reframed the photo, which can leave visible seams.
    if (row.stagedChangesOutsideMask.meanAbsoluteDelta > 8) {
      row.checkSeams = true;
      console.warn(`[${img.name}] Gemini changed the rest of the room a lot (avg ${row.stagedChangesOutsideMask.meanAbsoluteDelta}) — check panel 5 for seams`);
    }
    row.ok = true;
  } catch (e: any) {
    row.ok = false;
    row.error = String(e?.message || e).slice(0, 400);
  }

  let previous: Buffer | null = null;
  if (img.previousFile && !PAIR_MODE) {
    if (fs.existsSync(img.previousFile)) {
      previous = fs.readFileSync(img.previousFile);
      fs.writeFileSync(path.join(dir, `0_old_failed_attempt${path.extname(img.previousFile)}`), previous);
      row.oldFailedAttempt = path.relative(ROOT, img.previousFile);
    } else {
      console.warn(`[${img.name}] old attempt not found: ${img.previousFile}`);
    }
  }
  const reshaped = row.framingCheck?.framingChanged ? " - RESHAPED, re-stage" : "";
  const panels =
    HARMONISE
      ? [
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Safe composite (no shadows)", image: safeFinal },
          { label: "4. Gemini blend (raw, unchecked)", image: harmRaw },
          { label: "5. App-built final" + reshaped + (row.harmonise && !row.harmonise.blendUsed ? " - NO SHADOWS" : ""), image: harmFinal },
          { label: `6. Checked blend: repaired patches (red)${row.checkedBlend ? ` ${row.checkedBlend.repairPct}%` : ""}`, image: checkedBlendView },
          { label: "7. Checked blend final" + reshaped + (row.checkedBlend?.usedAppBuiltInstead ? " - TOO MANY CHANGES, used 5" : "") + (row.doorAccess?.blocked ? " - DOOR BLOCKED" : ""), image: checkedBlend },
        ]
      : MERGE_MODE === "all"
      ? [
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Structure: floor/wall/ceiling/opening/fixture", image: structureView },
          { label: "4. Original-first" + reshaped, image: final },
          { label: "5. Hybrid" + reshaped, image: hybridFinal },
          { label: "6. Surface" + reshaped + (row.surface?.floorCheck?.floorChanged ? " - FLOOR CHANGED" : ""), image: surfaceFinal },
        ]
      : MERGE_MODE === "surface"
      ? [
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Structure: floor/wall/ceiling/opening/fixture", image: structureView },
          { label: "4. Furniture red / art kept blue / dropped orange", image: traced },
          { label: "5. Surface result" + reshaped + (row.surface?.floorCheck?.floorChanged ? " - FLOOR CHANGED" : ""), image: surfaceFinal },
        ]
      : MERGE_MODE === "hybrid"
      ? [
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Furniture red / art blue / reflections purple / dropped orange", image: traced },
          { label: "4. Hybrid result" + reshaped, image: hybridFinal },
        ]
      : MERGE_MODE === "both"
      ? [
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Furniture red / art blue / reflections purple / dropped orange", image: traced },
          { label: "4. Original-first result" + reshaped, image: final },
          { label: "5. Staged-first: reverted areas (red)", image: stagedFirstReverted },
          { label: "6. Staged-first result" + reshaped, image: stagedFirstFinal },
        ]
      : [
          ...(previous ? [{ label: "0. Old failed attempt", image: previous }] : []),
          { label: "1. Original", image: original },
          { label: PAIR_MODE ? "2. Failed image (input)" : "2. Gemini staged (raw)", image: staged },
          { label: "3. Furniture red / art blue / reflections purple / dropped orange", image: traced },
          ...(MERGE_MODE === "staged_first"
            ? [
                { label: "4. Staged-first: reverted areas (red)", image: stagedFirstReverted },
                { label: "5. Staged-first result" + reshaped, image: stagedFirstFinal },
              ]
            : [
                { label: "4. Room changes removed (red)", image: undone },
                { label: row.framingCheck?.framingChanged ? "5. Final - ROOM RESHAPED, re-stage" : "5. Final (pasted back)", image: final },
              ]),
        ];
  const sheet = await contactSheet(panels, w, h);
  fs.writeFileSync(path.join(OUT, `${runName}__compare.jpg`), sheet);
  row.seconds = (Date.now() - t0) / 1000;
  console.log("RESULT", JSON.stringify(row));
  return row;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.env.ONLY;
  const rows: any[] = [];
  for (const img of resolveImages()) {
    if (only && !img.name.includes(only)) continue;
    if (!fs.existsSync(img.file)) {
      console.warn(`Skipping ${img.name}: file not found (${img.file})`);
      continue;
    }
    // A photo needs re-staging when the final image has a blocked doorway or
    // Gemini reshaped the room. One re-stage (MAX_RESTAGES) for any reason; if
    // the re-staged result also fails, the photo fails and the app delivers
    // its last good output — the Stage 2 input (Stage 1A, or 1B if decluttered).
    let opts: { attempt: number; hints: string[]; doors?: DoorOpening[] | null } = { attempt: 1, hints: [] };
    for (;;) {
      const row = await runOne(img, opts);
      rows.push(row);
      const reasons = [
        ...(row.doorAccess?.blocked ? ["doorway blocked"] : []),
        ...(row.framingCheck?.framingChanged ? ["room reshaped"] : []),
        ...(row.ok === false ? ["processing error"] : []),
      ];
      if (reasons.length === 0) {
        row.outcome = "publish";
        break;
      }
      if (PAIR_MODE || FROM_RUN) {
        row.outcome = `needs re-stage (${reasons.join(", ")}) — not possible in pair/offline mode`;
        console.warn(`[${row.image}] ${row.outcome}`);
        break;
      }
      if (opts.attempt > MAX_RESTAGES) {
        row.outcome = `FAILED after re-stage (${reasons.join(", ")}) — the app delivers its last good output (the Stage 2 input)`;
        const dir = path.join(OUT, row.image);
        if (fs.existsSync(dir)) fs.copyFileSync(img.file, path.join(dir, `13_fallback_output${path.extname(img.file)}`));
        console.warn(`[${row.image}] ${row.outcome}`);
        break;
      }
      row.outcome = `re-stage (${reasons.join(", ")})`;
      console.warn(`[${row.image}] re-staging (attempt ${opts.attempt + 1}): ${reasons.join(", ")}`);
      opts = { attempt: opts.attempt + 1, hints: row.doorAccess?.blocked ? row.doorAccess.restageHints || [] : [], doors: row.doorAccess?.doors ?? null };
    }
  }
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(rows, null, 2));
  console.log(`\nDone. ${rows.filter((r) => r.ok).length}/${rows.length} succeeded.`);
  console.log(`Open the *__compare.jpg files in: ${OUT}`);
}

if (require.main === module) {
  // Exit explicitly: the worker modules this loads (Stage 2, Gemini helpers)
  // keep background connections/timers open, so Node would otherwise never
  // exit after the results are written.
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

export { fillChangedGaps, buildAppliancePrompt, buildApplianceSpacePrompt, doorwayAppearsBlocked, evaluateDoorAccess, buildDoorAccessPrompt, buildMirrorPrompt, evaluateReflections, buildReflectionPrompt, checkBlend, removeSunPatches, checkStructureRetained, fillEnclosedHoles, compositeHarmonise, buildHarmonisePrompt, classifyStructure, snapFloorTop, compositeSurface, structureOverlay, STRUCTURE_LABELS, compositeStagedFirst, refineArtRegion, evaluateWallArt, compositeLayers, layersOverlay, labelComponents, fillFurnitureColumns, checkFraming, binarizeTraceResponse, measureOutsideDrift, maskToPng, maskOverlay, undoneOverlay, contactSheet, removeSmallComponents, dilate, growDown, ratioOf };
