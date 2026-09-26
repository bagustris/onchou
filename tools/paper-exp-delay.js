#!/usr/bin/env node
// paper-exp-delay.js -- does the 40ms peak-delay window (tuned on JSUT read
// speech, capped by synthetic zero-delay words) suit ISOLATED words spoken
// by many native speakers? Sweeps PEAK_DELAY_MS on UME-JRF natives A (+ JSUT
// app-like train) and reports B / JSUT test; also measures mora duration,
// since the delay is a fixed time and isolated words have longer morae.
'use strict';
const H = require('./paper-harness.js');
const D = H.load();

// Median mora duration per set, from the voiced span (no alignment on UME).
function moraMs(set) {
  const d = set.map((s) => {
    const v = s.trace.filter((f) => f.hz != null);
    return v.length ? (v[v.length - 1].tMs - v[0].tMs) / s.moraCount : null;
  }).filter((x) => x != null).sort((a, b) => a - b);
  return d[d.length >> 1];
}
console.log(`median voiced-span per mora: UME natives ${moraMs(D.ume.all).toFixed(0)}ms, UME learners ${moraMs(D.ume.learners).toFixed(0)}ms, JSUT app-like ${moraMs(D.jsutApp.train).toFixed(0)}ms`);

console.log('\ndelay  | UME natives A (choose) | JSUT app train (choose) | UME natives B (report) | JSUT app test (report) | UME learners');
for (const d of [0, 20, 40, 60, 80, 100, 125, 150]) {
  const MS = H.variant({ PEAK_DELAY_MS: d });
  const f = H.predictShipped(MS);
  const cells = [D.ume.A, D.jsutApp.train, D.ume.B, D.jsutApp.test, D.ume.learners].map((set) => {
    const r = H.metrics(set, f);
    return `k=${r.kappa.toFixed(3)} u=${(100 * r.unclear).toFixed(1)}%`.padEnd(22);
  });
  console.log(`${String(d).padStart(4)}ms | ${cells.join(' | ')}`);
}
