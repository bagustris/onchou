#!/usr/bin/env node
// paper-exp-frontend.js -- options #4-#6 from the paper plan, each measured
// against the shipped pipeline on the same splits (choose: UME natives A +
// JSUT app train; report: UME natives B, JSUT app test, UME learners):
//   #4 pitch-track smoothing  (median filter over voiced runs; octave-jump
//      folding toward a local median) -- applied to the trace, pipeline
//      otherwise unchanged
//   #5 perceptual end-of-mora values (MORA_VALUE 'late' / 'target';
//      Ishi et al. 2001, Short et al. 2011)
//   #6 per-speaker calibration: evidence thresholds scaled by the speaker's
//      own pitch range, estimated LEAVE-ONE-WORD-OUT from their other takes
//      (what an app would get from a short enrollment)
'use strict';
const H = require('./paper-harness.js');
const MS = H.shipped;
const D = H.load();

// ---- #4 smoothing ------------------------------------------------------
function voicedRuns(trace) {
  const runs = []; let cur = null;
  trace.forEach((f, i) => { if (f.hz != null) { if (!cur) { cur = []; runs.push(cur); } cur.push(i); } else cur = null; });
  return runs;
}
function medFilter(trace, k) {
  const out = trace.map((f) => ({ ...f }));
  for (const run of voicedRuns(trace)) {
    for (let j = 0; j < run.length; j++) {
      const w = [];
      for (let q = Math.max(0, j - k); q <= Math.min(run.length - 1, j + k); q++) w.push(trace[run[q]].hz);
      w.sort((a, b) => a - b);
      out[run[j]].hz = w[w.length >> 1];
    }
  }
  return out;
}
function octaveFix(trace) {
  const out = trace.map((f) => ({ ...f }));
  const vi = trace.map((f, i) => (f.hz != null ? i : -1)).filter((i) => i >= 0);
  for (let j = 0; j < vi.length; j++) {
    const w = [];
    for (let q = Math.max(0, j - 5); q <= Math.min(vi.length - 1, j + 5); q++) if (q !== j) w.push(trace[vi[q]].hz);
    if (!w.length) continue;
    w.sort((a, b) => a - b);
    const med = w[w.length >> 1], hz = trace[vi[j]].hz;
    if (hz > 1.6 * med) out[vi[j]].hz = hz / 2;
    else if (hz < med / 1.6) out[vi[j]].hz = hz * 2;
  }
  return out;
}
const withTrace = (tf) => (s) => MS.segmentByMora(tf(s.trace), s.moraCount, { morae: s.morae }).pattern;

// ---- #6 calibration ----------------------------------------------------
function takeRangeCents(s) {
  const c = MS._computeSlots(s.trace, s.moraCount);
  if (!c) return null;
  const v = c.slotMedians.filter((x) => x != null).map((x) => 1200 * Math.log2(x));
  if (v.length < 2) return null;
  return Math.max(...v) - Math.min(...v);
}
function speakerRanges(set) {
  const by = new Map();
  for (const s of set) {
    const r = takeRangeCents(s);
    if (r == null) continue;
    if (!by.has(s.speaker)) by.set(s.speaker, []);
    by.get(s.speaker).push({ s, r });
  }
  return by;
}
const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
const popRange = med([...speakerRanges(D.ume.A).values()].map((arr) => med(arr.map((x) => x.r))));
function calibrated(alpha, set) {
  const by = speakerRanges(set);
  const scaleOf = new Map();
  for (const [spk, arr] of by) {
    for (const { s } of arr) {
      const others = arr.filter((x) => x.s !== s).map((x) => x.r); // leave this word out
      const R = others.length ? med(others) : popRange;
      scaleOf.set(s, Math.min(2, Math.max(0.5, Math.pow(R / popRange, alpha))));
    }
  }
  return (s) => {
    const c = MS._computeSlots(s.trace, s.moraCount);
    if (!c) return new Array(s.moraCount).fill('unclear');
    const k = scaleOf.get(s) || 1;
    return MS._decodeAccentPattern(c.slotMedians, {
      heavyInitial: MS._heavyInitial(s.morae), minSplitCents: 100 * k, minRiseCents: 100 * k,
    });
  };
}

// ---- run ---------------------------------------------------------------
const sets = [['UME A*', D.ume.A], ['JSUT app train*', D.jsutApp.train], ['UME B', D.ume.B], ['JSUT app test', D.jsutApp.test], ['learners', D.ume.learners]];
function row(label, fnFor) {
  const cells = sets.map(([, set]) => { const r = H.metrics(set, fnFor(set)); return `${r.kappa.toFixed(3)}/${(100 * r.unclear).toFixed(0)}%`.padEnd(12); });
  console.log(label.padEnd(34) + cells.join(''));
}
console.log(`kappa/unclear per split (* = choosing splits). Population pitch range (UME A median of per-take slot range): ${popRange.toFixed(0)} cents\n`);
console.log(''.padEnd(34) + sets.map(([n]) => n.padEnd(12)).join(''));
row('shipped', () => H.predictShipped());
console.log('-- #4 smoothing');
row('median filter k=1 (3 frames)', () => withTrace((t) => medFilter(t, 1)));
row('median filter k=2 (5 frames)', () => withTrace((t) => medFilter(t, 2)));
row('octave-jump folding', () => withTrace(octaveFix));
row('octave folding + median k=1', () => withTrace((t) => medFilter(octaveFix(t), 1)));
console.log('-- #5 perceptual end-of-mora value');
for (const mv of ['late', 'target']) { const V = H.variant({ MORA_VALUE: mv }); row(`MORA_VALUE=${mv}`, () => H.predictShipped(V)); }
console.log('-- #6 per-speaker calibration (thresholds x (range/pop)^alpha, leave-one-word-out)');
for (const a of [0.5, 1, 1.5]) row(`alpha=${a}`, (set) => (set[0] && set[0].speaker ? calibrated(a, set) : H.predictShipped()));
