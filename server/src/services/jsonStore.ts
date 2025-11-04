import * as fs from "node:fs";
import * as path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), "server", "data");
const dataDir = DATA_DIR;

// make sure it exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export function readJsonFile<T>(fileName: string, fallback: T): T {
  const full = path.join(dataDir, fileName);
  if (!fs.existsSync(full)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(full, "utf8")) as T;
  } catch (err) {
    console.error(`[jsonStore] Failed to read ${fileName}`, err);
    return fallback;
  }
}

export function writeJsonFile<T>(fileName: string, data: T): void {
  const full = path.join(dataDir, fileName);
  fs.writeFileSync(full, JSON.stringify(data, null, 2), "utf8");
}
