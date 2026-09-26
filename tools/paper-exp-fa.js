#!/usr/bin/env node
// paper-exp-fa.js -- option #8 (alignment upper bound) on ISOLATED words:
// UME-JRF scored with CTC forced-aligned mora windows (tools/paper-fa.py)
// instead of the production time-proportional slots, everything else held
// identical (same gated trace, same production decoder incl. the
// heavy-syllable rule). Also the peak-delay diagnostic on isolated words:
// mean F0 step between adjacent aligned morae by target pattern (the same
// analysis that showed a ~1-mora lag in JSUT read speech).
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./paper-harness.js');
const PD = require('../js/pitch-diagram.js');
const MS = H.shipped;
const D = H.load();
const FA = JSON.parse(fs.readFileSync(path.join(__dirname, 'tmp', 'umejrf-fa.json'), 'utf8'));
const UME_WAV = path.join(process.env.UMEJRF_DIR || '', 'UME-JRF', 'wav');
const wavOf = (s) => { const [site, spk] = s.speaker.split('/'); return path.join(UME_WAV, s.group, site, spk, `D1_${String(s.wordIdx).padStart(3, '0')}.wav`); };

const med = (a) => { const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
function faValues(s, delayMs) {
  const b = FA[wavOf(s)];
  if (!b || b.length !== s.moraCount) return null;
  const tr = MS._gateQuietFrames(s.trace);
  return b.map(([a, e]) => {
    const lo = a * 1000 + delayMs, hi = e * 1000 + delayMs;
    const hz = tr.filter((f) => f.hz != null && f.tMs >= lo && f.tMs < hi).map((f) => f.hz);
    return hz.length ? med(hz) : null;
  });
}
const faPredict = (delayMs) => (s) => {
  const v = faValues(s, delayMs);
  if (!v) return MS.segmentByMora(s.trace, s.moraCount, { morae: s.morae }).pattern;
  return MS._decodeAccentPattern(v, { heavyInitial: MS._heavyInitial(s.morae) });
};

const covered = (set) => set.filter((s) => { const b = FA[wavOf(s)]; return b && b.length === s.moraCount; });
const A = covered(D.ume.A), B = covered(D.ume.B), Lr = covered(D.ume.learners);
console.log(`aligned coverage: natives A ${A.length}/${D.ume.A.length}, B ${B.length}/${D.ume.B.length}, learners ${Lr.length}/${D.ume.learners.length}\n`);
const cell = (set, f) => { const r = H.metrics(set, f); return `k=${r.kappa.toFixed(3)} strict=${(100 * r.strict).toFixed(1)}% u=${(100 * r.unclear).toFixed(1)}%`.padEnd(34); };
console.log(''.padEnd(38) + 'natives A (choose)'.padEnd(34) + 'natives B (report)'.padEnd(34) + 'learners');
console.log('shipped (proportional slots)'.padEnd(38) + cell(A, H.predictShipped()) + cell(B, H.predictShipped()) + cell(Lr, H.predictShipped()));
for (const d of [-40, -20, 0, 20, 40, 60]) console.log(`forced-aligned windows, delay ${d}ms`.padEnd(38) + cell(A, faPredict(d)) + cell(B, faPredict(d)) + cell(Lr, faPredict(d)));

// Peak-delay diagnostic: mean cents step between adjacent aligned morae,
// by target pattern, natives only (no delay applied).
console.log('\nisolated-word F0 steps on ALIGNED morae (natives, cents; ideal: + at L->H, - at H->L, ~0 elsewhere)');
for (const n of [3, 4]) {
  const g = {};
  for (const s of D.ume.all.filter((x) => x.moraCount === n)) {
    const v = faValues(s, 0); if (!v || v.some((x) => x == null)) continue;
    const p = PD.pitchLevels(n, s.accents[0]).slice(0, n).join('');
    const st = v.slice(1).map((x, i) => 1200 * Math.log2(x / v[i]));
    g[p] = g[p] || { s: st.map(() => 0), c: 0 }; st.forEach((x, i) => { g[p].s[i] += x; }); g[p].c++;
  }
  for (const [p, o] of Object.entries(g).sort()) console.log(`  ${p.padEnd(6)} n=${String(o.c).padEnd(5)} ${o.s.map((z) => (z / o.c).toFixed(0).padStart(6)).join(' ')}`);
}
