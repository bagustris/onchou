#!/usr/bin/env node
// build-rating-set.js -- prepares a LOCAL native-rater study that turns the
// learner results into real accuracy (the paper's main open limitation:
// UME-JRF has no accent labels for learner speech).
//
// Samples UME-JRF Set D learner words, stratified by target pattern and
// spread over speakers, plus hidden controls:
//   - native control items (natives B), whose expected label is the
//     dictionary pattern -- flags inattentive raters;
//   - repeats of ~10% of items -- intra-rater reliability.
// Raters mark each mora H or L BLIND to the target (tools/rating/index.html).
//
// UME-JRF is research-only and must not be redistributed, so nothing here is
// ever published: the page and audio are served from this machine only
// (see the usage line). The items file stores paths relative to the served
// root, which symlinks to the local UME-JRF wav directory.
//
// Usage:
//   UMEJRF_DIR=... node tools/build-rating-set.js [N=400]
//   cd tools/rating && ln -sfn "$UMEJRF_DIR/UME-JRF/wav" wav && python3 -m http.server 8777
//   -> open http://localhost:8777/  (each rater: their own browser/profile)
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./paper-harness.js');
const PD = require('../js/pitch-diagram.js');
const D = H.load();
const N = +(process.argv[2] || 400);

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rel = (s) => { const [site, spk] = s.speaker.split('/'); return `wav/${s.group}/${site}/${spk}/D1_${String(s.wordIdx).padStart(3, '0')}.wav`; };
const pat = (s) => PD.pitchLevels(s.moraCount, s.accents[0]).slice(0, s.moraCount).join('');

// Stratify learners by target pattern class, round-robin over speakers.
const pool = D.ume.learners.filter((s) => s.moraCount >= 2 && s.moraCount <= 5);
const byClass = new Map();
for (const s of shuffle(pool.slice())) { const k = s.moraCount + ':' + pat(s); if (!byClass.has(k)) byClass.set(k, []); byClass.get(k).push(s); }
const classes = [...byClass.keys()].sort();
const picked = [];
const perSpk = new Map();
while (picked.length < N) {
  let added = false;
  for (const k of classes) {
    const arr = byClass.get(k);
    const i = arr.findIndex((s) => (perSpk.get(s.speaker) || 0) < 4);
    if (i < 0) continue;
    const s = arr.splice(i, 1)[0];
    perSpk.set(s.speaker, (perSpk.get(s.speaker) || 0) + 1);
    picked.push(s); added = true;
    if (picked.length >= N) break;
  }
  if (!added) break;
}
const natives = shuffle(D.ume.B.filter((s) => s.moraCount >= 2 && s.moraCount <= 5).slice()).slice(0, Math.round(N * 0.08));
const item = (s, kind) => ({ id: `${s.group}/${s.speaker}/${s.wordIdx}`, kind, audio: rel(s), word: s.word, reading: s.reading,
  morae: PD.moraSplit(s.reading), target: s.accents.map((a) => PD.pitchLevels(s.moraCount, a).slice(0, s.moraCount).join('')) });
let items = picked.map((s) => item(s, 'learner')).concat(natives.map((s) => item(s, 'native-control')));
const repeats = shuffle(items.slice()).slice(0, Math.round(items.length * 0.1)).map((it) => ({ ...it, kind: it.kind + '-repeat' }));
items = shuffle(items.concat(repeats));

const out = path.join(__dirname, 'rating', 'items.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ version: 1, created: new Date().toISOString(), items }, null, 1));
console.error(`${items.length} items (${picked.length} learner, ${natives.length} native controls, ${repeats.length} repeats) from ${perSpk.size} learners -> ${out}`);
