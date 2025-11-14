import sharp from "sharp";
// Adjust import paths as needed for your project
// import { detectWindows } from "../ai/windowDetector";
// import { validateWindows } from "../ai/windowValidator";

export interface WindowLockOptions {
  mask?: Buffer;
  preMaskWindows?: boolean;
  preFillColor?: [number, number, number];
  useNoiseFill?: boolean;
  validate?: boolean;
  rejectOnValidationFail?: boolean;
  ai?: any;
}

export interface WindowLockResult {
  maskedForModel: Buffer;
  preservedWindows: Buffer;
  windowMask: Buffer;
  restored: Buffer;
  validationOk?: boolean;
}

export async function prepareWindowLock(
  original: Buffer,
  opts: WindowLockOptions = {}
): Promise<WindowLockResult> {
  let windowMask = opts.mask;
  if (!windowMask && opts.ai) {
    // Auto-detect: expects detectWindows to return mask or coordinates
    const imageB64 = original.toString("base64");
    const detection = await opts.ai.detectWindows(imageB64);
    if (detection && detection.windows && detection.windows.length > 0) {
      const { width, height } = await sharp(original).metadata();
      let maskBuffer = Buffer.alloc(width! * height!, 0);
      for (const win of detection.windows) {
        const [x, y, w, h] = win.bbox;
        for (let row = y; row < y + h; row++) {
          for (let col = x; col < x + w; col++) {
            if (row >= 0 && row < height! && col >= 0 && col < width!) {
              maskBuffer[row * width! + col] = 255;
            }
          }
        }
      }
      windowMask = await sharp(maskBuffer, {
        raw: { width: width!, height: height!, channels: 1 }
      }).png().toBuffer();
    }
  }

  // Ensure mask is single-channel 8-bit
  if (windowMask) {
    const maskMeta = await sharp(windowMask).metadata();
    if ((maskMeta.channels ?? 1) > 1) {
      windowMask = await sharp(windowMask)
        .ensureAlpha()
        .extractChannel("alpha")
        .toColourspace("b-w")
        .toBuffer();
    }
  }

  const preservedWindows = original;
  let maskedForModel = original;
  if (opts.preMaskWindows && windowMask) {
    const { width, height } = await sharp(original).metadata();
    const fillColor = opts.preFillColor ?? [255, 255, 255];
    let fill: Buffer;
    if (opts.useNoiseFill) {
      const noiseArray = Buffer.alloc(width! * height! * 3);
      for (let i = 0; i < noiseArray.length; i++) {
        noiseArray[i] = Math.floor(Math.random() * 256);
      }
      fill = await sharp(noiseArray, {
        raw: { width: width!, height: height!, channels: 3 }
      }).png().toBuffer();
    } else {
      fill = await sharp({
        create: {
          width: width!,
          height: height!,
          channels: 3,
          background: { r: fillColor[0], g: fillColor[1], b: fillColor[2] }
        }
      }).png().toBuffer();
    }
    maskedForModel = await sharp(original)
      .composite([
        {
          input: fill,
          blend: "over",
          mask: { input: windowMask }
        }
      ])
      .toBuffer();
  }

  return {
    maskedForModel,
    preservedWindows,
    windowMask: windowMask!,
    restored: original // placeholder until stageModelOutputRestore is called
  };
}

export async function stageModelOutputRestore(
  modelOutput: Buffer,
  original: Buffer,
  windowMask: Buffer,
  opts: WindowLockOptions = {}
): Promise<WindowLockResult> {
  const restored = await sharp(modelOutput)
    .composite([
      {
        input: original,
        blend: "over",
        mask: { input: windowMask }
      }
    ])
    .toBuffer();

  let validationOk: boolean | undefined;
  if (opts.validate && opts.ai && typeof opts.ai.validateWindows === "function") {
    const v = await opts.ai.validateWindows(original, restored);
    validationOk = v.ok;
    if (!validationOk && opts.rejectOnValidationFail) {
      throw new Error("Window validation failed after restoration.");
    }
  }

  return {
    maskedForModel: modelOutput,
    preservedWindows: original,
    windowMask,
    restored,
    validationOk
  };
}
