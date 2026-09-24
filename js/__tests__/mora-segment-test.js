const assert = require('assert');
const { segmentByMora, scorePattern, _classifyLevels: classifyLevels } = require('../mora-segment.js');

let pass = 0, fail = 0;
function eq(desc, got, expected) {
  try { assert.deepStrictEqual(got, expected); pass++; }
  catch (e) { fail++; console.error(`FAIL: ${desc} => ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`); }
}

// -- segmentByMora: time-proportional slot division --------------------

// Three morae, evenly spaced, each slot cleanly high or low relative to the
// overall median. Trace spans 0-300ms, so slot boundaries land at 100/200.
{
  const trace = [
    { tMs: 0, hz: 200 }, { tMs: 20, hz: 205 }, { tMs: 40, hz: 195 }, // slot 0: ~200 (H)
    { tMs: 110, hz: 100 }, { tMs: 130, hz: 105 }, { tMs: 150, hz: 95 }, // slot 1: ~100 (L)
    { tMs: 220, hz: 200 }, { tMs: 240, hz: 205 }, { tMs: 260, hz: 195 }, // slot 2: ~200 (H)
  ];
  // overall median of [200,205,195,100,105,95,200,205,195] sorted ->
  // [95,100,105,195,195,200,200,205,205], mid index 4 -> 195
  const { pattern } = segmentByMora(trace, 3);
  eq('3-mora HLH pattern', pattern, ['H', 'L', 'H']);
}

// A slot with zero voiced frames is 'unclear', regardless of its neighbors.
{
  const trace = [
    { tMs: 0, hz: 150 }, { tMs: 10, hz: 150 },      // slot 0
    { tMs: 100, hz: null }, { tMs: 110, hz: null },  // slot 1: unvoiced only
    { tMs: 200, hz: 150 }, { tMs: 210, hz: 150 },    // slot 2
  ];
  const { pattern } = segmentByMora(trace, 3);
  eq('middle slot with no voiced frames is unclear', pattern[1], 'unclear');
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

// -- median-relative H/L conversion: objectively low-pitched speaker ----
//
// A trace that is, in absolute terms, low-pitched throughout (a low male
// voice, say) must still correctly identify which of ITS OWN morae are
// relatively higher vs lower -- comparison is against the recording's own
// median, never an absolute Hz threshold.
{
  const trace = [
    { tMs: 0, hz: 80 }, { tMs: 20, hz: 82 },     // slot 0: ~81 (low relative to this speaker)
    { tMs: 110, hz: 130 }, { tMs: 130, hz: 128 }, // slot 1: ~129 (high relative to this speaker)
    { tMs: 220, hz: 80 }, { tMs: 240, hz: 82 },   // slot 2: ~81 (low relative to this speaker)
  ];
  // Every value here (80-130Hz) is well below what a naive absolute
  // threshold (e.g. 150Hz) would call "high" -- yet the middle mora is
  // still the speaker's relative peak and must come out H.
  const { pattern } = segmentByMora(trace, 3);
  eq('low-pitched-overall speaker: relative H/L still correct', pattern, ['L', 'H', 'L']);
}

// Symmetric check: an objectively high-pitched speaker (child's voice, say)
// must still show relative lows, not all-H just because every Hz value is
// numerically large.
{
  const trace = [
    { tMs: 0, hz: 400 }, { tMs: 20, hz: 405 },
    { tMs: 110, hz: 300 }, { tMs: 130, hz: 295 },
    { tMs: 220, hz: 400 }, { tMs: 240, hz: 405 },
  ];
  const { pattern } = segmentByMora(trace, 3);
  eq('high-pitched-overall speaker: relative H/L still correct', pattern, ['H', 'L', 'H']);
}

// -- classifyLevels: 2-cluster split, direct unit tests -----------------

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

// -- The bug this replaced: a plurality class ties the OLD "vs. population
// median" rule's own threshold, and no tie-breaking direction (nor routing
// ties to 'unclear') fixes it without instead breaking whichever pattern
// makes the opposite class the majority. Found via a synthetic-audio
// validation experiment (tools/pitch-accuracy-experiment.js): a perfect,
// noiseless oracle trace of an atamadaka-shaped (H,L,L) word came back
// ['H','H','H'] under the old rule. The 2-cluster split has no such
// asymmetry -- its boundary is a computed midpoint, not one of the observed
// values -- so it gets both an L-majority and an H-majority word right. -----

{
  // atamadaka-shaped: two of three morae are L. Old rule: population median
  // of [150,150,100,100,100,100] is exactly 100 (the L value) -- every L
  // slot ties it and comes out 'H'. New rule splits on value, not position.
  const trace = [
    { tMs: 0, hz: 150 }, { tMs: 20, hz: 150 },   // slot 0: H
    { tMs: 110, hz: 100 }, { tMs: 130, hz: 100 }, // slot 1: L
    { tMs: 220, hz: 100 }, { tMs: 240, hz: 100 }, // slot 2: L
  ];
  const { pattern, overallMedian } = segmentByMora(trace, 3);
  eq('overallMedian is still the raw population median (pitch-contour.js contract, unchanged)', overallMedian, 100);
  eq('L-majority (atamadaka-shaped) word: L morae no longer misread as H', pattern, ['H', 'L', 'L']);
}

// Symmetric case: an H-majority pattern (two of three morae H).
{
  const trace = [
    { tMs: 0, hz: 150 }, { tMs: 20, hz: 150 },
    { tMs: 110, hz: 150 }, { tMs: 130, hz: 150 },
    { tMs: 220, hz: 100 }, { tMs: 240, hz: 100 },
  ];
  const { pattern, overallMedian } = segmentByMora(trace, 3);
  eq('overallMedian is still the raw population median (pitch-contour.js contract, unchanged)', overallMedian, 150);
  eq('H-majority word: H morae correctly classified', pattern, ['H', 'H', 'L']);
}

// A 1-mora word has only one slot, with nothing to compare it against -- the
// old rule always reported 'H' regardless of the recording (a 1-mora heiban
// target is 'L', so the learner could never be scored correct no matter
// what they said). Correctly 'unclear' now: there's no relative contrast a
// single mora can carry.
{
  const trace = [{ tMs: 0, hz: 120 }, { tMs: 20, hz: 122 }, { tMs: 40, hz: 118 }];
  const { pattern } = segmentByMora(trace, 1);
  eq('1-mora word: no possible internal contrast -> unclear, not a guessed H', pattern, ['unclear']);
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

console.log(`mora-segment-test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
