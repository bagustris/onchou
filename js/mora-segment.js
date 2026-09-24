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

  function sum(values) {
    var s = 0;
    for (var i = 0; i < values.length; i++) s += values[i];
    return s;
  }

  // Sum of squared deviations from the mean -- the within-group spread a
  // 2-means/Otsu-style split tries to minimize.
  function withinGroupSS(values) {
    if (!values.length) return 0;
    var mean = sum(values) / values.length;
    var ss = 0;
    for (var i = 0; i < values.length; i++) { var d = values[i] - mean; ss += d * d; }
    return ss;
  }

  // classifyLevels(slotMedians) -> ['H'|'L'|'unclear', ...], same length and
  // order as slotMedians (a slot median of null -- no voiced frames in that
  // slot -- always stays 'unclear').
  //
  // A pitch-accent word's morae are, by construction, EITHER all one level
  // (only possible for a 1-mora word) OR a genuine two-class mix of H and L
  // -- so this treats the slot medians as a 1D two-cluster problem: sort
  // them (in log2 Hz, so an octave-scale difference is weighted the same
  // regardless of absolute pitch), try every possible split point, and keep
  // whichever split minimizes the total within-group sum-of-squared
  // deviations (equivalent to 1D 2-means / Otsu thresholding). Slots below
  // the split are L, at/above it are H.
  //
  // This replaces an earlier "each slot vs. the recording's OWN overall
  // median" rule, which is structurally unable to avoid exact ties: with a
  // plurality class (e.g. atamadaka's H,L,L -- two of three morae are L),
  // the population median lands exactly ON that class's own value, so its
  // slots tie the very threshold they're being compared to. No tie-breaking
  // direction (or routing ties to 'unclear') fixes that without instead
  // breaking whichever OTHER pattern makes the opposite class the majority
  // (e.g. heiban, this app's single largest accent class, is H-majority).
  // A 2-cluster split has no such asymmetry: its boundary is a computed
  // midpoint between the two nearest clusters, not one of the observed
  // values, so by construction it can't coincide with either class's own
  // value unless there's no contrast to find in the first place.
  //
  // If fewer than 2 distinct voiced-slot values are present at all --
  // including every 1-mora word, which has only one slot to begin with --
  // there's no basis for a relative H/L judgement, so every present slot
  // stays 'unclear' rather than guessing (this is a real, if small, change
  // in behavior: a 1-mora word previously always reported 'H', which for a
  // 1-mora heiban target -- 'L' -- meant the learner could never be scored
  // as correct no matter what they said).
  //
  // MIN_SPLIT_CENTS guards against the OPPOSITE failure: unlike a
  // population-median threshold, a 2-cluster split always finds SOME
  // division of the data into two groups, even when the recording has no
  // real H/L contrast at all (a flat/monotone attempt, or a mic picking up
  // only noise) -- there's always a "best" split, however small the gap it
  // separates. Without this guard, a 2-mora word is the worst case: with
  // only two slots, the split can only ever come out LH or HL, and every
  // 2-mora accent target IS one of exactly those two shapes -- so a flat,
  // no-accent attempt isn't a rare fluke away from an exact match, it's a
  // coin flip.
  //
  // 100 was picked from tools/pitch-accuracy-experiment.js's Stage 4/5:
  // Stage 5 scores a flat/no-contrast synthetic trace against every real
  // target shape (2/3/4 morae, the SAME per-mora + per-frame jitter model
  // Stage 4 uses for genuine contrasts, so this isn't measured against an
  // easier noise floor than the real numbers below). At 100 cents, that
  // false-"exact match" rate is 0.0% at every mora count tested (down from
  // 3-52% under the old rule) for a trace with NO declination -- i.e. truly
  // just noise. Stage 4 confirms a wide synthetic H/L gap (700+ cents, this
  // app's own test parameter -- NOT a measurement of what real learners
  // produce) is untouched, and a 3.2-semitone-scale gap (H/L ratio 1.2) and
  // above stays untouched too, even under added declination.
  //
  // Two disclosed trade-offs, not resolved by this threshold (or by any
  // choice of it -- both are inherent to classifying from per-mora medians
  // alone, with no forced alignment): (1) a small H/L gap (ratio 1.05, ~84
  // cents) is now scored WORSE than under the old rule, because a gap that
  // small barely clears the noise floor even in a perfect, noiseless
  // signal -- 'unclear' is arguably the more honest answer there anyway.
  // (2) Stage 5 with declination added surfaces a separate, pre-existing
  // ambiguity: a genuinely DECLINING trend (not noise -- a real, monotonic
  // drop across the recording) looks a lot like atamadaka's H-then-
  // sustained-L shape to any per-mora-median method. Under heavy (-10%)
  // declination specifically scored against an atamadaka target, the new
  // rule's false-positive rate is measurably HIGHER than the old rule's at
  // 3-4 morae (though still much lower at 2 morae, and lower than the old
  // rule for every OTHER target shape at the same declination) -- this is
  // not eliminated by raising or lowering MIN_SPLIT_CENTS, since declination
  // is a genuine trend, not noise a stricter threshold can filter out.
  //
  // Tuned entirely against synthetic audio; would benefit from
  // recalibration against real recorded takes.
  var MIN_SPLIT_CENTS = 100;

  function classifyLevels(slotMedians) {
    var labels = [];
    var present = [];
    for (var i = 0; i < slotMedians.length; i++) {
      labels.push('unclear');
      if (slotMedians[i] != null) present.push({ i: i, logHz: Math.log2(slotMedians[i]) });
    }
    if (present.length < 2) return labels;

    var distinctCount = 1;
    var sortedPresent = present.slice().sort(function (a, b) { return a.logHz - b.logHz; });
    for (var d = 1; d < sortedPresent.length; d++) {
      if (sortedPresent[d].logHz !== sortedPresent[d - 1].logHz) distinctCount++;
    }
    if (distinctCount < 2) return labels; // every present slot is the same value -- no contrast

    var bestSplit = -1;
    var bestCost = Infinity;
    for (var k = 1; k < sortedPresent.length; k++) {
      if (sortedPresent[k - 1].logHz === sortedPresent[k].logHz) continue; // not a real split point
      var low = [];
      var high = [];
      for (var li = 0; li < k; li++) low.push(sortedPresent[li].logHz);
      for (var hi = k; hi < sortedPresent.length; hi++) high.push(sortedPresent[hi].logHz);
      var cost = withinGroupSS(low) + withinGroupSS(high);
      if (cost < bestCost) { bestCost = cost; bestSplit = k; }
    }

    var lowGroup = sortedPresent.slice(0, bestSplit);
    var highGroup = sortedPresent.slice(bestSplit);
    var meanLow = sum(lowGroup.map(function (p) { return p.logHz; })) / lowGroup.length;
    var meanHigh = sum(highGroup.map(function (p) { return p.logHz; })) / highGroup.length;
    var gapCents = 1200 * (meanHigh - meanLow);
    if (gapCents < MIN_SPLIT_CENTS) return labels; // best split found is too weak to trust -- stays all-unclear

    for (var idx = 0; idx < sortedPresent.length; idx++) {
      labels[sortedPresent[idx].i] = idx < bestSplit ? 'L' : 'H';
    }
    return labels;
  }

  // segmentByMora(trace, moraCount) -> {
  //   pattern: ['H'|'L'|'unclear', ...],
  //   spanStart, spanEnd: the voiced span's tMs bounds (both null if no
  //     voiced frames at all) -- exposed so js/pitch-contour.js's target
  //     step-line can divide the SAME span into the SAME per-mora slots
  //     this function actually scored against, rather than guessing an
  //     independent timing.
  //   overallMedian: the voiced-frame median Hz (null if no voiced frames).
  //     NOT used to decide H/L below (see classifyLevels()) -- exposed
  //     purely so js/pitch-contour.js can normalize the learner's raw trace
  //     to a stable, speaker-independent reference point for its contour
  //     rendering.
  // }
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
  // slot's median to H/L relative to the OTHER slots in the same word (not
  // any absolute Hz, not the target pattern -- absolute pitch varies by
  // speaker) via classifyLevels() below -- not by comparing each slot to a
  // single population-wide threshold; see that function for why.
  function segmentByMora(trace, moraCount) {
    if (!moraCount || moraCount < 1) return { pattern: [] };

    var voiced = (trace || []).filter(function (f) { return f && f.hz != null; });

    if (!voiced.length) {
      var pattern = [];
      for (var i = 0; i < moraCount; i++) pattern.push('unclear');
      return { pattern: pattern, spanStart: null, spanEnd: null, overallMedian: null };
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

    var slotMedians = slots.map(function (slotHz) { return slotHz.length ? median(slotHz) : null; });
    var result = classifyLevels(slotMedians);

    return { pattern: result, spanStart: spanStart, spanEnd: spanEnd, overallMedian: overallMedian };
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
    _classifyLevels: classifyLevels, // exposed for testing
  };
});
