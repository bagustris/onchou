#!/usr/bin/env node
// synthetic-regression.js -- guards the real-audio-tuned pipeline changes
// (tools/evaluate-pipeline.js) against regressing on the two synthetic
// conditions tools/pitch-accuracy-experiment.js established as the app's
// contract:
//   1. Clean isolated words with a real H/L contrast (and optional
//      declination) -- must still be recognized. These traces have ZERO
//      peak delay, so they're the worst case for a window delay tuned on
//      fast read speech; run at 150ms (Stage 4's value) AND a slower 250ms
//      mora, closer to a careful learner's single word.
//   2. Monotone/flat attempts (no contrast, just noise) -- must NOT be
//      scored as an exact match (Stage 5's false-positive rule, the reason
//      MIN_SPLIT_CENTS exists).
// Same trace model as pitch-accuracy-experiment.js's oracleTraceV2 (per-mora
// + per-frame jitter), reimplemented here only to vary the frame density /
// mora length; 20ms frames like the real recorder.
'use strict';

const MoraSegment = require('../js/mora-segment.js');
const PitchDiagram = require('../js/pitch-diagram.js');
const D = require('./accent-decoders.js');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng) {
  const u1 = Math.max(rng(), 1e-12), u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// glideMs: linear pitch glide centered on each mora boundary (0 = abrupt).
// Added after tools/pitch-accuracy-experiment.js's Stage 2 caught a 50ms
// peak delay dropping to 92% exact on 40ms glides with zero-delay audio --
// the case this file originally missed.
function trace(target, hHz, lHz, moraMs, decl, moraJ, frameJ, rng, glideMs) {
  glideMs = glideMs || 0;
  const out = [];
  const total = target.length * moraMs;
  const mf = target.map(() => 1 + (rng() * 2 - 1) * moraJ);
  const lvl = (i) => (target[i] === 'H' ? hHz : lHz) * mf[i];
  for (let t = 0; t < total; t += 20) {
    const i = Math.min(target.length - 1, Math.floor(t / moraMs));
    let hz = lvl(i);
    if (glideMs > 0) {
      const b = Math.round(t / moraMs) * moraMs; // nearest boundary
      const bi = b / moraMs;
      if (bi > 0 && bi < target.length && Math.abs(t - b) < glideMs / 2) {
        const w = (t - (b - glideMs / 2)) / glideMs; // 0..1 across the glide
        hz = lvl(bi - 1) + (lvl(bi) - lvl(bi - 1)) * w;
      }
    }
    hz *= 1 + decl * (t / total);
    hz *= 1 + gaussian(rng) * frameJ;
    out.push({ tMs: t, hz });
  }
  return out;
}

// 'old' = the pre-2026-09-25 segmentByMora (median slots + unconstrained
// 2-cluster split), reproduced via tools/accent-decoders.js -- verified
// byte-identical to it on all 33,786 multi-mora JSUT phrases. 'new' = the
// CURRENT shipped js/mora-segment.js segmentByMora itself.
const CANDIDATES = {
  old: (tr, n) => {
    const v = D.moraValuesProportional(tr, n, 'median', 0);
    return v ? D.decode(v, 'twoMeans', { minContrastCents: 100 }) : new Array(n).fill('unclear');
  },
  new: (tr, n) => MoraSegment.segmentByMora(tr, n).pattern,
};

const SEEDS = 40;
console.log('=== 1. contrast recognition: exact-pattern match % (all (n, accentNum) strata n=2..6, equally weighted) ===');
for (const moraMs of [150, 250]) {
  console.log(`-- mora ${moraMs}ms --`);
  console.log(['H/L ratio', 'decl', 'glide'].concat(Object.keys(CANDIDATES)).join('\t'));
  for (const ratio of [1.1, 1.2, 1.3]) {
    for (const [decl, glideMs] of [[0, 0], [-0.1, 0], [0, 40], [-0.1, 40]]) {
      const row = [ratio, decl, glideMs];
      for (const [name, fn] of Object.entries(CANDIDATES)) {
        let ok = 0, tot = 0;
        for (let n = 2; n <= 6; n++) {
          for (let a = 0; a <= n; a++) {
            const target = PitchDiagram.pitchLevels(n, a).slice(0, n);
            for (let s = 0; s < SEEDS; s++) {
              const rng = mulberry32(n * 1000 + a * 100 + s * 7 + Math.round(ratio * 10) + (decl ? 5 : 0) + moraMs);
              const tr = trace(target, 100 * ratio, 100, moraMs, decl, 0.02, 0.01, rng, glideMs);
              const p = fn(tr, n);
              if (MoraSegment.scorePattern(p, target).matched === n) ok++;
              tot++;
            }
          }
        }
        row.push((100 * ok / tot).toFixed(1));
      }
      console.log(row.join('\t'));
    }
  }
}

console.log('\n=== 2. monotone false positives: % of flat attempts scored as an EXACT match (lower is better) ===');
console.log(['n', 'decl'].concat(Object.keys(CANDIDATES)).join('\t'));
for (const n of [2, 3, 4]) {
  for (const decl of [0, -0.05, -0.1]) {
    const row = [n, decl];
    for (const [name, fn] of Object.entries(CANDIDATES)) {
      let fp = 0, tot = 0;
      for (let a = 0; a <= n; a++) {
        const target = PitchDiagram.pitchLevels(n, a).slice(0, n);
        for (let s = 0; s < 300; s++) {
          const rng = mulberry32(n * 7919 + a * 104729 + s * 31 + Math.round(-decl * 1000));
          const tr = trace(new Array(n).fill('L'), 120, 120, 150, decl, 0.02, 0.01, rng);
          if (MoraSegment.scorePattern(fn(tr, n), target).matched === n) fp++;
          tot++;
        }
      }
      row.push((100 * fp / tot).toFixed(1));
    }
    console.log(row.join('\t'));
  }
}
