import { trimLogMessage, maskSecrets } from "../src/utils/logTrim";

describe("log trimming (keeps logs inside the log host's rate limit)", () => {
  it("prints an object on the same line as its tag", () => {
    const line = trimLogMessage(["[CREDIT_FINALIZED] job", { charge: 2, reason: "staged_image" }], "log");
    expect(line).toBe('[CREDIT_FINALIZED] job {"charge":2,"reason":"staged_image"}');
    expect(line).not.toMatch(/\n/);
  });
  it("joins line breaks inside a message", () => {
    expect(trimLogMessage(["a\nb\n\nc"], "log")).toBe("a | b | c");
  });
  it("drops routine detail but keeps job results, warnings and errors", () => {
    expect(trimLogMessage(["[stage1A-postfinish] transform", { width: 1 }], "log")).toBeNull();
    expect(trimLogMessage(["[MEM_PHASE_END]", { heap: 1 }], "log")).toBeNull();
    expect(trimLogMessage(["[PUBLISH] >>> UPLOADING NOW <<<"], "log")).toBeNull();
    expect(trimLogMessage(["[PUBLISH] ❌ upload failed: timeout"], "log")).not.toBeNull();
    expect(trimLogMessage(["JOB_START", { jobId: "x" }], "log")).toBeNull();
    expect(trimLogMessage(["[JOB_START] job=job_1 image=01.jpg"], "log")).not.toBeNull();
    expect(trimLogMessage(["═══════════"], "log")).toBeNull();
    expect(trimLogMessage(["[STAGE2_MASKED_SUMMARY] job=job_1 RESULT=published attempts=1"], "log")).not.toBeNull();
    expect(trimLogMessage(["[MEM_PHASE_END] something odd"], "error")).not.toBeNull();
  });
  it("masks secrets", () => {
    expect(maskSecrets("[WORKER] Redis: redis://default:abcDEF123456@redis.internal:6379")).toBe("[WORKER] Redis: redis://default:***@redis.internal:6379");
    expect(maskSecrets("key: AKIA3Y3FABCDEFGH")).toBe("key: AKIA***");
    // ...but download links keep working (the debug links in the logs)
    const link = "https://b.s3.amazonaws.com/x.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA3Y3FABCDEFGH%2F20261126%2Fap-southeast-2%2Fs3%2Faws4_request&X-Amz-Expires=86400";
    expect(maskSecrets(link)).toBe(link);
    expect(maskSecrets("https://x/y?key=AbCdEf123456&a=1")).toBe("https://x/y?key=***&a=1");
  });
  it("formats errors on one line", () => {
    const line = trimLogMessage(["[X] failed:", new Error("boom")], "error")!;
    expect(line).toMatch(/^\[X\] failed: Error: boom/);
    expect(line).not.toMatch(/\n/);
  });
});

describe("job reports are never cut", () => {
  it("keeps a long staging report whole", () => {
    const report = { jobId: "job_1", reports: [{ text: "x".repeat(30000) }] };
    const line = trimLogMessage(["[STAGE2_MASKED_RESULT]", JSON.stringify(report)], "log")!;
    expect(line.endsWith("}")).toBe(true);
    expect(JSON.parse(line.slice("[STAGE2_MASKED_RESULT] ".length)).reports[0].text).toHaveLength(30000);
  });
});
