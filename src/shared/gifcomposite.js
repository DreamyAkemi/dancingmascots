'use strict';
/**
 * gifcomposite.js — builds the displayed picture of an animated GIF, frame by frame, in plain
 * memory (no <canvas> compositing), so the result is identical on every PC and graphics card.
 *
 * A GIF stores each frame as a small rectangle ("patch") that gets drawn over the previous result.
 * Pixels in a patch are either fully opaque or fully transparent (GIF has no partial alpha), and
 * each frame says what to do with its area afterwards ("disposal"):
 *   0/1 = leave it, 2 = clear it to transparent, 3 = put back what was there before.
 * We keep one full-size RGBA buffer and apply those rules to it.
 */

/**
 * @param {number} width   GIF logical screen width
 * @param {number} height  GIF logical screen height
 */
function createCompositor(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4); // starts fully transparent
  let saved = null; // copy of `pixels` for disposal method 3

  /** Clear a rectangle (clamped to the picture) back to transparent. */
  function clearRect(left, top, w, h) {
    const x0 = Math.max(0, left), x1 = Math.min(width, left + w);
    const y0 = Math.max(0, top), y1 = Math.min(height, top + h);
    for (let y = y0; y < y1; y++) pixels.fill(0, (y * width + x0) * 4, (y * width + x1) * 4);
  }

  return {
    pixels,

    /**
     * Draw one frame.
     * @param {object|null} prev   metadata of the previously drawn frame ({dims, disposalType}), or null
     *                             for the first frame of a loop
     * @param {object} frame       { dims:{left,top,width,height}, disposalType }
     * @param {Uint8ClampedArray} patch  RGBA pixels of the frame's rectangle (from gifuct-js)
     */
    draw(prev, frame, patch) {
      // 1. Undo / clear the previous frame as it asked.
      if (!prev) pixels.fill(0);
      else if (prev.disposalType === 2) clearRect(prev.dims.left, prev.dims.top, prev.dims.width, prev.dims.height);
      else if (prev.disposalType === 3 && saved) pixels.set(saved);

      // 2. If *this* frame will be undone with method 3, remember the picture as it is now.
      if (frame.disposalType === 3) saved = pixels.slice();

      // 3. Copy the opaque pixels of the patch in. Transparent ones are skipped, so whatever was
      //    underneath (or nothing) shows through, and their colour data is never used.
      const { left, top, width: w, height: h } = frame.dims;
      for (let y = 0; y < h; y++) {
        const py = y + top;
        if (py < 0 || py >= height) continue;
        for (let x = 0; x < w; x++) {
          const px = x + left, s = (y * w + x) * 4;
          if (px < 0 || px >= width || patch[s + 3] === 0) continue;
          const o = (py * width + px) * 4;
          pixels[o] = patch[s]; pixels[o + 1] = patch[s + 1]; pixels[o + 2] = patch[s + 2]; pixels[o + 3] = 255;
        }
      }
    },
  };
}

module.exports = { createCompositor };
