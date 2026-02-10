export const VALIDATION_FOCUS_MODE = process.env.VALIDATION_FOCUS_MODE === "true";

const FOCUS_TAGS = [
  "VALIDATOR",
  "STAGE2",
  "RETRY",
  "PUBLISH",
  "PARTIAL_COMPLETE",
  "JOB_FINAL",
  "STAGE2_RETRY_SUMMARY",
  "STAGE2_SEMANTIC_OVERRIDE_GATE",
  "MODEL",
];

export function focusLog(tag: string, ...args: any[]) {
  if (!VALIDATION_FOCUS_MODE) {
    console.log(...args);
    return;
  }
  if (FOCUS_TAGS.some((t) => tag.includes(t))) {
    console.log(...args);
  }
}
