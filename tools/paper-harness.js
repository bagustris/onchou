// paper-harness.js -- shared evaluation harness for the paper experiments
// (tools/paper-*.js). Loads every real-audio split ONCE, with the word's
// morae attached everywhere, and provides the metric everything is judged
// by, so no experiment can quietly use a different split or scorer.
//
// Splits (tuning may only ever look at the *_TRAIN / *_A sets):
//   jsutApp.train / .test   JSUT app-like (phrase + real surrounding silence),
//                           sentences 1-4000 / 4001-5000
//   jsutPhrase.train / .test  JSUT phrases in continuous speech, same split
//   ume.A / .B              UME-JRF Set D natives, alternate speakers
//   ume.learners            UME-JRF Set D learners (agreement with target only)
//
// Metric: within-mora-count Cohen's kappa of predicted vs target pattern (a
// constant guess scores 0; see tools/evaluate-decoders.js), with strict,
// per-mora and unclear rates, and cluster-bootstrap 95% CIs (clusters =
// speakers for UME, sentences for JSUT).
'use strict';

const fs = require('fs');
const path = require('path');
const PD = require('../js/pitch-diagram.js');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, 'tmp');

// ---- JSUT morae from jsut-label phones (pseudo-kana: only what
// heavyInitial needs -- special morae and bare vowels -- is exact).
const V = { a: 'か', i: 'き', u: 'く', e: 'け', o: 'こ' }, BARE = { a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お' };
function pseudoKana(phones) {
  if (phones.length === 1 && phones[0] === 'N') return 'ん';
  if (phones.length === 1 && phones[0] === 'cl') return 'っ';
  const v = phones[phones.length - 1];
  if (phones.length === 1 && BARE[v]) return BARE[v];
  return V[v] || 'か';
}

let cache = null;
function load() {
  if (cache) return cache;
  const { parseAccentPhrases } = require('./jsut-lab-parser.js');
  const labDir = (() => {
    const d = process.env.JSUT_LABEL_DIR;
    if (!d) throw new Error('Set JSUT_LABEL_DIR (see tools/evaluate-jsut-accuracy.js).');
    return fs.existsSync(path.join(d, 'BASIC5000_0001.lab')) ? d : path.join(d, 'labels', 'basic5000');
  })();
  const labCache = new Map();
  const phrasesOf = (id) => {
    if (!labCache.has(id)) labCache.set(id, parseAccentPhrases(fs.readFileSync(path.join(labDir, id + '.lab'), 'utf8')));
    return labCache.get(id);
  };
  const num = (id) => Number(id.split('_').pop());

  const app = JSON.parse(fs.readFileSync(path.join(TMP, 'jsut-applike-v2.json'), 'utf8')).map((s) => {
    const ph = phrasesOf(s.sentenceId);
    const p = s.position === 'initial' ? ph[0] : ph[ph.length - 1];
    return { ...s, accents: [s.accentType], morae: p.moras.map((m) => pseudoKana(m.phones)), cluster: s.sentenceId };
  });

  // Phrase cache entries are in label order per sentence (see
  // evaluate-jsut-accuracy.js buildPhraseSamples), so the k-th sample of a
  // sentence is its k-th parsed phrase.
  const phraseRaw = JSON.parse(fs.readFileSync(path.join(TMP, 'jsut-traces-cache-v4-limitInfinity-pad30.json'), 'utf8'));
  const seen = new Map();
  const phrase = phraseRaw.map((s) => {
    const k = seen.get(s.sentenceId) || 0; seen.set(s.sentenceId, k + 1);
    const p = phrasesOf(s.sentenceId)[k];
    if (p.moraCount !== s.moraCount || p.accentType !== s.accentType) throw new Error('phrase alignment broke at ' + s.sentenceId);
    return { ...s, accents: [s.accentType], morae: p.moras.map((m) => pseudoKana(m.phones)), cluster: s.sentenceId };
  });

  const ume = JSON.parse(fs.readFileSync(path.join(TMP, 'umejrf-dset-v1.json'), 'utf8'))
    .map((s) => ({ ...s, morae: PD.moraSplit(s.reading), cluster: s.speaker }));
  const jjSpk = [...new Set(ume.filter((s) => s.group === 'JJ').map((s) => s.speaker))].sort();
  const halfA = new Set(jjSpk.filter((_, i) => i % 2 === 0));

  cache = {
    jsutApp: { train: app.filter((s) => num(s.sentenceId) <= 4000), test: app.filter((s) => num(s.sentenceId) > 4000) },
    jsutPhrase: { train: phrase.filter((s) => num(s.sentenceId) <= 4000), test: phrase.filter((s) => num(s.sentenceId) > 4000) },
    ume: {
      A: ume.filter((s) => s.group === 'JJ' && halfA.has(s.speaker)),
      B: ume.filter((s) => s.group === 'JJ' && !halfA.has(s.speaker)),
      all: ume.filter((s) => s.group === 'JJ'),
      learners: ume.filter((s) => s.group === 'FJ'),
    },
  };
  return cache;
}

function targetFor(s, pred) {
  const pats = s.accents.map((a) => PD.pitchLevels(s.moraCount, a).slice(0, s.moraCount));
  return pats.find((p) => p.join('') === pred.join('')) || pats[0];
}

// metrics(set, predict) where predict(sample) -> pattern array.
function aggregate(items) { // items: [{s, p}]
  const by = new Map();
  let m = 0, u = 0, t = 0, st = 0, ph = 0;
  for (const { s, p } of items) {
    const tg = targetFor(s, p);
    let mm = 0, uu = 0;
    for (let i = 0; i < tg.length; i++) { if (p[i] === 'unclear') uu++; else if (p[i] === tg[i]) mm++; }
    m += mm; u += uu; t += tg.length; ph++;
    if (mm === tg.length) st++;
    const g = by.get(s.moraCount) || { t: new Map(), p: new Map(), a: 0, N: 0 };
    const tl = tg.join(''), pl = p.join('');
    g.t.set(tl, (g.t.get(tl) || 0) + 1); g.p.set(pl, (g.p.get(pl) || 0) + 1);
    if (tl === pl) g.a++; g.N++;
    by.set(s.moraCount, g);
  }
  let ks = 0, kw = 0;
  for (const g of by.values()) {
    if (g.N < 20 || g.t.size < 2) continue;
    let pe = 0;
    for (const [l, c] of g.t) pe += (c / g.N) * ((g.p.get(l) || 0) / g.N);
    ks += g.N * ((g.a / g.N - pe) / (1 - pe)); kw += g.N;
  }
  return { kappa: kw ? ks / kw : NaN, strict: st / ph, perMora: m / (t - u), pessimistic: m / t, unclear: u / t, n: ph };
}

function predictAll(set, predict) {
  const out = [];
  for (const s of set) {
    if (!s.trace.some((f) => f && f.hz != null)) continue; // no voice at all: excluded, as the app does
    out.push({ s, p: predict(s) });
  }
  return out;
}

function metrics(set, predict) { return aggregate(predictAll(set, predict)); }

// Cluster bootstrap 95% CI for kappa (and optionally a paired difference
// against a second predictor on the SAME resamples).
function bootstrap(set, predict, B, predict2) {
  B = B || 300;
  const items = predictAll(set, predict);
  const items2 = predict2 ? predictAll(set, predict2) : null;
  const clusters = new Map();
  items.forEach((it, i) => {
    const k = it.s.cluster;
    if (!clusters.has(k)) clusters.set(k, []);
    clusters.get(k).push(i);
  });
  const keys = [...clusters.keys()];
  let seed = 20260925;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ks = [], ds = [];
  for (let b = 0; b < B; b++) {
    const idx = [];
    for (let i = 0; i < keys.length; i++) idx.push(...clusters.get(keys[Math.floor(rnd() * keys.length)]));
    const k1 = aggregate(idx.map((i) => items[i])).kappa;
    ks.push(k1);
    if (items2) ds.push(aggregate(idx.map((i) => items2[i])).kappa - k1);
  }
  const q = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(p * (a.length - 1))]; };
  const out = { point: aggregate(items), ci: [q(ks, 0.025), q(ks, 0.975)] };
  if (items2) out.diff = { point: aggregate(items2).kappa - out.point.kappa, ci: [q(ds, 0.025), q(ds, 0.975)] };
  return out;
}

// variant({NAME: value, ...}) -> a fresh copy of js/mora-segment.js with the
// given `var NAME = ...;` constants overridden (real file untouched).
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'mora-segment.js'), 'utf8');
let variantN = 0;
function variant(overrides) {
  let src = SRC;
  for (const [k, v] of Object.entries(overrides || {})) {
    const re = new RegExp(`var ${k} = [^;]+;`);
    if (!re.test(src)) throw new Error('no constant ' + k);
    src = src.replace(re, `var ${k} = ${JSON.stringify(v)};`);
  }
  const f = path.join(TMP, `ms-variant-${process.pid}-${variantN++}.js`);
  fs.writeFileSync(f, src);
  const mod = require(f);
  fs.unlinkSync(f);
  return mod;
}

const shipped = require('../js/mora-segment.js');
const predictShipped = (MS) => (s) => (MS || shipped).segmentByMora(s.trace, s.moraCount, { morae: s.morae }).pattern;

const fmt = (r) => `k=${r.kappa.toFixed(3)} strict=${(100 * r.strict).toFixed(1)}% perMora=${(100 * r.perMora).toFixed(1)}% unclear=${(100 * r.unclear).toFixed(1)}%`;

// Morae (pseudo-kana) for a JSUT sample from its own stored label phones.
const moraeOf = (s) => (s.moras && s.moras[0] && s.moras[0].phones ? s.moras.map((m) => pseudoKana(m.phones)) : undefined);

module.exports = { load, metrics, bootstrap, variant, predictShipped, targetFor, fmt, shipped, pseudoKana, moraeOf };
