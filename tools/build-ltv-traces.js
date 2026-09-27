#!/usr/bin/env node
// build-ltv-traces.js -- production pitch traces (js/pitch-detect.js via
// tools/evaluate-jsut-accuracy.js buildTrace) for the LaboroTV short-phrase
// set (tools/build-ltv-set.py), from 48kHz copies in $LTV48_DIR (sox
// -r 48000, like the UME-JRF copies). Output: tools/tmp/ltv-traces.json,
// read by tools/paper-harness.js as the ltv.train / ltv.test splits.
'use strict';
const fs = require('fs');
const path = require('path');
const { readWavSync } = require('./wav-reader.js');
const { buildTrace } = require('./evaluate-jsut-accuracy.js');
const TMP = path.join(__dirname, 'tmp');
const DIR = process.env.LTV48_DIR;
const rows = fs.readFileSync(path.join(TMP, 'ltv-short.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const out = [];
for (const r of rows) {
  const f = path.join(DIR, path.basename(r.wav));
  if (!fs.existsSync(f)) continue;
  const w = readWavSync(f);
  out.push({ ...r, trace: buildTrace(w.samples, w.sampleRate, 0, w.samples.length / w.sampleRate) });
  if (out.length % 2000 === 0) console.error(`  ${out.length}/${rows.length}`);
}
fs.writeFileSync(path.join(TMP, 'ltv-traces.json'), JSON.stringify(out));
console.error(`${out.length} traces`);
