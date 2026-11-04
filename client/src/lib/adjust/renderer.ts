// Photo Adjust: renderers.
//
// WebGL2 is the main path: one fragment shader that mirrors colour.ts
// exactly. The same shader draws the live preview and the full-size image
// that gets saved, so the saved photo is what the user saw.
// CpuRenderer is the fallback (no WebGL2, or the photo is bigger than the
// GPU's texture limit) and calls colour.ts directly.

import {
  CONTRAST_FLATTEN,
  CONTRAST_S_AMOUNT,
  HIGHLIGHT_ZONE,
  LUMA_B,
  LUMA_G,
  LUMA_R,
  MASK_DETAIL_MIX,
  SHADOW_ZONE,
  SHOULDER_START,
  HIGHLIGHT_STOPS,
  SHADOW_STOPS,
  adjustPixel,
  computeUniforms,
  outputToSource,
  planGeometry,
} from "./colour";
import type { AdjustParams } from "./params";

export interface AdjustSource {
  /** full-resolution decoded photo */
  image: ImageBitmap | HTMLCanvasElement | HTMLImageElement;
  width: number;
  height: number;
  /** blurred luminance (from buildLumaMask) at analysis resolution */
  mask: Uint8Array;
  maskWidth: number;
  maskHeight: number;
}

export interface AdjustRenderer {
  readonly kind: "webgl2" | "cpu";
  /** Draw `params` into the renderer's canvas at outW × outH pixels. */
  render(params: AdjustParams, outW: number, outH: number): void;
  dispose(): void;
}

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));

const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
out vec2 vOut; // output position in pixels, y down
uniform vec2 uOutSize;
void main() {
  vOut = vec2((aPos.x * 0.5 + 0.5) * uOutSize.x, (0.5 - aPos.y * 0.5) * uOutSize.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vOut;
out vec4 outColor;
uniform sampler2D uImage;
uniform sampler2D uMask;
uniform vec2 uSrcSize;
uniform vec2 uOutSize;
uniform float uAngle;
uniform float uScale;
uniform float uEv;
uniform vec3 uWb;
uniform float uHighlights;
uniform float uShadows;
uniform float uShoulder;
uniform float uContrast;
uniform float uVibrance;
uniform float uSaturation;

const vec3 LUMA = vec3(${f(LUMA_R)}, ${f(LUMA_G)}, ${f(LUMA_B)});

float toLin(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
vec3 toLin(vec3 c) { return vec3(toLin(c.r), toLin(c.g), toLin(c.b)); }
float toSrgb(float c) { c = max(0.0, c); return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
vec3 toSrgb(vec3 c) { return vec3(toSrgb(c.r), toSrgb(c.g), toSrgb(c.b)); }
vec3 shoulder(vec3 x) {
  float s = ${f(SHOULDER_START)};
  float room = 1.0 - s;
  vec3 rolled = s + room * (1.0 - exp(-(x - s) / room));
  return mix(x, rolled, step(vec3(s), x));
}

void main() {
  // Geometry: output pixel -> source pixel (inverse clockwise rotation, zoom to fill).
  vec2 p = (vOut - 0.5 * uOutSize) / uScale;
  float c = cos(uAngle);
  float s = sin(uAngle);
  vec2 src = vec2(c * p.x + s * p.y, -s * p.x + c * p.y) + 0.5 * uSrcSize;
  vec2 uv = clamp(src / uSrcSize, vec2(0.0), vec2(1.0));

  vec3 rgb = texture(uImage, uv).rgb;
  float maskSrgb = texture(uMask, uv).r;

  float expo = exp2(uEv);
  vec3 lin = toLin(rgb) * uWb * expo;

  if (uHighlights != 0.0 || uShadows != 0.0) {
    float pixelY = dot(lin, LUMA);
    float maskY = toLin(maskSrgb) * expo;
    float m = toSrgb(min(1.0, (1.0 - ${f(MASK_DETAIL_MIX)}) * maskY + ${f(MASK_DETAIL_MIX)} * pixelY));
    float wh = smoothstep(${f(HIGHLIGHT_ZONE[0])}, ${f(HIGHLIGHT_ZONE[1])}, m);
    float ws = 1.0 - smoothstep(${f(SHADOW_ZONE[0])}, ${f(SHADOW_ZONE[1])}, m);
    lin *= exp2(${f(HIGHLIGHT_STOPS)} * uHighlights * wh + ${f(SHADOW_STOPS)} * uShadows * ws);
  }

  if (uShoulder > 0.0) {
    lin = mix(lin, shoulder(lin), uShoulder);
  }

  vec3 pc = clamp(toSrgb(lin), 0.0, 1.0);

  if (uContrast > 0.0) {
    pc += (pc * pc * (3.0 - 2.0 * pc) - pc) * (${f(CONTRAST_S_AMOUNT)} * uContrast);
  } else if (uContrast < 0.0) {
    pc += (0.5 + (pc - 0.5) * ${f(CONTRAST_FLATTEN)} - pc) * (-uContrast);
  }

  if (uVibrance != 0.0 || uSaturation != 0.0) {
    float y = dot(pc, LUMA);
    float chroma = max(pc.r, max(pc.g, pc.b)) - min(pc.r, min(pc.g, pc.b));
    float factor = (1.0 + uVibrance * (1.0 - chroma)) * (1.0 + uSaturation);
    pc = y + (pc - y) * factor;
  }

  outColor = vec4(clamp(pc, 0.0, 1.0), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("adjust: createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`adjust: shader compile failed: ${log}`);
  }
  return shader;
}

export class WebGLAdjustRenderer implements AdjustRenderer {
  readonly kind = "webgl2" as const;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private imageTex: WebGLTexture;
  private maskTex: WebGLTexture;
  private vao: WebGLVertexArrayObject;
  private buffer: WebGLBuffer;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  /** Returns null when WebGL2 is unavailable or the photo is too large for this GPU. */
  static create(canvas: HTMLCanvasElement, source: AdjustSource, opts: { preserveDrawingBuffer?: boolean } = {}): WebGLAdjustRenderer | null {
    try {
      const gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
      });
      if (!gl) return null;
      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      if (source.width > maxTex || source.height > maxTex) return null;
      return new WebGLAdjustRenderer(canvas, gl, source);
    } catch (err) {
      console.warn("[adjust] WebGL2 unavailable, using CPU renderer", err);
      return null;
    }
  }

  private constructor(private canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, private source: AdjustSource) {
    this.gl = gl;
    const program = gl.createProgram();
    if (!program) throw new Error("adjust: createProgram failed");
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`adjust: link failed: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
    for (const name of [
      "uImage", "uMask", "uSrcSize", "uOutSize", "uAngle", "uScale", "uEv", "uWb",
      "uHighlights", "uShadows", "uShoulder", "uContrast", "uVibrance", "uSaturation",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }

    // Full-screen triangle pair.
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

    // Photo texture, with mipmaps so the small preview isn't jagged.
    this.imageTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source.image as TexImageSource);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Tone mask (single channel).
    this.maskTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, source.maskWidth, source.maskHeight, 0, gl.RED, gl.UNSIGNED_BYTE, source.mask);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  render(params: AdjustParams, outW: number, outH: number): void {
    const gl = this.gl;
    if (this.canvas.width !== outW) this.canvas.width = outW;
    if (this.canvas.height !== outH) this.canvas.height = outH;
    const g = planGeometry(this.source.width, this.source.height, params);
    const u = computeUniforms(params);
    // The preview is drawn smaller than the photo: scale the geometry so
    // "output pixels" stay in full-resolution units.
    const k = g.outW / outW;

    gl.viewport(0, 0, outW, outH);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.uniform1i(this.uniforms.uImage, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(this.uniforms.uMask, 1);
    gl.uniform2f(this.uniforms.uSrcSize, this.source.width, this.source.height);
    gl.uniform2f(this.uniforms.uOutSize, outW, outH);
    gl.uniform1f(this.uniforms.uAngle, g.angle);
    gl.uniform1f(this.uniforms.uScale, g.scale / k);
    gl.uniform1f(this.uniforms.uEv, u.ev);
    gl.uniform3f(this.uniforms.uWb, u.wb[0], u.wb[1], u.wb[2]);
    gl.uniform1f(this.uniforms.uHighlights, u.highlights);
    gl.uniform1f(this.uniforms.uShadows, u.shadows);
    gl.uniform1f(this.uniforms.uShoulder, u.shoulder);
    gl.uniform1f(this.uniforms.uContrast, u.contrast);
    gl.uniform1f(this.uniforms.uVibrance, u.vibrance);
    gl.uniform1f(this.uniforms.uSaturation, u.saturation);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.imageTex);
    gl.deleteTexture(this.maskTex);
    gl.deleteBuffer(this.buffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** Bilinear sample of an RGBA buffer at source pixel coords (pixel centres at +0.5). */
function sampleRgba(data: Uint8ClampedArray, w: number, h: number, x: number, y: number, out: number[]) {
  const fx = Math.min(w - 1, Math.max(0, x - 0.5));
  const fy = Math.min(h - 1, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  for (let c = 0; c < 3; c++) {
    const a = data[(y0 * w + x0) * 4 + c];
    const b = data[(y0 * w + x1) * 4 + c];
    const d = data[(y1 * w + x0) * 4 + c];
    const e = data[(y1 * w + x1) * 4 + c];
    out[c] = ((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty) / 255;
  }
}

function sampleMask(mask: Uint8Array, mw: number, mh: number, u: number, v: number): number {
  const fx = Math.min(mw - 1, Math.max(0, u * mw - 0.5));
  const fy = Math.min(mh - 1, Math.max(0, v * mh - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(mw - 1, x0 + 1);
  const y1 = Math.min(mh - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = mask[y0 * mw + x0];
  const b = mask[y0 * mw + x1];
  const d = mask[y1 * mw + x0];
  const e = mask[y1 * mw + x1];
  return ((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty) / 255;
}

/**
 * Pure CPU render into an RGBA buffer (also used by tests as the reference).
 * `srcPixels` is the full-resolution photo.
 */
export function renderCpuPixels(
  srcPixels: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  mask: Uint8Array,
  maskW: number,
  maskH: number,
  params: AdjustParams,
  outW: number,
  outH: number
): Uint8ClampedArray {
  const g = planGeometry(srcW, srcH, params);
  const u = computeUniforms(params);
  const k = g.outW / outW;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const rgb = [0, 0, 0];
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const [sx, sy] = outputToSource((ox + 0.5) * k, (oy + 0.5) * k, srcW, srcH, g);
      sampleRgba(srcPixels, srcW, srcH, sx, sy, rgb);
      const m = sampleMask(mask, maskW, maskH, Math.min(1, Math.max(0, sx / srcW)), Math.min(1, Math.max(0, sy / srcH)));
      const [r, gg, b] = adjustPixel(rgb[0], rgb[1], rgb[2], m, u);
      const i = (oy * outW + ox) * 4;
      out[i] = Math.round(r * 255);
      out[i + 1] = Math.round(gg * 255);
      out[i + 2] = Math.round(b * 255);
      out[i + 3] = 255;
    }
  }
  return out;
}

export class CpuAdjustRenderer implements AdjustRenderer {
  readonly kind = "cpu" as const;
  private pixels: Uint8ClampedArray;

  constructor(private canvas: HTMLCanvasElement, private source: AdjustSource) {
    const c = document.createElement("canvas");
    c.width = source.width;
    c.height = source.height;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(source.image as CanvasImageSource, 0, 0);
    this.pixels = ctx.getImageData(0, 0, source.width, source.height).data;
  }

  render(params: AdjustParams, outW: number, outH: number): void {
    const s = this.source;
    const data = renderCpuPixels(this.pixels, s.width, s.height, s.mask, s.maskWidth, s.maskHeight, params, outW, outH);
    this.canvas.width = outW;
    this.canvas.height = outH;
    const ctx = this.canvas.getContext("2d")!;
    ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, outW, outH), 0, 0);
  }

  dispose(): void {
    this.pixels = new Uint8ClampedArray(0);
  }
}

export function createAdjustRenderer(canvas: HTMLCanvasElement, source: AdjustSource, opts: { preserveDrawingBuffer?: boolean } = {}): AdjustRenderer {
  return WebGLAdjustRenderer.create(canvas, source, opts) || new CpuAdjustRenderer(canvas, source);
}

/** Render the full-resolution result and return it as a lossless PNG. */
export async function renderFullSizePng(source: AdjustSource, params: AdjustParams): Promise<{ blob: Blob; width: number; height: number }> {
  const g = planGeometry(source.width, source.height, params);
  const canvas = document.createElement("canvas");
  const renderer = createAdjustRenderer(canvas, source, { preserveDrawingBuffer: true });
  try {
    renderer.render(params, g.outW, g.outH);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not create the adjusted image");
    return { blob, width: g.outW, height: g.outH };
  } finally {
    renderer.dispose();
  }
}

/**
 * Decode a photo blob and build everything the renderers need
 * (full-size bitmap, tone mask, small analysis pixels for Auto).
 */
export async function prepareAdjustSource(blob: Blob): Promise<{ source: AdjustSource; analysis: { pixels: Uint8ClampedArray; width: number; height: number } }> {
  const image = await createImageBitmap(blob, { imageOrientation: "from-image", premultiplyAlpha: "none" } as ImageBitmapOptions);
  const longEdge = Math.max(image.width, image.height);
  const a = Math.min(1, 512 / longEdge);
  const aw = Math.max(8, Math.round(image.width * a));
  const ah = Math.max(8, Math.round(image.height * a));
  const c = document.createElement("canvas");
  c.width = aw;
  c.height = ah;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, aw, ah);
  const pixels = ctx.getImageData(0, 0, aw, ah).data;
  const { buildLumaMask } = await import("./auto");
  const mask = buildLumaMask(pixels, aw, ah);
  return {
    source: { image, width: image.width, height: image.height, mask, maskWidth: aw, maskHeight: ah },
    analysis: { pixels, width: aw, height: ah },
  };
}
