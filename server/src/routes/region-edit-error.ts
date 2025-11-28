import { Request, Response } from "express";

// Example error handler for region-edit
export function handleRegionEditError(err: any, req: Request, res: Response) {
  if (err && err.message && err.message.includes("IMAGE_HISTORY_NOT_FOUND")) {
    return res.status(404).json({
      error: "IMAGE_HISTORY_NOT_FOUND",
      message: "Editing is only available for images processed after 28 Nov 2025. Please re-upload this image to edit."
    });
  }
  if (err && err.message && err.message.includes("redis")) {
    return res.status(500).json({
      error: "REDIS_ERROR",
      message: "Something went wrong. Please try again later."
    });
  }
  // fallback
  return res.status(422).json({
    error: "UNPROCESSABLE_ENTITY",
    message: err?.message || "Unprocessable request."
  });
}
