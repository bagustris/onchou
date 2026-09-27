#!/usr/bin/env node
// build-jvs-set.js -- a 100-speaker app-like set from the JVS corpus
// (Takamichi et al. 2019; research / non-commercial use, no redistribution).
//
// JVS's "nonpara30" recordings include ~3,000 readings of JSUT basic5000
// sentences by 100 professional speakers (~31 each). jsut-label has MANUAL
// accent labels for those sentences, and JVS ships automatic phone
// alignments (lab/ful, seconds) for about 1,800 of the recordings. Each
// jsut-label line keeps its context (manual accents) but takes its start/end
// time from the JVS alignment of that speaker's recording, when the two phone
// sequences match line for line (JVS's labels write devoiced vowels as I/U;
// those are lowercased before comparing, and recordings whose automatic
// reading differs from jsut-label's -- e.g. なに vs なん -- are skipped).
//
// Then, exactly as tools/build-applike-set.js does for JSUT: each sentence's
// first accent phrase with up to 300ms of its real leading silence, and its
// last phrase with up to 300ms of trailing silence, traced through the
// production pitch detector. Audio: 48kHz copies in $JVS48_DIR/<speaker>/
// (sox -r 48000 of wav24kHz16bit, like the UME-JRF copies).
//
// Caveat: the label is the JSUT speaker's accent (manually corrected to her
// production); another speaker reading the same sentence may occasionally
// use a different accepted accent.
//
// Output: tools/tmp/jvs-applike.json. No JVS speaker has been used for any
// tuning, so all of it is held out; paper-harness.js splits speakers in
// alternating halves (jvs.A / jvs.B) in case a later change needs to choose
// on one half.
//   JSUT_LABEL_DIR=... JVS_DIR=/data/jvs_ver1 JVS48_DIR=... node tools/build-jvs-set.js
'use strict';
const fs = require('fs');
const path = require('path');
const { readWavSync } = require('./wav-reader.js');
const { parseAccentPhrases } = require('./jsut-lab-parser.js');
const { buildTrace } = require('./evaluate-jsut-accuracy.js');

const JVS = process.env.JVS_DIR || '/data/jvs_ver1';
const JVS48 = process.env.JVS48_DIR;
const LEAD_MS = 300, TRAIL_MS = 300, INNER_PAD_MS = 30;
const labDir = (() => { const d = process.env.JSUT_LABEL_DIR; return fs.existsSync(path.join(d, 'BASIC5000_0001.lab')) ? d : path.join(d, 'labels', 'basic5000'); })();
const phoneOf = (ctx) => { const m = /-(.+?)\+/.exec(ctx); return m ? m[1] : ctx; };
const norm = (p) => (p === 'I' ? 'i' : p === 'U' ? 'u' : p);

const gender = {};
for (const l of fs.readFileSync(path.join(JVS, 'gender_f0range.txt'), 'utf8').split('\n').slice(1)) { const [s, g] = l.split(/\s+/); if (s) gender[s] = g; }

const out = [];
let seen = 0, mismatch = 0;
for (const spk of fs.readdirSync(JVS).filter((d) => /^jvs\d{3}$/.test(d)).sort()) {
  const ful = path.join(JVS, spk, 'nonpara30', 'lab', 'ful');
  if (!fs.existsSync(ful)) continue;
  for (const f of fs.readdirSync(ful).filter((x) => /^BASIC5000_\d+\.lab$/.test(x)).sort()) {
    const id = f.replace(/\.lab$/, '');
    const refPath = path.join(labDir, f), wavPath = path.join(JVS48, spk, id + '.wav');
    if (!fs.existsSync(refPath) || !fs.existsSync(wavPath)) continue;
    seen++;
    const jvs = fs.readFileSync(path.join(ful, f), 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/));
    const ref = fs.readFileSync(refPath, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/));
    if (jvs.length !== ref.length || jvs.some((j, i) => norm(phoneOf(j[2])) !== phoneOf(ref[i][2]))) { mismatch++; continue; }
    // jsut-label context + JVS times (seconds -> 100ns, the unit jsut-label uses)
    const hybrid = ref.map((r, i) => `${Math.round(+jvs[i][0] * 1e7)} ${Math.round(+jvs[i][1] * 1e7)} ${r[2]}`).join('\n');
    const phrases = parseAccentPhrases(hybrid);
    if (phrases.length < 2) continue;
    const wav = readWavSync(wavPath), dur = wav.samples.length / wav.sampleRate;
    const pick = [
      { position: 'initial', p: phrases[0], s: phrases[0].startSec - LEAD_MS / 1000, e: phrases[0].endSec + INNER_PAD_MS / 1000 },
      { position: 'final', p: phrases[phrases.length - 1], s: phrases[phrases.length - 1].startSec - INNER_PAD_MS / 1000, e: phrases[phrases.length - 1].endSec + TRAIL_MS / 1000 },
    ];
    for (const k of pick) {
      const s = Math.max(0, k.s), e = Math.min(dur, k.e);
      out.push({ speaker: spk, gender: gender[spk], sentenceId: id, position: k.position, moraCount: k.p.moraCount, accentType: k.p.accentType,
        trace: buildTrace(wav.samples, wav.sampleRate, s, e), spanStartSec: s, spanEndSec: e, moras: k.p.moras });
    }
  }
}
fs.writeFileSync(path.join(__dirname, 'tmp', 'jvs-applike.json'), JSON.stringify(out));
console.error(`${seen} recordings with alignment; ${mismatch} skipped (reading/phone mismatch); ${out.length} phrases from ${new Set(out.map((s) => s.speaker)).size} speakers`);
