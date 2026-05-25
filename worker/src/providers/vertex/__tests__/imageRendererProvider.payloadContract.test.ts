/**
 * Canonical regression tests for the verified Vertex Imagen 3 edit `:predict` wire payload.
 *
 * VERIFIED CONTRACT:
 * - `referenceImages[]` entries must carry image data under `referenceImage`
 * - mask configuration must live under `maskImageConfig`
 * - camelCase JSON field names are required on this synchronous endpoint
 * - legacy wrapper keys like `rawReferenceImage`, `maskReferenceImage`, and flat `image`
 *   must never reappear in the outbound payload
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVertexEditPredictPayload,
  buildVertexEditPredictPayloadFlat,
  buildVertexEditPredictPayloadForMode,
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
    renderProfile: {
      isolationMode: "CONTINUITY_STRICT_INSERTION",
      editMode: "EDIT_MODE_INPAINT_INSERTION",
      maskDilation: 0,
      outsideMaskMaxMae: 6,
      outsideMaskMaxChangedRatio: 0.035,
      outsideMaskChangeThreshold: 18,
    },
  });
}

function buildFlatPayload() {
  return buildVertexEditPredictPayloadFlat({
    prompt: "test prompt",
    sourcePayload,
    maskPayload,
    guidanceScale: 12,
    renderProfile: {
      isolationMode: "CONTINUITY_STRICT_INSERTION",
      editMode: "EDIT_MODE_INPAINT_INSERTION",
      maskDilation: 0,
      outsideMaskMaxMae: 6,
      outsideMaskMaxChangedRatio: 0.035,
      outsideMaskChangeThreshold: 18,
    },
  });
}

test("instances[0] has exactly one prompt and two referenceImages", () => {
  const payload = buildPayload();
  assert.equal(payload.instances.length, 1);
  const instance = payload.instances[0]!;
  assert.equal(instance.prompt, "test prompt");
  assert.equal(instance.referenceImages.length, 2);
});

test("mode-based builder defaults to the verified camelCase referenceImage schema", () => {
  const payload = buildVertexEditPredictPayloadForMode({
    prompt: "test prompt",
    sourcePayload,
    maskPayload,
    guidanceScale: 12,
    renderProfile: {
      isolationMode: "CONTINUITY_STRICT_INSERTION",
      editMode: "EDIT_MODE_INPAINT_INSERTION",
      maskDilation: 0,
      outsideMaskMaxMae: 6,
      outsideMaskMaxChangedRatio: 0.035,
      outsideMaskChangeThreshold: 18,
    },
    payloadSchemaMode: "wrapper",
  });

  assert.ok("referenceImage" in payload.instances[0]!.referenceImages[0]!);
  assert.ok("referenceImage" in payload.instances[0]!.referenceImages[1]!);
});

test("mode-based builder flat mode stays on the same verified schema", () => {
  const payload = buildVertexEditPredictPayloadForMode({
    prompt: "test prompt",
    sourcePayload,
    maskPayload,
    guidanceScale: 12,
    renderProfile: {
      isolationMode: "CONTINUITY_STRICT_INSERTION",
      editMode: "EDIT_MODE_INPAINT_INSERTION",
      maskDilation: 0,
      outsideMaskMaxMae: 6,
      outsideMaskMaxChangedRatio: 0.035,
      outsideMaskChangeThreshold: 18,
    },
    payloadSchemaMode: "flat",
  });

  assert.ok("referenceImage" in payload.instances[0]!.referenceImages[0]!);
  assert.ok("referenceImage" in payload.instances[0]!.referenceImages[1]!);
});

test("source uses nested referenceImage and never legacy image keys", () => {
  const payload = buildPayload();
  const sourceEntry = payload.instances[0]!.referenceImages[0]! as Record<string, unknown>;

  assert.equal(sourceEntry.referenceType, "REFERENCE_TYPE_RAW");
  assert.equal(sourceEntry.referenceId, 1);
  assert.ok("referenceImage" in sourceEntry);
  assert.equal((sourceEntry as any).image, undefined);
  assert.equal((sourceEntry as any).rawReferenceImage, undefined);
  assert.equal((sourceEntry as any).maskReferenceImage, undefined);
  assert.equal((sourceEntry as any).config, undefined);

  const image = (sourceEntry as any).referenceImage;
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.bytesBase64Encoded, SOURCE_B64);
  assert.equal(image.imageBytes, undefined);
  assert.equal(image.bytes_base64_encoded, undefined);
});

test("mask uses referenceImage plus maskImageConfig and never legacy wrapper keys", () => {
  const payload = buildPayload();
  const maskEntry = payload.instances[0]!.referenceImages[1]! as Record<string, unknown>;

  assert.equal(maskEntry.referenceType, "REFERENCE_TYPE_MASK");
  assert.equal(maskEntry.referenceId, 2);
  assert.ok("referenceImage" in maskEntry);
  assert.ok("maskImageConfig" in maskEntry);
  assert.equal((maskEntry as any).image, undefined);
  assert.equal((maskEntry as any).rawReferenceImage, undefined);
  assert.equal((maskEntry as any).maskReferenceImage, undefined);
  assert.equal((maskEntry as any).config, undefined);

  const image = (maskEntry as any).referenceImage;
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.bytesBase64Encoded, MASK_B64);
  assert.equal(image.imageBytes, undefined);
  assert.equal(image.bytes_base64_encoded, undefined);

  const maskImageConfig = (maskEntry as any).maskImageConfig;
  assert.equal(maskImageConfig.maskMode, "MASK_MODE_USER_PROVIDED");
  assert.equal(maskImageConfig.maskDilation, 0);
});

test("referenceImage shape survives JSON serialization round-trip", () => {
  const serialised = JSON.parse(JSON.stringify(buildPayload()));
  assert.equal(serialised.instances[0].referenceImages[0].referenceImage.mimeType, "image/jpeg");
  assert.ok(typeof serialised.instances[0].referenceImages[0].referenceImage.bytesBase64Encoded === "string");
  assert.equal(serialised.instances[0].referenceImages[0].image, undefined);
  assert.equal(serialised.instances[0].referenceImages[0].rawReferenceImage, undefined);

  assert.equal(serialised.instances[0].referenceImages[1].referenceImage.mimeType, "image/png");
  assert.ok(typeof serialised.instances[0].referenceImages[1].referenceImage.bytesBase64Encoded === "string");
  assert.equal(serialised.instances[0].referenceImages[1].maskImageConfig.maskMode, "MASK_MODE_USER_PROVIDED");
  assert.equal(serialised.instances[0].referenceImages[1].config, undefined);
});

test("parameters contain required Imagen 3 edit fields", () => {
  const payload = buildPayload();
  const params = payload.parameters;
  assert.equal(params.editMode, "EDIT_MODE_INPAINT_INSERTION");
  assert.equal(params.numberOfImages, 1);
  assert.equal((params as Record<string, unknown>).sampleCount, undefined);
  assert.equal((params as Record<string, unknown>).guidanceScale, undefined);
  assert.equal((params as Record<string, unknown>).addWatermark, undefined);
  assert.equal((params as Record<string, unknown>).outputOptions, undefined);
});

test("parameters must NOT contain maskMode and entries must NOT regress to image/config keys", () => {
  const serialised = JSON.parse(JSON.stringify(buildPayload()));
  assert.equal(
    (serialised.parameters as Record<string, unknown>).maskMode,
    undefined,
    "maskMode must not appear in parameters when using the referenceImages path"
  );
  assert.equal(serialised.instances[0].referenceImages[0].image, undefined);
  assert.equal(serialised.instances[0].referenceImages[1].image, undefined);
  assert.equal(serialised.instances[0].referenceImages[1].config, undefined);
});

test("GCS uri source uses referenceImage and no inline byte keys", () => {
  const gcsSourcePayload: VertexWireImagePayload = {
    gcsUri: "gs://my-bucket/source.jpeg",
    mimeType: "image/jpeg",
  };
  const payload = buildVertexEditPredictPayload({
    prompt: "gcs test",
    sourcePayload: gcsSourcePayload,
    maskPayload,
    guidanceScale: 10,
    renderProfile: {
      isolationMode: "CONTINUITY_STRICT_INSERTION",
      editMode: "EDIT_MODE_INPAINT_INSERTION",
      maskDilation: 0,
      outsideMaskMaxMae: 6,
      outsideMaskMaxChangedRatio: 0.035,
      outsideMaskChangeThreshold: 18,
    },
  });
  const serialised = JSON.parse(JSON.stringify(payload));
  const sourceEntry = serialised.instances[0].referenceImages[0];
  assert.ok("referenceImage" in sourceEntry, "GCS source must use referenceImage");
  assert.equal(sourceEntry.image, undefined);
  assert.equal(sourceEntry.rawReferenceImage, undefined);
  const inner = sourceEntry.referenceImage;
  assert.equal(inner.gcsUri, "gs://my-bucket/source.jpeg");
  assert.equal(inner.imageBytes, undefined);
  assert.equal(inner.bytesBase64Encoded, undefined);
  assert.equal(inner.bytes_base64_encoded, undefined);
});

test("flat builder is an alias of the verified referenceImage contract", () => {
  const payload = buildFlatPayload();
  const sourceEntry = payload.instances[0]!.referenceImages[0]! as Record<string, unknown>;

  assert.ok("referenceImage" in sourceEntry);
  assert.equal(sourceEntry.image, undefined);
  assert.equal(sourceEntry.rawReferenceImage, undefined);
  assert.equal(sourceEntry.maskReferenceImage, undefined);
  assert.equal(sourceEntry.config, undefined);

  const maskEntry = payload.instances[0]!.referenceImages[1]! as Record<string, any>;
  assert.ok("referenceImage" in maskEntry);
  assert.equal(maskEntry.rawReferenceImage, undefined);
  assert.equal(maskEntry.maskReferenceImage, undefined);
  assert.equal(maskEntry.maskImageConfig?.maskMode, "MASK_MODE_USER_PROVIDED");
});

