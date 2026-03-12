import { resolveSelectedDisplayUrl } from "../src/stageUrlResolver";

describe("resolveSelectedDisplayUrl", () => {
  it("returns retryLatestUrl when retried is explicitly selected", () => {
    const resolved = resolveSelectedDisplayUrl("retried", {
      retryLatestUrl: "retry.png",
      stage2Url: "stage.png",
    });

    expect(resolved).toBe("retry.png");
  });

  it("returns null when retried is selected but retry artifact is missing", () => {
    const resolved = resolveSelectedDisplayUrl("retried", {
      retryLatestUrl: null,
      stage2Url: "stage.png",
    });

    expect(resolved).toBeNull();
  });
});
