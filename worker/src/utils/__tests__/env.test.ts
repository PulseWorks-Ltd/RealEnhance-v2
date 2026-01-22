import { getEnvBoolean } from "../env";

describe("getEnvBoolean", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns default when unset", () => {
    delete process.env.TEST_FLAG;
    expect(getEnvBoolean("TEST_FLAG", false)).toBe(false);
    expect(getEnvBoolean("TEST_FLAG", true)).toBe(true);
  });

  it("treats truthy strings as true", () => {
    ["1", "true", "yes", "on", " TRUE  "].forEach((v) => {
      process.env.TEST_FLAG = v as string;
      expect(getEnvBoolean("TEST_FLAG", false)).toBe(true);
    });
  });

  it("treats falsy strings as false", () => {
    ["0", "false", "no", "off", " False "].forEach((v) => {
      process.env.TEST_FLAG = v as string;
      expect(getEnvBoolean("TEST_FLAG", true)).toBe(false);
    });
  });
});
