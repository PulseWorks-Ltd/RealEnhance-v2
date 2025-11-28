import { parseRetryInfo, recordEnhancedImageRedis, findByPublicUrlRedis } from "./imageStore";

describe("Key normalization and lookup", () => {
  it("normalizes URLs with query params and logs", () => {
    const url = "https://foo.com/bar/abc-retry2.jpg?token=123";
    const spy = jest.spyOn(console, "info").mockImplementation(() => {});
    const result = parseRetryInfo(url);
    expect(result.noQuery).toBe("https://foo.com/bar/abc-retry2.jpg");
    // baseKey includes extension by design
    expect(result.baseKey).toBe("abc.jpg");
    expect(result.retry).toBe(2);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("normalized url from"),
    );
    spy.mockRestore();
  });

  it("normalizes baseKey and logs if mismatched", async () => {
    const opts = {
      userId: "user1",
      imageId: "img1",
      publicUrl: "https://foo.com/bar/abc-retry1.jpg",
      baseKey: "abc-wrong",
      versionId: "v1"
    };
    const spy = jest.spyOn(console, "info").mockImplementation(() => {});
    await expect(recordEnhancedImageRedis(opts)).resolves.not.toThrow();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("normalized baseKey from abc-wrong to abc"),
    );
    spy.mockRestore();
  });

  it("throws on unusable input", async () => {
    // parseRetryInfo throws synchronously
    // @ts-ignore
    expect(() => parseRetryInfo(null)).toThrow();
    // recordEnhancedImageRedis throws asynchronously
    // @ts-ignore
    await expect(recordEnhancedImageRedis({})).rejects.toThrow();
    // findByPublicUrlRedis throws asynchronously
    // @ts-ignore
    await expect(findByPublicUrlRedis(null, null)).rejects.toThrow();
  });

  it("parses retry and baseKey correctly", () => {
    const url = "https://foo.com/bar/abc-retry12.webp";
    const result = parseRetryInfo(url);
    // baseKey includes extension
    expect(result.baseKey).toBe("abc.webp");
    expect(result.retry).toBe(12);
  });

  it("parses non-retry filename", () => {
    const url = "https://foo.com/bar/xyz.jpg";
    const result = parseRetryInfo(url);
    // baseKey includes extension
    expect(result.baseKey).toBe("xyz.jpg");
    expect(result.retry).toBe(0);
  });
});

// Contract test (pseudo, as redis is not mocked):
// it("worker writes, server reads with same logic", async () => {
//   // Use a mock redis or in-memory map for full contract test
// });
