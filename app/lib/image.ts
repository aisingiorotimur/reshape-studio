import { debugSegmentation, detectSegments, type DetectSegmentsOptions, type SegmentRegion } from "./segmentation";

export type { DetectSegmentsOptions, SegmentRegion } from "./segmentation";

export type EditorOperation =
  | {
      kind: "resize";
      width: number;
      height: number;
    }
  | {
      kind: "crop";
      aspectRatio: number;
      /** Normalized focal point (0–1). The default is the image center. */
      focusX?: number;
      /** Normalized focal point (0–1). The default is the image center. */
      focusY?: number;
    }
  | {
      kind: "rotate";
      degrees: 90 | -90 | 180;
    }
  | {
      kind: "flip";
      axis: "horizontal" | "vertical";
    };

export interface RenderedImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

export interface OptimizedImage {
  dataUrl: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  mimeType: string;
  bytes: number;
}

export interface OptimizeImageOptions {
  /** Longest output edge. Defaults to 1600 pixels. */
  maxDimension?: number;
  /** Approximate compressed size. Defaults to 500 KiB. */
  targetBytes?: number;
  /** A lower, per-call upload limit; it cannot raise the hard limit. */
  maxInputBytes?: number;
  /** Highest quality attempted during compression. */
  quality?: number;
  /** Lowest quality attempted before reducing pixel dimensions. */
  minQuality?: number;
  outputType?: "image/webp" | "image/jpeg" | "image/png";
}

export const DEFAULT_MAX_DIMENSION = 1600;
export const DEFAULT_TARGET_BYTES = 500 * 1024;
export const MAX_INPUT_BYTES = 30 * 1024 * 1024;

const MAX_CANVAS_DIMENSION = 8192;
const MAX_CANVAS_PIXELS = 40_000_000;
const MAX_OPERATIONS = 100;
const MAX_SOURCE_DATA_URL_LENGTH = 20 * 1024 * 1024;
const DEFAULT_QUALITY = 0.88;
const DEFAULT_MIN_QUALITY = 0.42;
const MAX_DIMENSION_REDUCTION_PASSES = 6;
const QUALITY_SEARCH_PASSES = 6;

function requireBrowserCanvas(): void {
  if (typeof document === "undefined") {
    throw new Error("图片处理只能在浏览器中进行，请在页面加载后重试。");
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  requireBrowserCanvas();
  const safeWidth = normalizeDimension(width, "宽度");
  const safeHeight = normalizeDimension(height, "高度");
  assertCanvasArea(safeWidth, safeHeight);

  const canvas = document.createElement("canvas");
  canvas.width = safeWidth;
  canvas.height = safeHeight;
  return canvas;
}

function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("当前浏览器无法创建图片画布，请更新浏览器后重试。");
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return context;
}

function normalizeDimension(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}必须是大于 0 的数字。`);
  }

  const rounded = Math.round(value);
  if (rounded < 1) {
    throw new Error(`${label}太小，至少需要 1 像素。`);
  }
  if (rounded > MAX_CANVAS_DIMENSION) {
    throw new Error(`${label}不能超过 ${MAX_CANVAS_DIMENSION} 像素。`);
  }
  return rounded;
}

function assertCanvasArea(width: number, height: number): void {
  if (width * height > MAX_CANVAS_PIXELS) {
    throw new Error("图片像素总量过大，请将宽高缩小后重试。");
  }
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function hasSupportedImageType(file: File): boolean {
  const supportedMimeTypes = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
    "image/bmp",
  ]);
  return supportedMimeTypes.has(file.type.toLowerCase()) ||
    (!file.type && /\.(?:jpe?g|png|webp|gif|avif|bmp)$/i.test(file.name));
}

type DecodedFile = {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
};

async function decodeFile(file: File): Promise<DecodedFile> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => bitmap.close(),
      };
    } catch {
      // Some browsers expose createImageBitmap but cannot decode every supported
      // format with it. The HTMLImageElement path still honors EXIF orientation.
    }
  }

  if (typeof Image === "undefined" || typeof URL === "undefined") {
    throw new Error("当前浏览器不支持读取这张图片，请尝试 JPG、PNG、WebP 或 GIF。");
  }

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("图片解码失败"));
      image.src = objectUrl;
    });
  } catch {
    URL.revokeObjectURL(objectUrl);
    throw new Error("无法读取这张图片，文件可能已损坏或格式不受支持。");
  }

  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    dispose: () => {
      image.src = "";
      URL.revokeObjectURL(objectUrl);
    },
  };
}

async function loadDataUrl(sourceDataUrl: string): Promise<HTMLImageElement> {
  if (typeof Image === "undefined") {
    throw new Error("图片处理只能在浏览器中进行，请在页面加载后重试。");
  }
  if (!sourceDataUrl.startsWith("data:image/")) {
    throw new Error("图片来源无效，请重新导入图片。");
  }
  if (sourceDataUrl.length > MAX_SOURCE_DATA_URL_LENGTH) {
    throw new Error("图片数据过大，请重新导入并压缩后再试。");
  }

  const image = new Image();
  image.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("无法读取图片数据，请重新导入图片。"));
    image.src = sourceDataUrl;
  });
  return image;
}

function validateDecodedDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error("图片没有有效的宽高，请选择另一张图片。");
  }
  if (width > MAX_CANVAS_DIMENSION * 8 || height > MAX_CANVAS_DIMENSION * 8) {
    throw new Error("图片边长过大，无法安全处理，请先缩小图片。");
  }
  if (width * height > MAX_CANVAS_PIXELS * 2) {
    throw new Error("图片像素总量过大，无法安全处理，请先缩小图片。");
  }
}

function drawSourceToCanvas(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): HTMLCanvasElement {
  const canvas = createCanvas(targetWidth, targetHeight);
  getContext(canvas).drawImage(
    source,
    0,
    0,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}

function resizeCanvas(
  source: HTMLCanvasElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  return drawSourceToCanvas(source, source.width, source.height, width, height);
}

function validateFocus(value: number | undefined, label: string): number {
  if (value === undefined) return 0.5;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label}必须在 0 到 1 之间。`);
  }
  return value;
}

function cropCanvas(
  source: HTMLCanvasElement,
  aspectRatio: number,
  focusXValue?: number,
  focusYValue?: number,
): HTMLCanvasElement {
  if (!Number.isFinite(aspectRatio) || aspectRatio < 0.01 || aspectRatio > 100) {
    throw new Error("裁切比例必须是 0.01 到 100 之间的数字。");
  }

  const focusX = validateFocus(focusXValue, "横向焦点");
  const focusY = validateFocus(focusYValue, "纵向焦点");
  const sourceRatio = source.width / source.height;
  let cropWidth = source.width;
  let cropHeight = source.height;

  if (sourceRatio > aspectRatio) {
    cropWidth = source.height * aspectRatio;
  } else if (sourceRatio < aspectRatio) {
    cropHeight = source.width / aspectRatio;
  }

  const focalX = focusX * source.width;
  const focalY = focusY * source.height;
  const sourceX = Math.min(
    source.width - cropWidth,
    Math.max(0, focalX - cropWidth / 2),
  );
  const sourceY = Math.min(
    source.height - cropHeight,
    Math.max(0, focalY - cropHeight / 2),
  );
  const canvas = createCanvas(
    Math.max(1, Math.round(cropWidth)),
    Math.max(1, Math.round(cropHeight)),
  );

  getContext(canvas).drawImage(
    source,
    sourceX,
    sourceY,
    cropWidth,
    cropHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}

function rotateCanvas(
  source: HTMLCanvasElement,
  degrees: 90 | -90 | 180,
): HTMLCanvasElement {
  const swapsAxes = Math.abs(degrees) === 90;
  const canvas = createCanvas(
    swapsAxes ? source.height : source.width,
    swapsAxes ? source.width : source.height,
  );
  const context = getContext(canvas);

  if (degrees === 90) {
    context.translate(canvas.width, 0);
  } else if (degrees === -90) {
    context.translate(0, canvas.height);
  } else {
    context.translate(canvas.width, canvas.height);
  }
  context.rotate((degrees * Math.PI) / 180);
  context.drawImage(source, 0, 0);
  return canvas;
}

function flipCanvas(
  source: HTMLCanvasElement,
  axis: "horizontal" | "vertical",
): HTMLCanvasElement {
  const canvas = createCanvas(source.width, source.height);
  const context = getContext(canvas);

  if (axis === "horizontal") {
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
  } else {
    context.translate(0, canvas.height);
    context.scale(1, -1);
  }
  context.drawImage(source, 0, 0);
  return canvas;
}

function renderOperation(
  source: HTMLCanvasElement,
  operation: EditorOperation,
  index: number,
): HTMLCanvasElement {
  try {
    switch (operation.kind) {
      case "resize": {
        const width = normalizeDimension(operation.width, "目标宽度");
        const height = normalizeDimension(operation.height, "目标高度");
        assertCanvasArea(width, height);
        return resizeCanvas(source, width, height);
      }
      case "crop":
        return cropCanvas(
          source,
          operation.aspectRatio,
          operation.focusX,
          operation.focusY,
        );
      case "rotate":
        if (![90, -90, 180].includes(operation.degrees)) {
          throw new Error("旋转角度只能是 90°、-90° 或 180°。");
        }
        return rotateCanvas(source, operation.degrees);
      case "flip":
        if (operation.axis !== "horizontal" && operation.axis !== "vertical") {
          throw new Error("翻转方向必须是水平或垂直。");
        }
        return flipCanvas(source, operation.axis);
      default: {
        const exhaustive: never = operation;
        throw new Error(`不支持的操作：${String(exhaustive)}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    throw new Error(`第 ${index + 1} 步处理失败：${message}`);
  }
}

/**
 * Detects individually-framed photos inside the canvas (e.g. several prints
 * scanned together on one sheet) so each can be exported on its own.
 */
export function detectImageSegments(
  source: HTMLCanvasElement,
  options?: DetectSegmentsOptions,
): SegmentRegion[] {
  if (source.width < 1 || source.height < 1) {
    throw new Error("画布尺寸无效，无法检测独立图片。");
  }
  const imageData = getContext(source).getImageData(0, 0, source.width, source.height);
  return detectSegments({ data: imageData.data, width: source.width, height: source.height }, options);
}

export interface SegmentationDebugView {
  background: { r: number; g: number; b: number };
  /** Original image with pixels classified as "photo content" tinted magenta, background left as-is. */
  overlayCanvas: HTMLCanvasElement;
}

/**
 * Renders what auto-segmentation sees on this specific image: the background
 * color it estimated, and an overlay highlighting every pixel it classifies
 * as photo content vs. background/gutter. Useful for diagnosing a detection
 * that finds nothing or splits incorrectly.
 */
export function renderSegmentationDebugView(
  source: HTMLCanvasElement,
  options?: DetectSegmentsOptions,
): SegmentationDebugView {
  const imageData = getContext(source).getImageData(0, 0, source.width, source.height);
  const debugInfo = debugSegmentation(
    { data: imageData.data, width: source.width, height: source.height },
    options,
  );

  const overlay = createCanvas(source.width, source.height);
  const overlayContext = getContext(overlay);
  overlayContext.drawImage(source, 0, 0);
  const overlayData = overlayContext.getImageData(0, 0, source.width, source.height);
  for (let pixel = 0, index = 0; pixel < debugInfo.foregroundMask.length; pixel += 1, index += 4) {
    if (!debugInfo.foregroundMask[pixel]) continue;
    overlayData.data[index] = Math.min(255, overlayData.data[index] * 0.35 + 255 * 0.65);
    overlayData.data[index + 1] = Math.round(overlayData.data[index + 1] * 0.35);
    overlayData.data[index + 2] = Math.min(255, overlayData.data[index + 2] * 0.35 + 255 * 0.65);
  }
  overlayContext.putImageData(overlayData, 0, 0);

  return { background: debugInfo.background, overlayCanvas: overlay };
}

export function cropRegionToCanvas(
  source: HTMLCanvasElement,
  region: SegmentRegion,
): HTMLCanvasElement {
  const x = Math.max(0, Math.min(source.width - 1, Math.round(region.x)));
  const y = Math.max(0, Math.min(source.height - 1, Math.round(region.y)));
  const width = Math.max(1, Math.min(source.width - x, Math.round(region.width)));
  const height = Math.max(1, Math.min(source.height - y, Math.round(region.height)));
  const canvas = createCanvas(width, height);
  getContext(canvas).drawImage(source, x, y, width, height, 0, 0, width, height);
  return canvas;
}

export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/webp",
  quality = DEFAULT_QUALITY,
): Promise<Blob> {
  if (!canvas || canvas.width < 1 || canvas.height < 1) {
    throw new Error("画布尺寸无效，无法导出图片。");
  }
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new Error("导出质量必须在 0 到 1 之间。");
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("图片编码失败，请换用较小的尺寸后重试。"));
        }
      },
      type,
      quality,
    );
  });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader === "undefined") {
    throw new Error("当前浏览器无法生成图片数据，请更新浏览器后重试。");
  }

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("图片数据生成失败，请重试。"));
      }
    };
    reader.onerror = () => reject(new Error("图片数据读取失败，请重试。"));
    reader.readAsDataURL(blob);
  });
}

type CompressedCanvas = {
  canvas: HTMLCanvasElement;
  blob: Blob;
};

async function compressCanvas(
  source: HTMLCanvasElement,
  type: string,
  targetBytes: number,
  maximumQuality: number,
  minimumQuality: number,
): Promise<CompressedCanvas> {
  let workingCanvas = source;
  let smallest: CompressedCanvas | undefined;

  for (let dimensionPass = 0; dimensionPass <= MAX_DIMENSION_REDUCTION_PASSES; dimensionPass += 1) {
    const highQualityBlob = await canvasToBlob(workingCanvas, type, maximumQuality);
    if (!smallest || highQualityBlob.size < smallest.blob.size) {
      smallest = { canvas: workingCanvas, blob: highQualityBlob };
    }
    if (highQualityBlob.size <= targetBytes) {
      return { canvas: workingCanvas, blob: highQualityBlob };
    }

    const lowQualityBlob = await canvasToBlob(workingCanvas, type, minimumQuality);
    if (!smallest || lowQualityBlob.size < smallest.blob.size) {
      smallest = { canvas: workingCanvas, blob: lowQualityBlob };
    }

    if (lowQualityBlob.size <= targetBytes) {
      let low = minimumQuality;
      let high = maximumQuality;
      let bestBlob = lowQualityBlob;

      for (let qualityPass = 0; qualityPass < QUALITY_SEARCH_PASSES; qualityPass += 1) {
        const quality = (low + high) / 2;
        const candidate = await canvasToBlob(workingCanvas, type, quality);
        if (candidate.size <= targetBytes) {
          bestBlob = candidate;
          low = quality;
        } else {
          high = quality;
        }
      }
      return { canvas: workingCanvas, blob: bestBlob };
    }

    if (dimensionPass === MAX_DIMENSION_REDUCTION_PASSES) break;

    const estimatedScale = Math.sqrt(targetBytes / Math.max(1, lowQualityBlob.size)) * 0.94;
    const scale = Math.min(0.9, Math.max(0.55, estimatedScale));
    const nextWidth = Math.max(1, Math.floor(workingCanvas.width * scale));
    const nextHeight = Math.max(1, Math.floor(workingCanvas.height * scale));
    if (nextWidth === workingCanvas.width && nextHeight === workingCanvas.height) break;
    workingCanvas = resizeCanvas(workingCanvas, nextWidth, nextHeight);
  }

  // Extremely noisy images may remain slightly above the requested target even
  // after all safety-bounded passes. Returning the smallest valid result is more
  // useful than discarding a successfully decoded image.
  if (!smallest) {
    throw new Error("图片压缩失败，请尝试尺寸更小的图片。");
  }
  return smallest;
}

function readPositiveOption(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}必须是大于 0 的数字。`);
  }
  return value;
}

function readQualityOption(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label}必须在 0 到 1 之间。`);
  }
  return value;
}

export async function optimizeImageFile(
  file: File,
  options: OptimizeImageOptions = {},
): Promise<OptimizedImage> {
  requireBrowserCanvas();
  if (!(file instanceof File)) {
    throw new Error("请选择一个有效的图片文件。");
  }
  if (!hasSupportedImageType(file)) {
    throw new Error("暂不支持此格式，请选择 JPG、PNG、WebP、GIF 或 AVIF 图片。");
  }
  if (file.size < 1) {
    throw new Error("图片文件为空，请选择另一张图片。");
  }

  const requestedInputLimit = readPositiveOption(
    options.maxInputBytes,
    MAX_INPUT_BYTES,
    "文件大小上限",
  );
  const inputLimit = Math.min(requestedInputLimit, MAX_INPUT_BYTES);
  if (file.size > inputLimit) {
    throw new Error(`图片不能超过 ${formatMiB(inputLimit)}，请压缩后再上传。`);
  }

  const maxDimension = normalizeDimension(
    readPositiveOption(options.maxDimension, DEFAULT_MAX_DIMENSION, "最大边长"),
    "最大边长",
  );
  const targetBytes = readPositiveOption(
    options.targetBytes,
    DEFAULT_TARGET_BYTES,
    "目标文件大小",
  );
  const quality = readQualityOption(options.quality, DEFAULT_QUALITY, "最高质量");
  const minQuality = readQualityOption(
    options.minQuality,
    DEFAULT_MIN_QUALITY,
    "最低质量",
  );
  if (minQuality > quality) {
    throw new Error("最低质量不能高于最高质量。");
  }

  const decoded = await decodeFile(file);
  try {
    validateDecodedDimensions(decoded.width, decoded.height);
    const scale = Math.min(1, maxDimension / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = drawSourceToCanvas(
      decoded.source,
      decoded.width,
      decoded.height,
      width,
      height,
    );
    const compressed = await compressCanvas(
      canvas,
      options.outputType ?? "image/webp",
      targetBytes,
      quality,
      minQuality,
    );
    const dataUrl = await blobToDataUrl(compressed.blob);

    return {
      dataUrl,
      width: compressed.canvas.width,
      height: compressed.canvas.height,
      originalWidth: decoded.width,
      originalHeight: decoded.height,
      mimeType: compressed.blob.type || options.outputType || "image/webp",
      bytes: compressed.blob.size,
    };
  } finally {
    decoded.dispose();
  }
}

export async function renderOperations(
  sourceDataUrl: string,
  operations: readonly EditorOperation[],
): Promise<RenderedImage> {
  requireBrowserCanvas();
  if (!Array.isArray(operations)) {
    throw new Error("编辑记录格式无效，请重新打开分享链接。");
  }
  if (operations.length > MAX_OPERATIONS) {
    throw new Error(`编辑记录最多支持 ${MAX_OPERATIONS} 步。`);
  }

  const image = await loadDataUrl(sourceDataUrl);
  try {
    validateDecodedDimensions(image.naturalWidth, image.naturalHeight);
    let canvas = drawSourceToCanvas(
      image,
      image.naturalWidth,
      image.naturalHeight,
      image.naturalWidth,
      image.naturalHeight,
    );

    for (let index = 0; index < operations.length; index += 1) {
      canvas = renderOperation(canvas, operations[index], index);
    }

    return { canvas, width: canvas.width, height: canvas.height };
  } finally {
    image.src = "";
  }
}
