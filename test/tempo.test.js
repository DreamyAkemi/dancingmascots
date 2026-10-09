'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TempoTracker, foldedRate } = require('../src/shared/tempo');

// Synthetic drum track: kick on the beat, quieter off-beat hat, a little noise.
function run(bpm, seconds, { fps = 60, jitter = true, seed = 1 } = {}) {
  let r = seed;
  const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const tr = new TempoTracker();
  const beat = 60 / bpm;
  let t = 0;
  while (t < seconds) {
    const phase = (t % beat) / beat;
    const kick = Math.exp(-phase * 25);
    const hat = 0.4 * Math.exp(-Math.abs(phase - 0.5) * 60);
    tr.push(t, 20 * (kick + hat) + rnd() * 3, 0.1);
    t += 1 / fps + (jitter ? (rnd() - 0.5) * 0.008 : 0);
    if (Math.floor(t * 2) !== Math.floor((t - 1 / fps) * 2)) tr.update();
  }
  return tr.update();
}

for (const bpm of [80, 100, 120, 128, 140, 174]) {
  test(`detects ${bpm} BPM`, () => {
    const s = run(bpm, 14);
    assert.ok(s.playing);
    // Accept the exact tempo; double/half is handled by the half/double control & folding.
    const ok = [1, 2, 0.5].some((k) => Math.abs(s.bpm / (bpm * k) - 1) < 0.02);
    assert.ok(ok, `got ${s.bpm} for ${bpm}`);
    // Very fast tracks are reported at half time (87 for 174); the gif speed folding covers that.
    const expected = bpm > 170 ? bpm / 2 : bpm;
    assert.ok(Math.abs(s.bpm / expected - 1) < 0.02, `expected ~${expected}, got ${s.bpm}`);
  });
}

test('reports silence as not playing', () => {
  const tr = new TempoTracker();
  for (let t = 0; t < 5; t += 1 / 60) tr.push(t, 0, 0);
  assert.strictEqual(tr.update().playing, false);
});

test('foldedRate picks nearest to natural speed', () => {
  assert.strictEqual(foldedRate(120, 120, true), 1);
  assert.strictEqual(foldedRate(60, 120, true), 1); // 0.5 -> doubled
  assert.strictEqual(foldedRate(60, 120, false), 0.5);
});
