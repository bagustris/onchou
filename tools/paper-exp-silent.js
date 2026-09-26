#!/usr/bin/env node
// paper-exp-silent.js -- held-out effect of silent morae (js/mora-segment.js
// SILENT_MORAE: geminate closures + predicted high-vowel devoicing), with
// paired cluster-bootstrap differences against the decoder without them.
// Settings were chosen on UME natives A + JSUT app-like train
// (tools/tmp/paper-silent-sweep.txt); MIN_VOICED_MORAE=3 was chosen to keep
// the monotone false-acceptance rate (tools/paper-exp-flat.js, natives-B
// resynthesis) at its previous level -- disclosed as a guard-driven choice.
'use strict';
const H = require('./paper-harness.js');
const D = H.load();
const B = +(process.env.BOOT || 500);

const systems = [
  ['without silent morae (previous)', H.predictShipped(H.variant({ SILENT_MORAE: false }))],
  ['+ geminates only', H.predictShipped(H.variant({ DEVOICE_FINAL: false, MIN_VOICED_MORAE: 99 }))],
  ['+ geminates + devoicing (shipped)', H.predictShipped()],
];
const sets = [['UME natives B', D.ume.B], ['JSUT app-like test', D.jsutApp.test], ['UME learners', D.ume.learners],
  ['(choosing) UME natives A', D.ume.A], ['(choosing) JSUT app-like train', D.jsutApp.train]];
const f3 = (x) => x.toFixed(3);
for (const [name, set] of sets) {
  console.log(`\n## ${name}`);
  console.log('| system | κ [95% CI] | Δκ vs previous [95% CI] | strict | unclear |\n|---|---|---|---|---|');
  for (const [sn, fn] of systems) {
    const r = H.bootstrap(set, fn, B, null);
    let d = '—';
    if (sn !== systems[0][0]) { const p = H.bootstrap(set, systems[0][1], B, fn); d = `${p.diff.point >= 0 ? '+' : ''}${f3(p.diff.point)} [${f3(p.diff.ci[0])}, ${f3(p.diff.ci[1])}]`; }
    console.log(`| ${sn} | ${f3(r.point.kappa)} [${f3(r.ci[0])}, ${f3(r.ci[1])}] | ${d} | ${(100 * r.point.strict).toFixed(1)}% | ${(100 * r.point.unclear).toFixed(1)}% |`);
  }
}
