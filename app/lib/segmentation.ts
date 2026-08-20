export interface SegmentRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelBuffer {
  /** RGBA pixel data, four bytes per pixel, row-major. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface DetectSegmentsOptions {
  /** Color-distance (0-255 per channel) that separates background from a photo. Defaults to 28. */
  threshold?: number;
  /** Regions smaller than this fraction of the total image area are discarded as noise. Defaults to 0.004. */
  minAreaRatio?: number;
  /** Minimum width/height, in pixels, for a detected region. Defaults to 24. */
  minSide?: number;
  /** Padding added around each detected bounding box, in pixels. Defaults to 4. */
  padding?: number;
  /** Regions within this many pixels of each other are merged into one. Defaults to 4. */
  mergeGap?: number;
  /** Passes of morphological closing used to bridge small gaps before labeling. Defaults to 1. */
  closeRadius?: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Component extends Box {
  area: number;
}

const DEFAULT_THRESHOLD = 28;
const DEFAULT_MIN_AREA_RATIO = 0.004;
const DEFAULT_MIN_SIDE = 24;
const DEFAULT_PADDING = 4;
// Real combined-photo templates commonly pack cells only 5-15px apart, far
// tighter than this module's own earlier tests assumed. Merging/closing too
// aggressively silently welds every cell into one blob, which then gets
// discarded as "not combined" — worse than leaving an occasional accidental
// split unmerged, so these defaults stay conservative.
const DEFAULT_MERGE_GAP = 4;
const DEFAULT_CLOSE_RADIUS = 1;
/** A single leftover blob covering more than this share of the canvas is "one photo", not a combined sheet. */
const SOLO_REGION_AREA_RATIO = 0.92;

/**
 * Detects individually-framed photos inside one combined image (e.g. a scanned
 * contact sheet or a manually collaged grid) by treating the color sampled from
 * the image border as background and grouping the remaining pixels into blobs.
 * Returns an empty array when the image looks like a single photo already.
 */
export function detectSegments(
  buffer: PixelBuffer,
  options: DetectSegmentsOptions = {},
): SegmentRegion[] {
  const { data, width, height } = buffer;
  if (width < 2 || height < 2) return [];

  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minAreaRatio = options.minAreaRatio ?? DEFAULT_MIN_AREA_RATIO;
  const minSide = options.minSide ?? DEFAULT_MIN_SIDE;
  const padding = options.padding ?? DEFAULT_PADDING;
  const mergeGap = options.mergeGap ?? DEFAULT_MERGE_GAP;
  const closeRadius = options.closeRadius ?? DEFAULT_CLOSE_RADIUS;

  const background = sampleBorderColor(data, width, height);
  const mask = closeMask(
    buildForegroundMask(data, width, height, background, threshold * threshold),
    width,
    height,
    closeRadius,
  );

  const totalArea = width * height;
  const minArea = Math.max(minAreaRatio * totalArea, minSide * minSide);

  let boxes: Box[] = labelComponents(mask, width, height)
    .filter(
      (component) =>
        component.area >= minArea &&
        component.width >= minSide &&
        component.height >= minSide,
    )
    .map(({ x, y, width: w, height: h }) => ({ x, y, width: w, height: h }));

  boxes = mergeCloseBoxes(boxes, mergeGap);

  if (boxes.length <= 1) {
    const solo = boxes[0];
    if (!solo || solo.width * solo.height >= totalArea * SOLO_REGION_AREA_RATIO) {
      return [];
    }
  }

  return boxes
    .map((box) => padBox(box, padding, width, height))
    .sort(readingOrder);
}

function sampleBorderColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { r: number; g: number; b: number } {
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  const sample = (x: number, y: number) => {
    const index = (y * width + x) * 4;
    r.push(data[index]);
    g.push(data[index + 1]);
    b.push(data[index + 2]);
  };

  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    sample(0, y);
    sample(width - 1, y);
  }

  return { r: median(r), g: median(g), b: median(b) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildForegroundMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  background: { r: number; g: number; b: number },
  thresholdSq: number,
): Uint8Array {
  const pixelCount = width * height;
  const mask = new Uint8Array(pixelCount);
  for (let pixel = 0, index = 0; pixel < pixelCount; pixel += 1, index += 4) {
    const dr = data[index] - background.r;
    const dg = data[index + 1] - background.g;
    const db = data[index + 2] - background.b;
    mask[pixel] = dr * dr + dg * dg + db * db > thresholdSq ? 1 : 0;
  }
  return mask;
}

// Dilation/erosion are separable for a square structuring element: a horizontal
// pass followed by a vertical pass equals one full 3x3-neighborhood pass, at a
// fraction of the cost of checking all eight neighbors per pixel.
function dilateHorizontal(mask: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      output[index] =
        mask[index] || (x > 0 && mask[index - 1]) || (x < width - 1 && mask[index + 1]) ? 1 : 0;
    }
  }
  return output;
}

function dilateVertical(mask: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      output[index] =
        mask[index] ||
        (y > 0 && mask[index - width]) ||
        (y < height - 1 && mask[index + width])
          ? 1
          : 0;
    }
  }
  return output;
}

function erodeHorizontal(mask: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      const left = x > 0 ? mask[index - 1] : 0;
      const right = x < width - 1 ? mask[index + 1] : 0;
      output[index] = mask[index] && left && right ? 1 : 0;
    }
  }
  return output;
}

function erodeVertical(mask: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      const up = y > 0 ? mask[index - width] : 0;
      const down = y < height - 1 ? mask[index + width] : 0;
      output[index] = mask[index] && up && down ? 1 : 0;
    }
  }
  return output;
}

function closeMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  let result = mask;
  for (let pass = 0; pass < radius; pass += 1) {
    result = dilateVertical(dilateHorizontal(result, width, height), width, height);
  }
  for (let pass = 0; pass < radius; pass += 1) {
    result = erodeVertical(erodeHorizontal(result, width, height), width, height);
  }
  return result;
}

function labelComponents(mask: Uint8Array, width: number, height: number): Component[] {
  const visited = new Uint8Array(mask.length);
  const components: Component[] = [];
  const stackX = new Int32Array(mask.length);
  const stackY = new Int32Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (!mask[start] || visited[start]) continue;

      let top = 0;
      stackX[top] = x;
      stackY[top] = y;
      top += 1;
      visited[start] = 1;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let area = 0;

      while (top > 0) {
        top -= 1;
        const cx = stackX[top];
        const cy = stackY[top];
        area += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = cy + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            if (nx < 0 || nx >= width) continue;
            const neighbor = ny * width + nx;
            if (mask[neighbor] && !visited[neighbor]) {
              visited[neighbor] = 1;
              stackX[top] = nx;
              stackY[top] = ny;
              top += 1;
            }
          }
        }
      }

      components.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area });
    }
  }

  return components;
}

function boxesAreClose(a: Box, b: Box, gap: number): boolean {
  const gapX = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const gapY = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return gapX <= gap && gapY <= gap;
}

function mergeBoxes(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width);
  const y2 = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: x2 - x, height: y2 - y };
}

function mergeCloseBoxes(boxes: Box[], gap: number): Box[] {
  let current = boxes;
  let mergedAny = true;

  while (mergedAny) {
    mergedAny = false;
    const next: Box[] = [];
    const used = new Array<boolean>(current.length).fill(false);

    for (let i = 0; i < current.length; i += 1) {
      if (used[i]) continue;
      let merged = current[i];
      used[i] = true;
      for (let j = i + 1; j < current.length; j += 1) {
        if (used[j]) continue;
        if (boxesAreClose(merged, current[j], gap)) {
          merged = mergeBoxes(merged, current[j]);
          used[j] = true;
          mergedAny = true;
        }
      }
      next.push(merged);
    }
    current = next;
  }

  return current;
}

function padBox(box: Box, padding: number, maxWidth: number, maxHeight: number): Box {
  const x = Math.max(0, box.x - padding);
  const y = Math.max(0, box.y - padding);
  const x2 = Math.min(maxWidth, box.x + box.width + padding);
  const y2 = Math.min(maxHeight, box.y + box.height + padding);
  return { x, y, width: x2 - x, height: y2 - y };
}

function readingOrder(a: Box, b: Box): number {
  const rowThreshold = Math.min(a.height, b.height) * 0.5;
  if (Math.abs(a.y - b.y) > rowThreshold) return a.y - b.y;
  return a.x - b.x;
}
