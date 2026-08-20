import assert from "node:assert/strict";
import test from "node:test";
import { detectSegments } from "../app/lib/segmentation.ts";

function createBuffer(width, height, background) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = background[0];
    data[index + 1] = background[1];
    data[index + 2] = background[2];
    data[index + 3] = 255;
  }
  return { data, width, height };
}

function paintRect(buffer, x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const index = (yy * buffer.width + xx) * 4;
      buffer.data[index] = color[0];
      buffer.data[index + 1] = color[1];
      buffer.data[index + 2] = color[2];
      buffer.data[index + 3] = 255;
    }
  }
}

test("finds two separated photos on a white sheet", () => {
  const buffer = createBuffer(200, 120, [255, 255, 255]);
  paintRect(buffer, 10, 10, 40, 40, [10, 10, 10]);
  paintRect(buffer, 150, 20, 40, 40, [10, 10, 10]);

  const regions = detectSegments(buffer);

  assert.equal(regions.length, 2);
  const [first, second] = regions;
  assert.ok(first.x < second.x, "regions should be sorted left to right");
  // Padded boxes should still fully contain the original painted rectangles.
  assert.ok(first.x <= 10 && first.x + first.width >= 50);
  assert.ok(first.y <= 10 && first.y + first.height >= 50);
  assert.ok(second.x <= 150 && second.x + second.width >= 190);
});

test("returns nothing for a single edge-to-edge photo", () => {
  const buffer = createBuffer(100, 100, [40, 60, 90]);
  // Fill almost the entire frame so there's no real background to key off of.
  paintRect(buffer, 1, 1, 98, 98, [200, 120, 60]);

  const regions = detectSegments(buffer);

  assert.deepEqual(regions, []);
});

test("treats one dominant blob near full canvas size as a single photo", () => {
  const buffer = createBuffer(100, 100, [255, 255, 255]);
  paintRect(buffer, 2, 2, 96, 96, [20, 20, 20]);

  const regions = detectSegments(buffer);

  assert.deepEqual(regions, []);
});

test("filters out small noise specks", () => {
  const buffer = createBuffer(200, 200, [255, 255, 255]);
  paintRect(buffer, 20, 20, 60, 60, [10, 10, 10]);
  paintRect(buffer, 120, 120, 60, 60, [10, 10, 10]);
  // A handful of stray pixels, e.g. JPEG artifacts, should not become regions.
  paintRect(buffer, 5, 190, 2, 2, [10, 10, 10]);
  paintRect(buffer, 190, 5, 1, 1, [10, 10, 10]);

  const regions = detectSegments(buffer);

  assert.equal(regions.length, 2);
});

test("merges two blobs separated by a sub-pixel-noise gap", () => {
  // A real deliberate divider is now respected even when thin (that's the
  // whole point of the grid-cut strategy — see the tightly-packed template
  // test below), so only a gap this tiny — clearly noise, not a divider —
  // should still get folded back into one region.
  const buffer = createBuffer(200, 100, [255, 255, 255]);
  paintRect(buffer, 20, 20, 40, 40, [10, 10, 10]);
  paintRect(buffer, 61, 20, 40, 40, [10, 10, 10]); // 1px gap from the first rect

  const regions = detectSegments(buffer);

  assert.equal(regions.length, 1);
});

test("keeps two blobs separate when the gap exceeds mergeGap", () => {
  const buffer = createBuffer(200, 100, [255, 255, 255]);
  paintRect(buffer, 10, 20, 40, 40, [10, 10, 10]);
  paintRect(buffer, 130, 20, 40, 40, [10, 10, 10]); // 80px gap

  const regions = detectSegments(buffer, { mergeGap: 14 });

  assert.equal(regions.length, 2);
});

test("supports a grid of four combined photos in reading order", () => {
  // A realistic 20px divider, not the 50px gap used before — tight,
  // deliberately-spaced grids are the common case this module targets.
  const buffer = createBuffer(240, 240, [255, 255, 255]);
  paintRect(buffer, 10, 10, 90, 90, [200, 30, 30]);
  paintRect(buffer, 120, 10, 90, 90, [30, 200, 30]);
  paintRect(buffer, 10, 120, 90, 90, [30, 30, 200]);
  paintRect(buffer, 120, 120, 90, 90, [200, 200, 30]);

  const regions = detectSegments(buffer);

  assert.equal(regions.length, 4);
  assert.ok(regions[0].x < regions[1].x, "top row should read left to right");
  assert.ok(regions[0].y < regions[2].y, "second row should sort after the first");
});

// Real templates (e.g. a "4 close-ups on top, 1 wide shot on the bottom" social
// post) pack cells only a handful of pixels apart, with photo-like gradients
// instead of flat colors and no real margin around the outside of the collage —
// unlike every case above, whose wide gaps and solid fills made separation easy.
test("separates a tightly-packed 4-up-plus-banner template with photo-like cells", () => {
  const width = 1000;
  const height = 566;
  const gutter = 8;
  const outerMargin = 6;
  const topHeight = 220;
  const cream = [237, 224, 204];
  const buffer = createBuffer(width, height, cream);

  const paintPhotoCell = (x0, y0, w, h, baseA, baseB, blobColor) => {
    const blobX = x0 + w * 0.35;
    const blobY = y0 + h * 0.4;
    const blobRadius = Math.min(w, h) * 0.28;
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) {
        const t = ((x - x0) / w + (y - y0) / h) / 2;
        let color = [0, 1, 2].map((c) => Math.round(baseA[c] * (1 - t) + baseB[c] * t));
        const distance = Math.hypot(x - blobX, y - blobY);
        if (distance < blobRadius) {
          const mix = 1 - distance / blobRadius;
          color = color.map((v, i) => Math.round(v * (1 - mix) + blobColor[i] * mix));
        }
        const index = (y * width + x) * 4;
        buffer.data[index] = color[0];
        buffer.data[index + 1] = color[1];
        buffer.data[index + 2] = color[2];
        buffer.data[index + 3] = 255;
      }
    }
  };

  const cellWidth = Math.round((width - outerMargin * 2 - gutter * 3) / 4);
  const topCells = [
    [[160, 40, 40], [200, 90, 70], [245, 235, 220]],
    [[210, 200, 180], [150, 30, 30], [255, 255, 255]],
    [[40, 35, 30], [90, 70, 60], [220, 210, 195]],
    [[25, 22, 20], [60, 50, 45], [235, 225, 210]],
  ];
  for (let i = 0; i < 4; i += 1) {
    const x0 = Math.round(outerMargin + i * (cellWidth + gutter));
    paintPhotoCell(x0, outerMargin, cellWidth, topHeight, ...topCells[i]);
  }
  const bottomY = outerMargin + topHeight + gutter;
  paintPhotoCell(
    outerMargin,
    bottomY,
    width - outerMargin * 2,
    height - bottomY - outerMargin,
    [180, 30, 35],
    [225, 210, 190],
    [30, 25, 20],
  );

  const regions = detectSegments(buffer);

  assert.equal(regions.length, 5);
  const [topRow, bottomRow] = [regions.slice(0, 4), regions.slice(4)];
  for (let i = 0; i + 1 < topRow.length; i += 1) {
    assert.ok(topRow[i].x < topRow[i + 1].x, "top row should read left to right");
  }
  assert.ok(bottomRow[0].y > topRow[0].y, "banner should sort after the top row");
  assert.ok(bottomRow[0].width > topRow[0].width * 2, "banner should span most of the width");
});

// Reproduces the actually-reported failure: cells whose own interior is
// LARGELY the same color as the gutter (e.g. a plain wall taking up most of
// a close-up shot), not just a busy edge-to-edge photo. Foreground/background
// masking alone sees these as scattered small islands rather than one solid
// cell — this is why grid-line cutting (detecting full-span background rows
// and columns) is the primary strategy, with blob masking only as a fallback.
test("separates cells whose interior is mostly background-colored, like a plain wall behind a close-up", () => {
  const width = 1000;
  const height = 566;
  const gutter = 12;
  const outerMargin = 8;
  const topHeight = 220;
  const cream = [237, 224, 204];
  const buffer = createBuffer(width, height, cream);
  const cellWidth = Math.round((width - outerMargin * 2 - gutter * 3) / 4);

  // Panel 1: a red sleeve sweeping across ~62% of the frame, hand+pin lower-right.
  {
    const x0 = outerMargin;
    paintRect(buffer, x0, outerMargin, Math.round(cellWidth * 0.62), topHeight, [165, 40, 38]);
    paintRect(
      buffer,
      x0 + Math.round(cellWidth * 0.45),
      outerMargin + Math.round(topHeight * 0.35),
      Math.round(cellWidth * 0.35),
      Math.round(topHeight * 0.4),
      [230, 195, 165],
    );
  }
  // Panel 2: hand + hairpin on the left, plain cream wall filling the right side.
  {
    const x0 = outerMargin + cellWidth + gutter;
    paintRect(
      buffer,
      x0 + Math.round(cellWidth * 0.08),
      outerMargin + Math.round(topHeight * 0.3),
      Math.round(cellWidth * 0.55),
      Math.round(topHeight * 0.55),
      [225, 190, 160],
    );
    paintRect(
      buffer,
      x0 + Math.round(cellWidth * 0.15),
      outerMargin + Math.round(topHeight * 0.1),
      Math.round(cellWidth * 0.12),
      Math.round(topHeight * 0.35),
      [170, 35, 35],
    );
  }
  // Panel 3: dark hair bun taking up more than half the frame.
  {
    const x0 = outerMargin + 2 * (cellWidth + gutter);
    paintRect(buffer, x0 + Math.round(cellWidth * 0.3), outerMargin, Math.round(cellWidth * 0.7), topHeight, [35, 28, 24]);
    paintRect(
      buffer,
      x0 + Math.round(cellWidth * 0.05),
      outerMargin + Math.round(topHeight * 0.2),
      Math.round(cellWidth * 0.3),
      Math.round(topHeight * 0.5),
      [225, 190, 160],
    );
  }
  // Panel 4: dark hair fills almost the entire frame.
  {
    const x0 = outerMargin + 3 * (cellWidth + gutter);
    paintRect(buffer, x0, outerMargin, cellWidth, topHeight, [22, 18, 16]);
  }

  // Bottom banner: cream wall, curtains at both edges, two robed figures
  // connected by a hand — not floating apart with a background gap between them.
  const bottomY = outerMargin + topHeight + gutter;
  const bottomHeight = height - bottomY - outerMargin;
  const bottomWidth = width - outerMargin * 2;
  paintRect(buffer, outerMargin, bottomY, Math.round(bottomWidth * 0.06), bottomHeight, [150, 25, 25]);
  paintRect(
    buffer,
    outerMargin + bottomWidth - Math.round(bottomWidth * 0.06),
    bottomY,
    Math.round(bottomWidth * 0.06),
    bottomHeight,
    [150, 25, 25],
  );
  paintRect(buffer, outerMargin + Math.round(bottomWidth * 0.28), bottomY + 15, Math.round(bottomWidth * 0.22), bottomHeight - 15, [170, 35, 35]);
  paintRect(buffer, outerMargin + Math.round(bottomWidth * 0.5), bottomY + 15, Math.round(bottomWidth * 0.22), bottomHeight - 15, [170, 35, 35]);
  paintRect(
    buffer,
    outerMargin + Math.round(bottomWidth * 0.47),
    bottomY + 15,
    Math.round(bottomWidth * 0.06),
    Math.round((bottomHeight - 15) * 0.4),
    [225, 190, 160],
  );

  const regions = detectSegments(buffer);

  assert.equal(regions.length, 5);
  const topRow = regions.slice(0, 4);
  const banner = regions[4];
  for (let i = 0; i + 1 < topRow.length; i += 1) {
    assert.ok(topRow[i].x < topRow[i + 1].x, "top row should read left to right");
  }
  assert.ok(banner.y > topRow[0].y, "banner should sort after the top row");
  assert.ok(banner.width > topRow[0].width * 2, "banner should span most of the width");
});
