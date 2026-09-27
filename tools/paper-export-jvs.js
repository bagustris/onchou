#!/usr/bin/env node
// paper-export-jvs.js -- the JVS app-like set (tools/build-jvs-set.js) in the
// slots-export format tools/paper-ssl-jvs.py reads: original 24kHz wav path,
// PRODUCTION mora-slot windows in absolute seconds, target, speaker, and the
// sentence number (JSUT-trained models saw sentences 1-4000, so text-
// disjoint results use 4001-5000 only). Output: tools/tmp/jvs-slots-export.jsonl
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./paper-harness.js');
const MS = H.shipped;
const D = H.load();
const JVS = process.env.JVS_DIR || '/data/jvs_ver1';
const out = [];
const spkA = new Set(D.jvs.A.map((s) => s.speaker));
for (const s of D.jvs.all) {
  if (s.moraCount < 2) continue;
  const c = MS._computeSlots(s.trace, s.moraCount, MS._silentFor(s.morae, s.moraCount));
  if (!c) continue;
  out.push({
    split: spkA.has(s.speaker) ? 'jvs.A' : 'jvs.B', speaker: s.speaker, sentence: Number(s.sentenceId.split('_').pop()),
    wav: path.join(JVS, s.speaker, 'nonpara30', 'wav24kHz16bit', s.sentenceId + '.wav'),
    moraCount: s.moraCount, accents: s.accents, morae: s.morae,
    slots: c.slots.map(([a, b]) => [s.spanStartSec + a / 1000, s.spanStartSec + b / 1000]),
    shipped: MS.segmentByMora(s.trace, s.moraCount, { morae: s.morae }).pattern,
  });
}
fs.writeFileSync(path.join(__dirname, 'tmp', 'jvs-slots-export.jsonl'), out.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.error(`${out.length} JVS samples exported`);
