import pLimit from "p-limit";

export const UPLOAD_CONCURRENCY = 3;

const limit = pLimit(UPLOAD_CONCURRENCY);

export async function runUploadQueue<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  return await Promise.all(tasks.map((task) => limit(task)));
}