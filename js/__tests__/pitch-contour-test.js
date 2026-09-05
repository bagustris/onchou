// Node-builtin test runner for pitch-contour.js's pure builder functions
// (buildLearnerPolyline, buildTargetSteps) -- same plain-assert, no-framework
// style as the rest of js/__tests__/. renderSVG itself (string templating
// over these builders) is intentionally NOT unit-tested here, matching
// pitch-diagram.js's own renderSVG, which this codebase already leaves to
// manual in-browser verification (see that file's test suite).
const assert = require('assert');
const { buildLearnerPolyline, buildTargetSteps } = require('../pitch-contour.js');

let pass = 0, fail = 0;
function eq(desc, got, expected) {
  try {
    assert.deepStrictEqual(got, expected);
    pass++;
  } catch (e) {
    fail++;
    console.error(`FAIL: ${desc} => ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
}

// --- buildLearnerPolyline ------------------------------------------------

eq('all-voiced trace, all at median -> ratio 0, one segment',
  buildLearnerPolyline([{ tMs: 0, hz: 150 }, { tMs: 20, hz: 150 }], 150),
  [[{ t: 0, y: 0 }, { t: 20, y: 0 }]]);

eq('one octave above median clamps to ratio 1 (default clampOctaves=1)',
  buildLearnerPolyline([{ tMs: 0, hz: 300 }], 150),
  [[{ t: 0, y: 1 }]]);

eq('two octaves above median clamps to ratio 1 (default clampOctaves=1)',
  buildLearnerPolyline([{ tMs: 0, hz: 600 }], 150),
  [[{ t: 0, y: 1 }]]);

eq('one octave below median clamps to ratio -1',
  buildLearnerPolyline([{ tMs: 0, hz: 75 }], 150),
  [[{ t: 0, y: -1 }]]);

eq('two octaves above median, clampOctaves=2 -> ratio 2 (no clamp)',
  buildLearnerPolyline([{ tMs: 0, hz: 600 }], 150, { clampOctaves: 2 }),
  [[{ t: 0, y: 2 }]]);

eq('a null-hz frame breaks the line into two segments',
  buildLearnerPolyline(
    [{ tMs: 0, hz: 150 }, { tMs: 20, hz: null }, { tMs: 40, hz: 150 }],
    150),
  [[{ t: 0, y: 0 }], [{ t: 40, y: 0 }]]);

eq('leading/trailing null frames produce no empty segments',
  buildLearnerPolyline(
    [{ tMs: 0, hz: null }, { tMs: 20, hz: 150 }, { tMs: 40, hz: null }],
    150),
  [[{ t: 20, y: 0 }]]);

eq('empty trace -> no segments',
  buildLearnerPolyline([], 150),
  []);

// --- buildTargetSteps -----------------------------------------------------

// 3-mora word (levels array has 4 entries: 3 morae + 1 trailing pseudo-mora,
// which carries no time in the recording and must be excluded).
eq('3-mora word over a 0..300ms span -> 3 equal-width steps, trailing excluded',
  buildTargetSteps(['L', 'H', 'H', 'H'], 0, 300),
  [
    { tStart: 0, tEnd: 100, level: 'L' },
    { tStart: 100, tEnd: 200, level: 'H' },
    { tStart: 200, tEnd: 300, level: 'H' },
  ]);

eq('1-mora word (2-entry levels array) spans the whole recording',
  buildTargetSteps(['H', 'L'], 10, 50),
  [{ tStart: 10, tEnd: 50, level: 'H' }]);

eq('degenerate zero-width span -> zero-width steps at spanStart',
  buildTargetSteps(['L', 'H', 'H'], 5, 5),
  [
    { tStart: 5, tEnd: 5, level: 'L' },
    { tStart: 5, tEnd: 5, level: 'H' },
  ]);

console.log(`pitch-contour: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
