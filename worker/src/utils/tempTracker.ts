/**
 * Tracks temp files created during a job so they can be cleaned up in a finally block.
 * Usage:
 *   const tracker = createTempTracker();
 *   const p = tracker.track(downloadToTemp(url, hint));
 *   // ... use p ...
 *   tracker.cleanup(); // in finally block
 */
import fs from "fs";

export interface TempTracker {
  /** Register a path for cleanup. Returns the same path for chaining. */
  track(pathOrPromise: string): string;
  /** Register a path from a promise. Returns the promise unchanged. */
  trackAsync(p: Promise<string>): Promise<string>;
  /** Best-effort delete all tracked files. Safe to call multiple times. */
  cleanup(): void;
}

export function createTempTracker(): TempTracker {
  const paths: string[] = [];

  return {
    track(filePath: string): string {
      if (filePath) paths.push(filePath);
      return filePath;
    },

    trackAsync(p: Promise<string>): Promise<string> {
      return p.then((filePath) => {
        if (filePath) paths.push(filePath);
        return filePath;
      });
    },

    cleanup(): void {
      for (const p of paths) {
        try {
          if (fs.existsSync(p)) {
            fs.unlinkSync(p);
          }
        } catch {
          // Ignore ENOENT or permission errors — best-effort
        }
      }
      paths.length = 0;
    },
  };
}
