import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import {
  bootstrapGoogleCredentialsFromEnv,
  getGoogleCredentialsPath,
  googleCredentialsFileExists,
} from "../bootstrap/googleCredentials";
import { getVertexGenAiClient, getVertexProjectConfig } from "../providers/vertex/adc";

type TransportMode = "inline" | "gcs" | "both";
type CandidateName = string;
type ProbeFamily = "default" | "b" | "b-cross" | "wrapper" | "image-field" | "rest-wire";

type ProbeImageLeaf = {
  bytesBase64Encoded?: string;
  gcsUri?: string;
  mimeType: string;
};

type ProbeResult = {
  candidate: CandidateName;
  transportMode: Exclude<TransportMode, "both">;
  payloadFile: string;
  serializedBytes: number;
  fingerprint: Record<string, unknown>;
  success: boolean;
  responseStatus: number | null;
  responseStatusText: string | null;
  responseBody: unknown;
  error: Record<string, unknown> | null;
};

type ProbeScenario = {
  name: CandidateName;
  buildPayload: (params: {
    prompt: string;
    sourceImage: ProbeImageLeaf;
    maskImage: ProbeImageLeaf;
    guidanceScale: number;
  }) => Record<string, unknown>;
};

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const eqIndex = token.indexOf("=");
    if (eqIndex >= 0) {
      const key = token.slice(2, eqIndex).trim();
      const value = token.slice(eqIndex + 1).trim();
      if (key) {
        parsed[key] = value;
      }
      continue;
    }

    const key = token.slice(2).trim();
    const next = argv[index + 1];
    if (!key) {
      continue;
    }
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function requireNonEmpty(value: string | undefined, message: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function resolveTransportMode(value: string | undefined): TransportMode {
  const normalized = String(value || "inline").trim().toLowerCase();
  if (normalized === "inline" || normalized === "gcs" || normalized === "both") {
    return normalized;
  }
  throw new Error(`Unsupported --transport value: ${value}`);
}

function resolveModel(value: string | undefined): string {
  const normalized = String(value || process.env.VERTEX_IMAGEN_PROBE_MODEL || "imagen-3.0-capability-001").trim();
  if (!normalized) {
    throw new Error("Probe model is required");
  }
  return normalized;
}

function resolveOutputDir(value: string | undefined): string {
  const explicit = String(value || "").trim();
  if (explicit) {
    return explicit;
  }
  return path.join(process.cwd(), ".tmp-test", `vertex-imagen-contract-probe-${Date.now()}`);
}

function resolvePrompt(value: string | undefined): string {
  return String(value || "minimal probe prompt for Vertex Imagen edit contract validation").trim();
}

function inferMimeTypeFromLocation(value: string | undefined, fallback: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (normalized.endsWith(".png")) {
    return "image/png";
  }
  if (normalized.endsWith(".webp")) {
    return "image/webp";
  }
  return fallback;
}

function resolveProbeFamily(value: string | undefined): ProbeFamily {
  const normalized = String(value || "default").trim().toLowerCase();
  if (
    normalized === "default"
    || normalized === "b"
    || normalized === "b-cross"
    || normalized === "wrapper"
    || normalized === "image-field"
    || normalized === "rest-wire"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported --family value: ${value}`);
}

async function createTinyPngBase64(params: {
  width: number;
  height: number;
  channels?: 3 | 4;
  background: { r: number; g: number; b: number; alpha?: number };
}): Promise<string> {
  const buffer = await sharp({
    create: {
      width: params.width,
      height: params.height,
      channels: params.channels ?? 3,
      background: params.background,
    },
  }).png().toBuffer();
  return buffer.toString("base64");
}

function createImageLeaf(params: {
  transportMode: Exclude<TransportMode, "both">;
  role: "source" | "mask";
  inlineBase64: string;
  mimeType: string;
  args: Record<string, string>;
}): ProbeImageLeaf {
  if (params.transportMode === "inline") {
    return {
      bytesBase64Encoded: params.inlineBase64,
      mimeType: params.mimeType,
    };
  }

  const argKey = params.role === "source" ? "source-gcs-uri" : "mask-gcs-uri";
  const envKey = params.role === "source" ? "VERTEX_IMAGEN_PROBE_SOURCE_GCS_URI" : "VERTEX_IMAGEN_PROBE_MASK_GCS_URI";
  return {
    gcsUri: requireNonEmpty(
      params.args[argKey] || process.env[envKey],
      `Missing GCS URI for ${params.role}. Provide --${argKey}=gs://... or ${envKey}`
    ),
    mimeType: params.mimeType,
  };
}

function buildCandidatePayload(params: {
  candidate: CandidateName;
  prompt: string;
  sourceImage: ProbeImageLeaf;
  maskImage: ProbeImageLeaf;
  guidanceScale: number;
}) {
  const parameters = {
    sampleCount: 1,
    guidanceScale: params.guidanceScale,
    addWatermark: false,
    editMode: "EDIT_MODE_INPAINT_INSERTION",
    outputOptions: {
      mimeType: "image/png",
    },
  } as Record<string, unknown>;

  if (params.candidate === "A") {
    return {
      instances: [
        {
          prompt: params.prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              rawReferenceImage: {
                image: params.sourceImage,
              },
            },
            {
              referenceId: 2,
              referenceType: "REFERENCE_TYPE_MASK",
              maskReferenceImage: {
                maskMode: "MASK_MODE_USER_PROVIDED",
                image: params.maskImage,
              },
            },
          ],
        },
      ],
      parameters,
    };
  }

  if (params.candidate === "B") {
    return {
      instances: [
        {
          prompt: params.prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              referenceImage: params.sourceImage,
            },
            {
              referenceId: 2,
              referenceType: "REFERENCE_TYPE_MASK",
              referenceImage: params.maskImage,
              config: {
                maskMode: "MASK_MODE_USER_PROVIDED",
              },
            },
          ],
        },
      ],
      parameters,
    };
  }

  if (params.candidate === "C") {
    return {
      instances: [
        {
          prompt: params.prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              referenceImage: {
                image: params.sourceImage,
              },
            },
            {
              referenceId: 2,
              referenceType: "REFERENCE_TYPE_MASK",
              referenceImage: {
                image: params.maskImage,
              },
              config: {
                maskMode: "MASK_MODE_USER_PROVIDED",
              },
            },
          ],
        },
      ],
      parameters,
    };
  }

  return {
    instances: [
      {
        prompt: params.prompt,
        referenceImages: [
          {
            referenceId: 1,
            referenceType: "REFERENCE_TYPE_RAW",
            image: params.sourceImage,
          },
          {
            referenceId: 2,
            referenceType: "REFERENCE_TYPE_MASK",
            image: params.maskImage,
            maskMode: "MASK_MODE_USER_PROVIDED",
          },
        ],
      },
    ],
    parameters,
  };
}

function createBFamilyScenarios(): ProbeScenario[] {
  const buildBaseParameters = (editMode: string) => ({
    sampleCount: 1,
    guidanceScale: 12,
    addWatermark: false,
    editMode,
    outputOptions: {
      mimeType: "image/png",
    },
  });

  return [
    {
      name: "B_BASELINE",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              referenceImage: sourceImage,
            },
            {
              referenceId: 2,
              referenceType: "REFERENCE_TYPE_MASK",
              referenceImage: maskImage,
              config: {
                maskMode: "MASK_MODE_USER_PROVIDED",
              },
            },
          ],
        }],
        parameters: {
          ...buildBaseParameters("EDIT_MODE_INPAINT_INSERTION"),
          guidanceScale,
        },
      }),
    },
    {
      name: "B_NO_REFERENCE_IDS",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceType: "REFERENCE_TYPE_RAW",
              referenceImage: sourceImage,
            },
            {
              referenceType: "REFERENCE_TYPE_MASK",
              referenceImage: maskImage,
              config: {
                maskMode: "MASK_MODE_USER_PROVIDED",
              },
            },
          ],
        }],
        parameters: {
          ...buildBaseParameters("EDIT_MODE_INPAINT_INSERTION"),
          guidanceScale,
        },
      }),
    },
    {
      name: "B_REFERENCE_IDS_ZERO_BASED",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceId: 0,
              referenceType: "REFERENCE_TYPE_RAW",
              referenceImage: sourceImage,
            },
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_MASK",
              referenceImage: maskImage,
              config: {
                maskMode: "MASK_MODE_USER_PROVIDED",
              },
            },
          ],
        }],
        parameters: {
          ...buildBaseParameters("EDIT_MODE_INPAINT_INSERTION"),
          guidanceScale,
        },
      }),
    },
    {
      name: "B_MASKMODE_IN_PARAMETERS",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              referenceImage: sourceImage,
            },
            {
              referenceId: 2,
              referenceType: "REFERENCE_TYPE_MASK",
              referenceImage: maskImage,
            },
          ],
        }],
        parameters: {
          ...buildBaseParameters("EDIT_MODE_INPAINT_INSERTION"),
          guidanceScale,
          maskMode: "MASK_MODE_USER_PROVIDED",
        },
      }),
    },
    {
      name: "B_NO_MASKMODE",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              referenceImage: sourceImage,
            },
            {
              referenceId: 2,
              referenceType: "REFERENCE_TYPE_MASK",
              referenceImage: maskImage,
            },
          ],
        }],
        parameters: {
          ...buildBaseParameters("EDIT_MODE_INPAINT_INSERTION"),
          guidanceScale,
        },
      }),
    },
    {
      name: "B_MASKMODE_USER_PROVIDED",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              referenceImage: sourceImage,
            },
            {
              referenceId: 2,
              referenceType: "REFERENCE_TYPE_MASK",
              referenceImage: maskImage,
              config: {
                maskMode: "USER_PROVIDED",
              },
            },
          ],
        }],
        parameters: {
          ...buildBaseParameters("EDIT_MODE_INPAINT_INSERTION"),
          guidanceScale,
        },
      }),
    },
    {
      name: "B_EDITMODE_INPAINT_INSERTION",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              referenceImage: sourceImage,
            },
            {
              referenceId: 2,
              referenceType: "REFERENCE_TYPE_MASK",
              referenceImage: maskImage,
              config: {
                maskMode: "MASK_MODE_USER_PROVIDED",
              },
            },
          ],
        }],
        parameters: {
          ...buildBaseParameters("INPAINT_INSERTION"),
          guidanceScale,
        },
      }),
    },
    {
      name: "B_REFERENCE_TYPE_RAW_MASK",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "RAW",
              referenceImage: sourceImage,
            },
            {
              referenceId: 2,
              referenceType: "MASK",
              referenceImage: maskImage,
              config: {
                maskMode: "MASK_MODE_USER_PROVIDED",
              },
            },
          ],
        }],
        parameters: {
          ...buildBaseParameters("EDIT_MODE_INPAINT_INSERTION"),
          guidanceScale,
        },
      }),
    },
    {
      name: "B_MASKMODE_TOP_LEVEL_ON_MASK_REFERENCE",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              referenceImage: sourceImage,
            },
            {
              referenceId: 2,
              referenceType: "REFERENCE_TYPE_MASK",
              referenceImage: maskImage,
              maskMode: "MASK_MODE_USER_PROVIDED",
            },
          ],
        }],
        parameters: {
          ...buildBaseParameters("EDIT_MODE_INPAINT_INSERTION"),
          guidanceScale,
        },
      }),
    },
  ];
}

function createBCrossFamilyScenarios(): ProbeScenario[] {
  const buildParameters = (guidanceScale: number) => ({
    sampleCount: 1,
    guidanceScale,
    addWatermark: false,
    editMode: "EDIT_MODE_INPAINT_INSERTION",
    outputOptions: {
      mimeType: "image/png",
    },
  });

  const rawEntry = (referenceId: number, sourceImage: ProbeImageLeaf) => ({
    referenceId,
    referenceType: "REFERENCE_TYPE_RAW",
    referenceImage: sourceImage,
  });

  const maskEntry = (referenceId: number, maskImage: ProbeImageLeaf) => ({
    referenceId,
    referenceType: "REFERENCE_TYPE_MASK",
    referenceImage: maskImage,
    config: {
      maskMode: "MASK_MODE_USER_PROVIDED",
    },
  });

  return [
    {
      name: "B_CROSS_BASELINE_1_2",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [rawEntry(1, sourceImage), maskEntry(2, maskImage)],
        }],
        parameters: buildParameters(guidanceScale),
      }),
    },
    {
      name: "B_CROSS_ZERO_BASED_0_1",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [rawEntry(0, sourceImage), maskEntry(1, maskImage)],
        }],
        parameters: buildParameters(guidanceScale),
      }),
    },
    {
      name: "B_CROSS_SWAPPED_IDS_2_1",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [rawEntry(2, sourceImage), maskEntry(1, maskImage)],
        }],
        parameters: buildParameters(guidanceScale),
      }),
    },
    {
      name: "B_CROSS_DUPLICATE_IDS_1_1",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [rawEntry(1, sourceImage), maskEntry(1, maskImage)],
        }],
        parameters: buildParameters(guidanceScale),
      }),
    },
    {
      name: "B_CROSS_MASK_FIRST_2_1",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [maskEntry(2, maskImage), rawEntry(1, sourceImage)],
        }],
        parameters: buildParameters(guidanceScale),
      }),
    },
    {
      name: "B_CROSS_MASK_FIRST_1_2",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [maskEntry(1, maskImage), rawEntry(2, sourceImage)],
        }],
        parameters: buildParameters(guidanceScale),
      }),
    },
  ];
}

function createWrapperFamilyScenarios(): ProbeScenario[] {
  const buildParameters = (guidanceScale: number) => ({
    sampleCount: 1,
    guidanceScale,
    addWatermark: false,
    editMode: "EDIT_MODE_INPAINT_INSERTION",
    outputOptions: {
      mimeType: "image/png",
    },
  });

  const rawEntry = (referenceId: number, sourceImage: ProbeImageLeaf) => ({
    referenceId,
    referenceType: "REFERENCE_TYPE_RAW",
    rawReferenceImage: {
      image: sourceImage,
    },
  });

  const maskEntry = (referenceId: number, maskImage: ProbeImageLeaf) => ({
    referenceId,
    referenceType: "REFERENCE_TYPE_MASK",
    maskReferenceImage: {
      maskMode: "MASK_MODE_USER_PROVIDED",
      image: maskImage,
    },
  });

  return [
    {
      name: "WRAPPER_BASELINE_1_2",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [rawEntry(1, sourceImage), maskEntry(2, maskImage)],
        }],
        parameters: buildParameters(guidanceScale),
      }),
    },
    {
      name: "WRAPPER_MASK_FIRST_1_2",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [maskEntry(1, maskImage), rawEntry(2, sourceImage)],
        }],
        parameters: buildParameters(guidanceScale),
      }),
    },
  ];
}

function createImageFieldFamilyScenarios(): ProbeScenario[] {
  const buildParameters = (guidanceScale: number) => ({
    sampleCount: 1,
    guidanceScale,
    addWatermark: false,
    editMode: "EDIT_MODE_INPAINT_INSERTION",
    outputOptions: {
      mimeType: "image/png",
    },
  });

  return [
    {
      name: "IMAGE_FIELD_DIRECT_BASELINE_1_2",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              image: sourceImage,
            },
            {
              referenceId: 2,
              referenceType: "REFERENCE_TYPE_MASK",
              image: maskImage,
              maskMode: "MASK_MODE_USER_PROVIDED",
            },
          ],
        }],
        parameters: buildParameters(guidanceScale),
      }),
    },
    {
      name: "IMAGE_FIELD_HYBRID_WITH_WRAPPERS_1_2",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              image: sourceImage,
              rawReferenceImage: {},
            },
            {
              referenceId: 2,
              referenceType: "REFERENCE_TYPE_MASK",
              image: maskImage,
              maskReferenceImage: {
                maskMode: "MASK_MODE_USER_PROVIDED",
              },
            },
          ],
        }],
        parameters: buildParameters(guidanceScale),
      }),
    },
  ];
}

function createRestWireFamilyScenarios(): ProbeScenario[] {
  const toSnakeImageLeaf = (image: ProbeImageLeaf) => {
    const snakeImage: Record<string, unknown> = {};
    if (image.bytesBase64Encoded !== undefined) {
      snakeImage.bytes_base64_encoded = image.bytesBase64Encoded;
    }
    if (image.gcsUri !== undefined) {
      snakeImage.gcs_uri = image.gcsUri;
    }
    if (image.mimeType !== undefined) {
      snakeImage.mime_type = image.mimeType;
    }
    return snakeImage;
  };

  const toSnakeReferenceImageEntry = (params: {
    referenceId: number;
    referenceType: string;
    image: ProbeImageLeaf;
  }) => ({
    reference_id: params.referenceId,
    reference_type: params.referenceType,
    reference_image: toSnakeImageLeaf(params.image),
  });

  return [
    {
      name: "REST_WIRE_EXACT_GCS_SHAPE",
      buildPayload: ({ prompt, sourceImage, maskImage }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              image: sourceImage,
            },
            {
              referenceId: 2,
              referenceType: "REFERENCE_TYPE_MASK",
              image: maskImage,
              maskImageConfig: {
                maskMode: "MASK_MODE_USER_PROVIDED",
                maskDilation: 0.1,
              },
            },
          ],
        }],
        parameters: {
          editMode: "EDIT_MODE_DEFAULT",
          aspectRatio: "4:3",
          numberOfImages: 1,
        },
      }),
    },
    {
      name: "REST_WIRE_SNAKE_IMAGE_LEAF",
      buildPayload: ({ prompt, sourceImage, maskImage }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              image: toSnakeImageLeaf(sourceImage),
            },
            {
              referenceId: 2,
              referenceType: "REFERENCE_TYPE_MASK",
              image: toSnakeImageLeaf(maskImage),
              maskImageConfig: {
                maskMode: "MASK_MODE_USER_PROVIDED",
                maskDilation: 0.1,
              },
            },
          ],
        }],
        parameters: {
          editMode: "EDIT_MODE_DEFAULT",
          aspectRatio: "4:3",
          numberOfImages: 1,
        },
      }),
    },
    {
      name: "REST_WIRE_REFERENCE_IMAGE_FLAT",
      buildPayload: ({ prompt, sourceImage, maskImage }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              referenceImage: sourceImage,
            },
            {
              referenceId: 2,
              referenceType: "REFERENCE_TYPE_MASK",
              referenceImage: maskImage,
              maskImageConfig: {
                maskMode: "MASK_MODE_USER_PROVIDED",
                maskDilation: 0.1,
              },
            },
          ],
        }],
        parameters: {
          editMode: "EDIT_MODE_DEFAULT",
          aspectRatio: "4:3",
          numberOfImages: 1,
        },
      }),
    },
    {
      name: "REST_WIRE_CAMEL_REF_IMAGE",
      buildPayload: ({ prompt, sourceImage }) => ({
        instances: [{
          prompt,
          referenceImages: [
            {
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              referenceImage: sourceImage,
            },
          ],
        }],
        parameters: {
          editMode: "EDIT_MODE_DEFAULT",
        },
      }),
    },
    {
      name: "REST_WIRE_SNAKE_REF_IMAGE",
      buildPayload: ({ prompt, sourceImage }) => ({
        instances: [{
          prompt,
          reference_images: [
            toSnakeReferenceImageEntry({
              referenceId: 1,
              referenceType: "REFERENCE_TYPE_RAW",
              image: sourceImage,
            }),
          ],
        }],
        parameters: {
          edit_mode: "EDIT_MODE_DEFAULT",
        },
      }),
    },
  ];
}

function getProbeScenarios(family: ProbeFamily): ProbeScenario[] {
  if (family === "b") {
    return createBFamilyScenarios();
  }

  if (family === "b-cross") {
    return createBCrossFamilyScenarios();
  }

  if (family === "wrapper") {
    return createWrapperFamilyScenarios();
  }

  if (family === "image-field") {
    return createImageFieldFamilyScenarios();
  }

  if (family === "rest-wire") {
    return createRestWireFamilyScenarios();
  }

  return [
    {
      name: "A",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => buildCandidatePayload({
        candidate: "A",
        prompt,
        sourceImage,
        maskImage,
        guidanceScale,
      }),
    },
    {
      name: "B",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => buildCandidatePayload({
        candidate: "B",
        prompt,
        sourceImage,
        maskImage,
        guidanceScale,
      }),
    },
    {
      name: "C",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => buildCandidatePayload({
        candidate: "C",
        prompt,
        sourceImage,
        maskImage,
        guidanceScale,
      }),
    },
    {
      name: "D",
      buildPayload: ({ prompt, sourceImage, maskImage, guidanceScale }) => buildCandidatePayload({
        candidate: "D",
        prompt,
        sourceImage,
        maskImage,
        guidanceScale,
      }),
    },
  ];
}

function getFirstReference(payload: Record<string, any>): Record<string, any> {
  return payload.instances?.[0]?.referenceImages?.[0]
    || payload.instances?.[0]?.reference_images?.[0]
    || {};
}

function resolveNestedContainer(reference: Record<string, any>): Record<string, any> {
  return reference.rawReferenceImage
    || reference.maskReferenceImage
    || reference.referenceImage
    || reference.reference_image
    || reference.image
    || {};
}

function resolveImageLeaf(reference: Record<string, any>): Record<string, any> {
  const container = resolveNestedContainer(reference);
  return container.image || container;
}

function resolveMaskModeLocation(payload: Record<string, any>): string | null {
  const parametersMaskMode = payload.parameters?.maskMode;
  if (parametersMaskMode !== undefined) {
    return "parameters.maskMode";
  }

  const snakeParametersMaskMode = payload.parameters?.edit_mode;
  if (snakeParametersMaskMode !== undefined) {
    return "parameters.edit_mode";
  }

  const maskReference = payload.instances?.[0]?.referenceImages?.[1]
    || payload.instances?.[0]?.reference_images?.[1]
    || {};
  if (maskReference.config?.maskMode !== undefined) {
    return "referenceImages[1].config.maskMode";
  }
  if (maskReference.maskImageConfig?.maskMode !== undefined) {
    return "referenceImages[1].maskImageConfig.maskMode";
  }
  if (maskReference.mask_image_config?.mask_mode !== undefined) {
    return "reference_images[1].mask_image_config.mask_mode";
  }
  if (maskReference.maskReferenceImage?.maskMode !== undefined) {
    return "referenceImages[1].maskReferenceImage.maskMode";
  }
  if (maskReference.maskMode !== undefined) {
    return "referenceImages[1].maskMode";
  }
  return null;
}

function buildSchemaFingerprint(params: {
  candidate: CandidateName;
  transportMode: Exclude<TransportMode, "both">;
  payload: Record<string, any>;
}): Record<string, unknown> {
  const firstInstance = params.payload.instances?.[0] || {};
  const firstReference = getFirstReference(params.payload);
  const nestedContainer = resolveNestedContainer(firstReference);
  const imageLeaf = resolveImageLeaf(firstReference);

  return {
    candidate: params.candidate,
    transportMode: params.transportMode,
    topLevelKeys: Object.keys(params.payload || {}),
    instanceKeys: Object.keys(firstInstance || {}),
    referenceKeys: Object.keys(firstReference || {}),
    nestedKeys: Object.keys(nestedContainer || {}),
    imageLeafKeys: Object.keys(imageLeaf || {}),
    hasRawReferenceImage: Object.prototype.hasOwnProperty.call(firstReference, "rawReferenceImage"),
    hasMaskReferenceImage: Object.prototype.hasOwnProperty.call(firstReference, "maskReferenceImage"),
    hasReferenceImage: Object.prototype.hasOwnProperty.call(firstReference, "referenceImage"),
    hasDirectImage: Object.prototype.hasOwnProperty.call(firstReference, "image"),
    hasConfig: Object.prototype.hasOwnProperty.call(firstReference, "config"),
    maskModeLocation: resolveMaskModeLocation(params.payload),
  };
}

async function writePayloadArtifact(params: {
  outputDir: string;
  candidate: CandidateName;
  transportMode: Exclude<TransportMode, "both">;
  serializedPayload: string;
}): Promise<string> {
  const fileName = `candidate-${params.candidate.toLowerCase()}-${params.transportMode}.json`;
  const filePath = path.join(params.outputDir, fileName);
  await fs.writeFile(filePath, params.serializedPayload, "utf8");
  return filePath;
}

async function parseResponseJson(response: any): Promise<unknown> {
  if (response && typeof response.json === "function") {
    return response.json();
  }
  return null;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      name: null,
      message: String(error),
      stack: null,
    };
  }

  const asAny = error as Error & {
    status?: number;
    statusText?: string;
    response?: { status?: number; statusText?: string; data?: unknown; body?: unknown };
    cause?: unknown;
  };

  return {
    name: asAny.name,
    message: asAny.message,
    stack: asAny.stack || null,
    status: asAny.status ?? asAny.response?.status ?? null,
    statusText: asAny.statusText ?? asAny.response?.statusText ?? null,
    responseData: asAny.response?.data ?? asAny.response?.body ?? null,
    cause: asAny.cause ?? null,
  };
}

function resolveModelResource(model: string): string {
  const { project, location } = getVertexProjectConfig();
  return `projects/${project}/locations/${location}/publishers/google/models/${model}`;
}

async function runCandidate(params: {
  candidate: CandidateName;
  transportMode: Exclude<TransportMode, "both">;
  outputDir: string;
  prompt: string;
  model: string;
  sourceImage: ProbeImageLeaf;
  maskImage: ProbeImageLeaf;
  guidanceScale: number;
  buildPayload?: ProbeScenario["buildPayload"];
}): Promise<ProbeResult> {
  const payload = (params.buildPayload
    ? params.buildPayload({
        prompt: params.prompt,
        sourceImage: params.sourceImage,
        maskImage: params.maskImage,
        guidanceScale: params.guidanceScale,
      })
    : buildCandidatePayload({
        candidate: params.candidate,
        prompt: params.prompt,
        sourceImage: params.sourceImage,
        maskImage: params.maskImage,
        guidanceScale: params.guidanceScale,
      })) as Record<string, any>;
  const fingerprint = buildSchemaFingerprint({
    candidate: params.candidate,
    transportMode: params.transportMode,
    payload,
  });
  const serializedPayload = JSON.stringify(payload);
  const payloadFile = await writePayloadArtifact({
    outputDir: params.outputDir,
    candidate: params.candidate,
    transportMode: params.transportMode,
    serializedPayload,
  });
  const endpoint = `${resolveModelResource(params.model)}:predict`;

  console.log("[SCHEMA_FINGERPRINT]", fingerprint);
  console.log("[VERTEX_IMAGEN_PROBE_REQUEST]", {
    candidate: params.candidate,
    transportMode: params.transportMode,
    endpoint,
    model: params.model,
    payloadFile,
    serializedBytes: Buffer.byteLength(serializedPayload, "utf8"),
  });
  console.log("[VERTEX_IMAGEN_FINAL_REQUEST]", serializedPayload);

  try {
    const apiClient = (getVertexGenAiClient() as any).apiClient;
    const response = await apiClient.request({
      path: endpoint,
      body: serializedPayload,
      httpMethod: "POST",
      httpOptions: {
        timeout: 120000,
      },
    });
    const responseBody = await parseResponseJson(response);
    const result: ProbeResult = {
      candidate: params.candidate,
      transportMode: params.transportMode,
      payloadFile,
      serializedBytes: Buffer.byteLength(serializedPayload, "utf8"),
      fingerprint,
      success: true,
      responseStatus: typeof response?.status === "number" ? response.status : null,
      responseStatusText: typeof response?.statusText === "string" ? response.statusText : null,
      responseBody,
      error: null,
    };
    console.log("[VERTEX_IMAGEN_PROBE_RESULT]", result);
    return result;
  } catch (error) {
    const serializedError = serializeError(error);
    const result: ProbeResult = {
      candidate: params.candidate,
      transportMode: params.transportMode,
      payloadFile,
      serializedBytes: Buffer.byteLength(serializedPayload, "utf8"),
      fingerprint,
      success: false,
      responseStatus: typeof serializedError.status === "number" ? serializedError.status as number : null,
      responseStatusText: typeof serializedError.statusText === "string" ? serializedError.statusText as string : null,
      responseBody: serializedError.responseData ?? null,
      error: serializedError,
    };
    console.log("[VERTEX_IMAGEN_PROBE_RESULT]", result);
    return result;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const credentialsPath = getGoogleCredentialsPath();
  if (!googleCredentialsFileExists(credentialsPath) && String(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "").trim()) {
    await bootstrapGoogleCredentialsFromEnv();
  }

  const model = resolveModel(args.model);
  const prompt = resolvePrompt(args.prompt);
  const outputDir = resolveOutputDir(args["output-dir"]);
  const transportMode = resolveTransportMode(args.transport);
  const probeFamily = resolveProbeFamily(args.family);
  const guidanceScale = Number(args["guidance-scale"] || 12);
  const sourceGcsUri = args["source-gcs-uri"] || process.env.VERTEX_IMAGEN_PROBE_SOURCE_GCS_URI;
  const maskGcsUri = args["mask-gcs-uri"] || process.env.VERTEX_IMAGEN_PROBE_MASK_GCS_URI;
  const sourceMimeType = String(
    args["source-mime-type"] || inferMimeTypeFromLocation(sourceGcsUri, "image/png")
  ).trim();
  const maskMimeType = String(
    args["mask-mime-type"] || inferMimeTypeFromLocation(maskGcsUri, "image/png")
  ).trim();
  const scenarios = getProbeScenarios(probeFamily);
  const transportModes: Array<Exclude<TransportMode, "both">> = transportMode === "both"
    ? ["inline", "gcs"]
    : [transportMode];

  if (!Number.isFinite(guidanceScale)) {
    throw new Error(`Invalid guidance scale: ${args["guidance-scale"]}`);
  }

  await fs.mkdir(outputDir, { recursive: true });

  const sourceInlineBase64 = await createTinyPngBase64({
    width: 4,
    height: 4,
    background: { r: 40, g: 80, b: 120 },
  });
  const maskInlineBase64 = await createTinyPngBase64({
    width: 4,
    height: 4,
    channels: 4,
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  });

  console.log("[VERTEX_IMAGEN_PROBE_START]", {
    outputDir,
    model,
    prompt,
    transportMode,
    probeFamily,
    project: getVertexProjectConfig().project,
    location: getVertexProjectConfig().location,
    candidateOrder: scenarios.map((scenario) => scenario.name),
  });

  const results: ProbeResult[] = [];
  for (const activeTransportMode of transportModes) {
    const sourceImage = createImageLeaf({
      transportMode: activeTransportMode,
      role: "source",
      inlineBase64: sourceInlineBase64,
      mimeType: sourceMimeType,
      args,
    });
    const maskImage = createImageLeaf({
      transportMode: activeTransportMode,
      role: "mask",
      inlineBase64: maskInlineBase64,
      mimeType: maskMimeType,
      args,
    });

    for (const scenario of scenarios) {
      const result = await runCandidate({
        candidate: scenario.name,
        transportMode: activeTransportMode,
        outputDir,
        prompt,
        model,
        sourceImage,
        maskImage,
        guidanceScale,
        buildPayload: scenario.buildPayload,
      });
      results.push(result);
    }
  }

  const resultsFile = path.join(outputDir, "results.json");
  await fs.writeFile(resultsFile, JSON.stringify(results, null, 2), "utf8");

  console.log("[VERTEX_IMAGEN_PROBE_COMPLETE]", {
    outputDir,
    resultsFile,
    acceptedCandidates: results.filter((entry) => entry.success).map((entry) => ({
      candidate: entry.candidate,
      transportMode: entry.transportMode,
    })),
    rejectedCandidates: results.filter((entry) => !entry.success).map((entry) => ({
      candidate: entry.candidate,
      transportMode: entry.transportMode,
      responseStatus: entry.responseStatus,
      message: entry.error?.message || null,
    })),
  });
}

main().catch((error) => {
  console.error("[VERTEX_IMAGEN_PROBE_FATAL]", serializeError(error));
  process.exitCode = 1;
});