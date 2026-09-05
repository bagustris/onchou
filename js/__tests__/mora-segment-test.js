const assert = require('assert');
const { segmentByMora, scorePattern } = require('../mora-segment.js');

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

console.log(`mora-segment-test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
