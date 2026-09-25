#!/usr/bin/env node
// paper-exp-learned.js -- option #7: small LEARNED decision rules on the
// exact production slot values (js/mora-segment.js computeSlots: voice gate,
// 20ms delay, per-slot median), vs the shipped model-free decoder.
//
//   gauss:  Ishi, Minematsu & Hirose (2001)-style -- the F0ratio vector
//           (cents step between adjacent slots) modelled by one diagonal
//           Gaussian per (mora count, pattern); max likelihood with EQUAL
//           class priors (can't exploit the corpus's skewed pattern mix).
//   ltmpl:  "learned templates" -- the shipped constrained decoder's
//           least-squares fit, but each valid pattern's idealized 0/1 step
//           replaced by its MEAN realized shape (per mora count) from
//           training data; same declination term, same evidence guard.
//           Keeps the decoder's structure and honesty rule; only the
//           expected shape is data-derived (a table of (n-1)*(n+1) numbers
//           per mora count).
//
// Training regimes (test sets never seen in training):
//   in-domain:    UME natives A -> natives B
//   cross-corpus: JSUT (app+phrase train) -> natives B
//   pooled:       JSUT train + natives A -> natives B, JSUT app test
// Plus the flat-attempt check: synthetic monotone takes scored as correct.
'use strict';
const H = require('./paper-harness.js');
const PD = require('../js/pitch-diagram.js');
const MS = H.shipped;
const D = H.load();

const sliced = (s) => PD.pitchLevels(s.moraCount, s.accents[0]).slice(0, s.moraCount).join('');
function slotVals(s) {
  const c = MS._computeSlots(s.trace, s.moraCount);
  return c ? c.slotMedians : null;
}
function fill(v) { // interpolate interior gaps, copy edge gaps; null if <2 present
  const n = v.length, idx = [];
  v.forEach((x, i) => { if (x != null) idx.push(i); });
  if (idx.length < 2) return null;
  const w = v.slice();
  for (let i = 0; i < n; i++) {
    if (w[i] != null) continue;
    let l = i - 1; while (l >= 0 && v[l] == null) l--;
    let r = i + 1; while (r < n && v[r] == null) r++;
    w[i] = l < 0 ? v[r] : r >= n ? v[l] : v[l] + ((v[r] - v[l]) * (i - l)) / (r - l);
  }
  return w.map((x) => 1200 * Math.log2(x));
}
const ratios = (c) => c.slice(1).map((x, i) => x - c[i]);

// ---- gauss
function trainGauss(train) {
  const m = new Map();
  for (const s of train) {
    if (s.moraCount < 2) continue;
    const v = slotVals(s); if (!v) continue;
    const c = fill(v); if (!c) continue;
    const x = ratios(c), key = s.moraCount, pat = sliced(s);
    if (!m.has(key)) m.set(key, new Map());
    const g = m.get(key).get(pat) || { s: x.map(() => 0), q: x.map(() => 0), n: 0 };
    x.forEach((xi, i) => { g.s[i] += xi; g.q[i] += xi * xi; }); g.n++;
    m.get(key).set(pat, g);
  }
  return m;
}
function predictGauss(model) {
  return (s) => {
    if (s.moraCount < 2) return MS.segmentByMora(s.trace, s.moraCount, { morae: s.morae }).pattern;
    const v = slotVals(s); const c = v && fill(v); const m = model.get(s.moraCount);
    if (!c || !m) return new Array(s.moraCount).fill('unclear');
    const x = ratios(c);
    let best = null, bl = -Infinity;
    for (const [pat, g] of m) {
      if (g.n < 10) continue;
      let ll = 0;
      for (let i = 0; i < x.length; i++) { const mu = g.s[i] / g.n; const vr = Math.max(2500, g.q[i] / g.n - mu * mu); ll += -0.5 * Math.log(vr) - (x[i] - mu) ** 2 / (2 * vr); }
      if (ll > bl) { bl = ll; best = pat; }
    }
    return best ? best.split('') : new Array(s.moraCount).fill('unclear');
  };
}

// ---- learned templates: mean per-slot contour (cents, mean-centred, then
// scaled so its range is 1) for each (n, pattern); decode like the shipped
// decoder -- lowest residual of v = a + b*i + c*T (c>=0, bounded slope),
// evidence guard on c.
function trainTemplates(train) {
  const acc = new Map();
  for (const s of train) {
    if (s.moraCount < 2) continue;
    const v = slotVals(s); const c = v && fill(v); if (!c) continue;
    const mu = c.reduce((a, b) => a + b, 0) / c.length;
    const key = s.moraCount + ':' + sliced(s);
    const a = acc.get(key) || { sum: c.map(() => 0), n: 0 };
    c.forEach((x, i) => { a.sum[i] += x - mu; }); a.n++;
    acc.set(key, a);
  }
  const t = new Map();
  for (const [key, a] of acc) {
    if (a.n < 10) continue;
    const m = a.sum.map((x) => x / a.n);
    const lo = Math.min(...m), hi = Math.max(...m);
    if (hi - lo < 1e-6) continue;
    const [n, pat] = key.split(':');
    if (!t.has(+n)) t.set(+n, []);
    t.get(+n).push({ pat, shape: m.map((x) => (x - lo) / (hi - lo)) });
  }
  return t;
}
function lsq3(y, x, t, bMin) { // same active-set idea as mora-segment.js fitWithDeclination, in cents
  let best = null;
  const n = y.length;
  const solve = (cols, yy) => {
    const k = cols.length, A = cols.map(() => new Array(k).fill(0)), r = new Array(k).fill(0);
    for (let q = 0; q < n; q++) for (let i = 0; i < k; i++) { r[i] += cols[i][q] * yy[q]; for (let j = 0; j < k; j++) A[i][j] += cols[i][q] * cols[j][q]; }
    for (let c = 0; c < k; c++) { let p = c; for (let q = c + 1; q < k; q++) if (Math.abs(A[q][c]) > Math.abs(A[p][c])) p = q; if (Math.abs(A[p][c]) < 1e-9) return null; [A[c], A[p]] = [A[p], A[c]]; [r[c], r[p]] = [r[p], r[c]]; for (let q = 0; q < k; q++) { if (q === c) continue; const f = A[q][c] / A[c][c]; for (let j = c; j < k; j++) A[q][j] -= f * A[c][j]; r[q] -= f * r[c]; } }
    return r.map((v, i) => v / A[i][i]);
  };
  const ones = y.map(() => 1);
  for (const [fixB, fixC] of [[null, null], [bMin, null], [0, null], [null, 0], [bMin, 0], [0, 0]]) {
    const cols = [ones]; const yy = y.slice();
    if (fixB == null) cols.push(x); else yy.forEach((_, q) => { yy[q] -= fixB * x[q]; });
    if (fixC == null) cols.push(t); else yy.forEach((_, q) => { yy[q] -= fixC * t[q]; });
    const co = solve(cols, yy); if (!co) continue;
    let i = 1; const b = fixB != null ? fixB : co[i++]; const c = fixC != null ? fixC : co[i++];
    if (c < -1e-9 || b < bMin - 1e-9 || b > 1e-9) continue;
    let sse = 0; for (let q = 0; q < n; q++) { const pr = co[0] + b * x[q] + c * t[q]; sse += (y[q] - pr) ** 2; }
    if (!best || sse < best.sse) best = { b, c, sse };
  }
  return best;
}
function predictTemplates(tm, minCents) {
  return (s) => {
    const n = s.moraCount;
    const list = tm.get(n);
    if (n < 2 || !list) return MS.segmentByMora(s.trace, n, { morae: s.morae }).pattern;
    const v = slotVals(s);
    if (!v) return new Array(n).fill('unclear');
    const idx = []; v.forEach((x, i) => { if (x != null) idx.push(i); });
    if (idx.length < 2) return new Array(n).fill('unclear');
    const y = idx.map((i) => 1200 * Math.log2(v[i])), x = idx.slice();
    let best = null;
    for (const { pat, shape } of list) {
      const t = idx.map((i) => shape[i]);
      if (Math.max(...t) - Math.min(...t) < 1e-6) continue;
      const f = lsq3(y, x, t, -50);
      if (f && (!best || f.sse < best.sse)) best = { pat, c: f.c };
    }
    if (!best || best.c < minCents) return new Array(n).fill('unclear');
    const out = best.pat.split('');
    idx.length; v.forEach((x, i) => { if (x == null) out[i] = 'unclear'; });
    return out;
  };
}

// ---- synthetic flat attempts (same model as tools/synthetic-regression.js)
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function flatCorrectRate(predict) {
  let ok = 0, n = 0;
  for (const m of [2, 3, 4]) for (const decl of [0, -0.05, -0.1]) for (let a = 0; a <= m; a++) {
    for (let k = 0; k < 100; k++) {
      const r = mulberry32(m * 7919 + a * 104729 + k * 31 + Math.round(-decl * 1000));
      const g = () => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());
      const mf = Array.from({ length: m }, () => 1 + (r() * 2 - 1) * 0.02);
      const tr = []; for (let t = 0; t < m * 150; t += 20) tr.push({ tMs: t, hz: 120 * mf[Math.floor(t / 150)] * (1 + decl * t / (m * 150)) * (1 + g() * 0.01) });
      const s = { trace: tr, moraCount: m, accents: [a], morae: new Array(m).fill('か') };
      const p = predict(s), tg = PD.pitchLevels(m, a).slice(0, m);
      if (p.join('') === tg.join('')) ok++; n++;
    }
  }
  return ok / n;
}

// ---- run
const jsutTrain = [].concat(D.jsutApp.train, D.jsutPhrase.train);
const regimes = [
  ['in-domain  (UME A)', D.ume.A],
  ['cross-corp (JSUT)', jsutTrain],
  ['pooled     (JSUT+UME A)', jsutTrain.concat(D.ume.A)],
];
const report = [['UME B', D.ume.B], ['JSUT app test', D.jsutApp.test], ['learners', D.ume.learners]];
const line = (label, f) => {
  const cells = report.map(([, set]) => { const r = H.metrics(set, f); return `${r.kappa.toFixed(3)}/${(100 * r.unclear).toFixed(0)}%`.padEnd(13); });
  console.log(label.padEnd(40) + cells.join('') + `flat->correct ${(100 * flatCorrectRate(f)).toFixed(1)}%`);
};
console.log(''.padEnd(40) + report.map(([n]) => n.padEnd(13)).join('') + '(kappa/unclear)');
line('shipped (model-free)', H.predictShipped());
for (const [name, train] of regimes) {
  line(`gauss   ${name}`, predictGauss(trainGauss(train)));
  const tm = trainTemplates(train);
  line(`ltmpl   ${name} guard=100`, predictTemplates(tm, 100));
  line(`ltmpl   ${name} guard=50`, predictTemplates(tm, 50));
}

// ---- guarded hybrid: the shipped decoder decides WHETHER there is a
// trustworthy contrast (its evidence guard, incl. the heavy-syllable rule);
// the learned Gaussians decide WHICH pattern. Flat takes stay 'unclear'
// exactly as in the shipped app; slots with no voiced frames stay 'unclear'.
function guarded(learned) {
  return (s) => {
    const base = MS.segmentByMora(s.trace, s.moraCount, { morae: s.morae }).pattern;
    if (s.moraCount < 2 || base.every((x) => x === 'unclear')) return base;
    const p = learned(s);
    if (p.every((x) => x === 'unclear')) return base;
    return p.map((x, i) => (base[i] === 'unclear' ? 'unclear' : x));
  };
}
console.log('-- guarded hybrid (shipped evidence guard + learned pattern choice)');
for (const [name, train] of regimes) line(`guarded gauss ${name}`, guarded(predictGauss(trainGauss(train))));
