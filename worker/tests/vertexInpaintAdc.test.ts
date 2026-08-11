describe("vertexInpaint adc", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("throws VertexAuthError when GOOGLE_CLOUD_PROJECT is unset", () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    const { getVertexProjectConfig } = require("../src/providers/vertexInpaint/adc");
    const { VertexAuthError } = require("../src/providers/vertexInpaint/types");
    expect(() => getVertexProjectConfig()).toThrow(VertexAuthError);
  });

  it("resolves project/location from env, defaulting location to us-central1", () => {
    process.env.GOOGLE_CLOUD_PROJECT = "my-test-project";
    delete process.env.GOOGLE_CLOUD_LOCATION;
    const { getVertexProjectConfig } = require("../src/providers/vertexInpaint/adc");
    expect(getVertexProjectConfig()).toEqual({ project: "my-test-project", location: "us-central1" });
  });

  it("honors an explicit GOOGLE_CLOUD_LOCATION override", () => {
    process.env.GOOGLE_CLOUD_PROJECT = "my-test-project";
    process.env.GOOGLE_CLOUD_LOCATION = "europe-west4";
    const { getVertexProjectConfig } = require("../src/providers/vertexInpaint/adc");
    expect(getVertexProjectConfig()).toEqual({ project: "my-test-project", location: "europe-west4" });
  });
});
