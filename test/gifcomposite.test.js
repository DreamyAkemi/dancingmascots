'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseGIF, decompressFrame } = require('gifuct-js');
const { createCompositor } = require('../src/shared/gifcomposite');

/** Decode a GIF and return the fully composed picture after each frame (as RGBA arrays). */
function composeAll(file) {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', file));
  const gif = parseGIF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const raw = gif.frames.filter((f) => f.image);
  const { width, height } = gif.lsd;
  const meta = raw.map((f) => decompressFrame(f, gif.gct, false));
  const comp = createCompositor(width, height);
  const pictures = raw.map((f, i) => {
    comp.draw(i === 0 ? null : meta[i - 1], meta[i], decompressFrame(f, gif.gct, true).patch);
    return Uint8ClampedArray.from(comp.pixels);
  });
  return { width, height, pictures };
}

const alphaAt = (pic, w, x, y) => pic[(y * w + x) * 4 + 3];

for (const file of ['full-frames.gif', 'cropped-frames.gif', 'cropped-keep.gif']) {
  test(`${file}: background stays transparent and the sprite is drawn`, () => {
    const { width, pictures } = composeAll(file);
    for (const [i, pic] of pictures.entries()) {
      assert.strictEqual(alphaAt(pic, width, 0, 0), 0, `top-left corner opaque in frame ${i}`);
      assert.strictEqual(alphaAt(pic, width, width - 1, 5), 0, `right edge opaque in frame ${i}`);
      let opaque = 0;
      for (let k = 3; k < pic.length; k += 4) if (pic[k] === 255) opaque++;
      assert.ok(opaque > 300 && opaque < pic.length / 4 / 2, `frame ${i}: ${opaque} opaque pixels`);
    }
  });
}

test('the same animation looks identical whether frames are stored full-size or cropped', () => {
  const full = composeAll('full-frames.gif').pictures;
  // (cropped-keep.gif is a different animation: its frames build on each other, so it isn't compared here)
  for (const file of ['cropped-frames.gif']) {
    const other = composeAll(file).pictures;
    assert.strictEqual(other.length, full.length);
    other.forEach((pic, i) => assert.deepStrictEqual(Array.from(pic), Array.from(full[i]), `${file} frame ${i} differs`));
  }
});
