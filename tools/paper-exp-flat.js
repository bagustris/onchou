#!/usr/bin/env node
// paper-exp-flat.js -- the flat-attempt (monotone) check on REAL speech:
// natives-B words resynthesized with no accent (tools/paper-flatten.py:
// 'flat' = constant F0, 'decl' = constant + 15% declining drift; 'copy' =
// vocoder control with the original F0). For each system: how often is the
// word scored fully CORRECT? Split by target class:
//   accented target (atamadaka/nakadaka, or odaka-internal fall): a flat take
//     can never be correct -> any "correct" is a false acceptance.
//   no-fall target (heiban/odaka shape L,H..H): flat is the right shape except
//     for the initial rise, so acceptance is policy (see the heavy-syllable
//     rule), reported separately.
// Also exports production slot windows for tools/paper-ssl-flat.py.
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./paper-harness.js');
const L = require('./paper-exp-learned-lib.js');
const PD = require('../js/pitch-diagram.js');
const MS = H.shipped;
const { readWavSync } = require('./wav-reader.js');
const { buildTrace } = require('./evaluate-jsut-accuracy.js');
const D = H.load();
const ROOT = process.env.UMEJRF_DIR;

const gauss = L.trainGauss([].concat(D.jsutApp.train, D.jsutPhrase.train));
const systems = {
  'proposed (model-free, shipped)': (s) => MS.segmentByMora(s.trace, s.moraCount, { morae: s.morae }).pattern,
  'guarded hybrid (useModel)': (s) => MS.segmentByMora(s.trace, s.moraCount, { morae: s.morae, useModel: true }).pattern,
  'Gaussians, forced choice': (s) => { const g = L.gaussWithMargin(gauss, s); return g ? g.pat.split('') : new Array(s.moraCount).fill('unclear'); },
  'original 2-cluster': (() => { const V = H.variant({ VOICE_GATE_DB: 999, PEAK_DELAY_MS: 0 }); return (s) => { const c = V._computeSlots(s.trace, s.moraCount); return c ? V._classifyLevels(c.slotMedians) : new Array(s.moraCount).fill('unclear'); }; })(),
};
const rel = (s) => { const [site, spk] = s.speaker.split('/'); return path.join(s.group, site, spk, `D1_${String(s.wordIdx).padStart(3, '0')}.wav`); };
const isNoFall = (s) => s.accents.every((a) => { const p = PD.pitchLevels(s.moraCount, a).slice(0, s.moraCount); return p.lastIndexOf('H') === s.moraCount - 1 && p[0] === 'L'; });

const variants = { original: null, copy: 'copy', flat: 'flat', decl: 'decl' };
const exportRows = [];
const rows = {};
for (const [vname, dir] of Object.entries(variants)) {
  const set = D.ume.B.filter((s) => s.moraCount >= 2).map((s) => {
    if (!dir) return s;
    const f = path.join(ROOT, 'wav48', 'flat', dir, rel(s));
    if (!fs.existsSync(f)) return null;
    const w = readWavSync(f);
    return { ...s, trace: buildTrace(w.samples, w.sampleRate, 0, w.samples.length / w.sampleRate) };
  }).filter(Boolean);
  for (const [sys, fn] of Object.entries(systems)) {
    const acc = { nf: [0, 0], ac: [0, 0] };
    for (const s of set) {
      if (!s.trace.some((f) => f.hz != null)) continue;
      const p = fn(s).join('');
      const ok = s.accents.some((a) => PD.pitchLevels(s.moraCount, a).slice(0, s.moraCount).join('') === p);
      const k = isNoFall(s) ? 'nf' : 'ac';
      acc[k][1]++; if (ok) acc[k][0]++;
    }
    rows[vname + '|' + sys] = acc;
  }
  if (dir) for (const s of set) {
    const c = MS._computeSlots(s.trace, s.moraCount);
    if (!c) continue;
    exportRows.push({ split: 'flat.' + vname, wav: path.join(ROOT, 'flat', dir, rel(s)), moraCount: s.moraCount, accents: s.accents, noFall: isNoFall(s),
      slots: c.slots.map(([a, b]) => [a / 1000, b / 1000]) });
  }
}
fs.writeFileSync(path.join(__dirname, 'tmp', 'flat-export.jsonl'), exportRows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const pct = (a) => (a[1] ? (100 * a[0] / a[1]).toFixed(1) + '%' : 'n/a').padStart(7);
console.log('% of natives-B words scored fully CORRECT, by audio condition\n');
console.log('system'.padEnd(34) + Object.keys(variants).map((v) => `${v}:accented / no-fall`.padEnd(26)).join(''));
for (const sys of Object.keys(systems)) {
  console.log(sys.padEnd(34) + Object.keys(variants).map((v) => { const r = rows[v + '|' + sys]; return `${pct(r.ac)} / ${pct(r.nf)}`.padEnd(26); }).join(''));
}
console.log('\n(accented-target acceptance on flat/decl = false acceptance of a take with NO accent)');
