#!/usr/bin/env node
// evaluate-decoders.js -- compares the accent decoders in
// tools/accent-decoders.js on real JSUT audio, reusing the trace cache that
// tools/evaluate-jsut-accuracy.js writes (run that first with --pad-ms 30;
// it produces tools/tmp/jsut-traces-cache-v4-limitInfinity-pad30.json).
//
// Held-out protocol: parameters are tuned ONLY on sentences BASIC5000_0001..
// 4000 ("train"); every number reported as a result is on 4001..5000
// ("test"), which the tuning never sees.
//
// Usage: node tools/evaluate-decoders.js [cache.json]
'use strict';

const fs = require('fs');
const path = require('path');
const PitchDiagram = require('../js/pitch-diagram.js');
const MoraSegment = require('../js/mora-segment.js');
const D = require('./accent-decoders.js');
const { moraeOf } = require('./paper-harness.js');

const cachePath = process.argv[2] ||
  path.join(__dirname, 'tmp', 'jsut-traces-cache-v4-limitInfinity-pad30.json');
const samples = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

// 'BASIC5000_0123' -> 123 (the corpus name itself contains digits, so take
// only what follows the underscore).
function sentenceNum(id) { return Number(id.split('_').pop()); }
const train = samples.filter((s) => sentenceNum(s.sentenceId) <= 4000);
const test = samples.filter((s) => sentenceNum(s.sentenceId) > 4000);
if (!train.length || !test.length) throw new Error(`bad split: train=${train.length} test=${test.length}`);

function oracleBoundaries(s) {
  const ms = s.moras.map((m) => ({ a: (m.startSec - s.spanStartSec) * 1000, b: (m.endSec - s.spanStartSec) * 1000 }));
  const out = ms.map((m) => m.a);
  out.push(ms[ms.length - 1].b);
  return out;
}

// Precompute per-sample mora values for each (boundary, method) once.
function precompute(set, boundaryMode, method) {
  return set.map((s) => {
    if (boundaryMode === 'proportional') return D.moraValuesProportional(s.trace, s.moraCount, method);
    if (!s.trace.some((f) => f && f.hz != null)) return null;
    return D.moraValuesFromBoundaries(s.trace, oracleBoundaries(s), method);
  });
}

// Why per-mora accuracy is NOT the headline metric: a decoder that ignores
// the audio entirely and always outputs the most frequent pattern for each
// mora count scores 66.1% per-mora / 41.1% strict on the test split --
// higher than every audio-based decoder under those two metrics -- because
// the corpus's pattern distribution is heavily skewed. Such a decoder is
// useless to a learner (it says the same thing whatever they produce). The
// primary metric is therefore BALANCED strict phrase accuracy: strict
// (every mora right) accuracy computed separately for each target class
// (mora count x target pattern) and then averaged with equal weight, so a
// constant guess only earns credit for the one class it always names.
// Cohen's kappa over the same (pattern) labels is reported alongside.
function evaluate(set, values, decoderFn) {
  let matched = 0, unclear = 0, total = 0, phrases = 0, strict = 0;
  const perClass = new Map(); // key -> {n, ok}
  const confusion = new Map(); // `${target}|${pred}` -> count, per mora count
  for (let k = 0; k < set.length; k++) {
    const v = values[k];
    if (!v) continue; // no voiced frames at all -- excluded, same as the shipped scorer
    const s = set[k];
    const pattern = decoderFn(s, v);
    const target = PitchDiagram.pitchLevels(s.moraCount, s.accentType).slice(0, s.moraCount);
    const sc = MoraSegment.scorePattern(pattern, target);
    matched += sc.matched; unclear += sc.unclear; total += sc.total; phrases++;
    const ok = sc.matched === sc.total;
    if (ok) strict++;
    const key = s.moraCount + ':' + target.join('');
    const c = perClass.get(key) || { n: 0, ok: 0 };
    c.n++; if (ok) c.ok++;
    perClass.set(key, c);
    const ck = s.moraCount + '|' + target.join('') + '|' + pattern.join(',');
    confusion.set(ck, (confusion.get(ck) || 0) + 1);
  }
  // Balanced accuracy over classes with enough support to be meaningful.
  let sumAcc = 0, nClasses = 0;
  for (const c of perClass.values()) { if (c.n >= 20) { sumAcc += c.ok / c.n; nClasses++; } }
  // Cohen's kappa computed WITHIN each mora count (target pattern vs
  // predicted pattern), then averaged weighted by support. Pooling all mora
  // counts into one label space would hand every decoder -- even a
  // constant guess -- free "agreement" for always knowing the mora count;
  // conditioned this way, a decoder that ignores the audio scores exactly 0.
  const byMc = new Map(); // mc -> {t: Map, p: Map, agree, N}
  for (const [ck, cnt] of confusion) {
    const [mc, t, p] = ck.split('|');
    const pl = p.split(',').join('');
    const g = byMc.get(mc) || { t: new Map(), p: new Map(), agree: 0, N: 0 };
    g.t.set(t, (g.t.get(t) || 0) + cnt);
    g.p.set(pl, (g.p.get(pl) || 0) + cnt);
    if (t === pl) g.agree += cnt;
    g.N += cnt;
    byMc.set(mc, g);
  }
  let kSum = 0, kW = 0;
  for (const g of byMc.values()) {
    if (g.N < 20 || g.t.size < 2) continue; // needs >1 target class to measure discrimination
    let pe = 0;
    for (const [l, c] of g.t) pe += (c / g.N) * ((g.p.get(l) || 0) / g.N);
    const po = g.agree / g.N;
    kSum += g.N * ((po - pe) / (1 - pe));
    kW += g.N;
  }
  return {
    perMora: matched / (total - unclear),
    pessimistic: matched / total,
    unclearRate: unclear / total,
    strictPhrase: strict / phrases,
    balancedStrict: sumAcc / nClasses,
    kappa: kSum / kW,
    n: total,
  };
}

function decoderFnFor(decoder, opts) {
  return (s, v) => {
    if (s.moraCount < 2) return D.decode([v[0]], 'twoMeans', opts);
    return D.decode(v, decoder, opts);
  };
}

const pct = (x) => (x * 100).toFixed(1) + '%';

// Grid of decoder parameters, tuned on TRAIN by within-mora-count kappa
// (see evaluate()'s comment for why not per-mora accuracy).
const GRID = {
  twoMeans: [0, 50, 100, 150].map((m) => ({ minContrastCents: m })),
  template: [0, 25, 50, 100].map((m) => ({ minContrastCents: m })),
  templateTrend: [].concat(...[0, 25, 50, 100].map((m) =>
    [10, 25, 50, 100, 200].map((d) => ({ minContrastCents: m, maxDeclCents: d })))),
  nucleus: [].concat(...[0, 50, 100].map((m) =>
    [25, 50, 100, 150, 200, 300, 400, 500, 600].map((f) =>
      [0, 25, 50, 100].map((d) => ({ minContrastCents: m, minFallCents: f, maxDeclCents: d }))).flat())),
};

function line(label, te, extra) {
  return `${label.padEnd(34)} TEST balanced=${pct(te.balancedStrict)} kappa=${te.kappa.toFixed(3)} ` +
    `strict=${pct(te.strictPhrase)} perMora=${pct(te.perMora)} unclear=${pct(te.unclearRate)}` +
    (extra ? `  ${extra}` : '');
}

console.log(`train: ${train.length} phrases, test: ${test.length} phrases\n`);
const rows = [];

// Reference rows: a no-audio constant guess (most frequent pattern per mora
// count on TRAIN), and the shipped algorithm itself.
{
  const cnt = {};
  for (const s of train) {
    const t = PitchDiagram.pitchLevels(s.moraCount, s.accentType).slice(0, s.moraCount).join(',');
    cnt[s.moraCount] = cnt[s.moraCount] || {};
    cnt[s.moraCount][t] = (cnt[s.moraCount][t] || 0) + 1;
  }
  const maj = {};
  for (const k of Object.keys(cnt)) maj[k] = Object.entries(cnt[k]).sort((a, b) => b[1] - a[1])[0][0].split(',');
  const teV = precompute(test, 'proportional', 'median');
  const prior = evaluate(test, teV, (s) => maj[s.moraCount] || new Array(s.moraCount).fill('L'));
  rows.push({ label: 'majority prior (no audio)', test: prior });
  console.log(line('majority prior (NO AUDIO)', prior));
  const shipped = evaluate(test, teV, (s) => MoraSegment.segmentByMora(s.trace, s.moraCount, { morae: moraeOf(s) }).pattern); // exactly what app.js calls, incl. the heavy-syllable rule
  rows.push({ label: 'shipped segmentByMora', test: shipped });
  console.log(line('shipped segmentByMora', shipped));
  console.log('');
}

for (const boundaryMode of ['proportional', 'oracle']) {
  for (const method of ['median', 'late', 'target']) {
    const trV = precompute(train, boundaryMode, method);
    const teV = precompute(test, boundaryMode, method);
    for (const decoder of Object.keys(GRID)) {
      let best = null;
      for (const opts of GRID[decoder]) {
        const r = evaluate(train, trV, decoderFnFor(decoder, opts));
        if (!best || r.kappa > best.r.kappa) best = { opts, r };
      }
      const te = evaluate(test, teV, decoderFnFor(decoder, best.opts));
      rows.push({ boundaryMode, method, decoder, opts: best.opts, train: best.r, test: te });
      console.log(line(`${boundaryMode} ${method} ${decoder}`, te,
        `(train kappa=${best.r.kappa.toFixed(3)}; ${JSON.stringify(best.opts)})`));
    }
  }
  console.log('');
}

// Production candidates at a FIXED contrast guard of 100 cents. The tuner
// above always picks 0 because JSUT contains no flat/monotone attempts --
// but a learner's app does, and 100 cents is what the synthetic flat-trace
// study (design spec 2026-09-24 addendum) showed drives false "exact
// match" on no-contrast input to 0%. So the numbers that matter for
// shipping are these, not the tuned-at-0 ones.
console.log('production candidates (proportional slots, fixed minContrastCents=100):');
for (const method of ['median', 'late', 'target']) {
  const teV = precompute(test, 'proportional', method);
  for (const [decoder, opts] of [
    ['twoMeans', { minContrastCents: 100 }],
    ['template', { minContrastCents: 100 }],
    ['templateTrend', { minContrastCents: 100, maxDeclCents: 50 }],
  ]) {
    const te = evaluate(test, teV, decoderFnFor(decoder, opts));
    rows.push({ label: 'production-candidate', method, decoder, opts, test: te });
    console.log(line(`  ${method} ${decoder}`, te));
  }
}
console.log('');

// Research reference, NOT shippable (it is a trained model): Ishi,
// Minematsu & Hirose (2001)'s F0ratio classifier -- the semitone step
// between adjacent mora values, one diagonal Gaussian per (mora count,
// pattern) class fit on TRAIN, maximum likelihood with EQUAL class priors
// (so it can't win by learning the corpus's skewed pattern frequencies).
// Answers: how much accent information do these same per-mora features
// carry when the decision rule is learned rather than hand-specified?
function f0ratios(v) {
  const n = v.length;
  const present = [];
  v.forEach((x, i) => { if (x != null) present.push(i); });
  if (present.length < 2) return null;
  const w = v.slice();
  for (let i = 0; i < n; i++) {
    if (w[i] != null) continue;
    let l = i - 1; while (l >= 0 && v[l] == null) l--;
    let r = i + 1; while (r < n && v[r] == null) r++;
    w[i] = l < 0 ? v[r] : r >= n ? v[l] : v[l] + ((v[r] - v[l]) * (i - l)) / (r - l);
  }
  const out = [];
  for (let i = 1; i < n; i++) out.push(1200 * (w[i] - w[i - 1]));
  return out;
}
for (const boundaryMode of ['proportional', 'oracle']) {
  for (const method of ['median', 'target']) {
    const trV = precompute(train, boundaryMode, method);
    const teV = precompute(test, boundaryMode, method);
    const models = new Map(); // mc -> Map(pattern -> {sum, sumsq, n})
    train.forEach((s, k) => {
      if (!trV[k] || s.moraCount < 2) return;
      const x = f0ratios(trV[k]);
      if (!x) return;
      const pat = PitchDiagram.pitchLevels(s.moraCount, s.accentType).slice(0, s.moraCount).join(',');
      const m = models.get(s.moraCount) || new Map();
      const g = m.get(pat) || { sum: new Array(x.length).fill(0), sumsq: new Array(x.length).fill(0), n: 0 };
      x.forEach((xi, i) => { g.sum[i] += xi; g.sumsq[i] += xi * xi; });
      g.n++;
      m.set(pat, g);
      models.set(s.moraCount, m);
    });
    const VAR_FLOOR = 50 * 50; // cents^2
    const fn = (s, v) => {
      if (s.moraCount < 2) return D.decode([v[0]], 'twoMeans', { minContrastCents: 100 });
      const x = f0ratios(v);
      const m = models.get(s.moraCount);
      if (!x || !m) return new Array(s.moraCount).fill('unclear');
      let best = null, bestLL = -Infinity;
      for (const [pat, g] of m) {
        if (g.n < 10) continue;
        let ll = 0;
        for (let i = 0; i < x.length; i++) {
          const mu = g.sum[i] / g.n;
          const vr = Math.max(VAR_FLOOR, g.sumsq[i] / g.n - mu * mu);
          ll += -0.5 * Math.log(vr) - ((x[i] - mu) * (x[i] - mu)) / (2 * vr);
        }
        if (ll > bestLL) { bestLL = ll; best = pat; }
      }
      return best ? best.split(',') : new Array(s.moraCount).fill('unclear');
    };
    const te = evaluate(test, teV, fn);
    rows.push({ label: 'trained-reference-gaussian-f0ratio', boundaryMode, method, test: te });
    console.log(line(`TRAINED ref ${boundaryMode} ${method} F0ratio-GMM`, te));
  }
}

const out = path.join(__dirname, 'tmp', 'decoder-comparison.json');
fs.writeFileSync(out, JSON.stringify(rows, null, 2));
console.log(`written ${out}`);
