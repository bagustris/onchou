#!/usr/bin/env node
// paper-exp-delay-rate.js -- best PEAK_DELAY_MS as a function of the take's
// own speaking rate (gated voiced span / mora count), pooled over the
// CHOOSING splits only (UME natives A + JSUT app-like train + JSUT phrase
// train). Motivates a rate-adaptive delay rule.
'use strict';
const H = require('./paper-harness.js');
const D = H.load();
const choose = [].concat(D.ume.A, D.jsutApp.train, D.jsutPhrase.train);

function rateMs(s) {
  const c = H.shipped._computeSlots(s.trace, s.moraCount);
  return c ? (c.spanEnd - c.spanStart) / s.moraCount : null;
}
const bins = [[0, 120], [120, 150], [150, 180], [180, 220], [220, 270], [270, 330], [330, 1e9]];
const binOf = (r) => bins.findIndex(([a, b]) => r >= a && r < b);
const byBin = bins.map(() => []);
for (const s of choose) { const r = rateMs(s); if (r != null) byBin[binOf(r)].push(s); }

const delays = [0, 20, 40, 60, 80, 100, 120];
const MSv = Object.fromEntries(delays.map((d) => [d, H.variant({ PEAK_DELAY_MS: d })]));
console.log('mora ms   n       ' + delays.map((d) => String(d).padStart(7)).join('') + '   best');
bins.forEach(([a, b], i) => {
  const set = byBin[i];
  if (set.length < 200) return;
  const ks = delays.map((d) => H.metrics(set, H.predictShipped(MSv[d])).kappa);
  const best = delays[ks.indexOf(Math.max(...ks))];
  console.log(`${String(a).padStart(3)}-${b > 1e8 ? '   ' : String(b).padEnd(3)}  ${String(set.length).padEnd(7)} ${ks.map((k) => k.toFixed(3).padStart(7)).join('')}   ${best}ms`);
});
