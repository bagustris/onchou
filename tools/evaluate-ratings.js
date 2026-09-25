#!/usr/bin/env node
// evaluate-ratings.js -- analyses native-rater exports from
// tools/rating/index.html (ratings-*.json) against the rating set built by
// tools/build-rating-set.js, turning learner results into real accuracy.
//
//   1. Rater quality: agreement with the dictionary on hidden native
//      controls; self-agreement on hidden repeats.
//   2. Inter-rater agreement on learner items (pairwise Cohen's kappa on
//      the whole-word pattern, and per-mora agreement).
//   3. Consensus label per learner item (majority of raters; ties and
//      'unsure' majorities dropped).
//   4. Each system vs the consensus: whole-word agreement, and ERROR
//      DETECTION -- consensus says the learner's accent differs from the
//      dictionary target; does the system flag it (its output != target)?
//      Precision / recall / F1 of "flag an accent error".
//
// Usage: UMEJRF_DIR=... node tools/evaluate-ratings.js <dir-with-ratings-*.json>
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./paper-harness.js');
const L = require('./paper-exp-learned-lib.js');
const D = H.load();
const MS = H.shipped;

const dir = process.argv[2];
if (!dir) throw new Error('usage: node tools/evaluate-ratings.js <dir>');
const set = JSON.parse(fs.readFileSync(path.join(__dirname, 'rating', 'items.json'), 'utf8')).items;
const files = fs.readdirSync(dir).filter((f) => /^ratings-.*\.json$/.test(f));
const raters = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
console.log(`${raters.length} raters, ${set.length} items`);

const byUid = raters.map((r) => { const m = new Map(); for (const [uid, v] of Object.entries(r.ratings)) m.set(uid, v); return m; });
const uidOf = (it, i) => i + ':' + it.id + ':' + it.kind;

// 1. rater quality
for (const [k, r] of raters.entries()) {
  let cOk = 0, cN = 0, rOk = 0, rN = 0;
  const first = new Map();
  set.forEach((it, i) => {
    const v = byUid[k].get(uidOf(it, i)); if (!v || v.labels === 'unsure') return;
    if (it.kind.startsWith('native-control')) { cN++; if (it.target.includes(v.labels)) cOk++; }
    const base = it.id + '|' + it.kind.replace('-repeat', '');
    if (first.has(base)) { rN++; if (first.get(base) === v.labels) rOk++; } else first.set(base, v.labels);
  });
  console.log(`rater ${r.rater}: native-control agreement ${cN ? (100 * cOk / cN).toFixed(0) : 'n/a'}% (n=${cN}), repeat self-agreement ${rN ? (100 * rOk / rN).toFixed(0) : 'n/a'}% (n=${rN})`);
}

// 2-3. inter-rater + consensus on learner items (first presentation only)
const learner = set.map((it, i) => ({ it, uid: uidOf(it, i) })).filter((x) => x.it.kind === 'learner');
function kappa(pairs) { const lab = [...new Set(pairs.flat())]; const n = pairs.length; if (!n) return NaN;
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const pe = lab.reduce((s, l) => s + (pairs.filter(([a]) => a === l).length / n) * (pairs.filter(([, b]) => b === l).length / n), 0);
  return (po - pe) / (1 - pe); }
for (let a = 0; a < raters.length; a++) for (let b = a + 1; b < raters.length; b++) {
  const pairs = learner.map(({ uid }) => [byUid[a].get(uid), byUid[b].get(uid)]).filter(([x, y]) => x && y && x.labels !== 'unsure' && y.labels !== 'unsure').map(([x, y]) => [x.labels, y.labels]);
  // Per-mora: each mora of each doubly-rated item is one H/L judgement pair.
  const moraPairs = [];
  for (const [x, y] of pairs) for (let i = 0; i < Math.min(x.length, y.length); i++) moraPairs.push([x[i], y[i]]);
  const moraAgree = moraPairs.filter(([x, y]) => x === y).length / Math.max(1, moraPairs.length);
  console.log(`inter-rater ${raters[a].rater}-${raters[b].rater}: whole-word kappa ${kappa(pairs).toFixed(3)} (n=${pairs.length}); ` +
    `per-mora agreement ${(100 * moraAgree).toFixed(1)}%, per-mora kappa ${kappa(moraPairs).toFixed(3)} (n=${moraPairs.length} morae)`);
}
const consensus = new Map();
for (const { it, uid } of learner) {
  const votes = byUid.map((m) => m.get(uid)).filter(Boolean).map((v) => v.labels);
  const c = {}; votes.forEach((v) => { c[v] = (c[v] || 0) + 1; });
  const top = Object.entries(c).sort((x, y) => y[1] - x[1]);
  if (!top.length || top[0][0] === 'unsure' || (top[1] && top[1][1] === top[0][1])) continue;
  consensus.set(it.id, top[0][0]);
}
console.log(`consensus labels for ${consensus.size}/${learner.length} learner items`);

// 4. systems vs consensus
const byId = new Map(D.ume.learners.map((s) => [`${s.group}/${s.speaker}/${s.wordIdx}`, s]));
const gauss = L.trainGauss([].concat(D.jsutApp.train, D.jsutPhrase.train));
const Vorig = H.variant({ VOICE_GATE_DB: 999, PEAK_DELAY_MS: 0 });
const systems = {
  'original 2-cluster': (s) => { const c = Vorig._computeSlots(s.trace, s.moraCount); return c ? Vorig._classifyLevels(c.slotMedians) : new Array(s.moraCount).fill('unclear'); },
  'proposed (shipped)': (s) => MS.segmentByMora(s.trace, s.moraCount, { morae: s.morae }).pattern,
  'Gaussians, forced choice': (s) => { const g = L.gaussWithMargin(gauss, s); return g ? g.pat.split('') : new Array(s.moraCount).fill('unclear'); },
};
for (const [name, f] of Object.entries(systems)) {
  let agree = 0, n = 0, tp = 0, fp = 0, fn = 0, abst = 0;
  for (const [id, lab] of consensus) {
    const s = byId.get(id); if (!s) continue;
    const it = learner.find((x) => x.it.id === id).it;
    const p = f(s).join(''); n++;
    if (p.includes('unclear')) { abst++; continue; }
    if (p === lab) agree++;
    const trueErr = !it.target.includes(lab), flagged = !it.target.includes(p);
    if (flagged && trueErr) tp++; else if (flagged && !trueErr) fp++; else if (!flagged && trueErr) fn++;
  }
  const P = tp / (tp + fp), R = tp / (tp + fn);
  console.log(`${name.padEnd(26)} agrees with raters ${(100 * agree / Math.max(1, n - abst)).toFixed(1)}% of answered (abstains ${(100 * abst / n).toFixed(1)}%); error detection P=${P.toFixed(2)} R=${R.toFixed(2)} F1=${(2 * P * R / (P + R)).toFixed(2)}`);
}
