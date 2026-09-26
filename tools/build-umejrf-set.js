#!/usr/bin/env node
// build-umejrf-set.js -- builds a multi-speaker ISOLATED-WORD real-audio set
// from UME-JRF (NII-SRC "Japanese Speech Database Read by Foreign
// Students"): Set D, 115 words read one at a time by 33 native Tokyo-
// dialect speakers (JJ) and 141 learners (FJ). Isolated single words are
// onchou's actual use case -- which JSUT (one speaker, continuous read
// sentences) never covered.
//
// Ground truth: UME-JRF has NO accent labels (its teacher ratings target
// segmental items, e.g. gemination in 酸っぱい). The target accent is the
// dictionary one (vendored Kanjium), which is also exactly what onchou
// scores learners against. For native Tokyo speakers that's a sound
// reference; for learners it's the TARGET, not a description of what they
// said -- so learner results measure agreement with the target, not
// detection accuracy.
//
// Words: tools/umejrf-dset-words.json (transcribed from UME-JRF's
// doc/FJrecord/D1.pdf). 101 found in Kanjium by (word, reading); 3 more by
// reading where every Kanjium spelling agrees (ビン=瓶 1, おばさん 0,
// おばあさん 2); the other 11 (loanwords, onomatopoeia, a surname) are
// excluded rather than guessed. Words Kanjium lists with several accepted
// accents keep all of them (`accents`).
//
// Audio is expected pre-resampled to 48kHz (the browser AudioContext rate
// onchou's recorder actually runs at -- _estimatePitch's 1024-sample frame
// means sample rate changes the analysis):
//   cd $UMEJRF_DIR && find UME-JRF/wav -name 'D1_*.wav' | sed 's|^UME-JRF/wav/||' |
//     xargs -P 16 -I{} sh -c 'mkdir -p "wav48/$(dirname {})" && sox "UME-JRF/wav/{}" -r 48000 "wav48/{}" rate -v'
//
// Usage: UMEJRF_DIR=/path/containing/wav48 node tools/build-umejrf-set.js
// Output: tools/tmp/umejrf-dset-v1.json
'use strict';

const fs = require('fs');
const path = require('path');
const PitchDiagram = require('../js/pitch-diagram.js');
const { readWavSync } = require('./wav-reader.js');
const { buildTrace } = require('./evaluate-jsut-accuracy.js');

const ROOT = path.join(__dirname, '..');
const WAV48 = path.join(process.env.UMEJRF_DIR || '', 'wav48');
if (!fs.existsSync(WAV48)) throw new Error('Set UMEJRF_DIR to the directory holding wav48/ (see header).');

const kata2hira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const exact = new Map(), byReading = new Map();
for (const line of fs.readFileSync(path.join(ROOT, 'vendor/kanji-data/compounds/accents_kanjium.txt'), 'utf8').split('\n')) {
  const [w, r, a] = line.split('\t');
  if (!a) continue;
  const rr = kata2hira(r);
  const key = w + '\t' + rr;
  if (!exact.has(key)) exact.set(key, a);
  if (!byReading.has(rr)) byReading.set(rr, []);
  byReading.get(rr).push(a);
}
// Kanjium sometimes annotates accents with part of speech, e.g. 楽/らく is
// "(名;形動)2,(名)1" -- strip the annotations, keep every numeric accent.
const parseAccents = (a) => a.split(',').map((x) => Number(x.replace(/\([^)]*\)/g, '').trim())).filter(Number.isFinite);
function accentsFor(word, reading) {
  const a = exact.get(word + '\t' + reading);
  if (a) { const v = parseAccents(a); return v.length ? v : null; }
  // Fallback only when every Kanjium spelling of this reading agrees.
  const alts = byReading.get(reading) || [];
  if (alts.length && alts.every((x) => x === alts[0])) {
    if (['ビン', 'おばさん', 'おばあさん'].includes(word)) return parseAccents(alts[0]);
  }
  return null;
}

const words = JSON.parse(fs.readFileSync(path.join(__dirname, 'umejrf-dset-words.json'), 'utf8'));
const out = [];
let skippedWords = 0;
for (const group of ['JJ', 'FJ']) {
  for (const site of fs.readdirSync(path.join(WAV48, group)).sort()) {
    for (const spk of fs.readdirSync(path.join(WAV48, group, site)).sort()) {
      for (let i = 0; i < words.length; i++) {
        const [word, reading] = words[i];
        const accents = accentsFor(word, reading);
        if (!accents) { if (group === 'JJ' && site === 'TKT' && spk === 'F01') skippedWords++; continue; }
        const f = path.join(WAV48, group, site, spk, `D1_${String(i + 1).padStart(3, '0')}.wav`);
        if (!fs.existsSync(f)) continue;
        const wav = readWavSync(f);
        const dur = wav.samples.length / wav.sampleRate;
        out.push({
          group, speaker: `${site}/${spk}`, wordIdx: i + 1, word, reading,
          moraCount: PitchDiagram.moraSplit(reading).length, accents,
          trace: buildTrace(wav.samples, wav.sampleRate, 0, dur),
        });
      }
    }
  }
}
const outPath = path.join(__dirname, 'tmp', 'umejrf-dset-v1.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
const jj = out.filter((s) => s.group === 'JJ'), fj = out.filter((s) => s.group === 'FJ');
console.error(`${out.length} samples (JJ ${jj.length} from ${new Set(jj.map((s) => s.speaker)).size} speakers, FJ ${fj.length} from ${new Set(fj.map((s) => s.speaker)).size}); ${skippedWords} words skipped (no dictionary accent). -> ${outPath}`);
