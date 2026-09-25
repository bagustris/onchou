#!/usr/bin/env node
// paper-exp-validity.js -- criterion validity without learner accent labels:
// does a system's per-SPEAKER agreement with the dictionary target separate
// native Tokyo speakers from learners? (It should: natives largely produce
// the target accent, learners often don't.) Natives B only (half A informed
// design choices) vs all 141 learners; AUC = P(random native speaker scores
// higher than a random learner), Mann-Whitney.
//   agreement = fraction of the speaker's words scored fully correct
//   (an abstention counts as not correct -- so a system can't look native
//   by abstaining).
'use strict';
const H = require('./paper-harness.js');
const L = require('./paper-exp-learned-lib.js');
const PD = require('../js/pitch-diagram.js');
const D = H.load();
const shipped = H.predictShipped();
const Vorig = H.variant({ VOICE_GATE_DB: 999, PEAK_DELAY_MS: 0 });
const original = (s) => { const c = Vorig._computeSlots(s.trace, s.moraCount); return c ? Vorig._classifyLevels(c.slotMedians) : new Array(s.moraCount).fill('unclear'); };
const gauss = L.trainGauss([].concat(D.jsutApp.train, D.jsutPhrase.train));
const gaussFn = (s) => { if (s.moraCount < 2) return shipped(s); const g = L.gaussWithMargin(gauss, s); return g ? g.pat.split('') : new Array(s.moraCount).fill('unclear'); };

function perSpeaker(set, f) {
  const by = new Map();
  for (const s of set) {
    if (!s.trace.some((x) => x.hz != null)) continue;
    const p = f(s).join('');
    const ok = s.accents.some((a) => PD.pitchLevels(s.moraCount, a).slice(0, s.moraCount).join('') === p);
    const g = by.get(s.speaker) || { ok: 0, n: 0 }; g.n++; if (ok) g.ok++; by.set(s.speaker, g);
  }
  return [...by.values()].map((g) => g.ok / g.n);
}
function auc(pos, neg) {
  let w = 0;
  for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
  return w / (pos.length * neg.length);
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log('system                              native agree  learner agree  AUC (native > learner)');
for (const [name, f] of [['original onchou', original], ['proposed model-free (shipped)', shipped], ['F0-ratio Gaussians (JSUT-trained)', gaussFn]]) {
  const nat = perSpeaker(D.ume.B, f), lea = perSpeaker(D.ume.learners, f);
  console.log(`${name.padEnd(36)}${(100 * mean(nat)).toFixed(1).padStart(8)}%${(100 * mean(lea)).toFixed(1).padStart(13)}%${auc(nat, lea).toFixed(3).padStart(14)}   (${nat.length} vs ${lea.length} speakers)`);
}
