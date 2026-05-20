/**
 * Regression tests for the Vertex Imagen edit `:predict` wire payload contract.
 *
 * The SDK's `apiClient.request()` sends the body JSON string as-is — it does NOT
 * perform the `imageBytes -> bytesBase64Encoded` transformation that the typed SDK
 * helpers apply.  These tests assert that the functions we use to build the raw
 * JSON payload already emit the correct REST wire format field names.
 *
 * Guard: if `imageBytes` ever reappears in the serialised body Vertex returns 400
 * "Image should have either uri or image bytes".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVertexEditPredictPayload,
  type VertexWireImagePayload,
} from "../imageRendererProvider.js";

const SOURCE_B64 = Buffer.from("fake-source-png-bytes").toString("base64");
const MASK_B64 = Buffer.from("fake-mask-png-bytes").toString("base64");

const sourcePayload: VertexWireImagePayload = {
  bytesBase64Encoded: SOURCE_B64,
  mimeType: "image/png",
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

test("instances[0] has exactly one prompt and two referenceImages", () => {
  const payload = buildPayload();
  assert.equal(payload.instances.length, 1);
  const instance = payload.instances[0]!;
  assert.equal(instance.prompt, "test prompt");
  assert.equal(instance.referenceImages.length, 2);
});

test("source referenceImage uses bytesBase64Encoded (not imageBytes) in wire format", () => {
  const payload = buildPayload();
  const sourceRef = payload.instances[0]!.referenceImages[0]!;

  // The field the Vertex REST API accepts:
  assert.equal(sourceRef.referenceImage.bytesBase64Encoded, SOURCE_B64,
    "source image must carry bytesBase64Encoded for the Vertex REST wire format");

  // Guard: the SDK TypeScript field name must NOT appear in the serialised body
  const serialised = JSON.parse(JSON.stringify(payload));
  const wireSourceImage = serialised.instances[0].referenceImages[0].referenceImage;
  assert.equal(wireSourceImage.imageBytes, undefined,
    "imageBytes must not appear in the serialised Vertex payload — Vertex returns 400 if it does");
  assert.ok(typeof wireSourceImage.bytesBase64Encoded === "string",
    "bytesBase64Encoded must survive JSON serialization round-trip");
});

test("mask referenceImage uses bytesBase64Encoded (not imageBytes) in wire format", () => {
  const payload = buildPayload();
  const maskRef = payload.instances[0]!.referenceImages[1]!;

  assert.equal(maskRef.referenceImage.bytesBase64Encoded, MASK_B64,
    "mask image must carry bytesBase64Encoded for the Vertex REST wire format");

  const serialised = JSON.parse(JSON.stringify(payload));
  const wireMaskImage = serialised.instances[0].referenceImages[1].referenceImage;
  assert.equal(wireMaskImage.imageBytes, undefined,
    "imageBytes must not appear in the serialised Vertex mask payload");
  assert.ok(typeof wireMaskImage.bytesBase64Encoded === "string",
    "mask bytesBase64Encoded must survive JSON serialization round-trip");
});

test("source referenceType is REFERENCE_TYPE_RAW", () => {
  const payload = buildPayload();
  assert.equal(
    payload.instances[0]!.referenceImages[0]!.referenceType,
    "REFERENCE_TYPE_RAW"
  );
});

test("source referenceId is a number", () => {
  const payload = buildPayload();
  const sourceRef = payload.instances[0]!.referenceImages[0]!;
  assert.ok(typeof sourceRef.referenceId === "number",
    "source referenceId must be a number — Vertex returns 400 if it is absent");
  const serialised = JSON.parse(JSON.stringify(payload));
  assert.ok(typeof serialised.instances[0].referenceImages[0].referenceId === "number",
    "source referenceId must survive JSON serialization round-trip");
});

test("mask referenceId is a number and different from source", () => {
  const payload = buildPayload();
  const sourceRef = payload.instances[0]!.referenceImages[0]!;
  const maskRef = payload.instances[0]!.referenceImages[1]!;
  assert.ok(typeof maskRef.referenceId === "number",
    "mask referenceId must be a number — Vertex returns 400 if it is absent");
  assert.notEqual(maskRef.referenceId, sourceRef.referenceId,
    "source and mask must have distinct referenceId values");
  const serialised = JSON.parse(JSON.stringify(payload));
  assert.ok(typeof serialised.instances[0].referenceImages[1].referenceId === "number",
    "mask referenceId must survive JSON serialization round-trip");
});

test("mask referenceType is REFERENCE_TYPE_MASK with MASK_MODE_USER_PROVIDED config", () => {
  const payload = buildPayload();
  const maskRef = payload.instances[0]!.referenceImages[1]!;
  assert.equal(maskRef.referenceType, "REFERENCE_TYPE_MASK");
  assert.equal(maskRef.config?.maskMode, "MASK_MODE_USER_PROVIDED");
});

test("source reference carries no mask config", () => {
  const payload = buildPayload();
  const sourceRef = payload.instances[0]!.referenceImages[0]!;
  assert.equal(sourceRef.config, undefined,
    "source reference must not carry mask config");
});

test("parameters include required Imagen edit fields", () => {
  const payload = buildPayload();
  const params = payload.parameters;
  assert.equal(params.editMode, "EDIT_MODE_INPAINT_INSERTION");
  assert.equal(params.sampleCount, 1);
  assert.equal(params.addWatermark, false);
  assert.equal(params.outputOptions.mimeType, "image/png");
});

test("parameters must NOT contain maskMode (it belongs only in mask config)", () => {
  // For the referenceImages path (Imagen 3), maskMode lives in
  // referenceImages[1].config.maskMode, not in top-level parameters.
  // Duplicating it in parameters triggers a generic INVALID_ARGUMENT from Vertex.
  const payload = buildPayload();
  const serialised = JSON.parse(JSON.stringify(payload));
  assert.equal(
    (serialised.parameters as Record<string, unknown>).maskMode,
    undefined,
    "maskMode must not appear in parameters when using the referenceImages path"
  );
});

test("GCS uri source payload serialises without imageBytes", () => {
  const gcsSourcePayload: VertexWireImagePayload = {
    gcsUri: "gs://my-bucket/source.png",
    mimeType: "image/png",
  };
  const payload = buildVertexEditPredictPayload({
    prompt: "gcs test",
    sourcePayload: gcsSourcePayload,
    maskPayload,
    guidanceScale: 10,
  });
  const serialised = JSON.parse(JSON.stringify(payload));
  const wireSourceImage = serialised.instances[0].referenceImages[0].referenceImage;
  assert.equal(wireSourceImage.gcsUri, "gs://my-bucket/source.png");
  assert.equal(wireSourceImage.imageBytes, undefined);
  assert.equal(wireSourceImage.bytesBase64Encoded, undefined);
});
