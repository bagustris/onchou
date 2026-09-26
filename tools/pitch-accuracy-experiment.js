// pitch-accuracy-experiment.js -- NOT a pass/fail test. A measurement
// experiment against synthetic audio, run manually:
//
//   node tools/pitch-accuracy-experiment.js
//
// Exercises the real shipped code (js/pitch-detect.js's _estimatePitch,
// js/mora-segment.js's segmentByMora/scorePattern, js/pitch-diagram.js's
// pitchLevels/moraSplit) -- nothing here is a reimplementation, so results
// reflect the actual app behavior, not a model of it.
//
// Two stages:
//   1. Frame-level: how accurate is _estimatePitch alone, across F0, sample
//      rate, SNR, and harmonic-content conditions?
//   2. Word-level: fed a realistic multi-mora take (synthesized audio ->
//      _estimatePitch -> a trace -> segmentByMora -> scorePattern), how
//      often does the learner's detected pattern match the target? Run
//      both with the real estimator and with an "oracle" trace (exact
//      target Hz values, no estimator) to separate estimator error from
//      segmentation-logic error.
//
// NOTE (2026-09-25): Stages 3-5 compare classifyLevels against the rule it
// replaced; classifyLevels has itself since been retired from segmentByMora
// (see the design spec's 2026-09-25 addendum). Stage 2 calls the real
// segmentByMora, so it measures the current algorithm. The synthetic
// contract for the CURRENT decoder lives in tools/synthetic-regression.js.
//
// Caveat stated up front: this is synthetic audio only (additive harmonic
// stacks + Gaussian noise). It validates the pipeline's *logic* under
// controlled, known-ground-truth conditions -- it is not a substitute for
// validation against recorded human speech.

'use strict';

const fs = require('fs');
const path = require('path');

const PitchDetect = require('../js/pitch-detect.js');
const MoraSegment = require('../js/mora-segment.js');
const PitchDiagram = require('../js/pitch-diagram.js');

const { _estimatePitch: estimatePitch, _FRAME_SIZE: FRAME_SIZE, _HOP_MS: HOP_MS } = PitchDetect;
const { segmentByMora, scorePattern, _classifyLevels: classifyShipped } = MoraSegment;
const { moraSplit, pitchLevels } = PitchDiagram;

// ---- seeded RNG (mulberry32) + Gaussian, for reproducible runs ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---- synthetic voiced-frame generation ----------------------------------
//
// Harmonic weight profiles, keyed by the real-world condition each stands
// in for. 'harmonic4' matches the existing pitch-detect-test.js's
// voicedLike() -- included so stage 1 spans a superset of what's already
// unit-tested, not a disjoint set.
const PROFILES = {
  harmonic4: [1, 0.6, 0.4, 0.2], // moderate harmonic stack (existing test's shape)
  sawtoothLike: null, // special-cased below: 1/k rolloff to Nyquist
  weakFundamental: [0.05, 1.0, 0.6, 0.3], // laptop-mic bass rolloff below ~150Hz
  strongH2: [0.3, 1.0, 0.5], // H2 louder than H1 (breathy/creaky voice quality)
};

// Adds zero-mean Gaussian noise to hit a target SNR in dB. snrDb === Infinity
// is a no-op (clean signal).
function addNoiseForSnr(buf, rng, snrDb) {
  if (snrDb === Infinity) return buf;
  let power = 0;
  for (let i = 0; i < buf.length; i++) power += buf[i] * buf[i];
  power /= buf.length;
  const snrLinear = Math.pow(10, snrDb / 10);
  const noiseStd = Math.sqrt(power / snrLinear);
  for (let i = 0; i < buf.length; i++) buf[i] += gaussian(rng) * noiseStd;
  return buf;
}

function synthVoicedFrame(f0, sampleRate, n, profile, snrDb, rng) {
  const buf = synthFrameNoNoise(f0, sampleRate, n, profile);
  addNoiseForSnr(buf, rng, snrDb);
  return buf;
}

function synthFrameNoNoise(f0, sampleRate, n, profile) {
  const buf = new Float32Array(n);
  let weights;
  if (profile === 'sawtoothLike') {
    const nyquist = sampleRate / 2;
    const maxK = Math.max(1, Math.min(20, Math.floor(nyquist / f0)));
    weights = [];
    for (let k = 1; k <= maxK; k++) weights.push(1 / k);
  } else {
    weights = PROFILES[profile];
  }
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (let k = 0; k < weights.length; k++) {
      v += weights[k] * Math.sin(2 * Math.PI * (k + 1) * f0 * t);
    }
    buf[i] = v;
  }
  return buf;
}

function silentFrame(n) {
  return new Float32Array(n);
}

// =========================================================================
// Stage 1: frame-level _estimatePitch accuracy sweep
// =========================================================================

function runStage1() {
  const F0_GRID = [70, 100, 130, 160, 190, 220, 250, 280, 310, 340, 370, 400];
  const SAMPLE_RATES = [44100, 48000];
  const SNRS = [Infinity, 30, 20, 10, 5];
  const PROFILE_NAMES = Object.keys(PROFILES);
  const REPEATS_NOISY = 3;

  // Aggregate keyed by "profile|snr"
  const agg = {};
  function bucket(profile, snrDb) {
    const key = profile + '|' + (snrDb === Infinity ? 'clean' : snrDb + 'dB');
    if (!agg[key]) {
      agg[key] = {
        profile, snrDb, correct: 0, octaveDown: 0, octaveUp: 0, grossOther: 0,
        voicingMiss: 0, total: 0, centsErrors: [],
      };
    }
    return agg[key];
  }

  let seedCounter = 1;
  for (const profile of PROFILE_NAMES) {
    for (const snrDb of SNRS) {
      const reps = snrDb === Infinity ? 1 : REPEATS_NOISY;
      const b = bucket(profile, snrDb);
      for (const sampleRate of SAMPLE_RATES) {
        for (const f0 of F0_GRID) {
          for (let r = 0; r < reps; r++) {
            const rng = mulberry32(seedCounter++);
            const buf = synthVoicedFrame(f0, sampleRate, FRAME_SIZE, profile, snrDb, rng);
            const hz = estimatePitch(buf, sampleRate);
            b.total++;
            if (hz == null) { b.voicingMiss++; continue; }
            const ratio = hz / f0;
            if (ratio > 0.95 && ratio < 1.05) {
              b.correct++;
              b.centsErrors.push(Math.abs(1200 * Math.log2(ratio)));
            } else if (ratio > 1.9 && ratio < 2.1) {
              b.octaveUp++;
            } else if (ratio > 0.45 && ratio < 0.55) {
              b.octaveDown++;
            } else {
              b.grossOther++;
            }
          }
        }
      }
    }
  }

  // Pure-noise false-voicing check, one per profile-independent condition
  // (noise doesn't depend on harmonic profile) across the same SNR-less
  // "noise floor" idea: just uncorrelated noise at a few amplitudes.
  let falseVoicings = 0, noiseTrials = 0;
  for (let trial = 0; trial < 50; trial++) {
    const rng = mulberry32(90000 + trial);
    const buf = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) buf[i] = gaussian(rng) * 0.3;
    const sampleRate = trial % 2 === 0 ? 44100 : 48000;
    const hz = estimatePitch(buf, sampleRate);
    noiseTrials++;
    if (hz != null) falseVoicings++;
  }

  console.log('\n=== Stage 1: frame-level _estimatePitch accuracy ===\n');
  console.log('Grid: F0 in [70..400]Hz (12 pts) x sampleRate {44100,48000} x profile x SNR, ' + REPEATS_NOISY + ' reps/noisy condition\n');
  const header = ['profile', 'snr', 'n', 'correct%', 'octaveDown%', 'octaveUp%', 'grossOther%', 'voicingMiss%', 'medianCentsErr'];
  console.log(header.join('\t'));
  for (const key of Object.keys(agg)) {
    const b = agg[key];
    const pct = (x) => ((100 * x) / b.total).toFixed(1);
    const sortedCents = b.centsErrors.slice().sort((a, c) => a - c);
    const medianCents = sortedCents.length ? sortedCents[Math.floor(sortedCents.length / 2)].toFixed(1) : 'n/a';
    console.log([
      b.profile,
      b.snrDb === Infinity ? 'clean' : b.snrDb + 'dB',
      b.total,
      pct(b.correct), pct(b.octaveDown), pct(b.octaveUp), pct(b.grossOther), pct(b.voicingMiss),
      medianCents,
    ].join('\t'));
  }
  console.log(`\nPure-noise false-voicing rate: ${falseVoicings}/${noiseTrials} (${((100 * falseVoicings) / noiseTrials).toFixed(1)}%)`);

  return agg;
}

// =========================================================================
// Stage 2: word-level pipeline (synthesis -> estimator -> segmentByMora ->
// scorePattern), oracle vs real estimator, plus one-knob-at-a-time realism.
//
// NOTE: this stage calls the real, current segmentByMora -- which, as of
// the 2026-09-24 fix, uses the 2-cluster classifyLevels() rule, not the
// median-vs-population rule this stage's "oracle, exact ties" run below was
// originally written to demonstrate. Its output no longer reproduces that
// bug (by design -- the bug is fixed); Stage 3 is where OLD-vs-NEW is
// actually compared, since it reimplements the retired rule standalone for
// that purpose. This stage is kept as-is for historical/regression
// reference (e.g. the declination and realism-knob numbers below still
// describe the current shipped behavior).
// =========================================================================

function loadWordStrata() {
  const wordsPath = path.join(__dirname, '..', 'data', 'words.json');
  const words = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));
  const counts = new Map();
  for (const w of words) {
    const moraCount = moraSplit(w.reading).length;
    if (moraCount < 1 || moraCount > 8) continue; // ignore pathological outliers
    const key = moraCount + '|' + w.accentNum;
    const entry = counts.get(key) || { moraCount, accentNum: w.accentNum, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  const strata = Array.from(counts.values()).sort((a, b) => b.count - a.count);
  return strata;
}

function accentClass(moraCount, accentNum) {
  if (accentNum === 0) return 'heiban';
  if (accentNum === 1) return 'atamadaka';
  if (accentNum === moraCount) return 'odaka';
  return 'nakadaka';
}

// Builds an oracle trace: one frame's worth of Hz per mora, straight from
// the target pattern, no estimator involved at all -- isolates
// segmentByMora's own logic from _estimatePitch's error.
function oracleTrace(target, hHz, lHz, moraMs, jitter, rng) {
  const trace = [];
  const framesPerMora = 3;
  for (let i = 0; i < target.length; i++) {
    const base = target[i] === 'H' ? hHz : lHz;
    for (let f = 0; f < framesPerMora; f++) {
      const tMs = i * moraMs + (f * moraMs) / framesPerMora;
      const hz = jitter > 0 ? base + gaussian(rng) * jitter : base;
      trace.push({ tMs, hz });
    }
  }
  return trace;
}

// Builds a realistic trace: synthesizes actual audio per HOP_MS hop and
// runs it through the real _estimatePitch, with optional realism knobs.
function pipelineTrace(target, hHz, lHz, opts, rng) {
  const {
    moraMs = 150,
    sampleRate = 48000,
    profile = 'harmonic4',
    snrDb = 20,
    glideMs = 0, // pitch glide at mora boundaries
    declinationSpan = 0, // fractional Hz change across the whole word (e.g. -0.15 = -15% by the end)
    unvoicedGapMs = 0, // silent gap inserted between morae
    moraJitterPct = 0, // per-mora random Hz offset (real speech isn't perfectly repeatable mora-to-mora)
  } = opts;

  const trace = [];
  let tMs = 0;
  const totalMoraMs = target.length * moraMs;

  // Drawn ONCE per mora (not per frame) -- models natural mora-to-mora
  // pitch variability distinct from within-mora estimator noise.
  const moraFactors = target.map(() => 1 + (rng() * 2 - 1) * moraJitterPct);

  function targetHzAt(continuousMoraPos) {
    // continuousMoraPos: fractional mora index (for glide interpolation)
    const i0 = Math.floor(continuousMoraPos);
    const frac = continuousMoraPos - i0;
    const hzAt = (idx) => {
      const clamped = Math.max(0, Math.min(target.length - 1, idx));
      return (target[clamped] === 'H' ? hHz : lHz) * moraFactors[clamped];
    };
    let hz;
    if (glideMs <= 0 || frac === 0) {
      hz = hzAt(i0);
    } else {
      // Only interpolate within glideMs of a boundary; otherwise flat.
      const posMs = continuousMoraPos * moraMs;
      const boundaryMs = (i0 + 1) * moraMs;
      const distToBoundary = boundaryMs - posMs;
      if (distToBoundary < glideMs) {
        const w = 1 - distToBoundary / glideMs;
        hz = hzAt(i0) * (1 - w) + hzAt(i0 + 1) * w;
      } else {
        hz = hzAt(i0);
      }
    }
    if (declinationSpan !== 0) {
      const wordFrac = (continuousMoraPos * moraMs) / totalMoraMs;
      hz *= 1 + declinationSpan * wordFrac;
    }
    return hz;
  }

  for (let i = 0; i < target.length; i++) {
    const moraStartMs = i * moraMs;
    const moraEndMs = moraStartMs + moraMs - unvoicedGapMs;
    for (let t = moraStartMs; t < moraEndMs; t += HOP_MS) {
      const continuousPos = i + (t - moraStartMs) / moraMs;
      const hz = targetHzAt(continuousPos);
      const buf = synthVoicedFrame(hz, sampleRate, FRAME_SIZE, profile, snrDb, rng);
      const detected = estimatePitch(buf, sampleRate);
      trace.push({ tMs: t, hz: detected });
    }
    if (unvoicedGapMs > 0) {
      for (let t = moraEndMs; t < moraStartMs + moraMs; t += HOP_MS) {
        trace.push({ tMs: t, hz: null }); // silence -> estimatePitch would report null anyway
      }
    }
  }
  return trace;
}

function runStage2() {
  const strata = loadWordStrata();
  const totalWords = strata.reduce((s, x) => s + x.count, 0);
  console.log(`\n=== Stage 2: word-level pipeline (${strata.length} distinct (moraCount, accentNum) strata, ${totalWords} words) ===\n`);

  const H_HZ = 150, L_HZ = 100;

  // ---- 2a. Oracle: exact-tie trace (identical Hz per mora, no jitter) ----
  // Isolates segmentByMora's H/L decision rule on its own, with the
  // cleanest possible input -- confirms/refutes the predicted median-tie
  // failure mode independent of any estimator noise.
  runOracleVariant(strata, totalWords, H_HZ, L_HZ, 0, 'oracle, exact ties (identical Hz per mora)');
  runOracleVariant(strata, totalWords, H_HZ, L_HZ, 3, 'oracle, small jitter (±3Hz Gaussian)');

  // ---- 2b. Full pipeline: real estimator, one realism knob at a time ----
  const TOP_N = 15;
  const topStrata = strata.slice(0, TOP_N);
  const topWeight = topStrata.reduce((s, x) => s + x.count, 0);
  console.log(`\n(Full-pipeline passes below use the top ${TOP_N} strata by frequency, covering ${topWeight}/${totalWords} words = ${((100 * topWeight) / totalWords).toFixed(0)}%)\n`);

  const passes = [
    { name: 'baseline (flat Hz, abrupt transitions, 20dB SNR, equal 150ms morae)', opts: {} },
    { name: '+ pitch glide (40ms) at mora boundaries', opts: { glideMs: 40 } },
    { name: '+ declination (-15% Hz across the word)', opts: { declinationSpan: -0.15 } },
    { name: '+ unvoiced gaps (15ms) between morae', opts: { unvoicedGapMs: 15 } },
    { name: 'clean audio, no noise (isolates estimator-noise contribution)', opts: { snrDb: Infinity } },
  ];

  const header = ['pass', 'exactMatch%', 'moraMatch%', 'moraMismatch%', 'moraUnclear%'];
  console.log(header.join('\t'));
  for (const p of passes) {
    const result = runFullPipelinePass(topStrata, H_HZ, L_HZ, p.opts);
    console.log([
      p.name,
      ((100 * result.exactMatches) / result.words).toFixed(1),
      ((100 * result.matched) / result.totalMorae).toFixed(1),
      ((100 * result.mismatch) / result.totalMorae).toFixed(1),
      ((100 * result.unclear) / result.totalMorae).toFixed(1),
    ].join('\t'));
  }

  // ---- 2c. Breakdown by accent class, baseline pass ----
  console.log('\n-- Baseline pass, broken down by accent class --');
  const byClass = {};
  for (const s of topStrata) {
    const cls = accentClass(s.moraCount, s.accentNum);
    const target = pitchLevels(s.moraCount, s.accentNum).slice(0, s.moraCount);
    const rng = mulberry32(hashKey(s.moraCount, s.accentNum, 'classbreak'));
    const trace = pipelineTrace(target, H_HZ, L_HZ, {}, rng);
    const { pattern } = segmentByMora(trace, s.moraCount);
    const scored = scorePattern(pattern, target);
    const exact = scored.matched === target.length;
    if (!byClass[cls]) byClass[cls] = { words: 0, exactMatches: 0, matched: 0, mismatch: 0, unclear: 0, totalMorae: 0 };
    const b = byClass[cls];
    b.words += s.count;
    if (exact) b.exactMatches += s.count;
    b.matched += scored.matched * s.count;
    b.unclear += scored.unclear * s.count;
    b.mismatch += (scored.total - scored.matched - scored.unclear) * s.count;
    b.totalMorae += scored.total * s.count;
  }
  console.log(['class', 'n(words)', 'exactMatch%', 'moraMatch%'].join('\t'));
  for (const cls of Object.keys(byClass)) {
    const b = byClass[cls];
    console.log([cls, b.words, ((100 * b.exactMatches) / b.words).toFixed(1), ((100 * b.matched) / b.totalMorae).toFixed(1)].join('\t'));
  }

  // ---- 2d. Heiban vs odaka: expected to be indistinguishable ----
  const heiban3 = pitchLevels(3, 0).slice(0, 3);
  const odaka3 = pitchLevels(3, 3).slice(0, 3);
  console.log(`\nHeiban(moraCount=3) word-internal target: [${heiban3}]  Odaka(moraCount=3) word-internal target: [${odaka3}]`);
  console.log('-> identical by construction; scorePattern cannot distinguish them (trailing particle-pitch entry is dropped). This is a scoring-contract limit, not a pipeline accuracy bug.');
}

function hashKey(a, b, s) {
  let h = 2166136261;
  const str = a + '|' + b + '|' + s;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function runOracleVariant(strata, totalWords, hHz, lHz, jitter, label) {
  let exactMatches = 0, matched = 0, mismatch = 0, unclear = 0, totalMorae = 0;
  const flaggedFailures = [];
  for (const s of strata) {
    const target = pitchLevels(s.moraCount, s.accentNum).slice(0, s.moraCount);
    const rng = mulberry32(hashKey(s.moraCount, s.accentNum, 'oracle' + jitter));
    const trace = oracleTrace(target, hHz, lHz, 150, jitter, rng);
    const { pattern } = segmentByMora(trace, s.moraCount);
    const scored = scorePattern(pattern, target);
    const exact = scored.matched === target.length;
    if (exact) exactMatches += s.count;
    matched += scored.matched * s.count;
    unclear += scored.unclear * s.count;
    mismatch += (scored.total - scored.matched - scored.unclear) * s.count;
    totalMorae += scored.total * s.count;
    if (!exact && flaggedFailures.length < 3) {
      flaggedFailures.push(`  e.g. moraCount=${s.moraCount} accentNum=${s.accentNum} (${accentClass(s.moraCount, s.accentNum)}): target=[${target}] got=[${pattern}]`);
    }
  }
  console.log(`-- ${label} --`);
  console.log(`  exact word match: ${((100 * exactMatches) / totalWords).toFixed(1)}%   mora match: ${((100 * matched) / totalMorae).toFixed(1)}%   mismatch: ${((100 * mismatch) / totalMorae).toFixed(1)}%   unclear: ${((100 * unclear) / totalMorae).toFixed(1)}%`);
  if (flaggedFailures.length) console.log(flaggedFailures.join('\n'));
  console.log('');
}

function runFullPipelinePass(strata, hHz, lHz, opts) {
  let exactMatches = 0, matched = 0, mismatch = 0, unclear = 0, totalMorae = 0, words = 0;
  for (const s of strata) {
    const target = pitchLevels(s.moraCount, s.accentNum).slice(0, s.moraCount);
    const rng = mulberry32(hashKey(s.moraCount, s.accentNum, JSON.stringify(opts)));
    const trace = pipelineTrace(target, hHz, lHz, opts, rng);
    const { pattern } = segmentByMora(trace, s.moraCount);
    const scored = scorePattern(pattern, target);
    const exact = scored.matched === target.length;
    words += s.count;
    if (exact) exactMatches += s.count;
    matched += scored.matched * s.count;
    unclear += scored.unclear * s.count;
    mismatch += (scored.total - scored.matched - scored.unclear) * s.count;
    totalMorae += scored.total * s.count;
  }
  return { exactMatches, matched, mismatch, unclear, totalMorae, words };
}

// =========================================================================

// =========================================================================
// Stage 3: A/B -- old median-vs-population H/L rule vs a candidate 2-cluster
// (1D 2-means / Otsu) split, on the classification step ONLY -- both share
// the identical slot-bucketing logic segmentByMora uses, copied here so the
// comparison isolates exactly the part in question, independent of any
// edits already made (or not yet made) to js/mora-segment.js itself.
//
// Motivation: a first attempt at fixing the confirmed median-tie bug
// (comparing each mora's median Hz to the recording's OWN median, which
// ties exactly whenever one class has most of the frames) tried "exact tie
// -> unclear" instead of "tie -> H". That is *worse*, not better: it doesn't
// just fix the tied class, it also flags every tie in the MAJORITY class as
// unclear -- and heiban (this dataset's single largest accent class, ~47%
// of words) is H-majority, so its H morae started ties just as often as
// atamadaka's L morae did. Median-vs-population is structurally unable to
// avoid ties on whichever class is a plurality; no choice of tie-breaking
// direction (or tie -> unclear) fixes that without breaking a different
// class. A 2-cluster split has no such asymmetry: the boundary is a
// computed midpoint between the two nearest clusters, not one of the
// observed values, so it doesn't coincide with either class by construction
// -- unless there IS no contrast at all (every present slot the same
// value), which is correctly reported as unclear.
// =========================================================================

function bucketSlots(trace, moraCount) {
  const voiced = (trace || []).filter((f) => f && f.hz != null);
  if (!voiced.length) return { slots: null };
  let spanStart = voiced[0].tMs, spanEnd = voiced[0].tMs;
  for (const v of voiced) {
    if (v.tMs < spanStart) spanStart = v.tMs;
    if (v.tMs > spanEnd) spanEnd = v.tMs;
  }
  const span = spanEnd - spanStart;
  const slots = Array.from({ length: moraCount }, () => []);
  for (const frame of voiced) {
    let idx;
    if (span <= 0) idx = 0;
    else {
      idx = Math.floor(((frame.tMs - spanStart) / span) * moraCount);
      if (idx >= moraCount) idx = moraCount - 1;
      if (idx < 0) idx = 0;
    }
    slots[idx].push(frame.hz);
  }
  return { slots, spanStart, spanEnd };
}

function medianOf(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// The RETIRED rule (js/mora-segment.js no longer contains this -- it's
// reimplemented here, standalone, purely so OLD-vs-NEW can still be
// compared after the fix landed): each slot vs the recording's OWN overall
// median.
function classifyOldRule(slots) {
  const slotMedians = slots.map((s) => (s.length ? medianOf(s) : null));
  const allHz = [].concat(...slots);
  const overallMedian = medianOf(allHz);
  return slotMedians.map((m) => (m == null ? 'unclear' : m >= overallMedian ? 'H' : 'L'));
}

// NEW: calls the actual SHIPPED classifier (js/mora-segment.js's
// _classifyLevels, exported for exactly this kind of validation) rather
// than a reimplementation -- so this script measures the real code, not a
// model of it that could silently drift from what ships.
function classifyNewRule(slots) {
  return classifyShipped(slots.map((s) => (s.length ? medianOf(s) : null)));
}

function runStage3ABComparison() {
  const strata = loadWordStrata();
  const H_HZ = 150, L_HZ = 100;
  const SEEDS = 25;

  const passes = [
    { name: 'oracle exact (no jitter, no estimator)', oracle: true, jitter: 0, opts: {} },
    { name: 'oracle + ±3Hz frame jitter', oracle: true, jitter: 3, opts: {} },
    { name: 'full pipeline baseline (20dB SNR, ±5% per-mora jitter)', oracle: false, opts: { moraJitterPct: 0.05 } },
    { name: 'full pipeline + declination -5%', oracle: false, opts: { moraJitterPct: 0.05, declinationSpan: -0.05 } },
    { name: 'full pipeline + declination -10%', oracle: false, opts: { moraJitterPct: 0.05, declinationSpan: -0.10 } },
    { name: 'full pipeline + declination -15%', oracle: false, opts: { moraJitterPct: 0.05, declinationSpan: -0.15 } },
    { name: 'full pipeline, clean (no noise)', oracle: false, opts: { moraJitterPct: 0.05, snrDb: Infinity } },
  ];

  console.log('\n=== Stage 3: A/B -- old median-vs-population rule vs candidate 2-cluster split ===\n');
  console.log(`(${SEEDS} seeds/stratum, weighted by real word frequency across all ${strata.length} strata)\n`);

  for (const p of passes) {
    const oldAgg = { exact: 0, matched: 0, mismatch: 0, unclear: 0, total: 0, words: 0 };
    const newAgg = { exact: 0, matched: 0, mismatch: 0, unclear: 0, total: 0, words: 0 };
    for (const s of strata) {
      const target = pitchLevels(s.moraCount, s.accentNum).slice(0, s.moraCount);
      for (let seed = 0; seed < SEEDS; seed++) {
        const rng = mulberry32(hashKey(s.moraCount, s.accentNum, p.name + seed));
        const trace = p.oracle
          ? oracleTrace(target, H_HZ, L_HZ, 150, p.jitter, rng)
          : pipelineTrace(target, H_HZ, L_HZ, p.opts, rng);
        const { slots } = bucketSlots(trace, s.moraCount);
        if (!slots) continue;
        for (const [agg, classify] of [[oldAgg, classifyOldRule], [newAgg, classifyNewRule]]) {
          const pattern = classify(slots);
          const scored = scorePattern(pattern, target);
          agg.words += s.count;
          if (scored.matched === target.length) agg.exact += s.count;
          agg.matched += scored.matched * s.count;
          agg.unclear += scored.unclear * s.count;
          agg.mismatch += (scored.total - scored.matched - scored.unclear) * s.count;
          agg.total += scored.total * s.count;
        }
      }
    }
    console.log(`-- ${p.name} --`);
    for (const [label, agg] of [['OLD', oldAgg], ['NEW', newAgg]]) {
      console.log(`  ${label}: exact=${((100 * agg.exact) / agg.words).toFixed(1)}%  moraMatch=${((100 * agg.matched) / agg.total).toFixed(1)}%  mismatch=${((100 * agg.mismatch) / agg.total).toFixed(1)}%  unclear=${((100 * agg.unclear) / agg.total).toFixed(1)}%`);
    }
  }

  console.log('\n-- Per accent-class breakdown, baseline pass --');
  const byClassOld = {}, byClassNew = {};
  for (const s of strata) {
    const cls = accentClass(s.moraCount, s.accentNum);
    const target = pitchLevels(s.moraCount, s.accentNum).slice(0, s.moraCount);
    for (let seed = 0; seed < SEEDS; seed++) {
      const rng = mulberry32(hashKey(s.moraCount, s.accentNum, 'classbreak' + seed));
      const trace = pipelineTrace(target, H_HZ, L_HZ, { moraJitterPct: 0.05 }, rng);
      const { slots } = bucketSlots(trace, s.moraCount);
      if (!slots) continue;
      for (const [store, classify] of [[byClassOld, classifyOldRule], [byClassNew, classifyNewRule]]) {
        if (!store[cls]) store[cls] = { exact: 0, matched: 0, total: 0, words: 0 };
        const pattern = classify(slots);
        const scored = scorePattern(pattern, target);
        const b = store[cls];
        b.words += s.count;
        if (scored.matched === target.length) b.exact += s.count;
        b.matched += scored.matched * s.count;
        b.total += scored.total * s.count;
      }
    }
  }
  console.log(['class', 'OLD exact%', 'NEW exact%', 'OLD moraMatch%', 'NEW moraMatch%'].join('\t'));
  for (const cls of Object.keys(byClassOld)) {
    const o = byClassOld[cls], n = byClassNew[cls];
    console.log([cls, ((100 * o.exact) / o.words).toFixed(1), ((100 * n.exact) / n.words).toFixed(1), ((100 * o.matched) / o.total).toFixed(1), ((100 * n.matched) / n.total).toFixed(1)].join('\t'));
  }

  console.log('\n-- 1-mora words (no possible internal H/L contrast) --');
  const oneMora = strata.filter((s) => s.moraCount === 1);
  for (const s of oneMora) {
    const target = pitchLevels(1, s.accentNum).slice(0, 1);
    const rng = mulberry32(hashKey(1, s.accentNum, 'onemora'));
    const trace = pipelineTrace(target, H_HZ, L_HZ, { moraJitterPct: 0.05 }, rng);
    const { slots } = bucketSlots(trace, 1);
    console.log(`  accentNum=${s.accentNum} target=[${target}] n=${s.count} words  OLD=[${classifyOldRule(slots)}]  NEW=[${classifyNewRule(slots)}]`);
  }
}

// =========================================================================
// Stage 4: contrast x declination sweep.
//
// Stage 3's H=150Hz/L=100Hz gap is a full 7 semitones -- far wider than
// either the ±5% per-mora jitter or -15% declination tested against it, so
// NEW hit a 99%+ ceiling there that says nothing about whether the
// 2-cluster split holds up as the genuine H/L gap gets SMALLER (a soft-
// spoken or careful learner may not swing their pitch as far as scripted
// TTS-like audio does) or as declination grows relative to that gap. This
// sweep is the actual stress test: shrink the H/L ratio while separately
// growing declination, and watch for the point (if any) where declination
// starts getting misread as -- or swamping -- the real accent contrast.
// Oracle traces (direct Hz values, no synthesized audio) since Stage 1
// already validated _estimatePitch itself -- this isolates the
// classification rule, which is what's actually in question here.
// =========================================================================

function oracleTraceV2(target, hHz, lHz, opts, rng) {
  const { moraMs = 150, declinationSpan = 0, moraJitterPct = 0, frameJitterPct = 0, framesPerMora = 5 } = opts;
  const trace = [];
  const totalMs = target.length * moraMs;
  const moraFactors = target.map(() => 1 + (rng() * 2 - 1) * moraJitterPct);
  for (let i = 0; i < target.length; i++) {
    const base = (target[i] === 'H' ? hHz : lHz) * moraFactors[i];
    for (let f = 0; f < framesPerMora; f++) {
      const tMs = i * moraMs + (f * moraMs) / framesPerMora;
      const wordFrac = tMs / totalMs;
      let hz = base * (1 + declinationSpan * wordFrac);
      if (frameJitterPct > 0) hz *= 1 + gaussian(rng) * frameJitterPct;
      trace.push({ tMs, hz });
    }
  }
  return trace;
}

function runStage4ContrastSweep() {
  const strata = loadWordStrata();
  const SEEDS = 30;
  const RATIOS = [1.05, 1.1, 1.2, 1.3]; // H/L ratio: 1.2 ~= 3.2 semitones, 1.3 ~= 4.6
  const DECLINATIONS = [0, -0.05, -0.10];
  const L_HZ = 100;

  console.log('\n=== Stage 4: contrast x declination sweep (oracle traces, retired vs shipped rule) ===\n');
  console.log(`(${SEEDS} seeds/stratum/condition, ±2% per-mora jitter + ±1% per-frame jitter, weighted by word frequency)\n`);
  console.log(['H/L ratio', 'declination', 'OLD exact%', 'NEW exact%', 'OLD moraMatch%', 'NEW moraMatch%'].join('\t'));

  for (const ratio of RATIOS) {
    const hHz = L_HZ * ratio;
    for (const decl of DECLINATIONS) {
      const oldAgg = { exact: 0, matched: 0, total: 0, words: 0 };
      const newAgg = { exact: 0, matched: 0, total: 0, words: 0 };
      for (const s of strata) {
        const target = pitchLevels(s.moraCount, s.accentNum).slice(0, s.moraCount);
        for (let seed = 0; seed < SEEDS; seed++) {
          const rng = mulberry32(hashKey(s.moraCount, s.accentNum, `sweep${ratio}_${decl}_${seed}`));
          const trace = oracleTraceV2(target, hHz, L_HZ, { declinationSpan: decl, moraJitterPct: 0.02, frameJitterPct: 0.01 }, rng);
          const { slots } = bucketSlots(trace, s.moraCount);
          if (!slots) continue;
          for (const [agg, classify] of [[oldAgg, classifyOldRule], [newAgg, classifyNewRule]]) {
            const pattern = classify(slots);
            const scored = scorePattern(pattern, target);
            agg.words += s.count;
            if (scored.matched === target.length) agg.exact += s.count;
            agg.matched += scored.matched * s.count;
            agg.total += scored.total * s.count;
          }
        }
      }
      console.log([
        ratio, decl,
        ((100 * oldAgg.exact) / oldAgg.words).toFixed(1),
        ((100 * newAgg.exact) / newAgg.words).toFixed(1),
        ((100 * oldAgg.matched) / oldAgg.total).toFixed(1),
        ((100 * newAgg.matched) / newAgg.total).toFixed(1),
      ].join('\t'));
    }
  }
}

// =========================================================================
// Stage 5: monotone-learner false-positive check.
//
// A recording with NO real H/L contrast at all (constant target F0, only
// noise) should score close to chance against every target pattern -- not
// get confidently marked correct. This specifically probes a risk a
// 2-cluster split carries that a population-median rule doesn't: with only
// noise to split on, 2-means will still partition the frames into two
// groups (there's always SOME split that minimizes within-group variance),
// so it's worth measuring directly whether that ever happens to
// reconstruct a real accent pattern by chance more often than the retired
// rule did.
//
// IMPORTANT: uses the SAME per-mora + per-frame jitter model as Stage 4's
// genuine-contrast sweep (moraJitterPct + frameJitterPct), not per-frame
// jitter alone. A 5-frames-per-mora slot median mostly averages away
// per-frame-only noise, understating how much spread a flat learner's own
// natural mora-to-mora wobble actually leaves behind -- per-mora jitter is
// exactly what the median CAN'T remove, and is what determines whether the
// MIN_SPLIT_CENTS threshold below is actually doing its job against the
// same kind of noise Stage 4's real-contrast measurements are competing
// against.
// =========================================================================

function monotoneTrace(moraCount, baseHz, moraJitterPct, frameJitterPct, declinationSpan, rng) {
  const dummyTarget = new Array(moraCount).fill('L'); // H/L irrelevant here: hHz === lHz
  return oracleTraceV2(dummyTarget, baseHz, baseHz, { declinationSpan, moraJitterPct, frameJitterPct }, rng);
}

// 2-mora is the important case here: with only two slots, classifyLevels
// can only ever return LH or HL, and EVERY 2-mora accent target is one of
// exactly those two shapes (heiban/odaka = LH, atamadaka = HL) -- so a
// monotone attempt on a 2-mora word isn't a rare coincidence away from an
// exact match, it's a coin flip, for old and new rules alike. This is why
// the sweep below spans moraCount, not just the 4-mora case Stage 5
// originally shipped with.
function runStage5MonotoneFalsePositive() {
  const SEEDS = 300;
  const DECLINATIONS = [0, -0.05, -0.10];
  // Two jitter models: the first matches Stage 4's genuine-contrast sweep
  // exactly (moraJitterPct 0.02 + frameJitterPct 0.01), so the false-
  // positive rate here is measured against the SAME noise level the
  // real-contrast numbers are competing against, not an easier one. The
  // second is a sensitivity check for a noisier flat speaker.
  const JITTER_MODELS = [
    { label: 'matched to Stage 4 (2% per-mora + 1% per-frame)', moraJitterPct: 0.02, frameJitterPct: 0.01 },
    { label: '5% per-mora + 1% per-frame', moraJitterPct: 0.05, frameJitterPct: 0.01 },
  ];

  console.log('\n=== Stage 5: monotone-learner false-positive check (no real contrast, just noise) ===\n');
  console.log(`(constant 120Hz F0, ${SEEDS} seeds/condition)\n`);

  for (const jm of JITTER_MODELS) {
    console.log(`-- jitter: ${jm.label} --`);
    console.log(['moraCount', 'declination', 'target class', 'target', 'OLD false-exact%', 'NEW false-exact%'].join('\t'));
    for (const moraCount of [2, 3, 4]) {
      const patterns = {
        heiban: pitchLevels(moraCount, 0).slice(0, moraCount),
        atamadaka: pitchLevels(moraCount, 1).slice(0, moraCount),
        nakadaka: pitchLevels(moraCount, 2).slice(0, moraCount), // impossible below 3 morae; skipped there
        odaka: pitchLevels(moraCount, moraCount).slice(0, moraCount),
      };
      for (const decl of DECLINATIONS) {
        for (const cls of Object.keys(patterns)) {
          if (moraCount < 3 && cls === 'nakadaka') continue;
          const target = patterns[cls];
          let oldFalse = 0, newFalse = 0;
          for (let seed = 0; seed < SEEDS; seed++) {
            const rng = mulberry32(hashKey(moraCount, decl * 1000, jm.label + '_' + cls + '_' + seed));
            const trace = monotoneTrace(moraCount, 120, jm.moraJitterPct, jm.frameJitterPct, decl, rng);
            const { slots } = bucketSlots(trace, moraCount);
            const oldPattern = classifyOldRule(slots);
            const newPattern = classifyNewRule(slots);
            if (scorePattern(oldPattern, target).matched === target.length) oldFalse++;
            if (scorePattern(newPattern, target).matched === target.length) newFalse++;
          }
          console.log([moraCount, decl, cls, target.join(''), ((100 * oldFalse) / SEEDS).toFixed(1), ((100 * newFalse) / SEEDS).toFixed(1)].join('\t'));
        }
      }
    }
  }
}

// FAST_STAGES_ONLY=1 skips Stages 1-3 (which synthesize and run real audio
// through _estimatePitch, several minutes) -- useful when only Stage 4/5's
// oracle-trace sweeps are needed, e.g. while tuning MIN_SPLIT_CENTS.
if (!process.env.FAST_STAGES_ONLY) {
  runStage1();
  runStage2();
  runStage3ABComparison();
}
runStage4ContrastSweep();
runStage5MonotoneFalsePositive();

console.log('\n=== Caveat ===');
console.log('All of the above is synthetic audio (additive harmonic stacks + Gaussian');
console.log('noise), not recorded human speech. It validates the pipeline\'s logic under');
console.log('controlled, known-ground-truth conditions. Real-speech validation would need');
console.log('recorded takes (e.g. via the app\'s own playback Blob) or a labeled Japanese');
console.log('speech corpus with accent annotations.');
