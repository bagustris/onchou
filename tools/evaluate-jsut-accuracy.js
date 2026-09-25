#!/usr/bin/env node
// evaluate-jsut-accuracy.js -- real-audio decision-level accuracy evaluation
// for onchou's shipped pitch pipeline (js/pitch-detect.js's `_estimatePitch`
// + js/mora-segment.js's `segmentByMora`/`scorePattern`), against the JSUT
// speech corpus (https://sites.google.com/site/shinnosuketakamichi/publication/jsut,
// vendored locally at JSUT_DIR below) using jsut-label's manually-annotated,
// forced-aligned accent-phrase labels
// (https://github.com/sarulab-speech/jsut-label) as ground truth.
//
// NOTE (2026-09-25, Round 3): js/mora-segment.js's segmentByMora was
// replaced after this tool's evaluation (voice gate + peak delay +
// constrained decoding -- see the design doc's "Round 3"). The plain
// default run below still calls the REAL segmentByMora, so it now measures
// the new algorithm; the --sweep/--detrend/--energy-align/--oracle helpers
// in this file mirror the RETIRED time-proportional + classifyLevels
// algorithm (they reproduce the Round 1-2 experiments). Use
// tools/evaluate-pipeline.js for current comparisons, and note that
// per-mora accuracy -- this tool's headline number -- rewards the corpus's
// pattern skew; within-mora-count kappa is the metric to trust.
//
// This runs the UNMODIFIED production estimator/classifier (not a
// reimplementation) against real, natural (if studio-quality, single-
// speaker) speech -- closing part of the "decision-level" validation gap
// docs/2026-09-05-pitch-accent-evaluation-research-plan.md describes as
// 2-3 years out pending a labeled corpus. See
// docs/superpowers/specs/2026-09-25-onchou-jsut-real-audio-eval-design.md
// for the full design and honest scope/caveats (single native speaker,
// studio conditions -- not a learner, not noisy-mic conditions; the
// research plan's perceptual-validation and learner-recording layers are
// still open).
//
// Usage:
//   JSUT_LABEL_DIR=/path/to/jsut-label node tools/evaluate-jsut-accuracy.js \
//     [--limit N] [--sweep] [--detrend] [--energy-align] [--oracle-boundaries] \
//     [--pad-ms N] [--out path.json] [--dump-traces N] [--dump-traces-out path.json]
//
//   --limit N     Only process the first N sentences with usable labels
//                 (label + wav both present, at least one valid accent
//                 phrase parsed). Default: all of basic5000 (labels only
//                 exist for that subset -- see jsut-label's README).
//   --sweep       Also sweep MIN_SPLIT_CENTS (see js/mora-segment.js) over a
//                 grid and report per-value accuracy, instead of only the
//                 shipped default (100).
//   --detrend     Also run the experimental classifyLevelsDetrended variant
//                 (linear declination removed before clustering -- see its
//                 own doc comment) over a threshold grid, for comparison
//                 against --sweep's non-detrended numbers.
//   --energy-align Also run segmentByMoraEnergyAligned (interior mora
//                 boundaries snapped to local energy minima instead of
//                 assumed equal-width -- a model-free proxy for
//                 "forced-alignment-based mora boundaries", see its own doc
//                 comment for why a real forced aligner isn't an option
//                 here) over a threshold grid.
//   --oracle-boundaries Also run segmentByMoraOracle (buckets each frame
//                 into its REAL, forced-aligned mora from jsut-label
//                 itself, not a shipped-app option -- see its own doc
//                 comment) over a threshold grid, to quantify how much of
//                 the real-audio accuracy gap is attributable to
//                 segmentation error alone vs. everything else.
//   --pad-ms N    Silence padding added on each side of a phrase's labeled
//                 span before frame extraction (default 50), clipped to the
//                 sentence's own audio bounds. Mimics the natural leading/
//                 trailing silence a real "Record" tap captures; segmentByMora
//                 finds its own voiced span inside this regardless, so this
//                 mostly matters for how much real context estimatePitch's
//                 frame windows get near the phrase edges.
//   --out path    Write the full JSON summary here too (default:
//                 tools/tmp/jsut-accuracy-<timestamp>.json). The tmp
//                 directory is gitignored-equivalent output, not committed.
//   --dump-traces N / --dump-traces-out path
//                 Also write the first N phrases' full real F0 traces (plus
//                 their labeled time span) to a JSON file, for
//                 tools/jsut-signal-level-check.py's independent reference-
//                 extractor cross-check.
//
// Frame extraction (the expensive step) is cached to disk per (--limit,
// --pad-ms) combination under tools/tmp/ -- see buildPhraseSamples -- so
// trying a new --sweep/--detrend grid against the same phrases after the
// first run costs seconds, not minutes.

'use strict';

const fs = require('fs');
const path = require('path');

const PitchDetect = require('../js/pitch-detect.js');
const MoraSegment = require('../js/mora-segment.js');
const PitchDiagram = require('../js/pitch-diagram.js');
const WordSelect = require('../js/word-select.js');
const { readWavSync } = require('./wav-reader.js');
const { parseAccentPhrases } = require('./jsut-lab-parser.js');

const JSUT_DIR = '/data/jsut_ver1.1/basic5000';

// jsut-label isn't vendored in this repo (it's a large label-only repo
// useful only for this one-off evaluation, not runtime app data -- unlike
// accents_kanjium.txt, which the app itself depends on at build time).
// JSUT_LABEL_DIR must point at either a jsut-label checkout root or
// directly at its labels/basic5000 directory.
function findLabelDir() {
  const direct = process.env.JSUT_LABEL_DIR;
  if (!direct) {
    throw new Error(
      'Set JSUT_LABEL_DIR to a checkout of https://github.com/sarulab-speech/jsut-label ' +
      '(its root, or directly to .../jsut-label/labels/basic5000).'
    );
  }
  if (fs.existsSync(path.join(direct, 'BASIC5000_0001.lab'))) return direct;
  const nested = path.join(direct, 'labels', 'basic5000');
  if (fs.existsSync(path.join(nested, 'BASIC5000_0001.lab'))) return nested;
  throw new Error(`JSUT_LABEL_DIR (${direct}) doesn't contain BASIC5000_0001.lab directly or under labels/basic5000/.`);
}

function parseArgs(argv) {
  const opts = { limit: Infinity, sweep: false, padMs: 50, out: null, dumpTraces: 0, dumpTracesOut: null, detrend: false, energyAlign: false, oracleBoundaries: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') opts.limit = Number(argv[++i]);
    else if (argv[i] === '--sweep') opts.sweep = true;
    else if (argv[i] === '--pad-ms') opts.padMs = Number(argv[++i]);
    else if (argv[i] === '--out') opts.out = argv[++i];
    // --dump-traces N: also write the first N phrases' full {tMs,hz} traces
    // plus their labeled time span, for tools/jsut-signal-level-check.py's
    // independent reference-F0-extractor cross-check (research plan item
    // 1, "signal-level" validation) -- kept separate from --sweep, which is
    // about the decision-level (classification) layer only.
    else if (argv[i] === '--dump-traces') opts.dumpTraces = Number(argv[++i]);
    else if (argv[i] === '--dump-traces-out') opts.dumpTracesOut = argv[++i];
    else if (argv[i] === '--detrend') opts.detrend = true;
    else if (argv[i] === '--energy-align') opts.energyAlign = true;
    else if (argv[i] === '--oracle-boundaries') opts.oracleBoundaries = true;
  }
  return opts;
}

// Builds a {tMs, hz|null} trace for one accent phrase, using the SAME
// FRAME_SIZE/HOP_MS the production recorder uses, and the SAME
// _estimatePitch function -- not a reimplementation. Each frame is the
// FRAME_SIZE window of real samples ending at that hop's absolute time
// (zero-padded at the very start of the sentence if a window would reach
// before sample 0), matching how AnalyserNode.getFloatTimeDomainData polled
// via setInterval hands back "the most recent window up to now" in the
// browser -- see js/pitch-detect.js's own header comment on that choice.
// Each frame also gets its RMS energy (sum-of-squares over the same samples
// _estimatePitch already touches -- effectively free, no extra audio pass)
// alongside the production hz estimate. Energy is NOT used by anything in
// production today -- it exists here purely to support
// segmentByMoraEnergyAligned's experimental boundary refinement (see its
// own doc comment) without needing any change to js/pitch-detect.js unless
// that experiment turns out to help.
function buildTrace(sentenceSamples, sampleRate, spanStartSec, spanEndSec) {
  const FRAME_SIZE = PitchDetect._FRAME_SIZE;
  const HOP_MS = PitchDetect._HOP_MS;
  const trace = [];
  const spanStartSample = Math.max(0, Math.round(spanStartSec * sampleRate));
  const spanEndSample = Math.min(sentenceSamples.length, Math.round(spanEndSec * sampleRate));

  for (let sampleIdx = spanStartSample; sampleIdx <= spanEndSample; sampleIdx += Math.round(sampleRate * HOP_MS / 1000)) {
    const frame = new Float32Array(FRAME_SIZE);
    const frameStart = sampleIdx - FRAME_SIZE;
    let sumSq = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const srcIdx = frameStart + i;
      const v = (srcIdx >= 0 && srcIdx < sentenceSamples.length) ? sentenceSamples[srcIdx] : 0;
      frame[i] = v;
      sumSq += v * v;
    }
    const hz = PitchDetect._estimatePitch(frame, sampleRate);
    const energy = Math.sqrt(sumSq / FRAME_SIZE);
    trace.push({ tMs: Math.round(((sampleIdx - spanStartSample) / sampleRate) * 1000), hz: hz, energy: energy });
  }
  return trace;
}

// Re-implements classifyLevels' 1D two-cluster split with an overridable
// MIN_SPLIT_CENTS, for --sweep. Kept as a faithful, deliberately-separate
// copy (not a refactor of js/mora-segment.js's production function) so this
// research tool cannot accidentally change shipped behavior -- see the
// design doc for why a signature change to the shipped module wasn't made
// just to support this sweep. Verified against js/mora-segment.js's own
// exported `_classifyLevels` at minSplitCents=100 (the shipped default) as
// part of this tool's own smoke test -- see tools/jsut-lab-parser.js's
// sibling test file's convention; the cross-check itself lives in this
// file's `selfTest()`.
function classifyLevelsWithThreshold(slotMedians, minSplitCents) {
  const labels = slotMedians.map(() => 'unclear');
  const present = [];
  for (let i = 0; i < slotMedians.length; i++) {
    if (slotMedians[i] != null) present.push({ i: i, logHz: Math.log2(slotMedians[i]) });
  }
  if (present.length < 2) return labels;

  const sorted = present.slice().sort((a, b) => a.logHz - b.logHz);
  let distinct = 1;
  for (let d = 1; d < sorted.length; d++) if (sorted[d].logHz !== sorted[d - 1].logHz) distinct++;
  if (distinct < 2) return labels;

  function ss(values) {
    if (!values.length) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0);
  }

  let bestSplit = -1, bestCost = Infinity;
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k - 1].logHz === sorted[k].logHz) continue;
    const low = sorted.slice(0, k).map((p) => p.logHz);
    const high = sorted.slice(k).map((p) => p.logHz);
    const cost = ss(low) + ss(high);
    if (cost < bestCost) { bestCost = cost; bestSplit = k; }
  }

  const lowGroup = sorted.slice(0, bestSplit);
  const highGroup = sorted.slice(bestSplit);
  const meanLow = lowGroup.reduce((a, p) => a + p.logHz, 0) / lowGroup.length;
  const meanHigh = highGroup.reduce((a, p) => a + p.logHz, 0) / highGroup.length;
  const gapCents = 1200 * (meanHigh - meanLow);
  if (gapCents < minSplitCents) return labels;

  sorted.forEach((p, idx) => { labels[p.i] = idx < bestSplit ? 'L' : 'H'; });
  return labels;
}

function selfTest() {
  // Cross-check classifyLevelsWithThreshold(..., 100) against the SHIPPED
  // _classifyLevels at its own default, on a handful of representative
  // slot-median arrays, so a --sweep run's other threshold values can be
  // trusted to reflect a faithful copy of the real algorithm.
  const cases = [
    [150, 200, null],
    [100, 100, 100],
    [220, 90, 210, 95],
    [],
  ];
  for (const c of cases) {
    const a = MoraSegment._classifyLevels(c);
    const b = classifyLevelsWithThreshold(c, 100);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error(`selfTest: classifyLevelsWithThreshold diverges from production _classifyLevels for ${JSON.stringify(c)}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
  }
}

// classifyLevelsDetrended(slotMedians, minSplitCents) -- an experimental
// variant tried BECAUSE the full-corpus MIN_SPLIT_CENTS sweep (see this
// tool's design doc) came back essentially flat (56.6-57.0% per-mora
// accuracy across the whole 0-400 cent grid): that threshold isn't the
// real-audio bottleneck, so the natural next thing to try is the mechanism
// a manually-inspected failure case pointed at -- real sentence-embedded
// speech carries genuine declination (a gradual pitch fall across the
// whole utterance) that a phrase's own local 2-cluster split can't tell
// apart from that phrase's own H/L contrast (exactly the risk
// docs/superpowers/specs/2026-09-04-onchou-pitch-accent-trainer-design.md's
// 2026-09-24 addendum already disclosed from SYNTHETIC declining traces).
//
// This fits a least-squares line through the present slots' log2-Hz values
// (vs. slot index) and 2-cluster-splits the RESIDUALS instead of the raw
// values, so a linear declination trend across the phrase is removed
// before classification rather than being read as part of the H/L signal.
// Kept as a clearly separate experimental function, not folded into
// classifyLevelsWithThreshold -- see this file's evaluation of whether it
// actually helps before treating it as anything more than that.
function classifyLevelsDetrended(slotMedians, minSplitCents) {
  const labels = slotMedians.map(() => 'unclear');
  const present = [];
  for (let i = 0; i < slotMedians.length; i++) {
    if (slotMedians[i] != null) present.push({ i: i, logHz: Math.log2(slotMedians[i]) });
  }
  if (present.length < 2) return labels;

  // Least-squares line: logHz ~ a + b*i, over present points only.
  const n = present.length;
  const meanX = present.reduce((a, p) => a + p.i, 0) / n;
  const meanY = present.reduce((a, p) => a + p.logHz, 0) / n;
  let num = 0, den = 0;
  for (const p of present) { num += (p.i - meanX) * (p.logHz - meanY); den += (p.i - meanX) * (p.i - meanX); }
  const slope = den > 0 ? num / den : 0;
  const intercept = meanY - slope * meanX;
  const residual = present.map((p) => ({ i: p.i, logHz: p.logHz - (intercept + slope * p.i) }));

  const sorted = residual.slice().sort((a, b) => a.logHz - b.logHz);
  let distinct = 1;
  for (let d = 1; d < sorted.length; d++) if (sorted[d].logHz !== sorted[d - 1].logHz) distinct++;
  if (distinct < 2) return labels;

  function ss(values) {
    if (!values.length) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0);
  }
  let bestSplit = -1, bestCost = Infinity;
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k - 1].logHz === sorted[k].logHz) continue;
    const low = sorted.slice(0, k).map((p) => p.logHz);
    const high = sorted.slice(k).map((p) => p.logHz);
    const cost = ss(low) + ss(high);
    if (cost < bestCost) { bestCost = cost; bestSplit = k; }
  }
  const lowGroup = sorted.slice(0, bestSplit);
  const highGroup = sorted.slice(bestSplit);
  const meanLow = lowGroup.reduce((a, p) => a + p.logHz, 0) / lowGroup.length;
  const meanHigh = highGroup.reduce((a, p) => a + p.logHz, 0) / highGroup.length;
  const gapCents = 1200 * (meanHigh - meanLow);
  if (gapCents < minSplitCents) return labels;

  sorted.forEach((p, idx) => { labels[p.i] = idx < bestSplit ? 'L' : 'H'; });
  return labels;
}

// classifyFn defaults to classifyLevelsWithThreshold (the faithful copy of
// production's own algorithm); pass classifyLevelsDetrended to try the
// experimental variant instead. Everything else (voiced-span detection,
// time-proportional slotting, per-slot median) is identical either way --
// only the final H/L decision differs.
function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function segmentByMoraWithThreshold(trace, moraCount, minSplitCents, classifyFn) {
  classifyFn = classifyFn || classifyLevelsWithThreshold;
  // Mirrors MoraSegment.segmentByMora's own slotting logic exactly (copied,
  // not called, so the minSplitCents override reaches classifyLevels) --
  // see js/mora-segment.js for the annotated original.
  const voiced = trace.filter((f) => f && f.hz != null);
  if (!voiced.length) return { pattern: new Array(moraCount).fill('unclear'), spanStart: null };
  let spanStart = voiced[0].tMs, spanEnd = voiced[0].tMs;
  for (const f of voiced) { if (f.tMs < spanStart) spanStart = f.tMs; if (f.tMs > spanEnd) spanEnd = f.tMs; }
  const span = spanEnd - spanStart;
  const slots = Array.from({ length: moraCount }, () => []);
  for (const f of voiced) {
    let idx = span <= 0 ? 0 : Math.floor(((f.tMs - spanStart) / span) * moraCount);
    if (idx >= moraCount) idx = moraCount - 1;
    if (idx < 0) idx = 0;
    slots[idx].push(f.hz);
  }
  const slotMedians = slots.map((s) => (s.length ? median(s) : null));
  return { pattern: classifyFn(slotMedians, minSplitCents), spanStart: spanStart };
}

// segmentByMoraEnergyAligned -- experimental alternative to time-proportional
// slicing, tried as a cheap, model-free proxy for "forced-alignment-based
// mora boundaries" (the next-step recommendation in
// docs/superpowers/specs/2026-09-25-onchou-jsut-real-audio-eval-design.md).
// A REAL forced aligner (Julius/Kaldi/MFA-style, as jsut-label's own ground
// truth was built with) needs a trained acoustic model -- fundamentally
// incompatible with onchou's "no ML model, no server" constraint (see the
// original design spec's non-goals) for a client-side, real-time recorder.
// This instead uses each frame's RMS ENERGY (buildTrace above computes it
// for free, from the same samples _estimatePitch already reads -- no
// separate model, no extra audio pass) as a boundary signal: consonant
// closures and inter-mora gaps tend to show as local energy dips, so each
// naive equal-width slot boundary is snapped to the nearest local energy
// minimum within a bounded search window, instead of assumed to fall
// exactly at 1/moraCount of the span.
//
// Only the INTERIOR boundaries are refined this way; the outer span
// (spanStart/spanEnd) still comes from the voiced-for-pitch frames, exactly
// as the shipped method already computes it -- kept identical so this
// experiment isolates ONLY the effect of non-equal-width slicing, not a
// change to how much of the recording is considered "the word" at all.
function segmentByMoraEnergyAligned(trace, moraCount, minSplitCents) {
  const voiced = trace.filter((f) => f && f.hz != null);
  if (!voiced.length) return { pattern: new Array(moraCount).fill('unclear'), spanStart: null };
  let spanStart = voiced[0].tMs, spanEnd = voiced[0].tMs;
  for (const f of voiced) { if (f.tMs < spanStart) spanStart = f.tMs; if (f.tMs > spanEnd) spanEnd = f.tMs; }
  const span = spanEnd - spanStart;

  if (moraCount <= 1 || span <= 0) {
    // Nothing to refine -- fall back to the same single-slot behavior as
    // the time-proportional method.
    const slots = Array.from({ length: moraCount }, () => []);
    for (const f of voiced) slots[0].push(f.hz);
    const slotMedians = slots.map((s) => (s.length ? median(s) : null));
    return { pattern: classifyLevelsWithThreshold(slotMedians, minSplitCents), spanStart: spanStart };
  }

  const avgSlotWidth = span / moraCount;
  const searchWindowMs = avgSlotWidth * 0.4; // stay well inside the neighboring naive slot
  const framesInSpan = trace
    .filter((f) => f && f.tMs >= spanStart && f.tMs <= spanEnd && f.energy != null)
    .sort((a, b) => a.tMs - b.tMs);

  const boundaries = [spanStart];
  let prevBoundary = spanStart;
  for (let k = 1; k < moraCount; k++) {
    const guess = spanStart + (span * k) / moraCount;
    const lo = Math.max(prevBoundary, guess - searchWindowMs);
    const hi = Math.min(spanEnd, guess + searchWindowMs);
    let best = guess, bestEnergy = Infinity;
    for (const f of framesInSpan) {
      if (f.tMs < lo || f.tMs > hi) continue;
      if (f.energy < bestEnergy) { bestEnergy = f.energy; best = f.tMs; }
    }
    boundaries.push(best);
    prevBoundary = best;
  }
  boundaries.push(spanEnd);

  const slots = Array.from({ length: moraCount }, () => []);
  for (const f of voiced) {
    let idx = 0;
    while (idx < moraCount - 1 && f.tMs >= boundaries[idx + 1]) idx++;
    slots[idx].push(f.hz);
  }
  const slotMedians = slots.map((s) => (s.length ? median(s) : null));
  return { pattern: classifyLevelsWithThreshold(slotMedians, minSplitCents), spanStart: spanStart };
}

// segmentByMoraEnergyGated -- tried after segmentByMoraEnergyAligned
// measured WORSE than the naive time-proportional baseline at full-corpus
// scale (55.0-55.2% vs. 56.7-57.0%, still a loss though smaller than
// detrending's). Hypothesis: an unconditional "snap to whatever the
// smallest energy value in the window is" chases spurious dips (a
// devoiced-vowel patch, a formant-transition dip mid-vowel) that aren't
// real mora boundaries, actively making some slot boundaries WORSE than
// just guessing evenly. This variant only moves a boundary when the found
// dip is a clearly real one: the minimum found must be at least
// `dipRatio` below the energy AT the naive guess itself (not just the
// smallest of a possibly-flat window) -- otherwise the naive boundary is
// kept unchanged, so this variant can only do as much damage as the
// baseline in the worst case, never MORE, unlike the unconditional version.
function segmentByMoraEnergyGated(trace, moraCount, minSplitCents, dipRatio) {
  const voiced = trace.filter((f) => f && f.hz != null);
  if (!voiced.length) return { pattern: new Array(moraCount).fill('unclear'), spanStart: null };
  let spanStart = voiced[0].tMs, spanEnd = voiced[0].tMs;
  for (const f of voiced) { if (f.tMs < spanStart) spanStart = f.tMs; if (f.tMs > spanEnd) spanEnd = f.tMs; }
  const span = spanEnd - spanStart;

  if (moraCount <= 1 || span <= 0) {
    const slots = Array.from({ length: moraCount }, () => []);
    for (const f of voiced) slots[0].push(f.hz);
    const slotMedians = slots.map((s) => (s.length ? median(s) : null));
    return { pattern: classifyLevelsWithThreshold(slotMedians, minSplitCents), spanStart: spanStart };
  }

  const avgSlotWidth = span / moraCount;
  const searchWindowMs = avgSlotWidth * 0.4;
  const framesInSpan = trace
    .filter((f) => f && f.tMs >= spanStart && f.tMs <= spanEnd && f.energy != null)
    .sort((a, b) => a.tMs - b.tMs);

  function nearestEnergyAt(tMs) {
    let best = null, bestDist = Infinity;
    for (const f of framesInSpan) {
      const d = Math.abs(f.tMs - tMs);
      if (d < bestDist) { bestDist = d; best = f.energy; }
    }
    return best == null ? 0 : best;
  }

  const boundaries = [spanStart];
  let prevBoundary = spanStart;
  for (let k = 1; k < moraCount; k++) {
    const guess = spanStart + (span * k) / moraCount;
    const guessEnergy = nearestEnergyAt(guess);
    const lo = Math.max(prevBoundary, guess - searchWindowMs);
    const hi = Math.min(spanEnd, guess + searchWindowMs);
    let best = guess, bestEnergy = guessEnergy;
    for (const f of framesInSpan) {
      if (f.tMs < lo || f.tMs > hi) continue;
      if (f.energy < bestEnergy) { bestEnergy = f.energy; best = f.tMs; }
    }
    // Only accept the snap if it's a CLEARLY lower dip than the naive
    // guess's own energy -- otherwise keep the naive guess unchanged.
    const accepted = guessEnergy > 0 && bestEnergy <= guessEnergy * (1 - dipRatio);
    boundaries.push(accepted ? best : guess);
    prevBoundary = boundaries[boundaries.length - 1];
  }
  boundaries.push(spanEnd);

  const slots = Array.from({ length: moraCount }, () => []);
  for (const f of voiced) {
    let idx = 0;
    while (idx < moraCount - 1 && f.tMs >= boundaries[idx + 1]) idx++;
    slots[idx].push(f.hz);
  }
  const slotMedians = slots.map((s) => (s.length ? median(s) : null));
  return { pattern: classifyLevelsWithThreshold(slotMedians, minSplitCents), spanStart: spanStart };
}

// segmentByMoraOracle -- NOT a candidate for the shipped app (see its own
// doc comment for why real forced alignment conflicts with onchou's "no ML
// model, no server" architecture). Exists purely to quantify, via
// --oracle-boundaries, how much of the real-audio accuracy gap is
// attributable to mora-BOUNDARY imprecision (segmentation error) alone,
// versus everything else (declination confounding the H/L classifier) --
// by bucketing each frame into its REAL, forced-aligned mora (from
// jsut-label, via Julius) instead of a time-proportional guess, with every
// other part of the pipeline (the same real trace, the same
// classifyLevelsWithThreshold) held identical. See the design doc's
// "Oracle check" section for the result and what it does/doesn't imply.
//
// moras: [{startSec, endSec}, ...], ABSOLUTE within the original sentence
// (parseAccentPhrases's own output) -- NOT relative to the trace's own
// tMs=0, so spanStartSec (the same value buildPhraseSamples stores
// alongside the trace) is needed to convert between the two.
function segmentByMoraOracle(trace, moraCount, moras, spanStartSec, minSplitCents) {
  const hasVoiced = trace.some((f) => f && f.hz != null);
  if (!hasVoiced) return { pattern: new Array(moraCount).fill('unclear'), spanStart: null };

  const slots = Array.from({ length: moraCount }, () => []);
  for (const f of trace) {
    if (!f || f.hz == null) continue;
    const absSec = spanStartSec + f.tMs / 1000;
    for (let i = 0; i < moras.length; i++) {
      if (absSec >= moras[i].startSec && absSec < moras[i].endSec) { slots[i].push(f.hz); break; }
    }
  }
  const slotMedians = slots.map((s) => (s.length ? median(s) : null));
  return { pattern: classifyLevelsWithThreshold(slotMedians, minSplitCents), spanStart: 0 };
}

function emptyStratum() {
  return { matched: 0, mismatch: 0, unclear: 0, total: 0, phrases: 0, exactMatch: 0 };
}
function addStratum(s, score) {
  s.matched += score.matched;
  s.mismatch += (score.total - score.matched - score.unclear);
  s.unclear += score.unclear;
  s.total += score.total;
  s.phrases += 1;
  if (score.total - score.matched - score.unclear === 0) s.exactMatch += 1;
}
function strataAccuracy(s) {
  const scored = s.total - s.unclear;
  return {
    perMoraAccuracy: scored > 0 ? s.matched / scored : null,
    perMoraAccuracyPessimistic: s.total > 0 ? s.matched / s.total : null,
    exactMatchRate: s.phrases > 0 ? s.exactMatch / s.phrases : null,
    unclearRate: s.total > 0 ? s.unclear / s.total : null,
    ...s,
  };
}

// segmentMode: null/'proportional' (default) uses the faithful copy of
// production's own time-proportional slicing (or the real
// MoraSegment.segmentByMora itself when minSplitCents/classifyFn are both
// unset, so the plain default run exercises the ACTUAL shipped function,
// not the copy); 'energy' uses segmentByMoraEnergyAligned instead.
function runEvaluation(phraseSamples, minSplitCents, classifyFn, segmentMode) {
  const overall = emptyStratum();
  const byAccentType = {};
  const byMoraCount = {};

  for (const sample of phraseSamples) {
    const { trace, moraCount, accentType } = sample;
    const effectiveMinSplitCents = minSplitCents == null ? 100 : minSplitCents;
    let segmented;
    if (segmentMode === 'energy') {
      segmented = segmentByMoraEnergyAligned(trace, moraCount, effectiveMinSplitCents);
    } else if (segmentMode === 'oracle') {
      segmented = segmentByMoraOracle(trace, moraCount, sample.moras, sample.spanStartSec, effectiveMinSplitCents);
    } else if (minSplitCents == null && !classifyFn) {
      segmented = MoraSegment.segmentByMora(trace, moraCount);
    } else {
      segmented = segmentByMoraWithThreshold(trace, moraCount, effectiveMinSplitCents, classifyFn);
    }
    if (segmented.spanStart == null) continue; // no voice detected at all -- excluded, not scored as wrong

    const targetPattern = PitchDiagram.pitchLevels(moraCount, accentType).slice(0, moraCount);
    const score = MoraSegment.scorePattern(segmented.pattern, targetPattern);

    addStratum(overall, score);
    const patternName = WordSelect.classifyPattern(moraCount, accentType);
    byAccentType[patternName] = byAccentType[patternName] || emptyStratum();
    addStratum(byAccentType[patternName], score);
    const key = String(moraCount);
    byMoraCount[key] = byMoraCount[key] || emptyStratum();
    addStratum(byMoraCount[key], score);
  }

  const out = { overall: strataAccuracy(overall), byAccentType: {}, byMoraCount: {} };
  for (const k of Object.keys(byAccentType)) out.byAccentType[k] = strataAccuracy(byAccentType[k]);
  for (const k of Object.keys(byMoraCount)) out.byMoraCount[k] = strataAccuracy(byMoraCount[k]);
  return out;
}

// Frame extraction (buildTrace, the expensive step -- real autocorrelation
// over every real-audio frame) is identical across every classification
// variant/threshold this tool tries, so it's cached to disk keyed by the
// inputs that actually change its output (limit, padMs). Re-running a new
// classification idea against the same phrases (e.g. --detrend) then costs
// seconds, not minutes -- important for iterating on the decision-level
// experiments this tool exists to run.
// v2: trace entries gained an `energy` field (see buildTrace).
// v3: phrase samples gained a `moras` field (real forced-aligned per-mora
// spans, for segmentByMoraOracle / --oracle-boundaries).
// Bumped on each change so a stale-shaped cache from an earlier run isn't
// silently reused missing a field a newer experiment needs.
function traceCachePath(opts) {
  return path.join(__dirname, 'tmp', `jsut-traces-cache-v3-limit${opts.limit}-pad${opts.padMs}.json`);
}

function buildPhraseSamples(opts) {
  const cachePath = traceCachePath(opts);
  if (fs.existsSync(cachePath)) {
    console.error(`Using cached traces: ${cachePath}`);
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  }

  const labelDir = findLabelDir();
  const wavDir = path.join(JSUT_DIR, 'wav');
  const labelFiles = fs.readdirSync(labelDir).filter((f) => f.endsWith('.lab')).sort();
  console.error(`Found ${labelFiles.length} label files in ${labelDir}`);

  const phraseSamples = [];
  let sentencesUsed = 0;
  for (const labelFile of labelFiles) {
    if (sentencesUsed >= opts.limit) break;
    const sentenceId = labelFile.replace(/\.lab$/, '');
    const wavPath = path.join(wavDir, sentenceId + '.wav');
    if (!fs.existsSync(wavPath)) continue;

    const labText = fs.readFileSync(path.join(labelDir, labelFile), 'utf8');
    const phrases = parseAccentPhrases(labText);
    if (!phrases.length) continue;

    const wav = readWavSync(wavPath);
    const padSec = opts.padMs / 1000;
    for (const phrase of phrases) {
      const spanStart = Math.max(0, phrase.startSec - padSec);
      const spanEnd = Math.min(wav.samples.length / wav.sampleRate, phrase.endSec + padSec);
      const trace = buildTrace(wav.samples, wav.sampleRate, spanStart, spanEnd);
      phraseSamples.push({
        sentenceId: sentenceId,
        moraCount: phrase.moraCount,
        accentType: phrase.accentType,
        trace: trace,
        spanStartSec: spanStart,
        spanEndSec: spanEnd,
        // Real, forced-aligned (Julius, via jsut-label) per-mora time spans,
        // in the SAME absolute sentence-timeline seconds as spanStartSec --
        // kept only for segmentByMoraOracle's --oracle-boundaries check
        // (an upper-bound comparison, not something onchou's shipped,
        // model-free pipeline can compute for itself at runtime).
        moras: phrase.moras,
      });
    }
    sentencesUsed++;
    if (sentencesUsed % 200 === 0) console.error(`...${sentencesUsed} sentences processed, ${phraseSamples.length} phrases so far`);
  }

  console.error(`\nTotal: ${sentencesUsed} sentences, ${phraseSamples.length} accent-phrase samples.\n`);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(phraseSamples));
  console.error(`Traces cached to ${cachePath}`);
  return phraseSamples;
}

function main() {
  selfTest();
  const opts = parseArgs(process.argv.slice(2));
  const phraseSamples = buildPhraseSamples(opts);
  const sentencesUsed = new Set(phraseSamples.map((s) => s.sentenceId)).size;

  const results = { sentencesUsed, phraseCount: phraseSamples.length, padMs: opts.padMs, runs: {} };

  results.runs.default = runEvaluation(phraseSamples, null);
  console.error('=== Default (shipped MIN_SPLIT_CENTS=100) ===');
  printSummary(results.runs.default);

  if (opts.sweep) {
    const grid = [0, 25, 50,75, 100, 125, 150, 175, 200, 250, 300, 400];
    for (const cents of grid) {
      results.runs['minSplitCents_' + cents] = runEvaluation(phraseSamples, cents);
    }
    console.error('\n=== MIN_SPLIT_CENTS sweep (per-mora accuracy, excl. unclear) ===');
    for (const cents of grid) {
      const r = results.runs['minSplitCents_' + cents].overall;
      console.error(
        `  ${String(cents).padStart(4)} cents: perMoraAcc=${fmtPct(r.perMoraAccuracy)}  ` +
        `pessimistic=${fmtPct(r.perMoraAccuracyPessimistic)}  exactMatch=${fmtPct(r.exactMatchRate)}  ` +
        `unclearRate=${fmtPct(r.unclearRate)}  (n=${r.total})`
      );
    }
  }

  if (opts.detrend) {
    const grid = [0, 25, 50, 75, 100, 125, 150, 175, 200];
    console.error('\n=== Detrended classification (linear declination removed before clustering) ===');
    for (const cents of grid) {
      results.runs['detrend_' + cents] = runEvaluation(phraseSamples, cents, classifyLevelsDetrended);
      const r = results.runs['detrend_' + cents].overall;
      console.error(
        `  ${String(cents).padStart(4)} cents: perMoraAcc=${fmtPct(r.perMoraAccuracy)}  ` +
        `pessimistic=${fmtPct(r.perMoraAccuracyPessimistic)}  exactMatch=${fmtPct(r.exactMatchRate)}  ` +
        `unclearRate=${fmtPct(r.unclearRate)}  (n=${r.total})`
      );
    }
  }

  if (opts.energyAlign) {
    const grid = [0, 25, 50, 75, 100, 125, 150, 175, 200];
    console.error('\n=== Energy-aligned boundaries (interior mora boundaries snapped to local energy minima) ===');
    for (const cents of grid) {
      results.runs['energyAlign_' + cents] = runEvaluation(phraseSamples, cents, null, 'energy');
      const r = results.runs['energyAlign_' + cents].overall;
      console.error(
        `  ${String(cents).padStart(4)} cents: perMoraAcc=${fmtPct(r.perMoraAccuracy)}  ` +
        `pessimistic=${fmtPct(r.perMoraAccuracyPessimistic)}  exactMatch=${fmtPct(r.exactMatchRate)}  ` +
        `unclearRate=${fmtPct(r.unclearRate)}  (n=${r.total})`
      );
    }
  }

  if (opts.oracleBoundaries) {
    const grid = [0, 50, 100, 150, 200];
    console.error('\n=== Oracle boundaries (real forced-aligned mora spans, not a shipped-app option) ===');
    for (const cents of grid) {
      results.runs['oracle_' + cents] = runEvaluation(phraseSamples, cents, null, 'oracle');
      const r = results.runs['oracle_' + cents].overall;
      console.error(
        `  ${String(cents).padStart(4)} cents: perMoraAcc=${fmtPct(r.perMoraAccuracy)}  ` +
        `pessimistic=${fmtPct(r.perMoraAccuracyPessimistic)}  exactMatch=${fmtPct(r.exactMatchRate)}  ` +
        `unclearRate=${fmtPct(r.unclearRate)}  (n=${r.total})`
      );
    }
  }

  const outPath = opts.out || path.join(__dirname, 'tmp', `jsut-accuracy-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.error(`\nFull results written to ${outPath}`);

  if (opts.dumpTraces > 0) {
    const dump = phraseSamples.slice(0, opts.dumpTraces).map((s) => ({
      sentenceId: s.sentenceId,
      moraCount: s.moraCount,
      accentType: s.accentType,
      spanStartSec: s.spanStartSec,
      spanEndSec: s.spanEndSec,
      trace: s.trace,
    }));
    const dumpPath = opts.dumpTracesOut || path.join(__dirname, 'tmp', 'jsut-trace-dump.json');
    fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
    fs.writeFileSync(dumpPath, JSON.stringify(dump));
    console.error(`Trace dump (${dump.length} phrases) written to ${dumpPath}`);
  }
}

function fmtPct(x) { return x == null ? 'n/a' : (x * 100).toFixed(1) + '%'; }

function printSummary(result) {
  const r = result.overall;
  console.error(`  Overall per-mora accuracy (excl. unclear): ${fmtPct(r.perMoraAccuracy)} (n=${r.total - r.unclear} of ${r.total})`);
  console.error(`  Overall per-mora accuracy (unclear=wrong): ${fmtPct(r.perMoraAccuracyPessimistic)}`);
  console.error(`  Unclear rate: ${fmtPct(r.unclearRate)}`);
  console.error(`  Exact-phrase-match rate: ${fmtPct(r.exactMatchRate)} (n=${r.phrases} phrases)`);
  console.error('  By accent type:');
  for (const k of Object.keys(result.byAccentType)) {
    const s = result.byAccentType[k];
    console.error(`    ${k.padEnd(10)} perMoraAcc=${fmtPct(s.perMoraAccuracy)}  exactMatch=${fmtPct(s.exactMatchRate)}  (n=${s.phrases} phrases, ${s.total} morae)`);
  }
  console.error('  By mora count:');
  for (const k of Object.keys(result.byMoraCount).sort((a, b) => Number(a) - Number(b))) {
    const s = result.byMoraCount[k];
    console.error(`    ${k.padStart(2)} morae:  perMoraAcc=${fmtPct(s.perMoraAccuracy)}  exactMatch=${fmtPct(s.exactMatchRate)}  (n=${s.phrases} phrases)`);
  }
}

if (require.main === module) main();

// Exported for ad hoc reuse (e.g. a one-off analysis script against an
// already-cached trace file) without re-running main()'s CLI/extraction
// path -- not used by any other file in this repo, but kept explicit since
// this module is a script by default, and require()-ing it would otherwise
// need this guard understood implicitly.
module.exports = {
  buildTrace, runEvaluation, segmentByMoraEnergyAligned, segmentByMoraEnergyGated,
  segmentByMoraOracle, classifyLevelsDetrended, classifyLevelsWithThreshold,
  strataAccuracy,
};
