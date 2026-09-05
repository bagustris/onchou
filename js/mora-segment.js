// mora-segment.js -- pure functions turning a raw pitch trace into a
// per-mora H/L/unclear pattern, plus scoring that pattern against a target.
//
// No DOM, no Web Audio API calls anywhere in this file -- everything here
// is plain data in, plain data out, so it's unit-testable against synthetic
// traces without a browser.
//
// Works in browser (window.MoraSegment) and Node (require, for tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MoraSegment = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function median(values) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
    return sorted[mid];
  }

  // segmentByMora(trace, moraCount) -> { pattern: ['H'|'L'|'unclear', ...] }
  //
  // trace: [{tMs, hz|null}, ...] -- raw pitch-detect output, in time order.
  // moraCount: plain number, supplied by the caller (PitchDiagram.moraSplit
  // owns computing this from a reading string -- this function never
  // computes it itself, and never depends on PitchDiagram).
  //
  // Method (time-proportional, no forced alignment): find the trace's
  // voiced span (first voiced frame's tMs to last voiced frame's tMs),
  // divide that span into moraCount equal-width time slots, take the median
  // Hz of voiced frames whose tMs falls in each slot, then convert each
  // slot's median to H/L by comparing it to the recording's own overall
  // voiced median (not any absolute Hz, not the target pattern -- absolute
  // pitch varies by speaker).
  function segmentByMora(trace, moraCount) {
    if (!moraCount || moraCount < 1) return { pattern: [] };

    var voiced = (trace || []).filter(function (f) { return f && f.hz != null; });

    if (!voiced.length) {
      var pattern = [];
      for (var i = 0; i < moraCount; i++) pattern.push('unclear');
      return { pattern: pattern };
    }

    var spanStart = voiced[0].tMs;
    var spanEnd = voiced[voiced.length - 1].tMs;
    for (var v = 0; v < voiced.length; v++) {
      if (voiced[v].tMs < spanStart) spanStart = voiced[v].tMs;
      if (voiced[v].tMs > spanEnd) spanEnd = voiced[v].tMs;
    }
    var span = spanEnd - spanStart;

    var overallMedian = median(voiced.map(function (f) { return f.hz; }));

    // Bucket voiced frames into moraCount equal-width time slots.
    var slots = [];
    for (var s = 0; s < moraCount; s++) slots.push([]);

    for (var f = 0; f < voiced.length; f++) {
      var frame = voiced[f];
      var slotIndex;
      if (span <= 0) {
        // Degenerate case: all voiced frames at (or effectively at) one
        // instant -- put everything in the first slot rather than divide
        // by zero.
        slotIndex = 0;
      } else {
        var fraction = (frame.tMs - spanStart) / span;
        slotIndex = Math.floor(fraction * moraCount);
        if (slotIndex >= moraCount) slotIndex = moraCount - 1;
        if (slotIndex < 0) slotIndex = 0;
      }
      slots[slotIndex].push(frame.hz);
    }

    var result = slots.map(function (slotHz) {
      if (!slotHz.length) return 'unclear';
      var m = median(slotHz);
      return m >= overallMedian ? 'H' : 'L';
    });

    return { pattern: result };
  }

  // scorePattern(learnerPattern, targetPattern) ->
  //   { matched, unclear, total, perMora: ['match'|'mismatch'|'unclear', ...] }
  //
  // Per-mora: match if both are 'H' or both are 'L'; an 'unclear' learner
  // mora is neither right nor wrong -- its own category, not folded into
  // "mismatch". Compares position-by-position up to the shorter of the two
  // arrays' lengths.
  function scorePattern(learnerPattern, targetPattern) {
    var total = Math.min(
      (learnerPattern || []).length,
      (targetPattern || []).length
    );
    var perMora = [];
    var matched = 0;
    var unclear = 0;

    for (var i = 0; i < total; i++) {
      var learner = learnerPattern[i];
      var target = targetPattern[i];
      if (learner === 'unclear') {
        perMora.push('unclear');
        unclear++;
      } else if (learner === target) {
        perMora.push('match');
        matched++;
      } else {
        perMora.push('mismatch');
      }
    }

    return { matched: matched, unclear: unclear, total: total, perMora: perMora };
  }

  return {
    segmentByMora: segmentByMora,
    scorePattern: scorePattern,
    _median: median, // exposed for testing
  };
});
