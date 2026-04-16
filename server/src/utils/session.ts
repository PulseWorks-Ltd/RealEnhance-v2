import type { Request } from "express";

export async function saveSession(req: Request): Promise<void> {
  if (!req.session) return;

  await new Promise<void>((resolve, reject) => {
    req.session.save((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}