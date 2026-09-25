#!/usr/bin/env node
// evaluate-pipeline.js -- end-to-end comparison of the shipped per-mora
// pipeline against the literature-derived improvements in
// tools/accent-decoders.js, on two real-audio JSUT sets:
//   - phrase: every accent phrase, 30ms pad (tools/evaluate-jsut-accuracy.js
//     cache) -- continuous-speech context.
//   - applike: sentence-initial/-final phrases WITH their real surrounding
//     silence (tools/build-applike-set.js) -- closest to an onchou take.
// Parameters are tuned ONLY on sentences 1..4000 of the applike set; every
// reported number is on held-out sentences 4001..5000.
//
// Primary metric: within-mora-count Cohen's kappa of the predicted pattern
// vs the target pattern (a no-audio constant guess scores 0) -- see
// tools/evaluate-decoders.js for why per-mora accuracy is misleading on
// this corpus. The contrast guard is FIXED at 100 cents for every
// candidate (the production honesty rule against flat attempts, which JSUT
// can't exercise because it has none).
'use strict';

const fs = require('fs');
const path = require('path');
const PitchDiagram = require('../js/pitch-diagram.js');
const MoraSegment = require('../js/mora-segment.js');
const D = require('./accent-decoders.js');
const { moraeOf } = require('./paper-harness.js');

const TMP = path.join(__dirname, 'tmp');
const sets = {
  phrase: JSON.parse(fs.readFileSync(path.join(TMP, 'jsut-traces-cache-v4-limitInfinity-pad30.json'), 'utf8')),
  applike: JSON.parse(fs.readFileSync(path.join(TMP, 'jsut-applike-v2.json'), 'utf8')),
};
const num = (id) => Number(id.split('_').pop());
const split = (arr) => ({ train: arr.filter((s) => num(s.sentenceId) <= 4000), test: arr.filter((s) => num(s.sentenceId) > 4000) });
const S = { phrase: split(sets.phrase), applike: split(sets.applike) };

function metrics(set, fn) {
  const by = new Map();
  let m = 0, u = 0, t = 0, st = 0, ph = 0;
  for (const s of set) {
    if (!s.trace.some((f) => f && f.hz != null)) continue;
    const p = fn(s);
    const tg = PitchDiagram.pitchLevels(s.moraCount, s.accentType).slice(0, s.moraCount);
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
  return { kappa: ks / kw, strict: st / ph, perMora: m / (t - u), unclear: u / t };
}

// A full candidate pipeline: optional voice gate -> proportional slots
// (optionally delayed by shiftMs) -> per-mora value -> decoder.
function pipeline(cfg) {
  return (s) => {
    const tr = D.gateTrace(s.trace, cfg.gateDb);
    if (s.moraCount < 2 || !tr.some((f) => f && f.hz != null)) return MoraSegment.segmentByMora(tr, s.moraCount).pattern;
    const v = D.moraValuesProportional(tr, s.moraCount, cfg.method, 0, cfg.shiftMs);
    return D.decode(v, cfg.decoder, { minContrastCents: 100, maxDeclCents: 50 });
  };
}
// Exactly what app.js calls, incl. the morae that enable the heavy-syllable rule.
const shipped = (s) => MoraSegment.segmentByMora(s.trace, s.moraCount, { morae: moraeOf(s) }).pattern;

const pct = (x) => (x * 100).toFixed(1) + '%';
function report(label, fn) {
  const a = metrics(S.applike.test, fn), p = metrics(S.phrase.test, fn);
  console.log(`${label.padEnd(44)} applike: k=${a.kappa.toFixed(3)} strict=${pct(a.strict)} perMora=${pct(a.perMora)} unclear=${pct(a.unclear)} | phrase: k=${p.kappa.toFixed(3)} strict=${pct(p.strict)}`);
  return { label, applike: a, phrase: p };
}

// ---- tune on applike TRAIN
const grid = [];
for (const gateDb of [null, 20, 25, 30, 35, 40])
  for (const method of ['median', 'late'])
    for (const shiftMs of [0, 25, 50, 75, 100, 125, 150])
      for (const decoder of ['twoMeans', 'template', 'templateTrend'])
        grid.push({ gateDb, method, shiftMs, decoder });
let best = null;
const trainScores = [];
for (const cfg of grid) {
  const r = metrics(S.applike.train, pipeline(cfg));
  trainScores.push({ cfg, kappa: r.kappa });
  if (!best || r.kappa > best.kappa) best = { cfg, kappa: r.kappa };
}
console.log(`tuned on applike train (${S.applike.train.length} samples); best: ${JSON.stringify(best.cfg)} k=${best.kappa.toFixed(3)}\n`);

// ---- held-out results: baseline, one-component ablations, tuned best
const rows = [];
console.log(`held-out TEST (applike n=${S.applike.test.length}, phrase n=${S.phrase.test.length}):`);
rows.push(report('shipped segmentByMora', shipped));
const bestGate = (dec, shiftMs, method) => {
  let b = null;
  for (const t of trainScores) {
    if (t.cfg.decoder !== dec || t.cfg.shiftMs !== shiftMs || t.cfg.method !== method) continue;
    if (!b || t.kappa > b.kappa) b = t;
  }
  return b.cfg.gateDb;
};
const g = bestGate('twoMeans', 0, 'median');
rows.push(report(`+ voice gate only (${g}dB)`, pipeline({ gateDb: g, method: 'median', shiftMs: 0, decoder: 'twoMeans' })));
rows.push(report('+ constrained templates only', pipeline({ gateDb: null, method: 'median', shiftMs: 0, decoder: 'templateTrend' })));
rows.push(report(`+ gate + templates`, pipeline({ gateDb: best.cfg.gateDb, method: 'median', shiftMs: 0, decoder: 'templateTrend' })));
rows.push(report(`+ gate + templates + delay ${best.cfg.shiftMs}ms`, pipeline({ ...best.cfg, method: 'median', decoder: 'templateTrend' })));
rows.push(report(`TUNED BEST ${JSON.stringify(best.cfg)}`, pipeline(best.cfg)));

// Sensitivity to the delay (the one component whose transfer from fast read
// speech to slow single words is uncertain), all else at the tuned best.
console.log('\ndelay sensitivity (tuned config, varying shiftMs):');
for (const shiftMs of [0, 25, 50, 75, 100, 125, 150]) {
  rows.push(report(`  shiftMs=${shiftMs}`, pipeline({ ...best.cfg, shiftMs })));
}

fs.writeFileSync(path.join(TMP, 'pipeline-comparison.json'), JSON.stringify({ best, rows }, null, 2));
