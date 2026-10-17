// Last-line guard so vendor / model names never show in the UI.
// Mirrors server/src/utils/publicError.ts.

const VENDOR_TERMS = /\b(ai|gemini|stability|openai|gpt|llm|model|models)\b|gemini-|imagen/i;

export const GENERIC_PROCESSING_ERROR = "Image processing encountered an issue. Please retry or contact support.";

export function toPublicText(msg: unknown): string {
  const text = typeof msg === "string" ? msg : msg == null ? "" : String(msg);
  if (!text || !VENDOR_TERMS.test(text)) return text;
  return GENERIC_PROCESSING_ERROR;
}
