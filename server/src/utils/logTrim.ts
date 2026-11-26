// server/src/utils/logTrim.ts (same as the worker's, with the server's own drop list)
// Keeps the worker's logs inside Railway's rate limit (500 lines a second per
// replica) so every job can still be reviewed from them (Nov 2026: one day's
// export had 21,800 lines dropped, and whole jobs were missing).
//
// Imported first in index.ts, so it covers every console call:
//  1. One line per message. An object printed with console.log came out as
//     one line per field (a transform diagnostic was ~10 lines); Railway
//     counts each line. Objects are now printed as compact JSON on the same
//     line, and line breaks inside a message are joined with " | ".
//  2. Routine detail nobody reviews is dropped: memory readings, image
//     format/transform diagnostics, upload chatter, status-write receipts,
//     duplicate start banners. Warnings and errors are kept (except the two
//     informational ones listed in DROP_ANY_LEVEL).
//  3. Secrets are masked: passwords in connection URLs, AWS key ids, API keys.
//
// LOG_TRIM=off restores the old behaviour.

const ENABLED = String(process.env.LOG_TRIM ?? "on").trim().toLowerCase() !== "off";
const MAX_LEN = Math.max(500, Number(process.env.LOG_TRIM_MAX_CHARS || 20000));
// Full job reports are never cut: they are what a job is reviewed from
// (Nov 2026: a 4,000-character cap cut the staging report mid-JSON).
const NEVER_CUT = ["[STAGE2_MASKED_RESULT]", "[STAGE2_MASKED_SUMMARY]", "[CREDIT_FINALIZED]"];

// Messages starting with (or, for the regexes, matching) these are dropped
// when logged with console.log / info / debug.
const DROP_PREFIXES = [
  // Job progress is polled every few seconds; these printed ~89% of the
  // server's log lines (Nov 2026). Errors from the same route are kept.
  "[status/batch] Job with stages",
  "[status/batch] Processing despite resultUrl",
  "[status/batch] Merged job status",
  "[status/batch] response items",
];
// Upload chatter: every [PUBLISH] line except failures.
const DROP_PUBLISH = /^\[PUBLISH\](?!.*(fail|error|❌|denied|timeout))/i;
// The duplicate object-form start event ("JOB_START" followed by an object);
// the one-line "[JOB_START] job=... image=..." is kept.
const DROP_EXACT_FIRST_ARG = new Set(["JOB_START"]);
// Separator-only lines (banners of ═ or = with no words).
const SEPARATOR_ONLY = /^[\s═=─\-*]+$/;
// Informational messages that are printed as warnings/errors.
const DROP_ANY_LEVEL = ["[stage1A] artifact_consistency", "[MEMORY_PHASE_PEAK_WARNING]"];

export function maskSecrets(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^:@\/\s]+):([^@\/\s]+)@/gi, "$1$2:***@")
    // AWS key ids are masked, except inside a time-limited download link
    // (X-Amz-Credential=...): masking it there broke every debug link in the
    // logs (Nov 2026). An access key id is an account name, not a password;
    // the link itself expires after a day.
    .replace(/(?<!X-Amz-Credential=)\b(AKIA|ASIA)[0-9A-Z]{2,}\b/g, "$1***")
    .replace(/\b(key|apikey|api_key|token|secret|password)=([^&\s"']{6,})/gi, "$1=***")
    .replace(/\bAIza[0-9A-Za-z_\-]{20,}\b/g, "AIza***")
    .replace(/\bsk_(live|test)_[0-9A-Za-z]{8,}\b/g, "sk_$1_***");
}

function safeJson(value: unknown): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
        if (Buffer.isBuffer(v)) return `[Buffer ${v.length} bytes]`;
        if (ArrayBuffer.isView(v)) return `[${(v as any).constructor?.name || "TypedArray"} ${(v as any).length}]`;
      }
      return v;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) {
    const stack = String(a.stack || "").split("\n").slice(1, 4).map((s) => s.trim()).join(" | ");
    const extra = Object.keys(a).length ? ` ${safeJson({ ...a })}` : "";
    return `${a.name}: ${a.message}${extra}${stack ? ` | ${stack}` : ""}`;
  }
  if (a === null || a === undefined || typeof a !== "object") return String(a);
  return safeJson(a);
}

/** One line, masked, length-capped — or null when the message is dropped. */
export function trimLogMessage(args: unknown[], level: "log" | "warn" | "error"): string | null {
  const first = args[0];
  const firstStr = typeof first === "string" ? first.trimStart() : "";
  if (firstStr && DROP_ANY_LEVEL.some((p) => firstStr.startsWith(p))) return null;
  if (level === "log") {
    if (typeof first === "string" && DROP_EXACT_FIRST_ARG.has(first.trim())) return null;
    if (firstStr && DROP_PREFIXES.some((p) => firstStr.startsWith(p))) return null;
    if (firstStr && DROP_PUBLISH.test(firstStr)) return null;
  }
  let line = args.map(formatArg).join(" ").replace(/\r?\n+/g, " | ").replace(/\s+\|\s+(\|\s+)+/g, " | ");
  if (level === "log" && SEPARATOR_ONLY.test(line)) return null;
  if (!line.trim()) return null;
  line = maskSecrets(line);
  if (line.length > MAX_LEN && !NEVER_CUT.some((t) => line!.startsWith(t))) line = `${line.slice(0, MAX_LEN)}… [${line.length - MAX_LEN} more chars]`;
  return line;
}

let installed = false;
export function installLogTrim(): void {
  if (!ENABLED || installed) return;
  installed = true;
  const orig = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };
  const wrap = (fn: (...a: any[]) => void, level: "log" | "warn" | "error") => (...args: any[]) => {
    let line: string | null;
    try {
      line = trimLogMessage(args, level);
    } catch {
      return fn(...args); // never lose a message because of the trimmer
    }
    if (line !== null) fn(line);
  };
  console.log = wrap(orig.log, "log");
  console.info = wrap(orig.info, "log");
  console.debug = wrap(orig.debug, "log");
  console.warn = wrap(orig.warn, "warn");
  console.error = wrap(orig.error, "error");
}

installLogTrim();
