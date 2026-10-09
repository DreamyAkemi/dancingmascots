'use strict';
/**
 * tempo.js — real-time tempo + beat tracking (pure JS, no Electron/DOM dependencies,
 * so it can be unit-tested in plain Node: see test/tempo.test.js).
 *
 * How it works
 * ------------
 * 1. The caller feeds in an "onset strength" number (how much new sound energy just
 *    appeared — we use spectral flux) plus a loudness number, ~60 times a second.
 * 2. We keep the last few seconds of onset strength in a small buffer.
 * 3. For every candidate tempo (70–180 BPM) we slide a train of evenly spaced pulses
 *    over that buffer and measure how well the pulses line up with the onsets
 *    (a "comb filter"). The best-scoring tempo wins.
 * 4. The winning tempo is smoothed over time so the dancers don't jitter.
 * 5. The best pulse alignment also tells us *when* the beats fall, which the
 *    overlay uses for the optional "bounce on the beat" effect.
 */

class TempoTracker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.rate=50]            onset buffer resolution in Hz
   * @param {number} [opts.windowSec=7]        how many seconds of history to analyse
   * @param {number} [opts.minBpm=70]          lowest tempo considered
   * @param {number} [opts.maxBpm=180]         highest tempo considered
   * @param {number} [opts.silenceLevel=0.002] RMS loudness below this counts as silence
   * @param {number} [opts.silenceHoldSec=2]   silence must last this long to count as "stopped"
   */
  constructor(opts = {}) {
    this.rate = opts.rate || 50;
    this.windowSec = opts.windowSec || 7;
    this.minBpm = opts.minBpm || 70;
    this.maxBpm = opts.maxBpm || 180;
    this.silenceLevel = opts.silenceLevel || 0.002;
    this.silenceHoldSec = opts.silenceHoldSec || 2;

    this.onsets = [];        // onset strength per time bin (oldest first)
    this.lastBin = null;     // absolute index of the newest bin (time * rate)
    this.lastLoudT = -Infinity; // last time we heard anything above silenceLevel
    this.lastT = 0;          // time of the most recent push()

    this.bpm = null;         // smoothed tempo (what we report)
    this.confidence = 0;     // 0..1, how clear the beat is
    this._pending = [];      // recent disagreeing estimates (see update())

    this._beatT = null;      // time (s) of a beat on the current beat grid
    this._period = null;     // seconds per beat on that grid
  }

  /** Forget everything (e.g. when the audio source changes). */
  reset() {
    this.onsets = [];
    this.lastBin = null;
    this.bpm = null;
    this.confidence = 0;
    this._pending = [];
    this._beatT = null;
    this._period = null;
  }

  /**
   * Feed one analysis frame.
   * @param {number} t      time in seconds (any monotonic clock)
   * @param {number} onset  onset strength for this frame
   * @param {number} level  RMS loudness for this frame (0..1)
   */
  push(t, onset, level) {
    this.lastT = t;
    if (level >= this.silenceLevel) this.lastLoudT = t;

    const bin = Math.floor(t * this.rate);
    if (this.lastBin === null) { // very first frame
      this.onsets = [onset];
      this.lastBin = bin;
      return;
    }
    if (bin === this.lastBin) { // several frames landed in the same bin: keep the loudest
      const i = this.onsets.length - 1;
      this.onsets[i] = Math.max(this.onsets[i], onset);
      return;
    }
    // New bin: pad any skipped bins with 0 (frames arrive at slightly irregular times).
    const gap = Math.min(bin - this.lastBin, this.rate * this.windowSec);
    for (let k = 1; k < gap; k++) this.onsets.push(0);
    this.onsets.push(onset);
    this.lastBin = bin;

    // Drop history older than the analysis window.
    const max = Math.round(this.rate * this.windowSec);
    if (this.onsets.length > max) this.onsets.splice(0, this.onsets.length - max);
  }

  /** True while sound has been heard within the last `silenceHoldSec` seconds. */
  get playing() {
    return this.lastT - this.lastLoudT <= this.silenceHoldSec;
  }

  /**
   * Turn the raw onset buffer into a cleaned-up envelope and return a sampler for it.
   * Cleaning = subtract a ~0.5 s moving average (so only *peaks* remain), drop negatives,
   * then blur by one bin. Returns null when there is too little (or no) signal.
   * @returns {{n:number, at:(p:number)=>number}|null} `at(p)` samples the envelope at the
   *          fractional bin position p (linear interpolation).
   */
  _envelope() {
    const n = this.onsets.length;
    const rate = this.rate;
    if (n < rate * 4) return null; // need at least ~4 s of audio

    const w = Math.round(rate * 0.5);
    const prefix = new Float64Array(n + 1); // prefix sums → O(1) moving averages
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + this.onsets[i];

    const x = new Float64Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
      const mean = (prefix[b] - prefix[a]) / (b - a);
      x[i] = Math.max(0, this.onsets[i] - mean);
      total += x[i];
    }
    if (total <= 1e-9) return null; // flat signal: nothing to track

    const s = new Float64Array(n); // light 3-tap blur
    for (let i = 0; i < n; i++) s[i] = 0.5 * x[i] + 0.25 * (x[i - 1] || 0) + 0.25 * (x[i + 1] || 0);

    const at = (p) => {
      if (p < 0 || p > n - 1) return 0;
      const i = Math.floor(p), f = p - i;
      return s[i] * (1 - f) + (s[i + 1] || 0) * f;
    };
    return { n, at };
  }

  /**
   * Find the pulse-train alignment that best matches the envelope.
   * @param {{n:number, at:Function}} env
   * @param {number} period   pulse spacing in bins
   * @param {number} phases   how many start offsets to try
   * @returns {{score:number, offset:number}} mean envelope value under the pulses, and
   *          the winning start offset (in bins, 0 <= offset < period)
   */
  _comb(env, period, phases) {
    let best = { score: 0, offset: 0 };
    for (let ph = 0; ph < phases; ph++) {
      const offset = (ph / phases) * period;
      let acc = 0, count = 0;
      for (let p = offset; p < env.n; p += period) { acc += env.at(p); count++; }
      if (count >= 3 && acc / count > best.score) best = { score: acc / count, offset };
    }
    return best;
  }

  /**
   * One raw (unsmoothed) tempo estimate from the current buffer.
   * @returns {{bpm:number, confidence:number}|null} null if there isn't enough signal yet
   */
  estimate() {
    const env = this._envelope();
    if (!env) return null;
    const rate = this.rate;

    let bestBpm = 0, bestScore = -1;
    const scores = [];
    for (let bpm = this.minBpm; bpm <= this.maxBpm; bpm += 0.5) {
      const period = (60 / bpm) * rate;
      // Every beat counts fully; every *other* beat counts half (rewards bar-level structure).
      const score = this._comb(env, period, 12).score + 0.5 * this._comb(env, period * 2, 12).score;
      // Gentle bias towards typical dance tempos (log-normal bump centred on 115 BPM).
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.9, 2));
      const weighted = score * prior;
      scores.push(weighted);
      if (weighted > bestScore) { bestScore = weighted; bestBpm = bpm; }
    }
    // Confidence: how far the winner stands out from a typical (median) candidate.
    const sorted = scores.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const confidence = bestScore > 0 ? Math.max(0, (bestScore - median) / bestScore) : 0;
    return { bpm: bestBpm, confidence };
  }

  /**
   * Work out where beats fall for the given tempo and ease our beat grid towards it.
   * The grid is only nudged a little each time so the bounce doesn't jitter.
   */
  _updateBeatGrid(bpm) {
    const env = this._envelope();
    if (!env) return;
    const period = (60 / bpm) * this.rate; // bins
    const { offset } = this._comb(env, period, 48);

    // Newest beat inside the buffer, converted from bins back to seconds.
    const startBin = this.lastBin - env.n + 1;
    const lastIdx = offset + Math.floor((env.n - 1 - offset) / period) * period;
    const newBeatT = (startBin + lastIdx) / this.rate;
    const periodSec = 60 / bpm;

    if (this._beatT === null) {
      this._beatT = newBeatT;
    } else {
      // Signed distance from our current grid to the new measurement, wrapped to ±half a beat.
      let err = (newBeatT - this._beatT) % periodSec;
      if (err > periodSec / 2) err -= periodSec;
      if (err < -periodSec / 2) err += periodSec;
      this._beatT += 0.3 * err;
    }
    this._period = periodSec;
  }

  /**
   * Call a couple of times per second. Returns the smoothed state:
   *   playing    – is there sound right now?
   *   bpm        – smoothed tempo (null until the first lock)
   *   confidence – 0..1
   *   beatT      – time (same clock as push()) of a beat; null if unknown
   *   period     – seconds per beat; null if unknown
   */
  update() {
    if (!this.playing) {
      // After a real gap, start fresh so the next song locks on quickly.
      if (this.lastT - this.lastLoudT > this.silenceHoldSec + 1) this.reset();
      return { playing: false, bpm: this.bpm, confidence: 0, beatT: null, period: null };
    }

    const est = this.estimate();
    if (est) {
      this.confidence = est.confidence;
      if (this.bpm === null) {
        this.bpm = est.bpm; // first lock: take it immediately
      } else if (Math.abs(est.bpm / this.bpm - 1) < 0.04) {
        this.bpm += 0.3 * (est.bpm - this.bpm); // small drift: ease towards it
        this._pending = [];
      } else {
        // Big change (new song? octave error?): only jump once it has been seen 3 times in a row.
        this._pending.push(est.bpm);
        if (this._pending.length > 4) this._pending.shift();
        const p = this._pending;
        if (p.length >= 3 && p.every((v) => Math.abs(v / p[p.length - 1] - 1) < 0.04)) {
          this.bpm = p[p.length - 1];
          this._pending = [];
          this._beatT = null; // tempo changed, so the old beat grid is meaningless
        }
      }
      if (this.bpm !== null) this._updateBeatGrid(this.bpm);
    }
    return {
      playing: true, bpm: this.bpm, confidence: this.confidence,
      beatT: this._beatT, period: this._period,
    };
  }
}

/**
 * Spectral flux between two magnitude spectra (as from AnalyserNode.getFloatFrequencyData,
 * in dB): the sum of all *increases* in energy per frequency bin. Big value = something
 * just hit (a drum, a note). Only the first `bins` bins are used (~0–4 kHz, where kicks,
 * snares and bass live, which keeps hi-hat/noise from dominating).
 */
function spectralFlux(prev, cur, bins) {
  let flux = 0;
  const n = Math.min(bins, cur.length);
  for (let i = 1; i < n; i++) {
    const a = Math.max(cur[i], -100), b = Math.max(prev[i], -100); // clamp -Infinity dB
    const d = a - b;
    if (d > 0) flux += d;
  }
  return flux;
}

/**
 * Playback-speed multiplier for a GIF.
 * @param {number}  bpm      the song's tempo
 * @param {number}  baseBpm  the tempo at which the GIF looks right at normal speed
 * @param {boolean} smart    if true, also consider half/double time and pick whichever gives
 *                           a speed closest to 1× (so a 70 BPM song still suits a 140 BPM dance)
 */
function foldedRate(bpm, baseBpm, smart) {
  const base = bpm / baseBpm;
  if (!smart) return base;
  let best = base;
  for (const k of [0.5, 2]) {
    if (Math.abs(Math.log(base * k)) < Math.abs(Math.log(best))) best = base * k;
  }
  return best;
}

module.exports = { TempoTracker, spectralFlux, foldedRate };
