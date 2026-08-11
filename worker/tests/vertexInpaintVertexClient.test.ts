jest.mock("../src/providers/vertexInpaint/adc");

describe("buildVertexInpaintPredictPayload", () => {
  it("produces the exact proven Vertex Imagen contract shape", () => {
    const { buildVertexInpaintPredictPayload } = require("../src/providers/vertexInpaint/vertexClient");
    const payload = buildVertexInpaintPredictPayload({
      prompt: "stage this room",
      sourcePayload: { bytesBase64Encoded: "AAAA", mimeType: "image/png" },
      maskPayload: { bytesBase64Encoded: "BBBB", mimeType: "image/png" },
    });

    expect(payload.instances).toHaveLength(1);
    expect(payload.instances[0].prompt).toBe("stage this room");

    const referenceImages = payload.instances[0].referenceImages;
    expect(referenceImages).toHaveLength(2);

    expect(referenceImages[0]).toEqual({
      referenceId: 1,
      referenceType: "REFERENCE_TYPE_RAW",
      referenceImage: { bytesBase64Encoded: "AAAA", mimeType: "image/png" },
    });

    expect(referenceImages[1]).toEqual({
      referenceId: 2,
      referenceType: "REFERENCE_TYPE_MASK",
      referenceImage: { bytesBase64Encoded: "BBBB", mimeType: "image/png" },
      maskImageConfig: {
        maskMode: "MASK_MODE_USER_PROVIDED",
        maskDilation: 0,
      },
    });

    expect(payload.parameters).toEqual({
      editMode: "EDIT_MODE_INPAINT_INSERTION",
      numberOfImages: 1,
    });
  });
});

describe("predictInpaint", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("calls apiClient.request against the publisher model :predict endpoint and extracts the generated image", async () => {
    const mockRequest = jest.fn().mockResolvedValue({
      json: async () => ({ predictions: [{ bytesBase64Encoded: "GENERATED_BYTES", mimeType: "image/png" }] }),
    });
    jest.doMock("../src/providers/vertexInpaint/adc", () => ({
      getVertexGenAiClient: () => ({ apiClient: { request: mockRequest } }),
      getVertexProjectConfig: () => ({ project: "test-project", location: "us-central1" }),
    }));

    const { buildVertexInpaintPredictPayload, predictInpaint } = require("../src/providers/vertexInpaint/vertexClient");
    const payload = buildVertexInpaintPredictPayload({
      prompt: "stage this room",
      sourcePayload: { bytesBase64Encoded: "AAAA", mimeType: "image/png" },
      maskPayload: { bytesBase64Encoded: "BBBB", mimeType: "image/png" },
    });

    const result = await predictInpaint(payload, "job_1", "img_1");
    expect(result).toEqual({ imageBytes: "GENERATED_BYTES", mimeType: "image/png" });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const callArgs = mockRequest.mock.calls[0][0];
    expect(callArgs.path).toBe("projects/test-project/locations/us-central1/publishers/google/models/imagen-3.0-capability-001:predict");
    expect(callArgs.httpMethod).toBe("POST");
    expect(JSON.parse(callArgs.body)).toEqual(payload);
  });

  it("throws VertexApiError when the response has no image bytes", async () => {
    const mockRequest = jest.fn().mockResolvedValue({
      json: async () => ({ predictions: [{}] }),
    });
    jest.doMock("../src/providers/vertexInpaint/adc", () => ({
      getVertexGenAiClient: () => ({ apiClient: { request: mockRequest } }),
      getVertexProjectConfig: () => ({ project: "test-project", location: "us-central1" }),
    }));

    const { buildVertexInpaintPredictPayload, predictInpaint } = require("../src/providers/vertexInpaint/vertexClient");
    const { VertexApiError } = require("../src/providers/vertexInpaint/types");
    const payload = buildVertexInpaintPredictPayload({
      prompt: "stage this room",
      sourcePayload: { bytesBase64Encoded: "AAAA", mimeType: "image/png" },
      maskPayload: { bytesBase64Encoded: "BBBB", mimeType: "image/png" },
    });

    await expect(predictInpaint(payload, "job_1", "img_1")).rejects.toThrow(VertexApiError);
  });
});
