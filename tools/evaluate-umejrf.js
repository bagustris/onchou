#!/usr/bin/env node
// evaluate-umejrf.js -- transfer test of the shipped pipeline on UME-JRF's
// isolated words (tools/build-umejrf-set.js): 33 native Tokyo speakers (JJ)
// and 141 learners (FJ), none of whom any parameter was tuned on.
//
// Target = the dictionary (Kanjium) accent. A word with several accepted
// accents counts as correct if the prediction matches ANY of them.
//
// Metric: within-mora-count Cohen's kappa (a no-audio constant guess
// scores 0; see tools/evaluate-decoders.js), plus strict whole-word and
// per-mora accuracy. Speaker-level bootstrap 95% CIs, since samples from
// one speaker aren't independent.
'use strict';

const fs = require('fs');
const path = require('path');
const PitchDiagram = require('../js/pitch-diagram.js');
const MoraSegment = require('../js/mora-segment.js');
const D = require('./accent-decoders.js');

const S = JSON.parse(fs.readFileSync(path.join(__dirname, 'tmp', 'umejrf-dset-v1.json'), 'utf8'));

function targetFor(s, pred) {
  const pats = s.accents.map((a) => PitchDiagram.pitchLevels(s.moraCount, a).slice(0, s.moraCount));
  return pats.find((p) => p.join('') === pred.join('')) || pats[0];
}

function metrics(set, fn) {
  const by = new Map();
  let m = 0, u = 0, t = 0, st = 0, ph = 0;
  for (const s of set) {
    if (!s.trace.some((f) => f && f.hz != null)) continue;
    const p = fn(s);
    const tg = targetFor(s, p);
    const sc = MoraSegment.scorePattern(p, tg);
    m += sc.matched; u += sc.unclear; t += sc.total; ph++;
    if (sc.matched === sc.total) st++;
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
  return { kappa: kw ? ks / kw : NaN, strict: st / ph, perMora: m / (t - u), unclear: u / t, n: ph };
}

// Speaker-level bootstrap CI for kappa.
function bootstrap(set, fn, B = 200) {
  const spk = [...new Set(set.map((s) => s.speaker))];
  const bySpk = new Map(spk.map((k) => [k, set.filter((s) => s.speaker === k)]));
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  // Cache predictions once per sample so bootstrapping only re-aggregates.
  const cached = new Map(set.map((s) => [s, fn(s)]));
  const ks = [];
  for (let b = 0; b < B; b++) {
    const draw = [];
    for (let i = 0; i < spk.length; i++) draw.push(...bySpk.get(spk[Math.floor(rnd() * spk.length)]));
    ks.push(metrics(draw, (s) => cached.get(s)).kappa);
  }
  ks.sort((a, b) => a - b);
  return [ks[Math.floor(B * 0.025)], ks[Math.floor(B * 0.975)]];
}

const old = (s) => {
  const v = D.moraValuesProportional(s.trace, s.moraCount, 'median', 0);
  return v ? D.decode(v, 'twoMeans', { minContrastCents: 100 }) : new Array(s.moraCount).fill('unclear');
};
const shipped = (s) => MoraSegment.segmentByMora(s.trace, s.moraCount, { morae: PitchDiagram.moraSplit(s.reading) }).pattern;

// No-audio reference: most frequent target pattern per mora count.
function priorFn(set) {
  const cnt = {};
  for (const s of set) {
    const t = PitchDiagram.pitchLevels(s.moraCount, s.accents[0]).slice(0, s.moraCount).join(',');
    cnt[s.moraCount] = cnt[s.moraCount] || {};
    cnt[s.moraCount][t] = (cnt[s.moraCount][t] || 0) + 1;
  }
  const maj = {};
  for (const k of Object.keys(cnt)) maj[k] = Object.entries(cnt[k]).sort((a, b) => b[1] - a[1])[0][0].split(',');
  return (s) => maj[s.moraCount];
}

const pct = (x) => (x * 100).toFixed(1) + '%';
const rows = {};
for (const group of ['JJ', 'FJ']) {
  const set = S.filter((s) => s.group === group);
  console.log(`\n=== ${group === 'JJ' ? 'NATIVE Tokyo speakers (JJ)' : 'LEARNERS (FJ) -- agreement with the target, not detection accuracy'}: ${set.length} words, ${new Set(set.map((s) => s.speaker)).size} speakers ===`);
  for (const [name, fn] of [['no-audio prior', priorFn(set)], ['old (pre-2026-09-25)', old], ['shipped (current)', shipped]]) {
    const r = metrics(set, fn);
    const ci = name === 'no-audio prior' ? null : bootstrap(set, fn);
    rows[group + ':' + name] = { ...r, ci };
    console.log(`  ${name.padEnd(22)} kappa=${r.kappa.toFixed(3)}${ci ? ` [95% CI ${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]` : '                     '} strict=${pct(r.strict)} perMora=${pct(r.perMora)} unclear=${pct(r.unclear)}`);
  }
}
fs.writeFileSync(path.join(__dirname, 'tmp', 'umejrf-results.json'), JSON.stringify(rows, null, 2));
