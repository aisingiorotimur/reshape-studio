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
  /** Fraction of background pixels a full row/column needs to count as a grid gutter. Defaults to 0.97. */
  gridGutterFraction?: number;
  /** Minimum consecutive background rows/columns to count as a real grid gutter, in pixels. Defaults to 2. */
  gridMinGutterThickness?: number;
  /**
   * Maximum consecutive background columns within a row-strip still treated
   * as a grid gutter, as a fraction of the strip's width. A run wider than
   * this is almost always empty space inside one photo (e.g. a plain wall
   * around a small subject, or the gap around a decorative element) rather
   * than a divider between cells — sized as a fraction of strip width, not
   * an absolute pixel count, since real gutters stay a small fraction of the
   * row's total width regardless of how large the image is, while margins
   * inside one cell scale up right along with it. Defaults to 0.12.
   */
  gridMaxGutterFraction?: number;
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
const DEFAULT_GRID_GUTTER_FRACTION = 0.97;
const DEFAULT_GRID_MIN_GUTTER_THICKNESS = 2;
const DEFAULT_GRID_MAX_GUTTER_FRACTION = 0.12;
/** A single leftover blob covering more than this share of the canvas is "one photo", not a combined sheet. */
const SOLO_REGION_AREA_RATIO = 0.92;

/**
 * Detects individually-framed photos inside one combined image (e.g. a
 * scanned contact sheet or a manually collaged grid).
 *
 * Tries two strategies:
 *  1. Grid-line cutting: finds rows/columns that are almost entirely the
 *     background color all the way across, and uses them as cut lines. This
 *     is the primary strategy because it stays correct even when a cell's
 *     own interior (e.g. a plain wall behind a close-up) matches the gutter
 *     color — foreground/background masking alone falls apart there, since
 *     it sees small islands of "content" rather than one solid cell.
 *  2. Foreground blobbing: falls back to grouping non-background pixels into
 *     blobs when the image isn't laid out as a clean grid (e.g. loose photos
 *     scattered at arbitrary positions on a background).
 *
 * Returns an empty array when the image looks like a single photo already.
 */
export function detectSegments(
  buffer: PixelBuffer,
  options: DetectSegmentsOptions = {},
): SegmentRegion[] {
  const { width, height } = buffer;
  if (width < 2 || height < 2) return [];

  const gridRegions = detectGridCuts(buffer, options);
  if (gridRegions.length >= 2) return gridRegions;

  return detectForegroundBlobs(buffer, options);
}

function detectGridCuts(buffer: PixelBuffer, options: DetectSegmentsOptions): SegmentRegion[] {
  const { data, width, height } = buffer;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minSide = options.minSide ?? DEFAULT_MIN_SIDE;
  const padding = options.padding ?? DEFAULT_PADDING;
  const gutterFraction = options.gridGutterFraction ?? DEFAULT_GRID_GUTTER_FRACTION;
  const minGutterThickness = options.gridMinGutterThickness ?? DEFAULT_GRID_MIN_GUTTER_THICKNESS;
  const maxGutterFraction = options.gridMaxGutterFraction ?? DEFAULT_GRID_MAX_GUTTER_FRACTION;
  const maxGutterThickness = Math.max(24, Math.round(width * maxGutterFraction));

  const background = estimateBackgroundColor(data, width, height);
  const mask = buildForegroundMask(data, width, height, background, threshold * threshold);

  const isRowGutter = (y: number) => {
    let backgroundCount = 0;
    const rowStart = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!mask[rowStart + x]) backgroundCount += 1;
    }
    return backgroundCount / width >= gutterFraction;
  };
  // The row pass considers the FULL image width at once, so a background row
  // there means every cell in that row is absent — always safe to cut on, no
  // matter how wide the resulting gap is. Only the column pass (below, run
  // per row-strip) needs the max-thickness cap, since a wide background run
  // there can just as easily be empty space inside one cell as a real gutter.
  const rowBands = contentBands(height, isRowGutter, minGutterThickness, Infinity, minSide);

  const regions: Box[] = [];
  for (const [y0, y1] of rowBands) {
    const stripHeight = y1 - y0;
    const isColGutter = (x: number) => {
      let backgroundCount = 0;
      for (let y = y0; y < y1; y += 1) {
        if (!mask[y * width + x]) backgroundCount += 1;
      }
      return backgroundCount / stripHeight >= gutterFraction;
    };
    const colBands = contentBands(width, isColGutter, minGutterThickness, maxGutterThickness, minSide);
    for (const [x0, x1] of colBands) {
      regions.push({ x: x0, y: y0, width: x1 - x0, height: stripHeight });
    }
  }

  return regions.map((box) => padBox(box, padding, width, height)).sort(readingOrder);
}

/**
 * Scans a 1D span of `length` positions and treats a run of "gutter"
 * positions as a real divider only when its length falls within
 * [minGutterThickness, maxGutterThickness] — too thin looks like noise, too
 * wide looks like empty space inside a single cell rather than a boundary
 * between cells. Everything else is folded back into content, and the
 * resulting content runs are returned as [start, end) bands, dropping any
 * band narrower than `minBandSize`.
 */
function contentBands(
  length: number,
  isGutter: (index: number) => boolean,
  minGutterThickness: number,
  maxGutterThickness: number,
  minBandSize: number,
): Array<[number, number]> {
  const gutter = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) gutter[i] = isGutter(i) ? 1 : 0;

  // Discard gutter runs that are too thin (noise) or too wide (empty space
  // inside a cell, not a deliberate divider) to be a real boundary.
  let runStart = -1;
  for (let i = 0; i <= length; i += 1) {
    const isGutterHere = i < length && gutter[i] === 1;
    if (isGutterHere && runStart === -1) {
      runStart = i;
    } else if (!isGutterHere && runStart !== -1) {
      const runLength = i - runStart;
      if (runLength < minGutterThickness || runLength > maxGutterThickness) {
        for (let j = runStart; j < i; j += 1) gutter[j] = 0;
      }
      runStart = -1;
    }
  }

  const bands: Array<[number, number]> = [];
  let bandStart = -1;
  for (let i = 0; i <= length; i += 1) {
    const isContent = i < length && gutter[i] === 0;
    if (isContent && bandStart === -1) {
      bandStart = i;
    } else if (!isContent && bandStart !== -1) {
      if (i - bandStart >= minBandSize) bands.push([bandStart, i]);
      bandStart = -1;
    }
  }
  return bands;
}

function detectForegroundBlobs(buffer: PixelBuffer, options: DetectSegmentsOptions): SegmentRegion[] {
  const { data, width, height } = buffer;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minAreaRatio = options.minAreaRatio ?? DEFAULT_MIN_AREA_RATIO;
  const minSide = options.minSide ?? DEFAULT_MIN_SIDE;
  const padding = options.padding ?? DEFAULT_PADDING;
  const mergeGap = options.mergeGap ?? DEFAULT_MERGE_GAP;
  const closeRadius = options.closeRadius ?? DEFAULT_CLOSE_RADIUS;

  const background = estimateBackgroundColor(data, width, height);
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

/**
 * Estimates the background/gutter color as the modal color across the whole
 * image, not just its outer border. A collaged photo can bleed all the way to
 * the frame edge (no real margin), so border sampling alone can pick up
 * actual photo content instead of the gutter color between cells.
 */
function estimateBackgroundColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { r: number; g: number; b: number } {
  const totalPixels = width * height;
  const targetSamples = 20_000;
  const stride = Math.max(1, Math.floor(Math.sqrt(totalPixels / targetSamples)));
  const bucketSize = 12;

  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const key =
        (Math.floor(r / bucketSize) << 16) |
        (Math.floor(g / bucketSize) << 8) |
        Math.floor(b / bucketSize);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.count += 1;
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
      } else {
        buckets.set(key, { count: 1, r, g, b });
      }
    }
  }

  let best: { count: number; r: number; g: number; b: number } | undefined;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  if (!best) return { r: 255, g: 255, b: 255 };
  return { r: best.r / best.count, g: best.g / best.count, b: best.b / best.count };
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
