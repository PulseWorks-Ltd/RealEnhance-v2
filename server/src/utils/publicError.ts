// Keeps vendor / model names out of text that is sent to the browser.
// Messages that mention them are replaced with a generic one; a leading
// machine code such as "stage2_retry_failed:" is kept because the client
// matches on it.

const VENDOR_TERMS = /\b(ai|gemini|stability|openai|gpt|llm|model|models)\b|gemini-|imagen/i;

export const GENERIC_PROCESSING_ERROR = "Image processing encountered an issue. Please retry or contact support.";

export function toPublicMessage<T extends string | null | undefined>(msg: T): T | string {
  if (typeof msg !== "string" || !msg) return msg;
  if (!VENDOR_TERMS.test(msg)) return msg;
  const code = msg.match(/^([a-z0-9_]+):/);
  return code ? `${code[1]}: processing issue` : GENERIC_PROCESSING_ERROR;
}
