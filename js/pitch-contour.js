// pitch-contour.js -- renders the raw learner F0 trace as a continuous
// line, overlaid with a stylized step-line for the target H/L pattern, so
// the learner sees the actual pitch movement they produced rather than
// only the derived per-mora H/L verdict (js/pitch-diagram.js's existing
// dot-and-line diagram already shows that verdict; this is additive, not a
// replacement).
//
// Two pure, DOM-free builder functions do all the numeric work and are
// unit-tested directly (js/__tests__/pitch-contour-test.js); renderSVG is a
// thin string-templating wrapper over them, left to manual in-browser
// verification -- same split js/pitch-diagram.js already uses between its
// tested pitchLevels/moraSplit and its untested renderSVG.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PitchContour = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // buildLearnerPolyline(trace, overallMedian, opts) -> [[{t, y}, ...], ...]
  //
  // trace: [{tMs, hz|null}, ...] -- raw pitch-detect output, in time order.
  // overallMedian: the recording's own overall voiced median Hz (same value
  // js/mora-segment.js's segmentByMora already computes and now returns),
  // used to convert each frame's Hz to a pitch RELATIVE to this speaker's
  // own recording -- never to absolute Hz or the target pattern, matching
  // the same speaker-independence principle segmentByMora's H/L conversion
  // already relies on.
  //
  // Each frame's y is log2(hz / overallMedian) -- a ratio in octaves, so
  // it's symmetric regardless of the speaker's absolute pitch -- clamped to
  // +/- opts.clampOctaves (default 1) so one stray outlier frame can't blow
  // out the whole graph's vertical scale.
  //
  // A null-hz (unvoiced) frame ends the current segment rather than being
  // plotted at some fabricated y -- the caller renders a gap there, not a
  // false dip through zero. Consecutive null frames (leading, trailing, or
  // mid-recording) never produce an empty segment.
  function buildLearnerPolyline(trace, overallMedian, opts) {
    opts = opts || {};
    var clampOctaves = opts.clampOctaves != null ? opts.clampOctaves : 1;
    var segments = [];
    var current = null;

    (trace || []).forEach(function (frame) {
      if (!frame || frame.hz == null || !overallMedian) {
        current = null;
        return;
      }
      var ratio = Math.log2(frame.hz / overallMedian);
      if (ratio > clampOctaves) ratio = clampOctaves;
      if (ratio < -clampOctaves) ratio = -clampOctaves;
      if (!current) {
        current = [];
        segments.push(current);
      }
      current.push({ t: frame.tMs, y: ratio });
    });

    return segments;
  }

  // buildTargetSteps(targetLevels, spanStart, spanEnd) -> [{tStart, tEnd, level}, ...]
  //
  // targetLevels: full pitchLevels() output (one 'H'/'L' per mora PLUS one
  // trailing pseudo-mora). The trailing entry is excluded here -- it
  // represents pitch on whatever follows the word, not a moment that
  // actually happened during this recording, so it has no time span to
  // occupy on this graph.
  //
  // spanStart/spanEnd: the same voiced-frame time span js/mora-segment.js's
  // segmentByMora already computes and now returns, divided into
  // equal-width slots identically to segmentByMora's own time-proportional
  // division -- so this step-line's mora boundaries land exactly on the
  // slots that were actually scored, not an independently-guessed timing.
  function buildTargetSteps(targetLevels, spanStart, spanEnd) {
    var wordLevels = (targetLevels || []).slice(0, -1);
    var moraCount = wordLevels.length;
    if (moraCount < 1) return [];

    var span = spanEnd - spanStart;
    var sliceWidth = span > 0 ? span / moraCount : 0;

    return wordLevels.map(function (level, i) {
      return {
        tStart: spanStart + i * sliceWidth,
        tEnd: spanStart + (i + 1) * sliceWidth,
        level: level,
      };
    });
  }

  // renderSVG(trace, targetLevels, segment, opts) -> SVG markup string
  //
  // segment: the {spanStart, spanEnd, overallMedian} MoraSegment.segmentByMora
  // already returns for this same trace -- callers pass it straight through
  // rather than recomputing it, so the target step-line and the learner
  // line are guaranteed to agree on the same span/median a caller already
  // used for scoring.
  //
  // Thin string-templating over the two pure builders above -- left to
  // manual in-browser verification rather than unit-tested, matching
  // js/pitch-diagram.js's own renderSVG (its pure pitchLevels/moraSplit are
  // unit-tested; its renderSVG is not).
  function renderSVG(trace, targetLevels, segment, opts) {
    opts = opts || {};
    segment = segment || {};
    if (segment.spanStart == null || segment.spanEnd == null || !segment.overallMedian) return '';

    var width = opts.width || 240;
    var height = opts.height || 48;
    var midY = height / 2;
    var halfHeight = midY - 4;
    var span = segment.spanEnd - segment.spanStart;

    function xAt(tMs) {
      if (span <= 0) return width / 2;
      return ((tMs - segment.spanStart) / span) * width;
    }
    // Ratio > 0 means higher pitch than the recording's own median (H-ish),
    // so it maps to a SMALLER y (higher on screen) -- same up-is-H
    // convention js/pitch-diagram.js's topY/bottomY already use.
    function yAtRatio(ratio) {
      return midY - ratio * halfHeight;
    }
    function yAtLevel(level) {
      return level === 'H' ? midY - halfHeight : midY + halfHeight;
    }

    var learnerSegments = buildLearnerPolyline(trace, segment.overallMedian, opts);
    var learnerPath = learnerSegments.map(function (seg) {
      return seg.map(function (pt, i) {
        return (i === 0 ? 'M' : 'L') + xAt(pt.t) + ',' + yAtRatio(pt.y);
      }).join(' ');
    }).join(' ');

    var steps = buildTargetSteps(targetLevels, segment.spanStart, segment.spanEnd);
    var targetPath = steps.map(function (step, i) {
      var y = yAtLevel(step.level);
      var startCmd = (i === 0 ? 'M' : 'L') + xAt(step.tStart) + ',' + y;
      var endCmd = 'L' + xAt(step.tEnd) + ',' + y;
      return startCmd + ' ' + endCmd;
    }).join(' ');

    return '<svg class="contour-plot" width="' + width + '" height="' + height +
      '" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Pitch curve">' +
      '<path d="' + targetPath + '" class="contour-line-target" fill="none" />' +
      '<path d="' + learnerPath + '" class="contour-line-learner" fill="none" />' +
      '</svg>';
  }

  return {
    buildLearnerPolyline: buildLearnerPolyline,
    buildTargetSteps: buildTargetSteps,
    renderSVG: renderSVG,
  };
});
