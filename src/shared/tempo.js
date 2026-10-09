'use strict';

// Real-time tempo tracker.
//
// Feed it an onset-strength value (e.g. spectral flux) plus a loudness value
// every audio frame via push(). Call update() a couple of times a second to get
// { playing, bpm, confidence }.
//
// Tempo is estimated with a phase-aware comb filter over the last few seconds of
// onset strength: for every candidate BPM we slide a train of pulses over the
// signal and keep the best phase. This copes with the irregular frame timing of
// an AnalyserNode poll loop much better than a plain autocorrelation.

class TempoTracker {
  constructor(opts = {}) {
    this.rate = opts.rate || 50; // onset buffer resolution, Hz
    this.windowSec = opts.windowSec || 7;
    this.minBpm = opts.minBpm || 70;
    this.maxBpm = opts.maxBpm || 180;
    this.silenceLevel = opts.silenceLevel || 0.002; // RMS below this == silence
    this.silenceHoldSec = opts.silenceHoldSec || 2;

    this.onsets = [];
    this.lastBin = null;
    this.lastLoudT = -Infinity;
    this.lastT = 0;

    this.bpm = null; // smoothed output
    this.confidence = 0;
    this._pending = [];
  }

  reset() {
    this.onsets = [];
    this.lastBin = null;
    this.bpm = null;
    this.confidence = 0;
    this._pending = [];
  }

  push(t, onset, level) {
    this.lastT = t;
    if (level >= this.silenceLevel) this.lastLoudT = t;
    const bin = Math.floor(t * this.rate);
    if (this.lastBin === null) {
      this.onsets = [onset];
      this.lastBin = bin;
      return;
    }
    if (bin === this.lastBin) {
      const i = this.onsets.length - 1;
      this.onsets[i] = Math.max(this.onsets[i], onset);
      return;
    }
    const gap = Math.min(bin - this.lastBin, this.rate * this.windowSec);
    for (let k = 1; k < gap; k++) this.onsets.push(0);
    this.onsets.push(onset);
    this.lastBin = bin;
    const max = Math.round(this.rate * this.windowSec);
    if (this.onsets.length > max) this.onsets.splice(0, this.onsets.length - max);
  }

  get playing() {
    return this.lastT - this.lastLoudT <= this.silenceHoldSec;
  }

  // Raw (unsmoothed) estimate from the current buffer, or null if not enough data.
  estimate() {
    const n = this.onsets.length;
    const rate = this.rate;
    if (n < rate * 4) return null;

    // Detrend (remove ~0.5 s moving average), rectify, light smoothing.
    const w = Math.round(rate * 0.5);
    const x = new Float64Array(n);
    let sum = 0;
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + this.onsets[i];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
      const mean = (prefix[b] - prefix[a]) / (b - a);
      x[i] = Math.max(0, this.onsets[i] - mean);
      sum += x[i];
    }
    if (sum <= 1e-9) return null;
    const s = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      s[i] = 0.5 * x[i] + 0.25 * (x[i - 1] || 0) + 0.25 * (x[i + 1] || 0);
    }
    const at = (p) => {
      if (p < 0 || p > n - 1) return 0;
      const i = Math.floor(p), f = p - i;
      return s[i] * (1 - f) + (s[i + 1] || 0) * f;
    };

    // Mean pulse-train energy for a period (in bins), maximised over phase.
    const comb = (period) => {
      const phases = 12;
      let best = 0;
      for (let ph = 0; ph < phases; ph++) {
        const off = (ph / phases) * period;
        let acc = 0, cnt = 0;
        for (let p = off; p < n; p += period) { acc += at(p); cnt++; }
        if (cnt >= 3) best = Math.max(best, acc / cnt);
      }
      return best;
    };

    let bestBpm = 0, bestScore = -1;
    const scores = [];
    for (let bpm = this.minBpm; bpm <= this.maxBpm; bpm += 0.5) {
      const period = (60 / bpm) * rate;
      // Beats count fully, every-other-beat counts partially (bar-level structure).
      const score = comb(period) + 0.5 * comb(period * 2);
      // Gentle preference for typical dance tempos.
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.9, 2));
      const weighted = score * prior;
      scores.push(weighted);
      if (weighted > bestScore) { bestScore = weighted; bestBpm = bpm; }
    }
    const sorted = scores.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const confidence = bestScore > 0 ? Math.max(0, (bestScore - median) / bestScore) : 0;
    return { bpm: bestBpm, confidence };
  }

  // Call periodically. Returns the smoothed state.
  update() {
    if (!this.playing) {
      // After a real gap start fresh so the next song locks on quickly.
      if (this.lastT - this.lastLoudT > this.silenceHoldSec + 1) {
        this.onsets = [];
        this.lastBin = null;
        this.bpm = null;
        this._pending = [];
      }
      return { playing: false, bpm: this.bpm, confidence: 0 };
    }
    const est = this.estimate();
    if (est) {
      this.confidence = est.confidence;
      if (this.bpm === null) {
        this.bpm = est.bpm;
      } else if (Math.abs(est.bpm / this.bpm - 1) < 0.04) {
        this.bpm += 0.3 * (est.bpm - this.bpm);
        this._pending = [];
      } else {
        // Different tempo: only jump once it has been seen consistently.
        this._pending.push(est.bpm);
        if (this._pending.length > 4) this._pending.shift();
        const p = this._pending;
        if (p.length >= 3 && p.every((v) => Math.abs(v / p[p.length - 1] - 1) < 0.04)) {
          this.bpm = p[p.length - 1];
          this._pending = [];
        }
      }
    }
    return { playing: true, bpm: this.bpm, confidence: this.confidence };
  }
}

// Spectral flux between two dB magnitude spectra (as from AnalyserNode.getFloatFrequencyData),
// restricted to the first `bins` bins (~0–4 kHz where kicks/snares/bass live).
function spectralFlux(prev, cur, bins) {
  let flux = 0;
  const n = Math.min(bins, cur.length);
  for (let i = 1; i < n; i++) {
    const a = Math.max(cur[i], -100), b = Math.max(prev[i], -100);
    const d = a - b;
    if (d > 0) flux += d;
  }
  return flux;
}

// Pick which of bpm, bpm/2, bpm*2 makes a GIF with the given "looks right at" BPM
// run closest to its natural speed, so a 70 BPM detection can still drive a 140 BPM dance.
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
