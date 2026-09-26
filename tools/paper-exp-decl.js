#!/usr/bin/env node
// paper-exp-decl.js -- tunes the decoder's declination bound
// (MAX_DECLINATION_CENTS) and fall threshold (MIN_SPLIT_CENTS) against BOTH
// accuracy on real speech and false acceptance of realistic monotone takes
// (tools/paper-flatten.py: natives' own words resynthesized flat / flat with
// a 15% declining drift). Choose on natives A (+ JSUT app train); report B.
//   false acceptance = % of ACCENTED-target words (a fall is required) whose
//   accentless resynthesis is still scored fully correct.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./paper-harness.js');
const PD = require('../js/pitch-diagram.js');
const { readWavSync } = require('./wav-reader.js');
const { buildTrace } = require('./evaluate-jsut-accuracy.js');
const D = H.load();
const ROOT = process.env.UMEJRF_DIR;
const rel = (s) => { const [site, spk] = s.speaker.split('/'); return path.join(s.group, site, spk, `D1_${String(s.wordIdx).padStart(3, '0')}.wav`); };
const accented = (s) => !s.accents.some((a) => { const p = PD.pitchLevels(s.moraCount, a).slice(0, s.moraCount); return p[0] === 'L' && p.lastIndexOf('H') === s.moraCount - 1; });

function flatSet(set, variant) {
  return set.filter((s) => s.moraCount >= 2 && accented(s)).map((s) => {
    const f = path.join(ROOT, 'wav48', 'flat', variant, rel(s));
    if (!fs.existsSync(f)) return null;
    const w = readWavSync(f);
    return { ...s, trace: buildTrace(w.samples, w.sampleRate, 0, w.samples.length / w.sampleRate) };
  }).filter(Boolean);
}
const flatA = { flat: flatSet(D.ume.A, 'flat'), decl: flatSet(D.ume.A, 'decl') };
const flatB = { flat: flatSet(D.ume.B, 'flat'), decl: flatSet(D.ume.B, 'decl') };
function falseAccept(set, f) {
  let ok = 0, n = 0;
  for (const s of set) {
    if (!s.trace.some((x) => x.hz != null)) continue;
    const p = f(s).join('');
    if (s.accents.some((a) => PD.pitchLevels(s.moraCount, a).slice(0, s.moraCount).join('') === p)) ok++;
    n++;
  }
  return ok / n;
}
const pct = (x) => (100 * x).toFixed(1).padStart(5) + '%';
console.log('[trendMin] maxDecl minSplit | natives A k  JSUT train k  FA flat  FA decl (choose) | natives B k  JSUT test k  FA flat  FA decl (report)');
const GRID = process.env.DECL_GRID ? JSON.parse(process.env.DECL_GRID)
  : [].concat(...[50, 75, 100, 150, 200].map((md) => [100, 150].map((ms) => [2, md, ms])));
for (const [tm, md, ms, md2] of GRID) {
  const V = H.variant({ TREND_MIN_MORAE: tm, MAX_DECLINATION_CENTS: md, MIN_SPLIT_CENTS: ms, MAX_DECLINATION_CENTS_2MORA: md2 != null ? md2 : md });
  const f = H.predictShipped(V);
  const a = H.metrics(D.ume.A, f).kappa, j = H.metrics(D.jsutApp.train, f).kappa;
  const b = H.metrics(D.ume.B, f).kappa, jt = H.metrics(D.jsutApp.test, f).kappa;
  console.log(`[${tm}${md2 != null ? ',2mora=' + md2 : ''}] ${String(md).padStart(7)} ${String(ms).padStart(8)} | ${a.toFixed(3).padStart(11)} ${j.toFixed(3).padStart(12)} ${pct(falseAccept(flatA.flat, f))} ${pct(falseAccept(flatA.decl, f))}         | ${b.toFixed(3).padStart(11)} ${jt.toFixed(3).padStart(11)} ${pct(falseAccept(flatB.flat, f))} ${pct(falseAccept(flatB.decl, f))}`);
}
