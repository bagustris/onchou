#!/usr/bin/env node
// paper-tables.js -- generates the paper's main results + ablation tables
// on the REPORTING splits (UME-JRF natives B, JSUT app-like test, UME-JRF
// learners), with cluster-bootstrap 95% CIs (speakers for UME, sentences for
// JSUT) and paired bootstrap differences between consecutive ablation rows.
// Output: printed markdown + tools/tmp/paper-tables.json.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./paper-harness.js');
const PD = require('../js/pitch-diagram.js');
const L = require('./paper-exp-learned-lib.js');
const MS = H.shipped;
const D = H.load();
const B = +(process.env.BOOT || 300);

// ---- systems
function priorFor(train) { // no-audio: most frequent target pattern per mora count
  const cnt = {};
  for (const s of train) {
    const t = PD.pitchLevels(s.moraCount, s.accents[0]).slice(0, s.moraCount).join(',');
    (cnt[s.moraCount] = cnt[s.moraCount] || {})[t] = (cnt[s.moraCount][t] || 0) + 1;
  }
  const maj = {};
  for (const k of Object.keys(cnt)) maj[k] = Object.entries(cnt[k]).sort((a, b) => b[1] - a[1])[0][0].split(',');
  return (s) => maj[s.moraCount] || new Array(s.moraCount).fill('L');
}
// Original onchou: no gate, no delay, median slots, unconstrained 2-means.
const Vorig = H.variant({ VOICE_GATE_DB: 999, PEAK_DELAY_MS: 0 });
const original = (s) => { const c = Vorig._computeSlots(s.trace, s.moraCount); return c ? Vorig._classifyLevels(c.slotMedians) : new Array(s.moraCount).fill('unclear'); };
// Ablation, adding one component at a time (production code, constants varied).
const Vgate = H.variant({ PEAK_DELAY_MS: 0 });
const gateOnly = (s) => { const c = Vgate._computeSlots(s.trace, s.moraCount); return c ? Vgate._classifyLevels(c.slotMedians) : new Array(s.moraCount).fill('unclear'); };
const Vtmpl = H.variant({ PEAK_DELAY_MS: 0, MIN_RISE_HEAVY_CENTS: 100, FALLBACK_TO_NO_FALL: false });
const Vdelay = H.variant({ MIN_RISE_HEAVY_CENTS: 100, FALLBACK_TO_NO_FALL: false });
const shipped = H.predictShipped();
// Learned (JSUT-trained, cross-corpus): forced choice, and guarded by the shipped evidence guard.
const gauss = L.trainGauss([].concat(D.jsutApp.train, D.jsutPhrase.train));
const gaussFn = (s) => {
  if (s.moraCount < 2) return shipped(s);
  const g = L.gaussWithMargin(gauss, s);
  return g ? g.pat.split('') : new Array(s.moraCount).fill('unclear');
};
const guardedFn = (s) => {
  const base = shipped(s);
  if (s.moraCount < 2 || base.every((x) => x === 'unclear')) return base;
  const p = gaussFn(s);
  return p.every((x) => x === 'unclear') ? base : p.map((x, i) => (base[i] === 'unclear' ? 'unclear' : x));
};

const REPORT = [['UME-JRF natives B', D.ume.B, D.ume.A], ['JSUT app-like test', D.jsutApp.test, D.jsutApp.train], ['UME-JRF learners', D.ume.learners, D.ume.A]];
const pct = (x) => (100 * x).toFixed(1);
const ci = (r) => `${r.point.kappa.toFixed(3)} [${r.ci[0].toFixed(3)}, ${r.ci[1].toFixed(3)}]`;
const out = { main: {}, ablation: {} };

console.log('## Main results (held-out; κ = within-mora-count Cohen\'s kappa, 95% cluster-bootstrap CI)\n');
console.log('| System | trained? | ' + REPORT.map(([n]) => `${n} κ | strict | unclear`).join(' | ') + ' |');
console.log('|---|---|' + REPORT.map(() => '---|---|---').join('|') + '|');
const mainRows = [
  ['No-audio prior (most frequent pattern)', 'counts', (train) => priorFor(train)],
  ['Original onchou (2-cluster split)', 'no', () => original],
  ['**Proposed, model-free (shipped)**', 'no', () => shipped],
  ['F0-ratio Gaussians [Ishi 2001], forced choice', 'JSUT', () => gaussFn],
  ['Guarded hybrid (proposed guard + Gaussians)', 'JSUT', () => guardedFn],
];
for (const [name, tr, mk] of mainRows) {
  const cells = REPORT.map(([, set, train]) => {
    const r = H.bootstrap(set, mk(train), B);
    out.main[name + '|' + set.length] = r;
    return `${ci(r)} | ${pct(r.point.strict)} | ${pct(r.point.unclear)}`;
  });
  console.log(`| ${name} | ${tr} | ${cells.join(' | ')} |`);
}

console.log('\n## Ablation on UME-JRF natives B (each row adds one component; Δ = paired bootstrap vs previous row)\n');
console.log('| Pipeline | κ [95% CI] | Δκ vs previous [95% CI] | strict | unclear |');
console.log('|---|---|---|---|---|');
const abl = [
  ['Original (no gate, no delay, 2-cluster)', original],
  ['+ relative voice gate', gateOnly],
  ['+ constrained templates, joint declination, split fall/rise guard', (s) => Vtmpl.segmentByMora(s.trace, s.moraCount, { morae: s.morae }).pattern],
  ['+ 20ms peak-delay window', (s) => Vdelay.segmentByMora(s.trace, s.moraCount, { morae: s.morae }).pattern],
  ['+ heavy-first-syllable rule (= shipped)', shipped],
];
let prev = null;
for (const [name, f] of abl) {
  const r = H.bootstrap(D.ume.B, f, B, null);
  let d = '—';
  if (prev) { const p = H.bootstrap(D.ume.B, prev, B, f); d = `${p.diff.point >= 0 ? '+' : ''}${p.diff.point.toFixed(3)} [${p.diff.ci[0].toFixed(3)}, ${p.diff.ci[1].toFixed(3)}]`; }
  out.ablation[name] = { r, d };
  console.log(`| ${name} | ${ci(r)} | ${d} | ${pct(r.point.strict)} | ${pct(r.point.unclear)} |`);
  prev = f;
}
fs.writeFileSync(path.join(__dirname, 'tmp', 'paper-tables.json'), JSON.stringify(out, null, 2));
