#!/usr/bin/env node
// paper-export-slots.js -- exports, for every sample in every paper split,
// its audio file, its PRODUCTION mora-slot windows (js/mora-segment.js
// computeSlots: voice gate + 20ms delay) in absolute seconds, its target and
// the shipped decision -- so the Python upper-bound experiments
// (tools/paper-ssl.py) use exactly the same segmentation and splits.
// Output: tools/tmp/slots-export.jsonl (one JSON object per line).
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./paper-harness.js');
const MS = H.shipped;
const D = H.load();
const UME_WAV = path.join(process.env.UMEJRF_DIR || '', 'UME-JRF', 'wav');
const JSUT_WAV = '/data/jsut_ver1.1/basic5000/wav';

const out = fs.createWriteStream(path.join(__dirname, 'tmp', 'slots-export.jsonl'));
let n = 0;
function emit(split, s, wav, t0) {
  const c = MS._computeSlots(s.trace, s.moraCount);
  if (!c || s.moraCount < 2) return;
  const shipped = MS.segmentByMora(s.trace, s.moraCount, { morae: s.morae }).pattern;
  out.write(JSON.stringify({
    split, cluster: s.cluster, wav, moraCount: s.moraCount, accents: s.accents,
    morae: s.morae, heavy: MS._heavyInitial(s.morae),
    slots: c.slots.map(([a, b]) => [t0 + a / 1000, t0 + b / 1000]),
    slotHz: c.slotMedians, shipped,
  }) + '\n');
  n++;
}
for (const [split, set] of [['jsutApp.train', D.jsutApp.train], ['jsutApp.test', D.jsutApp.test], ['jsutPhrase.train', D.jsutPhrase.train], ['jsutPhrase.test', D.jsutPhrase.test]]) {
  for (const s of set) emit(split, s, path.join(JSUT_WAV, s.sentenceId + '.wav'), s.spanStartSec);
}
for (const [split, set] of [['ume.A', D.ume.A], ['ume.B', D.ume.B], ['ume.learners', D.ume.learners]]) {
  for (const s of set) {
    const [site, spk] = s.speaker.split('/');
    emit(split, s, path.join(UME_WAV, s.group, site, spk, `D1_${String(s.wordIdx).padStart(3, '0')}.wav`), 0);
  }
}
out.end(() => console.error(`${n} samples exported`));
