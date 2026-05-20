/**
 * Canonical regression tests for the Vertex Imagen 3 edit `:predict` wire payload.
 *
 * KEY ARCHITECTURAL FACT:
 * The @google/genai SDK's RawReferenceImage / MaskReferenceImage TypeScript types
 * are USER-FACING ABSTRACTIONS, not wire-format shapes. Had the SDK supported
 * editing, it would transform them into type-specific wrappers before the REST call.
 * We bypass SDK serialization via raw apiClient.request(), so we must produce the
 * proto3 JSON wire format ourselves.
 *
 * WRONG (TypeScript SDK shape accidentally sent as wire format):
 *   referenceImages[0] = { referenceImage: {...}, referenceType: "REFERENCE_TYPE_RAW" }
 *   referenceImages[1] = { referenceImage: {...}, config: { maskMode: "..." }, referenceType: "REFERENCE_TYPE_MASK" }
 *
 * CORRECT (proto3 JSON wire format — what this file asserts):
 *   referenceImages[0] = {
 *     referenceId: 1, referenceType: "REFERENCE_TYPE_RAW",
 *     rawReferenceImage: { referenceImage: { bytesBase64Encoded: "...", mimeType: "..." } }
 *   }
 *   referenceImages[1] = {
 *     referenceId: 2, referenceType: "REFERENCE_TYPE_MASK",
 *     maskReferenceImage: { maskMode: "MASK_MODE_USER_PROVIDED", referenceImage: { bytesBase64Encoded: "...", mimeType: "..." } }
 *   }
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVertexEditPredictPayload,
  type VertexWireImagePayload,
} from "../imageRendererProvider.js";

const SOURCE_B64 = Buffer.from("fake-source-jpeg-bytes").toString("base64");
const MASK_B64 = Buffer.from("fake-mask-png-bytes").toString("base64");

const sourcePayload: VertexWireImagePayload = {
  bytesBase64Encoded: SOURCE_B64,
  mimeType: "image/jpeg",
};
const maskPayload: VertexWireImagePayload = {
  bytesBase64Encoded: MASK_B64,
  mimeType: "image/png",
};

function buildPayload() {
  return buildVertexEditPredictPayload({
    prompt: "test prompt",
    sourcePayload,
    maskPayload,
    guidanceScale: 12,
  });
}

// ─── Structure ───────────────────────────────────────────────────────────────

test("instances[0] has exactly one prompt and two referenceImages", () => {
  const payload = buildPayload();
  assert.equal(payload.instances.length, 1);
  const instance = payload.instances[0]!;
  assert.equal(instance.prompt, "test prompt");
  assert.equal(instance.referenceImages.length, 2);
});

// ─── Source: rawReferenceImage wrapper ───────────────────────────────────────

test("source uses rawReferenceImage wrapper (proto3 wire format)", () => {
  const payload = buildPayload();
  const sourceEntry = payload.instances[0]!.referenceImages[0]! as Record<string, unknown>;

  assert.ok(
    "rawReferenceImage" in sourceEntry,
    "source must have rawReferenceImage wrapper — not a flat referenceImage at outer level"
  );
  assert.equal(
    (sourceEntry as any).referenceImage,
    undefined,
    "source must NOT have a legacy flat referenceImage at outer level"
  );
});

test("source rawReferenceImage.referenceImage carries bytesBase64Encoded (not imageBytes)", () => {
  const payload = buildPayload();
  const sourceEntry = payload.instances[0]!.referenceImages[0]! as any;
  const inner = sourceEntry.rawReferenceImage?.referenceImage;

  assert.ok(inner, "rawReferenceImage.referenceImage must exist");
  assert.equal(inner.bytesBase64Encoded, SOURCE_B64,
    "rawReferenceImage.referenceImage must carry bytesBase64Encoded");

  // Guard: must not carry the deprecated SDK field name
  assert.equal(inner.imageBytes, undefined,
    "imageBytes must never appear — Vertex returns 400 if it does");
});

test("source rawReferenceImage.referenceImage survives JSON serialization round-trip", () => {
  const serialised = JSON.parse(JSON.stringify(buildPayload()));
  const inner = serialised.instances[0].referenceImages[0].rawReferenceImage.referenceImage;
  assert.equal(inner.mimeType, "image/jpeg");
  assert.ok(typeof inner.bytesBase64Encoded === "string" && inner.bytesBase64Encoded.length > 0);
  assert.equal(inner.imageBytes, undefined);
});

test("source referenceType is REFERENCE_TYPE_RAW", () => {
  const payload = buildPayload();
  assert.equal(
    (payload.instances[0]!.referenceImages[0]! as any).referenceType,
    "REFERENCE_TYPE_RAW"
  );
});

test("source referenceId is numeric and survives JSON round-trip", () => {
  const payload = buildPayload();
  const entry = payload.instances[0]!.referenceImages[0]! as any;
  assert.ok(typeof entry.referenceId === "number",
    "source referenceId must be a number — Vertex returns 400 if absent");
  const serialised = JSON.parse(JSON.stringify(payload));
  assert.ok(typeof serialised.instances[0].referenceImages[0].referenceId === "number",
    "source referenceId must survive JSON round-trip");
});

// ─── Mask: maskReferenceImage wrapper ────────────────────────────────────────

test("mask uses maskReferenceImage wrapper (proto3 wire format)", () => {
  const payload = buildPayload();
  const maskEntry = payload.instances[0]!.referenceImages[1]! as Record<string, unknown>;

  assert.ok(
    "maskReferenceImage" in maskEntry,
    "mask must have maskReferenceImage wrapper — not a flat referenceImage + config at outer level"
  );
  assert.equal(
    (maskEntry as any).referenceImage,
    undefined,
    "mask must NOT have a legacy flat referenceImage at outer level"
  );
  assert.equal(
    (maskEntry as any).config,
    undefined,
    "mask must NOT have a legacy config object at outer level — maskMode must be inside maskReferenceImage"
  );
});

test("mask maskReferenceImage.maskMode is MASK_MODE_USER_PROVIDED", () => {
  const payload = buildPayload();
  const maskEntry = payload.instances[0]!.referenceImages[1]! as any;
  assert.equal(
    maskEntry.maskReferenceImage?.maskMode,
    "MASK_MODE_USER_PROVIDED",
    "maskMode must be directly inside maskReferenceImage, not in outer config"
  );
});

test("mask maskReferenceImage.referenceImage carries bytesBase64Encoded (not imageBytes)", () => {
  const payload = buildPayload();
  const maskEntry = payload.instances[0]!.referenceImages[1]! as any;
  const inner = maskEntry.maskReferenceImage?.referenceImage;

  assert.ok(inner, "maskReferenceImage.referenceImage must exist");
  assert.equal(inner.bytesBase64Encoded, MASK_B64,
    "maskReferenceImage.referenceImage must carry bytesBase64Encoded");
  assert.equal(inner.imageBytes, undefined,
    "imageBytes must never appear in mask image");
});

test("mask maskReferenceImage.referenceImage survives JSON serialization round-trip", () => {
  const serialised = JSON.parse(JSON.stringify(buildPayload()));
  const inner = serialised.instances[0].referenceImages[1].maskReferenceImage.referenceImage;
  assert.equal(inner.mimeType, "image/png");
  assert.ok(typeof inner.bytesBase64Encoded === "string" && inner.bytesBase64Encoded.length > 0);
  assert.equal(inner.imageBytes, undefined);
});

test("mask referenceType is REFERENCE_TYPE_MASK", () => {
  const payload = buildPayload();
  assert.equal(
    (payload.instances[0]!.referenceImages[1]! as any).referenceType,
    "REFERENCE_TYPE_MASK"
  );
});

test("mask referenceId is numeric, distinct from source, and survives JSON round-trip", () => {
  const payload = buildPayload();
  const sourceEntry = payload.instances[0]!.referenceImages[0]! as any;
  const maskEntry = payload.instances[0]!.referenceImages[1]! as any;
  assert.ok(typeof maskEntry.referenceId === "number",
    "mask referenceId must be a number — Vertex returns 400 if absent");
  assert.notEqual(maskEntry.referenceId, sourceEntry.referenceId,
    "source and mask must have distinct referenceId values");
  const serialised = JSON.parse(JSON.stringify(payload));
  assert.ok(typeof serialised.instances[0].referenceImages[1].referenceId === "number",
    "mask referenceId must survive JSON round-trip");
});

// ─── Parameters ──────────────────────────────────────────────────────────────

test("parameters contain required Imagen 3 edit fields", () => {
  const payload = buildPayload();
  const params = payload.parameters;
  assert.equal(params.editMode, "EDIT_MODE_INPAINT_INSERTION");
  assert.equal(params.sampleCount, 1);
  assert.equal(params.guidanceScale, 12);
  assert.equal(params.addWatermark, false);
  assert.equal(params.outputOptions.mimeType, "image/png");
});

test("parameters must NOT contain maskMode (belongs only inside maskReferenceImage)", () => {
  const serialised = JSON.parse(JSON.stringify(buildPayload()));
  assert.equal(
    (serialised.parameters as Record<string, unknown>).maskMode,
    undefined,
    "maskMode must not appear in parameters when using the referenceImages path — Vertex INVALID_ARGUMENT if duplicated"
  );
});

// ─── Legacy field leakage guards ─────────────────────────────────────────────

test("no legacy flat referenceImage at outer referenceImages entry level (source)", () => {
  const serialised = JSON.parse(JSON.stringify(buildPayload()));
  const sourceEntry = serialised.instances[0].referenceImages[0];
  assert.equal(sourceEntry.referenceImage, undefined,
    "outer-level referenceImage must not exist on source — image data belongs in rawReferenceImage.referenceImage");
});

test("no legacy flat referenceImage at outer referenceImages entry level (mask)", () => {
  const serialised = JSON.parse(JSON.stringify(buildPayload()));
  const maskEntry = serialised.instances[0].referenceImages[1];
  assert.equal(maskEntry.referenceImage, undefined,
    "outer-level referenceImage must not exist on mask — image data belongs in maskReferenceImage.referenceImage");
});

test("no legacy config object at outer referenceImages entry level (mask)", () => {
  const serialised = JSON.parse(JSON.stringify(buildPayload()));
  const maskEntry = serialised.instances[0].referenceImages[1];
  assert.equal(maskEntry.config, undefined,
    "outer-level config must not exist — maskMode belongs inside maskReferenceImage");
});

// ─── GCS path ────────────────────────────────────────────────────────────────

test("GCS uri source uses rawReferenceImage wrapper and no imageBytes", () => {
  const gcsSourcePayload: VertexWireImagePayload = {
    gcsUri: "gs://my-bucket/source.jpeg",
    mimeType: "image/jpeg",
  };
  const payload = buildVertexEditPredictPayload({
    prompt: "gcs test",
    sourcePayload: gcsSourcePayload,
    maskPayload,
    guidanceScale: 10,
  });
  const serialised = JSON.parse(JSON.stringify(payload));
  const sourceEntry = serialised.instances[0].referenceImages[0];
  assert.ok("rawReferenceImage" in sourceEntry, "GCS source must still use rawReferenceImage wrapper");
  assert.equal(sourceEntry.referenceImage, undefined, "no outer-level referenceImage for GCS source");
  const inner = sourceEntry.rawReferenceImage.referenceImage;
  assert.equal(inner.gcsUri, "gs://my-bucket/source.jpeg");
  assert.equal(inner.imageBytes, undefined);
  assert.equal(inner.bytesBase64Encoded, undefined);
});

