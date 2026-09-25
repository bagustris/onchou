#!/usr/bin/env node
// build-applike-set.js -- builds an "app-like" real-audio test set from
// JSUT/jsut-label: accent phrases that sit next to REAL silence, extracted
// with that silence included, the way an onchou recording has silence
// around the word (the learner taps Record, pauses, speaks, pauses, taps
// Stop / hits the 3s cap).
//
//   - 'initial': a sentence's first accent phrase, with up to LEAD_MS of the
//     real leading silence before it (JSUT files open with ~0.2-0.3s 'sil').
//   - 'final':   a sentence's last accent phrase, with up to TRAIL_MS of the
//     real trailing silence after it.
//
// The phrase-level set tools/evaluate-jsut-accuracy.js builds pads only
// 30ms, which in continuous speech is always voiced (voicing runs straight
// across phrase boundaries), so it can't expose how the shipped pipeline
// treats silence. This set can.
//
// Output: tools/tmp/jsut-applike-v1.json -- same sample shape as the main
// trace cache ({sentenceId, moraCount, accentType, trace, spanStartSec,
// spanEndSec, moras}) plus `position`.
//
// Usage: JSUT_LABEL_DIR=/path/to/jsut-label node tools/build-applike-set.js
'use strict';

const fs = require('fs');
const path = require('path');
const { readWavSync } = require('./wav-reader.js');
const { parseAccentPhrases } = require('./jsut-lab-parser.js');
const { buildTrace } = require('./evaluate-jsut-accuracy.js');

const JSUT_WAV_DIR = '/data/jsut_ver1.1/basic5000/wav';
const LEAD_MS = 300;
const TRAIL_MS = 300;
const INNER_PAD_MS = 30; // same as the phrase-level set, on the non-silence side

function labelDir() {
  const d = process.env.JSUT_LABEL_DIR;
  if (!d) throw new Error('Set JSUT_LABEL_DIR (see tools/evaluate-jsut-accuracy.js).');
  return fs.existsSync(path.join(d, 'BASIC5000_0001.lab')) ? d : path.join(d, 'labels', 'basic5000');
}

const dir = labelDir();
const out = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.lab')).sort()) {
  const id = f.replace(/\.lab$/, '');
  const wavPath = path.join(JSUT_WAV_DIR, id + '.wav');
  if (!fs.existsSync(wavPath)) continue;
  const phrases = parseAccentPhrases(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (phrases.length < 2) continue; // need distinct first/last phrases
  const wav = readWavSync(wavPath);
  const dur = wav.samples.length / wav.sampleRate;
  const pick = [
    { position: 'initial', p: phrases[0], s: phrases[0].startSec - LEAD_MS / 1000, e: phrases[0].endSec + INNER_PAD_MS / 1000 },
    { position: 'final', p: phrases[phrases.length - 1], s: phrases[phrases.length - 1].startSec - INNER_PAD_MS / 1000, e: phrases[phrases.length - 1].endSec + TRAIL_MS / 1000 },
  ];
  for (const k of pick) {
    const s = Math.max(0, k.s), e = Math.min(dur, k.e);
    out.push({
      sentenceId: id, position: k.position,
      moraCount: k.p.moraCount, accentType: k.p.accentType,
      trace: buildTrace(wav.samples, wav.sampleRate, s, e),
      spanStartSec: s, spanEndSec: e, moras: k.p.moras,
    });
  }
}
const outPath = path.join(__dirname, 'tmp', 'jsut-applike-v1.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
console.error(`${out.length} app-like samples written to ${outPath}`);
