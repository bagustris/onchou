const assert = require('assert');
const { segmentByMora, scorePattern, _classifyLevels: classifyLevels, _decodeAccentPattern: decodeAccentPattern } = require('../mora-segment.js');

let pass = 0, fail = 0;
function eq(desc, got, expected) {
  try { assert.deepStrictEqual(got, expected); pass++; }
  catch (e) { fail++; console.error(`FAIL: ${desc} => ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`); }
}

// Dense trace builder, shaped like the real recorder's output: one frame
// every 20ms, `moraMs` per mora, each mora at the given Hz (null = unvoiced).
// Optional per-frame rms (default loud) for the voice-gate tests.
function dense(hzPerMora, moraMs, opts) {
  opts = opts || {};
  const out = [];
  const start = opts.startMs || 0;
  for (let i = 0; i < hzPerMora.length; i++) {
    for (let t = 0; t < moraMs; t += 20) {
      out.push({ tMs: start + i * moraMs + t, hz: hzPerMora[i], rms: opts.rms != null ? opts.rms : 0.3 });
    }
  }
  return out;
}

// -- segmentByMora: valid Tokyo patterns come back correctly -------------

eq('3-mora nakadaka (LHL)', segmentByMora(dense([100, 150, 100], 150), 3).pattern, ['L', 'H', 'L']);
eq('3-mora atamadaka (HLL)', segmentByMora(dense([150, 100, 100], 150), 3).pattern, ['H', 'L', 'L']);
eq('3-mora heiban/odaka shape (LHH)', segmentByMora(dense([100, 150, 150], 150), 3).pattern, ['L', 'H', 'H']);
eq('4-mora type 3 (LHHL)', segmentByMora(dense([100, 150, 150, 100], 150), 4).pattern, ['L', 'H', 'H', 'L']);

// Only the n+1 valid Tokyo patterns can come out (constrained decoding): an
// H,L,H-shaped take -- impossible in Tokyo Japanese (two rises) -- is mapped
// to the nearest valid pattern rather than reported verbatim.
{
  const valid = new Set(['LHH', 'HLL', 'LHL']);
  const p = segmentByMora(dense([150, 100, 150], 150), 3).pattern.join('');
  eq('an impossible H,L,H take decodes to a valid 3-mora pattern', valid.has(p), true);
}

// A slot with zero voiced frames is 'unclear', regardless of its neighbors --
// the winning pattern implies a level for it, but no data means no verdict.
// Two unvoiced morae in a row: each window is read PEAK_DELAY_MS late, so a
// single unvoiced mora's window would pick up the start of the next voiced
// one -- the window over the FIRST of two is what's genuinely empty.
{
  const { pattern } = segmentByMora(dense([100, null, null, 150], 150), 4);
  eq('slot whose (delayed) window has no voiced frames is unclear', pattern[1], 'unclear');
}

// All frames unvoiced -> every mora unclear (silence / muted mic case).
{
  const trace = [
    { tMs: 0, hz: null }, { tMs: 20, hz: null }, { tMs: 40, hz: null },
  ];
  const { pattern } = segmentByMora(trace, 4);
  eq('all-unvoiced trace yields all-unclear pattern', pattern, ['unclear', 'unclear', 'unclear', 'unclear']);
}

// moraCount of 0 (or falsy) yields an empty pattern rather than throwing.
{
  const { pattern } = segmentByMora([{ tMs: 0, hz: 150 }], 0);
  eq('moraCount 0 yields empty pattern', pattern, []);
}

// -- relative H/L: absolute pitch never matters -------------------------
eq('low-pitched-overall speaker: relative H/L still correct',
  segmentByMora(dense([80, 129, 80], 150), 3).pattern, ['L', 'H', 'L']);
eq('high-pitched-overall speaker: relative H/L still correct',
  segmentByMora(dense([400, 300, 300], 150), 3).pattern, ['H', 'L', 'L']);

// -- flat/monotone attempt: no contrast -> all unclear, not a forced pattern
eq('flat attempt stays all-unclear (MIN_SPLIT_CENTS guard on the fitted step)',
  segmentByMora(dense([120, 121, 120, 119], 150), 4).pattern, ['unclear', 'unclear', 'unclear', 'unclear']);

// -- declination: a genuinely falling baseline doesn't flip the pattern ---
// Heiban-shaped L,H,H,H,H with a steady 40-cent-per-mora fall across the H
// plateau: an independent per-mora split reads the late, lower H morae as L
// (that's what real-speech evaluation found it doing); the joint
// declination term absorbs the slope instead.
{
  const f = (c) => 150 * Math.pow(2, -c / 1200);
  const p = segmentByMora(dense([100, f(0), f(40), f(80), f(120)], 150), 5).pattern;
  eq('heiban-shaped take with steady declination is still LHHHH', p, ['L', 'H', 'H', 'H', 'H']);
}

// -- voice gate: quiet false-"voiced" frames in the silence around a word
// (the estimator reports random pitch on near-silence) must not stretch the
// voiced span the mora slots are cut from. -------------------------------
{
  const noise = (t0, n) => Array.from({ length: n }, (_, k) => ({ tMs: t0 + 20 * k, hz: [310, 90, 400, 72][k % 4], rms: 0.003 }));
  const word = dense([150, 100, 100], 150, { startMs: 300 });
  const trace = noise(0, 15).concat(word, noise(750, 15));
  const r = segmentByMora(trace, 3);
  eq('voice gate: spanStart is the word, not the leading noise', r.spanStart, 300);
  eq('voice gate: spanEnd is the word, not the trailing noise', r.spanEnd, 740);
  eq('voice gate: pattern read from the word itself', r.pattern, ['H', 'L', 'L']);
}
{
  // Traces without rms (older callers, synthetic tests) are not gated.
  const trace = [{ tMs: 0, hz: 100 }, { tMs: 20, hz: 100 }];
  eq('no rms -> no gating', segmentByMora(trace, 2).spanStart, 0);
}

// -- peak delay: the accentual fall realized ~60ms into the NEXT mora (as in
// real speech) still decodes to the right accent type. Without the window
// delay, the accented mora's slot would be half low. ----------------------
{
  // 3-mora atamadaka, 120ms morae; F0 stays high for 60ms into mora 2.
  const trace = [];
  for (let t = 0; t < 360; t += 20) trace.push({ tMs: t, hz: t < 180 ? 150 : 100, rms: 0.3 });
  eq('fall delayed into the next mora: still atamadaka', segmentByMora(trace, 3).pattern, ['H', 'L', 'L']);
}

// -- overallMedian contract (pitch-contour.js normalizes by it) -----------
{
  const { pattern, overallMedian } = segmentByMora(dense([150, 100, 100], 150), 3);
  eq('overallMedian is still the raw population median', overallMedian, 100);
  eq('L-majority (atamadaka-shaped) word decoded correctly', pattern, ['H', 'L', 'L']);
}
{
  const { pattern, overallMedian } = segmentByMora(dense([100, 150, 150], 150), 3);
  eq('overallMedian is still the raw population median (H-majority)', overallMedian, 150);
  eq('H-majority (heiban-shaped) word decoded correctly', pattern, ['L', 'H', 'H']);
}

// A 1-mora word has only one slot, with nothing to compare it against --
// correctly 'unclear': there's no relative contrast a single mora can carry.
{
  const trace = [{ tMs: 0, hz: 120 }, { tMs: 20, hz: 122 }, { tMs: 40, hz: 118 }];
  const { pattern } = segmentByMora(trace, 1);
  eq('1-mora word: no possible internal contrast -> unclear, not a guessed H', pattern, ['unclear']);
}

// -- heavy first syllable: no initial rise expected (Round 4) ------------
{
  const { _heavyInitial: heavy } = require('../mora-segment.js');
  eq('heavy: きんえん (ん as mora 2)', heavy(['き', 'ん', 'え', 'ん']), true);
  eq('heavy: びょういん (long vowel)', heavy(['びょ', 'う', 'い', 'ん']), true);
  eq('heavy: かいこく (diphthong)', heavy(['か', 'い', 'こ', 'く']), true);
  eq('NOT heavy: いっつう (geminate っ is not sonorant -- initial lowering applies)', heavy(['い', 'っ', 'つ', 'う']), false);
  eq('heavy: ビール (ー)', heavy(['ビ', 'ー', 'ル']), true);
  eq('light: さかな', heavy(['さ', 'か', 'な']), false);
  eq('light: じゆう (ゆ is a full mora)', heavy(['じ', 'ゆ', 'う']), false);
  eq('light: no morae given', heavy(undefined), false);
}
{
  // Near-flat take (30 cents of rise, well under MIN_RISE_CENTS): with a
  // heavy first syllable that's how natives say a heiban word, so it decodes
  // to the no-fall shape; with a light one it stays all-unclear.
  const c = (x) => 120 * Math.pow(2, x / 1200);
  const tr = dense([c(0), c(30), c(30), c(30)], 150);
  eq('heavy-initial near-flat take decodes as no-fall (heiban shape)',
    segmentByMora(tr, 4, { morae: ['き', 'ん', 'え', 'ん'] }).pattern, ['L', 'H', 'H', 'H']);
  eq('light-initial near-flat take stays all-unclear',
    segmentByMora(tr, 4, { morae: ['さ', 'か', 'な', 'か'] }).pattern, ['unclear', 'unclear', 'unclear', 'unclear']);
  eq('no morae given: stricter light rule (all-unclear)',
    segmentByMora(tr, 4).pattern, ['unclear', 'unclear', 'unclear', 'unclear']);
}
{
  // A clear accentual fall is still reported as a fall even for a heavy
  // first syllable -- the relaxed rule only affects the no-fall shape.
  eq('heavy-initial word with a real fall keeps its fall (type 2, LHLL)',
    segmentByMora(dense([100, 150, 100, 100], 150), 4, { morae: ['き', 'ん', 'え', 'ん'] }).pattern, ['L', 'H', 'L', 'L']);
}

// -- decodeAccentPattern, direct -----------------------------------------
eq('decode: clean nakadaka medians', decodeAccentPattern([100, 150, 150, 100]), ['L', 'H', 'H', 'L']);
eq('decode: null slot stays unclear', decodeAccentPattern([150, null, 100]), ['H', 'unclear', 'L']);
eq('decode: step under 100 cents -> all unclear', decodeAccentPattern([100, 100 * Math.pow(2, 60 / 1200)]), ['unclear', 'unclear']);
eq('decode: step over 100 cents -> classified', decodeAccentPattern([100, 100 * Math.pow(2, 150 / 1200)]), ['L', 'H']);
eq('decode: fewer than 2 present slots -> unclear', decodeAccentPattern([150, null]), ['unclear', 'unclear']);

// -- slots: the exact windows scored, for pitch-contour.js -----------------
{
  const r = segmentByMora(dense([100, 150, 100], 150), 3);
  eq('slots: one window per mora', r.slots.length, 3);
  eq('slots: first window starts after the peak delay (20ms)', r.slots[0][0], r.spanStart + 20);
  eq('slots: last window ends at the voiced span end', r.slots[2][1], r.spanEnd);
}

// -- classifyLevels (retired from segmentByMora, still exported for
// tools/pitch-accuracy-experiment.js): 2-cluster split, direct unit tests --

{
  // Two well-separated clusters, interleaved order -- split must group by
  // value, not by position.
  eq('two clean clusters split correctly regardless of order', classifyLevels([200, 100, 180, 90]), ['H', 'L', 'H', 'L']);
}
{
  // Every present slot the same value: no contrast to find, not a guess.
  eq('all-identical slot medians: no contrast -> all unclear', classifyLevels([150, 150, 150]), ['unclear', 'unclear', 'unclear']);
}
{
  // A null (no-voiced-frames) slot stays unclear; the other two still split.
  eq('null slot stays unclear; remaining two still classified', classifyLevels([150, null, 100]), ['H', 'unclear', 'L']);
}
{
  // Only one slot has data at all -- nothing to compare it against.
  eq('single present value has no basis for H/L -> unclear', classifyLevels([150]), ['unclear']);
}
{
  eq('empty input -> empty output', classifyLevels([]), []);
}

// -- MIN_SPLIT_CENTS: a 2-cluster split always finds SOME division, even
// when the "contrast" is too small to trust -- e.g. a flat/monotone
// attempt where the only variation is noise. Found the same way as the
// median-tie bug: tools/pitch-accuracy-experiment.js's Stage 5 measured a
// 2-mora word (where the split can only ever be LH or HL, and every 2-mora
// accent target IS one of those two shapes) as a near coin-flip false
// "correct" against pure noise before this guard existed. 100 cents was
// picked as comfortably above the gap noise alone produces and comfortably
// below a real accent contrast (H/L ratio 1.2+, ~316 cents) -- see the
// MIN_SPLIT_CENTS comment above classifyLevels for the full measurement. ---

{
  // ~60 cents apart (2^(60/1200) ratio) -- below the floor: two genuinely
  // different values, but too close to trust as a real H/L contrast.
  const values = [100, 100 * Math.pow(2, 60 / 1200)];
  eq('gap below MIN_SPLIT_CENTS: too weak to trust, stays unclear', classifyLevels(values), ['unclear', 'unclear']);
}
{
  // ~150 cents apart -- above the floor: a real, if modest, contrast.
  const values = [100, 100 * Math.pow(2, 150 / 1200)];
  eq('gap above MIN_SPLIT_CENTS: classified normally', classifyLevels(values), ['L', 'H']);
}

// -- scorePattern: match / mismatch / unclear categorization -----------

{
  const result = scorePattern(['H', 'L', 'H', 'unclear'], ['H', 'L', 'L', 'H']);
  eq('perMora categorization', result.perMora, ['match', 'match', 'mismatch', 'unclear']);
  eq('matched count', result.matched, 2);
  eq('unclear count', result.unclear, 1);
  eq('total count', result.total, 4);
}

// An unclear learner mora is neither right nor wrong -- confirm it is never
// counted as matched even when it happens to align position-wise with a
// target 'H'/'L' that a naive equality check might have let slip through.
{
  const result = scorePattern(['unclear'], ['H']);
  eq('unclear learner mora is its own category, not folded into mismatch', result.perMora, ['unclear']);
  eq('unclear does not count as matched', result.matched, 0);
  eq('unclear is tallied separately', result.unclear, 1);
}

// All-match and all-mismatch sanity checks.
{
  const allMatch = scorePattern(['H', 'L'], ['H', 'L']);
  eq('all match', allMatch, { matched: 2, unclear: 0, total: 2, perMora: ['match', 'match'] });

  const allMismatch = scorePattern(['H', 'H'], ['L', 'L']);
  eq('all mismatch', allMismatch, { matched: 0, unclear: 0, total: 2, perMora: ['mismatch', 'mismatch'] });
}

// -- Cross-module contract: pitchLevels' trailing entry vs. moraCount ---
//
// PitchDiagram.pitchLevels(moraCount, accentNum) returns moraCount + 1
// entries (a trailing particle-pitch level, per the design spec), while
// segmentByMora always returns exactly moraCount entries -- it has no
// concept of a trailing particle. scorePattern's Math.min(learner.length,
// target.length) means the extra target entry is silently ignored and
// `total` comes out as moraCount, which is the desired behavior -- but it
// was accidental until pinned here. Load PitchDiagram only if available
// (it's a sibling module built independently; this file must still run and
// pass standalone if PitchDiagram isn't present for some reason).
{
  let PitchDiagram;
  try { PitchDiagram = require('../pitch-diagram.js'); } catch (e) { PitchDiagram = null; }

  if (PitchDiagram) {
    const moraCount = 3;
    const target = PitchDiagram.pitchLevels(moraCount, 2); // nakadaka-style
    eq('pitchLevels returns moraCount + 1 entries (trailing particle level)', target.length, moraCount + 1);

    const learner = { pattern: ['H', 'L', 'H'] }; // segmentByMora always returns exactly moraCount
    const scored = scorePattern(learner.pattern, target);
    eq('scorePattern.total ignores the extra trailing target entry', scored.total, moraCount);
  } else {
    console.log('(skipping cross-module contract test: pitch-diagram.js not found)');
  }
}

// -- segmentByMora also returns spanStart/spanEnd/overallMedian, for
// js/pitch-contour.js's target step-line to align to the exact same
// time-slots this function actually scored against -----------------------

{
  const trace = [
    { tMs: 5, hz: 100 }, { tMs: 45, hz: 200 }, { tMs: 95, hz: 150 },
  ];
  const result = segmentByMora(trace, 3);
  eq('spanStart is the first voiced frame\'s tMs', result.spanStart, 5);
  eq('spanEnd is the last voiced frame\'s tMs', result.spanEnd, 95);
  eq('overallMedian is the median of all voiced Hz', result.overallMedian, 150);
}

{
  // All-unvoiced: no span, no median -- both null rather than throwing or
  // fabricating a value, matching the all-unclear pattern this case already
  // produces.
  const trace = [{ tMs: 0, hz: null }, { tMs: 20, hz: null }];
  const result = segmentByMora(trace, 2);
  eq('all-unvoiced trace: spanStart is null', result.spanStart, null);
  eq('all-unvoiced trace: spanEnd is null', result.spanEnd, null);
  eq('all-unvoiced trace: overallMedian is null', result.overallMedian, null);
}

// -- learned pattern choice is OPT-IN (js/accent-model.js) -----------------
{
  const MS = require('../mora-segment.js');
  eq('accent model table is loaded in Node', MS._hasModel, true);
  const tr = dense([100, 150, 100], 150);
  eq('default (no useModel) stays model-free', segmentByMora(tr, 3).pattern, ['L', 'H', 'L']);
  // The table expects connected speech's ~1-mora F0 lag, so on a clean
  // on-time step it may pick a different valid pattern -- but it must never
  // override the guard: a flat take stays all-unclear with useModel on.
  const flat = dense([120, 121, 120, 119], 150);
  eq('useModel: flat take still all-unclear (guard kept)', segmentByMora(flat, 4, { useModel: true }).pattern, ['unclear', 'unclear', 'unclear', 'unclear']);
  const p = segmentByMora(tr, 3, { useModel: true }).pattern.join('');
  eq('useModel: output is still a valid Tokyo pattern', ['LHH', 'HLL', 'LHL'].includes(p), true);
}

console.log(`mora-segment-test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
