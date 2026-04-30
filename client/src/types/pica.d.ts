declare module "pica" {
  interface ResizeOptions {
    alpha?: boolean;
    unsharpAmount?: number;
    unsharpRadius?: number;
    unsharpThreshold?: number;
  }

  export default class Pica {
    constructor(options?: Record<string, unknown>);
    resize(
      from: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
      to: HTMLCanvasElement | OffscreenCanvas,
      options?: ResizeOptions,
    ): Promise<void>;
  }
}