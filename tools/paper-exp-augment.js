#!/usr/bin/env node
// paper-exp-augment.js -- a small learned accent classifier trained with
// ACCENT-SWAP AUGMENTATION (the "#5" idea: learn from isolated, on-time
// native words, with labelled wrong answers).
//
// Earlier learned models (tools/paper-exp-learned.js) were trained on
// natives' correct takes only, so (a) every word came with one pattern,
// letting a model lean on how common a pattern is for a mora count, and (b)
// nothing taught them what an ABSENT accent looks like -- the Ishi-style
// Gaussians accept 44% of flat takes and score J 24 on the swap test. Here
// the training set, all from UME natives A (the choosing speakers), is
//   - each native take, labelled with its dictionary pattern,
//   - its WORLD accent swaps (tools/paper-swap.py), labelled with the
//     produced pattern -- every shape for every word, same voice and timing,
//   - its accent-removed versions (tools/paper-flatten.py flat/decl),
//     labelled NONE,
// and the model is multinomial logistic regression per mora count on the
// production slot values (js/mora-segment.js computeSlots, silent morae
// included): per-slot cents re the take mean and adjacent steps. Decision:
// the most likely class; NONE or probability < TAU -> all 'unclear'.
// TAU is chosen on natives A (speaker-grouped cross-validation) for the
// best kappa with flat false acceptance no higher than the shipped
// decoder's on the same speakers.
//
// Reported on natives B, learners, JSUT app test (kappa), the swap test
// (Youden J) and the flat test on natives B, plus the synthetic on-time check
// and a word-disjoint split (train on half the words, test on the rest).
//   UMEJRF_DIR=... node tools/paper-exp-augment.js
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./paper-harness.js');
const PD = require('../js/pitch-diagram.js');
const { readWavSync } = require('./wav-reader.js');
const { buildTrace } = require('./evaluate-jsut-accuracy.js');
const MS = H.shipped;
const D = H.load();
const ROOT = process.env.UMEJRF_DIR;
const TMP = path.join(__dirname, 'tmp');

// ---------------------------------------------------------------- data
const relOf = (s) => { const [site, spk] = s.speaker.split('/'); return path.join(s.group, site, spk, `D1_${String(s.wordIdx).padStart(3, '0')}.wav`); };
const swapTraces = JSON.parse(fs.readFileSync(path.join(TMP, 'swap-traces.json'), 'utf8'));
const manifest = fs.readFileSync(path.join(TMP, 'swap-manifest.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const flatCacheFile = path.join(TMP, 'flat-traces.json');
const flatCache = fs.existsSync(flatCacheFile) ? JSON.parse(fs.readFileSync(flatCacheFile, 'utf8')) : {};
let flatAdded = 0;
function flatTrace(variant, rel) {
  const key = `${variant}/${rel}`;
  if (!(key in flatCache)) {
    const f = path.join(ROOT, 'wav48', 'flat', variant, rel);
    if (!fs.existsSync(f)) flatCache[key] = null;
    else { const w = readWavSync(f); flatCache[key] = buildTrace(w.samples, w.sampleRate, 0, w.samples.length / w.sampleRate); }
    flatAdded++;
  }
  return flatCache[key];
}
const shapeOf = (n, a) => PD.pitchLevels(n, a).slice(0, n).join('');
function nativeRows(set) { // [{s-like, label, kind}]
  const rows = [];
  for (const s of set) {
    if (s.moraCount < 2 || s.accents.length !== 1) continue;
    rows.push({ ...s, label: shapeOf(s.moraCount, s.accents[0]), kind: 'native' });
  }
  return rows;
}
const swapBy = new Map(); // rel -> manifest rows
for (const r of manifest) { if (!swapBy.has(r.rel)) swapBy.set(r.rel, []); swapBy.get(r.rel).push(r); }
function augmentedRows(set) {
  const rows = nativeRows(set);
  for (const s of set) {
    if (s.moraCount < 2 || s.accents.length !== 1) continue;
    const rel = relOf(s);
    for (const r of swapBy.get(rel) || []) {
      const tr = swapTraces[`${r.swap}/${r.rel}`];
      if (tr) rows.push({ ...s, trace: tr, label: r.new, kind: r.swap === 'selfswap' ? 'selfswap' : 'swap' });
    }
    for (const v of ['flat', 'decl']) { const tr = flatTrace(v, rel); if (tr) rows.push({ ...s, trace: tr, label: 'NONE', kind: v }); }
  }
  return rows;
}

// ---------------------------------------------------------------- features
function slotCents(s) {
  const c = MS._computeSlots(s.trace, s.moraCount, MS._silentFor(s.morae, s.moraCount));
  if (!c) return null;
  const v = c.slotMedians, n = v.length, idx = [];
  v.forEach((x, i) => { if (x != null) idx.push(i); });
  if (idx.length < 2) return null;
  const w = v.slice();
  for (let i = 0; i < n; i++) {
    if (w[i] != null) continue;
    let l = i - 1; while (l >= 0 && v[l] == null) l--;
    let r = i + 1; while (r < n && v[r] == null) r++;
    w[i] = l < 0 ? v[r] : r >= n ? v[l] : v[l] + ((v[r] - v[l]) * (i - l)) / (r - l);
  }
  return { cents: w.map((x) => 1200 * Math.log2(x)), present: v.map((x) => x != null) };
}
function featurize(s) {
  const sc = slotCents(s);
  if (!sc) return null;
  const c = sc.cents, n = c.length, mean = c.reduce((a, b) => a + b, 0) / n;
  const f = [1];
  for (let i = 0; i < n; i++) f.push((c[i] - mean) / 100);
  for (let i = 1; i < n; i++) f.push((c[i] - c[i - 1]) / 100);
  const steps = c.slice(1).map((x, i) => x - c[i]);
  f.push(Math.max(...c.map((x) => x - mean)) / 100 - Math.min(...c.map((x) => x - mean)) / 100);
  f.push(Math.max(0, -Math.min(...steps)) / 100, Math.max(0, Math.max(...steps)) / 100);
  return f;
}

// ---------------------------------------------------------------- model
const classesFor = (n) => [...new Set([0, ...Array.from({ length: n }, (_, i) => i + 1)].map((a) => shapeOf(n, a)))].concat(['NONE']);
function trainLR(rows, l2 = 1e-3, epochs = 300, lr = 0.2) {
  const byN = new Map();
  for (const r of rows) {
    const x = featurize(r); if (!x) continue;
    if (!byN.has(r.moraCount)) byN.set(r.moraCount, []);
    byN.get(r.moraCount).push({ x, y: r.label });
  }
  const model = new Map();
  for (const [n, data] of byN) {
    const cls = classesFor(n), K = cls.length, d = data[0].x.length;
    const W = cls.map(() => new Array(d).fill(0));
    const cnt = cls.map((c) => data.filter((e) => e.y === c).length);
    const wt = cnt.map((k) => (k ? data.length / (K * k) : 0)); // balanced classes
    for (let ep = 0; ep < epochs; ep++) {
      const G = cls.map(() => new Array(d).fill(0));
      for (const { x, y } of data) {
        const yi = cls.indexOf(y); if (yi < 0) continue;
        const z = W.map((w) => w.reduce((a, wj, j) => a + wj * x[j], 0));
        const mx = Math.max(...z), e = z.map((v) => Math.exp(v - mx)), se = e.reduce((a, b) => a + b, 0);
        for (let k = 0; k < K; k++) { const g = (e[k] / se - (k === yi ? 1 : 0)) * wt[yi]; for (let j = 0; j < d; j++) G[k][j] += g * x[j]; }
      }
      for (let k = 0; k < K; k++) for (let j = 0; j < d; j++) W[k][j] -= lr * (G[k][j] / data.length + l2 * W[k][j]);
    }
    model.set(n, { cls, W });
  }
  return model;
}
function predictProba(model, s) {
  const m = model.get(s.moraCount); const x = featurize(s);
  if (!m || !x) return null;
  const z = m.W.map((w) => w.reduce((a, wj, j) => a + wj * x[j], 0));
  const mx = Math.max(...z), e = z.map((v) => Math.exp(v - mx)), se = e.reduce((a, b) => a + b, 0);
  return m.cls.map((c, k) => ({ c, p: e[k] / se })).sort((a, b) => b.p - a.p);
}
const predictor = (model, tau) => (s) => {
  const pr = predictProba(model, s);
  if (!pr || pr[0].c === 'NONE' || pr[0].p < tau) return new Array(s.moraCount).fill('unclear');
  return pr[0].c.split('');
};

// ---------------------------------------------------------------- evaluation helpers
function flatFA(set, fn) { // accented-target words scored correct on flat/decl resynthesis
  const acc = { flat: [0, 0], decl: [0, 0], copy: [0, 0] };
  for (const s of set) {
    if (s.moraCount < 2) continue;
    const noFall = s.accents.some((a) => { const p = shapeOf(s.moraCount, a); return p.lastIndexOf('H') === s.moraCount - 1 && p[0] === 'L'; });
    if (noFall) continue;
    for (const v of Object.keys(acc)) {
      const tr = flatTrace(v, relOf(s)); if (!tr || !tr.some((f) => f.hz != null)) continue;
      const p = fn({ ...s, trace: tr }).join('');
      acc[v][1]++; if (s.accents.some((a) => shapeOf(s.moraCount, a) === p)) acc[v][0]++;
    }
  }
  return { flat: acc.flat[0] / acc.flat[1], decl: acc.decl[0] / acc.decl[1], copy: acc.copy[0] / acc.copy[1] };
}
function swapJ(set, fn) {
  const rels = new Set(set.map(relOf));
  let wN = 0, wNot = 0, cN = 0, cNot = 0, exact = 0;
  for (const r of manifest) {
    if (!rels.has(r.rel)) continue;
    const tr = swapTraces[`${r.swap}/${r.rel}`]; if (!tr || !tr.some((f) => f.hz != null)) continue;
    const s = { trace: tr, moraCount: r.moraCount, accents: r.accents, morae: r.morae };
    const p = fn(s).join(''), target = shapeOf(r.moraCount, r.accents[0]);
    if (r.swap === 'selfswap') { cN++; if (p !== target) cNot++; }
    else { wN++; if (p !== target) wNot++; if (p === r.new) exact++; }
  }
  return { J: wNot / wN - cNot / cN, det: wNot / wN, fa: cNot / cN, diag: exact / wN };
}
// synthetic on-time words (the check that sank js/accent-model.js): dense
// clean steps, H/L ratio 1.2, 150ms morae, every (n, accent) for n = 2..5
function syntheticExact(fn) {
  let ok = 0, tot = 0;
  for (let n = 2; n <= 5; n++) for (let a = 0; a <= n; a++) {
    const lv = PD.pitchLevels(n, a).slice(0, n), tr = [];
    lv.forEach((l, i) => { for (let t = 0; t < 150; t += 20) tr.push({ tMs: 200 + i * 150 + t, hz: l === 'H' ? 180 : 150, rms: 0.3 }); });
    const pad = (t0, t1) => { for (let t = t0; t < t1; t += 20) tr.push({ tMs: t, hz: null, rms: 0.001 }); };
    pad(0, 200); pad(200 + n * 150, 400 + n * 150); tr.sort((x, y) => x.tMs - y.tMs);
    const p = fn({ trace: tr, moraCount: n, accents: [a], morae: new Array(n).fill('か').map((_, i) => 'かなまらた'[i % 5]) }).join('');
    tot++; if (p === lv.join('')) ok++;
  }
  return ok / tot;
}

// ---------------------------------------------------------------- choose TAU on natives A (speaker-grouped CV)
const shipped = H.predictShipped();
const A = D.ume.A, Bset = D.ume.B;
const spkA = [...new Set(A.map((s) => s.speaker))].sort();
const folds = [0, 1, 2, 3].map((k) => new Set(spkA.filter((_, i) => i % 4 === k)));
const TAUS = [0, 0.4, 0.5, 0.6, 0.7, 0.8];
const cvPred = new Map(); // tau -> Map(sample -> pattern) on A natives and A flat
const shippedFlatA = flatFA(A, shipped);
console.log(`shipped on natives A: flat FA ${(100 * shippedFlatA.flat).toFixed(1)}% / decl ${(100 * shippedFlatA.decl).toFixed(1)}%`);
const cvRows = [];
for (const test of folds) {
  const tr = A.filter((s) => !test.has(s.speaker)), te = A.filter((s) => test.has(s.speaker));
  const m = trainLR(augmentedRows(tr));
  cvRows.push({ m, te });
}
console.log('\nTAU choice (natives A, 4-fold speaker CV): kappa / flat FA / decl FA');
let bestTau = null, bestK = -1;
for (const tau of TAUS) {
  const items = [], fa = { flat: [0, 0], decl: [0, 0] };
  for (const { m, te } of cvRows) {
    const fn = predictor(m, tau);
    for (const s of te) items.push(s);
    const r = flatFA(te, fn), nAcc = te.filter((s) => s.moraCount >= 2).length;
    fa.flat[0] += r.flat * nAcc; fa.flat[1] += nAcc; fa.decl[0] += r.decl * nAcc; fa.decl[1] += nAcc;
  }
  const byS = new Map(); for (const { m, te } of cvRows) for (const s of te) byS.set(s, predictor(m, tau)(s));
  const k = H.metrics(items, (s) => byS.get(s));
  const ffa = fa.flat[0] / fa.flat[1], dfa = fa.decl[0] / fa.decl[1];
  const okGuard = ffa <= shippedFlatA.flat + 1e-9 && dfa <= shippedFlatA.decl + 1e-9;
  console.log(`  tau=${tau}: ${H.fmt(k)} | flat FA ${(100 * ffa).toFixed(1)}% decl FA ${(100 * dfa).toFixed(1)}% ${okGuard ? '' : '(fails guard)'}`);
  if (okGuard && k.kappa > bestK) { bestK = k.kappa; bestTau = tau; }
}
if (bestTau == null) bestTau = TAUS[TAUS.length - 1];
console.log(`chosen TAU = ${bestTau}`);

// ---------------------------------------------------------------- final model: all of natives A
const full = trainLR(augmentedRows(A));
const noAug = trainLR(nativeRows(A)); // ablation: natives only (no swaps / flat)
const systems = {
  'shipped model-free': shipped,
  'augmented LR (swaps + flat)': predictor(full, bestTau),
  'LR natives only (no augmentation)': predictor(noAug, 0),
};
console.log('\n## Held-out (trained on natives A only)');
console.log('| system | natives B κ | learners κ | JSUT app test κ | swap J (B) | swap detection / FA | flat FA (B) | decl FA (B) | copy accept (B) | synthetic on-time exact |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
const res = {};
for (const [name, fn] of Object.entries(systems)) {
  const kb = H.bootstrap(Bset, fn, 300), kl = H.metrics(D.ume.learners, fn), kj = H.metrics(D.jsutApp.test, fn);
  const sj = swapJ(Bset, fn), ff = flatFA(Bset, fn), syn = syntheticExact(fn);
  res[name] = { kb, kl, kj, sj, ff, syn };
  console.log(`| ${name} | ${kb.point.kappa.toFixed(3)} [${kb.ci[0].toFixed(3)}, ${kb.ci[1].toFixed(3)}] | ${kl.kappa.toFixed(3)} | ${kj.kappa.toFixed(3)} | ${(100 * sj.J).toFixed(1)} | ${(100 * sj.det).toFixed(1)} / ${(100 * sj.fa).toFixed(1)} | ${(100 * ff.flat).toFixed(1)}% | ${(100 * ff.decl).toFixed(1)}% | ${(100 * ff.copy).toFixed(1)}% | ${(100 * syn).toFixed(0)}% |`);
}
// paired difference augmented vs shipped on natives B kappa
const pd = H.bootstrap(Bset, shipped, 300, systems['augmented LR (swaps + flat)']);
console.log(`\nΔκ natives B, augmented − shipped: ${pd.diff.point.toFixed(3)} [${pd.diff.ci[0].toFixed(3)}, ${pd.diff.ci[1].toFixed(3)}]`);

// ---------------------------------------------------------------- word-disjoint check
const words = [...new Set(A.map((s) => s.word))].sort();
const W1 = new Set(words.filter((_, i) => i % 2 === 0));
const mW = trainLR(augmentedRows(A.filter((s) => W1.has(s.word))));
const Bw2 = Bset.filter((s) => !W1.has(s.word));
const fnW = predictor(mW, bestTau);
console.log(`\nword-disjoint (train natives A on half the words, test natives B on the other half, n=${Bw2.length}):`);
console.log(`  augmented LR ${H.fmt(H.metrics(Bw2, fnW))} | same-words model on the same takes ${H.fmt(H.metrics(Bw2, systems['augmented LR (swaps + flat)']))} | shipped ${H.fmt(H.metrics(Bw2, shipped))}`);
console.log(`  swap J on those words: augmented(word-disjoint) ${(100 * swapJ(Bw2, fnW).J).toFixed(1)} vs shipped ${(100 * swapJ(Bw2, shipped).J).toFixed(1)}`);

let nParams = 0; for (const m of full.values()) nParams += m.W.length * m.W[0].length;
console.log(`\nmodel size: ${nParams} numbers`);
if (flatAdded) fs.writeFileSync(flatCacheFile, JSON.stringify(flatCache));
fs.writeFileSync(path.join(TMP, 'augment-model.json'), JSON.stringify({ tau: bestTau, models: Object.fromEntries([...full].map(([n, m]) => [n, m])) }));

// ---------------------------------------------------------------- guarded hybrid: shipped guard decides WHETHER, natives-only LR decides WHICH
const hybrid = (s) => {
  const base = shipped(s);
  if (base.every((x) => x === 'unclear')) return base;
  const pr = predictProba(noAug, s);
  if (!pr) return base;
  const best = pr.find((e) => e.c !== 'NONE');
  return best ? best.c.split('').map((x, i) => (base[i] === 'unclear' ? 'unclear' : x)) : base;
};
{
  const kb = H.bootstrap(Bset, hybrid, 300), sj = swapJ(Bset, hybrid), ff = flatFA(Bset, hybrid);
  console.log(`\nguarded hybrid (shipped guard + natives-only LR): natives B κ ${kb.point.kappa.toFixed(3)} [${kb.ci[0].toFixed(3)}, ${kb.ci[1].toFixed(3)}] | learners ${H.metrics(D.ume.learners, hybrid).kappa.toFixed(3)} | JSUT ${H.metrics(D.jsutApp.test, hybrid).kappa.toFixed(3)} | swap J ${(100 * sj.J).toFixed(1)} (det ${(100 * sj.det).toFixed(1)} / FA ${(100 * sj.fa).toFixed(1)}, diag ${(100 * sj.diag).toFixed(1)}) | flat FA ${(100 * ff.flat).toFixed(1)}% decl ${(100 * ff.decl).toFixed(1)}% | synthetic ${(100 * syntheticExact(hybrid)).toFixed(0)}%`);
}
