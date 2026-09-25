// mora-segment.js -- pure functions turning a raw pitch trace into a
// per-mora H/L/unclear pattern, plus scoring that pattern against a target.
//
// No DOM, no Web Audio API calls anywhere in this file -- everything here
// is plain data in, plain data out, so it's unit-testable against synthetic
// traces without a browser.
//
// Works in browser (window.MoraSegment) and Node (require, for tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var model = null;
    try { model = require('./accent-model.js'); } catch (e) { model = null; }
    module.exports = factory(model);
  } else root.MoraSegment = factory(root.AccentModel || null);
})(typeof self !== 'undefined' ? self : this, function (ACCENT_MODEL) {
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

  // ---- accent-pattern decoding (replaced classifyLevels in segmentByMora
  // on 2026-09-25 -- see
  // docs/superpowers/specs/2026-09-25-onchou-jsut-real-audio-eval-design.md,
  // "Literature-derived improvements", for the real-audio evidence) -------
  //
  // Evaluated on real JSUT speech with jsut-label's manual accent labels,
  // classifyLevels' independent per-mora 2-cluster split turned out to
  // carry essentially no accent information (within-mora-count Cohen's
  // kappa 0.004 on continuous phrases, -0.04 on words with real silence
  // around them) -- its per-mora accuracy came from the corpus's skewed
  // pattern distribution, and it scored below a no-audio constant guess.
  // Three changes, each from the pitch-accent literature and each measured
  // on held-out sentences, replace it here:
  //
  // 1. Relative voice gate (VOICE_GATE_DB): frames more than 15dB below the
  //    take's loudest frame are treated as unvoiced. estimatePitch reports
  //    random 70-400Hz values on near-silence (-25..-58dB re the loudest
  //    frame on real recordings), and one such frame in the silence around
  //    a word stretches the voiced span every mora slot is cut from.
  // 2. Peak-delay compensation (PEAK_DELAY_MS): each slot window is read
  //    20ms late. The accentual F0 peak/fall is realized at the end of the
  //    accented mora or in the next one, and the phrase-initial rise eats
  //    into mora 1 -- measured even against real forced-aligned mora
  //    boundaries. Cf. Ishi, Minematsu & Hirose (2001), whose best mora-F0
  //    representations measure late in the mora ("target" value / VC
  //    unit). The right amount depends on speaking STYLE, not rate:
  //    connected read speech (JSUT) wants ~80-100ms, but isolated words
  //    from 33 native speakers (UME-JRF -- onchou's actual input) want
  //    ~20ms at the SAME per-mora rate (tools/paper-exp-delay*.js). 20ms is
  //    the isolated-word optimum (chosen on half the speakers), and also
  //    keeps clean synthetic zero-delay words -- glides included -- at 100%.
  // 3. Constrained decoding with a joint declination term
  //    (decodeAccentPattern): only the n+1 valid Tokyo accent patterns are
  //    allowed, as in every accent-type identifier in the Minematsu/Hirose
  //    line of work, and each is fit as v_i = a + b*i + c*T_i (c >= 0, b in
  //    [-MAX_DECLINATION_CENTS, 0]) with the lowest-residual pattern
  //    winning. Fitting declination JOINTLY with the accent step (the
  //    Fujisaki-model idea of separate phrase and accent components) is
  //    what makes this work where fitting a trend first and classifying the
  //    residuals did not -- a trend fit alone soaks up part of the step.
  //
  // Held-out result (sentences 4001-5000, never seen by tuning), words with
  // real surrounding silence: see the design doc's "Round 3" table.
  //
  // MIN_SPLIT_CENTS keeps its old job, now applied to the fitted accent
  // step c: below 100 cents the take is reported all-'unclear' rather than
  // forced onto the nearest pattern, so a flat/monotone attempt still isn't
  // scored as correct (re-checked on synthetic flat traces: false exact
  // matches stay at or below the old rule's rate).
  var VOICE_GATE_DB = 15;
  var PEAK_DELAY_MS = 20;
  // How one value per mora slot is taken: 'median' (shipped), or -- for the
  // perceptual-cue experiments (tools/paper-exp-cues.js) -- 'late' (median
  // of the slot's second half) or 'target' (least-squares line through the
  // slot's frames, evaluated at its end; Ishi, Minematsu & Hirose 2001).
  var MORA_VALUE = 'median';
  var MAX_DECLINATION_CENTS = 75; // per mora
  var TREND_MIN_MORAE = 2; // fit the slope only for words with at least this many morae
  var MAX_DECLINATION_CENTS_2MORA = 50; // per mora, 2-mora words (see decodeAccentPattern)
  // Separate evidence thresholds for the two kinds of claim the decoder
  // makes. The accent itself is the FALL (heiban = no fall), so:
  //   - MIN_SPLIT_CENTS guards a claimed fall (atamadaka/nakadaka);
  //   - MIN_RISE_CENTS guards the no-fall (heiban/odaka) shape, whose only
  //     contrast is the phrase-initial rise -- EXCEPT when the word's first
  //     syllable is heavy (heavyInitial below), where Tokyo speakers barely
  //     rise at all (MIN_RISE_HEAVY_CENTS = 0);
  //   - FALLBACK_TO_NO_FALL: a fall claim too weak to trust resolves to "no
  //     fall" when the no-fall shape itself qualifies, instead of
  //     all-'unclear'.
  // Found on UME-JRF's isolated words (33 native Tokyo speakers): a third of
  // native morae came back 'unclear', nearly all heavy-initial heiban words
  // (禁煙 31/33 speakers, 病院 30/33, 歓迎 30/33) said close to flat. Chosen
  // on JSUT's training split + half the native speakers; on the other half
  // kappa 0.270 -> 0.317 and 'unclear' 33% -> 13%. The flat-attempt guard is
  // unchanged everywhere except heavy-initial heiban words (synthetic flat
  // takes scored correct: light-initial heiban 0.3%, accented 1.0%, as
  // before; heavy-initial heiban 0.3% -> 98.6%, by design -- that IS how
  // natives say them). See the eval design doc's "Round 4".
  var MIN_RISE_CENTS = 100;
  var MIN_RISE_HEAVY_CENTS = 0;
  var FALLBACK_TO_NO_FALL = true;

  // Every valid Tokyo pattern over n slots as 0/1 arrays (1 = H): no drop
  // inside the slots (heiban/odaka, L,H,...,H), atamadaka (H,L,...,L), and a
  // drop after slot d for 2 <= d <= n-1. The same set covers particle mode
  // (word + が = n slots) unchanged.
  function validPatterns(n) {
    var out = [];
    if (n < 2) return out;
    var flat = [0], head = [1], i, d;
    for (i = 1; i < n; i++) { flat.push(1); head.push(0); }
    out.push(flat, head);
    for (d = 2; d <= n - 1; d++) {
      var t = [0];
      for (i = 1; i < n; i++) t.push(i < d ? 1 : 0);
      out.push(t);
    }
    return out;
  }

  // Least squares on a few regressor columns via normal equations; returns
  // {coef, sse} or null if singular.
  function lstsq(cols, y) {
    var k = cols.length, n = y.length, i, j, r, c;
    var A = [], rhs = [];
    for (i = 0; i < k; i++) { A.push([]); rhs.push(0); for (j = 0; j < k; j++) A[i].push(0); }
    for (r = 0; r < n; r++) {
      for (i = 0; i < k; i++) {
        rhs[i] += cols[i][r] * y[r];
        for (j = 0; j < k; j++) A[i][j] += cols[i][r] * cols[j][r];
      }
    }
    for (c = 0; c < k; c++) {
      var p = c;
      for (r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      var tmp = A[c]; A[c] = A[p]; A[p] = tmp;
      tmp = rhs[c]; rhs[c] = rhs[p]; rhs[p] = tmp;
      for (r = 0; r < k; r++) {
        if (r === c) continue;
        var fct = A[r][c] / A[c][c];
        for (j = c; j < k; j++) A[r][j] -= fct * A[c][j];
        rhs[r] -= fct * rhs[c];
      }
    }
    var coef = rhs.map(function (x, idx) { return x / A[idx][idx]; });
    var sse = 0;
    for (r = 0; r < n; r++) {
      var pred = 0;
      for (i = 0; i < k; i++) pred += coef[i] * cols[i][r];
      sse += (y[r] - pred) * (y[r] - pred);
    }
    return { coef: coef, sse: sse };
  }

  // Fit y = a + b*x + c*t with c >= 0 and bMin <= b <= 0, checking the few
  // active-set combinations (unconstrained, b clamped, c clamped, both).
  function fitWithDeclination(y, x, t, bMin) {
    var ones = y.map(function () { return 1; });
    var best = null;
    function tryFit(fixB, fixC) {
      var cols = [ones], yAdj = y.slice(), r;
      if (fixB == null) cols.push(x);
      if (fixC == null) cols.push(t);
      for (r = 0; r < y.length; r++) {
        if (fixB != null) yAdj[r] -= fixB * x[r];
        if (fixC != null) yAdj[r] -= fixC * t[r];
      }
      var res = lstsq(cols, yAdj);
      if (!res) return;
      var idx = 1;
      var b = fixB != null ? fixB : res.coef[idx++];
      var c = fixC != null ? fixC : res.coef[idx++];
      if (c < -1e-12 || b < bMin - 1e-12 || b > 1e-12) return;
      if (!best || res.sse < best.sse) best = { b: b, c: c, sse: res.sse };
    }
    tryFit(null, null); tryFit(bMin, null); tryFit(0, null);
    tryFit(null, 0); tryFit(bMin, 0); tryFit(0, 0);
    return best;
  }

  // decodeAccentPattern(slotMedians) -> ['H'|'L'|'unclear', ...]. Slots with
  // no voiced frames (null) stay 'unclear' even though the winning pattern
  // implies a level for them -- the app reports "no data" honestly rather
  // than filling it in.
  // heavyInitial(morae) -> true when the word's first syllable is heavy and
  // sonorant: mora 2 is ん or ー, or a vowel that lengthens /
  // diphthongizes mora 1 (びょう, かい, せい, おう...). In Tokyo Japanese the
  // phrase-initial low on mora 1 is weak or absent then (きんえん is said
  // close to H,H,H,H), so a missing initial rise is native-like, not an
  // error. morae: kana strings, e.g. PitchDiagram.moraSplit(reading).
  // Sonorant heavy syllables only: a geminate (CVQ, っ) does NOT weaken the
  // initial low (Youngberg 2021, Glossa 6(1):63; J_ToBI's %wL requires a
  // "heavy and sonorant" syllable, Venditti 1995/2005; Haraguchi 1999 p. 7).
  var SPECIAL_MORAE = { 'ん': 1, 'ン': 1, 'ー': 1 };
  var VOWEL_ROW = {}; // kana -> its vowel, for the lengthening check
  (function () {
    var rows = { a: 'あかさたなはまやらわがざだばぱぁゃアカサタナハマヤラワガザダバパァャ',
      i: 'いきしちにひみりぎじぢびぴぃイキシチニヒミリギジヂビピィ',
      u: 'うくすつぬふむゆるぐずづぶぷぅゅウクスツヌフムユルグズヅブプゥュ',
      e: 'えけせてねへめれげぜでべぺぇエケセテネヘメレゲゼデベペェ',
      o: 'おこそとのほもよろをごぞどぼぽぉょオコソトノホモヨロヲゴゾドボポォョ' };
    for (var v in rows) for (var j = 0; j < rows[v].length; j++) VOWEL_ROW[rows[v][j]] = v;
  })();
  function heavyInitial(morae) {
    if (!morae || morae.length < 2) return false;
    var m2 = morae[1];
    if (SPECIAL_MORAE[m2]) return true;
    var v1 = VOWEL_ROW[morae[0].charAt(morae[0].length - 1)]; // yōon: vowel of the small kana
    if (m2 === 'う' || m2 === 'ウ') return v1 === 'o' || v1 === 'u';
    if (m2 === 'い' || m2 === 'イ') return !!v1; // long ii / diphthong ai, ei, oi, ui
    if (m2 === 'あ' || m2 === 'ア') return v1 === 'a';
    if (m2 === 'え' || m2 === 'エ') return v1 === 'e';
    if (m2 === 'お' || m2 === 'オ') return v1 === 'o';
    return false;
  }

  function decodeAccentPattern(slotMedians, opts) {
    opts = opts || {};
    var n = slotMedians.length;
    var labels = [], idx = [], i;
    for (i = 0; i < n; i++) { labels.push('unclear'); if (slotMedians[i] != null) idx.push(i); }
    if (n < 2 || idx.length < 2) return labels;
    var y = idx.map(function (k) { return Math.log2(slotMedians[k]); });
    var x = idx.slice();
    // A declination slope and an accent step are only weakly separable in
    // short words: with two morae both explain the same single difference,
    // and a negative slope INFLATES a fitted rise (rise = raw difference +
    // |slope|), so a wide bound lets flat 2-mora takes with ordinary jitter
    // pass as heiban. Hence a tighter bound for 2-mora words; below
    // TREND_MIN_MORAE the slope is fixed at 0.
    var bound = n === 2 ? MAX_DECLINATION_CENTS_2MORA : MAX_DECLINATION_CENTS;
    var bMin = n >= TREND_MIN_MORAE ? -bound / 1200 : 0;
    var patterns = validPatterns(n), best = null, noFall = null;
    for (var p = 0; p < patterns.length; p++) {
      var t = idx.map(function (k) { return patterns[p][k]; });
      var constant = true;
      for (i = 1; i < t.length; i++) if (t[i] !== t[0]) { constant = false; break; }
      if (constant) continue; // indistinguishable from "no contrast" on the present slots
      var fit = fitWithDeclination(y, x, t, bMin);
      if (!fit) continue;
      var cand = { t: patterns[p], c: fit.c, sse: fit.sse, isNoFall: p === 0 };
      if (p === 0) noFall = cand; // validPatterns() always lists the no-fall shape first
      if (!best || fit.sse < best.sse - 1e-15) best = cand;
    }
    if (!best) return labels;
    var winner = best;
    // opts.minSplitCents / opts.minRiseCents override the module constants
    // (research tools only -- e.g. per-speaker calibration experiments).
    var minSplit = opts.minSplitCents != null ? opts.minSplitCents : MIN_SPLIT_CENTS;
    var minRise = opts.heavyInitial ? MIN_RISE_HEAVY_CENTS : (opts.minRiseCents != null ? opts.minRiseCents : MIN_RISE_CENTS);
    var need = winner.isNoFall ? minRise : minSplit;
    if (1200 * winner.c < need) {
      // The best pattern's own contrast is too weak to trust. If it claimed
      // a FALL, the honest reading may still be "no fall here" -- the
      // no-fall shape, provided its own rise clears MIN_RISE_CENTS.
      if (FALLBACK_TO_NO_FALL && !winner.isNoFall && noFall && 1200 * noFall.c >= minRise) winner = noFall;
      else return labels;
    }
    for (i = 0; i < idx.length; i++) labels[idx[i]] = winner.t[idx[i]] ? 'H' : 'L';
    return labels;
  }

  // Frames more than VOICE_GATE_DB below the take's loudest frame -> hz null.
  // Uses each frame's `rms` (js/pitch-detect.js records it); traces without
  // energy (older callers, synthetic test traces) pass through unchanged.
  // `energy` is accepted too, for the real-audio evaluation tools' traces.
  function gateQuietFrames(trace) {
    var maxE = 0, i, e;
    for (i = 0; i < trace.length; i++) {
      e = trace[i] ? (trace[i].rms != null ? trace[i].rms : trace[i].energy) : null;
      if (e != null && e > maxE) maxE = e;
    }
    if (maxE <= 0) return trace;
    var floor = maxE * Math.pow(10, -VOICE_GATE_DB / 20);
    return trace.map(function (f) {
      if (!f || f.hz == null) return f;
      var fe = f.rms != null ? f.rms : f.energy;
      return fe != null && fe < floor ? { tMs: f.tMs, hz: null, rms: fe } : f;
    });
  }

  // segmentByMora(trace, moraCount) -> {
  //   pattern: ['H'|'L'|'unclear', ...],
  //   spanStart, spanEnd: the voiced span's tMs bounds, after voice gating
  //     (both null if no voiced frames at all).
  //   slots: [[startMs, endMs], ...] -- the exact window each mora was read
  //     from (delayed by PEAK_DELAY_MS, the last one ending at spanEnd), so
  //     js/pitch-contour.js's target step-line can sit on the SAME slots
  //     this function actually scored rather than re-deriving them.
  //   overallMedian: the voiced-frame median Hz (null if no voiced frames).
  //     NOT used to decide H/L -- exposed purely so js/pitch-contour.js can
  //     normalize the learner's raw trace for its contour rendering.
  // }
  //
  // trace: [{tMs, hz|null, rms?}, ...] -- raw pitch-detect output, in time
  // order. moraCount: plain number, supplied by the caller (PitchDiagram
  // .moraSplit owns computing this from a reading string -- this function
  // never computes it itself, and never depends on PitchDiagram).
  // opts.morae (optional): the word's morae as kana strings, used only to
  // tell whether its first syllable is heavy (see heavyInitial); omitting it
  // keeps the stricter light-syllable rule.
  //
  // Method (time-proportional, no forced alignment -- a real aligner needs
  // an acoustic model, which onchou deliberately doesn't ship): gate quiet
  // frames, find the voiced span, cut it into moraCount equal slots read
  // PEAK_DELAY_MS late, take each slot's median Hz, and decode the H/L
  // pattern with decodeAccentPattern (see the block comment above for all
  // three steps and their evidence).
  // One value (Hz) per slot, per MORA_VALUE; null for an empty slot.
  function slotValue(hz, t, bounds) {
    if (!hz.length) return null;
    if (MORA_VALUE === 'late') {
      var mid = (bounds[0] + bounds[1]) / 2, late = [];
      for (var i = 0; i < hz.length; i++) if (t[i] >= mid) late.push(hz[i]);
      return median(late.length ? late : hz);
    }
    if (MORA_VALUE === 'target' && hz.length >= 3) {
      var n = hz.length, mx = 0, my = 0, lo = Infinity, hi = -Infinity, j;
      var y = hz.map(function (h) { return Math.log2(h); });
      for (j = 0; j < n; j++) { mx += t[j]; my += y[j]; if (y[j] < lo) lo = y[j]; if (y[j] > hi) hi = y[j]; }
      mx /= n; my /= n;
      var sxy = 0, sxx = 0;
      for (j = 0; j < n; j++) { sxy += (t[j] - mx) * (y[j] - my); sxx += (t[j] - mx) * (t[j] - mx); }
      var v = my + (sxx > 0 ? sxy / sxx : 0) * (bounds[1] - mx);
      return Math.pow(2, Math.min(hi, Math.max(lo, v))); // clamp to the slot's own range
    }
    return median(hz);
  }

  // computeSlots(trace, moraCount) -> {slotMedians, spanStart, spanEnd,
  // slots, overallMedian} | null (no voiced frames). The front half of
  // segmentByMora (voice gate -> voiced span -> equal slots read
  // PEAK_DELAY_MS late -> per-slot median Hz), split out so research tools
  // can try alternative decoders on EXACTLY the production slot values.
  function computeSlots(trace, moraCount) {
    var gated = gateQuietFrames(trace || []);
    var voiced = gated.filter(function (f) { return f && f.hz != null; });
    if (!voiced.length) return null;

    var spanStart = voiced[0].tMs;
    var spanEnd = voiced[voiced.length - 1].tMs;
    for (var v = 0; v < voiced.length; v++) {
      if (voiced[v].tMs < spanStart) spanStart = voiced[v].tMs;
      if (voiced[v].tMs > spanEnd) spanEnd = voiced[v].tMs;
    }
    var span = spanEnd - spanStart;
    var width = span / moraCount;
    // Never delay by more than half a slot: on an implausibly short span
    // the fixed delay would otherwise push most frames out of every slot.
    var delay = Math.min(PEAK_DELAY_MS, width / 2);

    var overallMedian = median(voiced.map(function (f) { return f.hz; }));

    var slotHz = [], slotT = [], slotBounds = [];
    for (var s = 0; s < moraCount; s++) {
      slotHz.push([]); slotT.push([]);
      slotBounds.push([spanStart + delay + s * width, s === moraCount - 1 ? spanEnd : spanStart + delay + (s + 1) * width]);
    }

    for (var f = 0; f < voiced.length; f++) {
      var frame = voiced[f];
      var slotIndex;
      if (span <= 0) {
        // Degenerate case: all voiced frames at (or effectively at) one
        // instant -- put everything in the first slot rather than divide
        // by zero.
        slotIndex = 0;
      } else {
        var pos = ((frame.tMs - spanStart - delay) / span) * moraCount;
        if (pos < 0) continue; // before the first (delayed) window
        slotIndex = Math.floor(pos);
        if (slotIndex >= moraCount) slotIndex = moraCount - 1;
      }
      slotHz[slotIndex].push(frame.hz);
      slotT[slotIndex].push(frame.tMs);
    }

    return {
      slotMedians: slotHz.map(function (hz, k) { return slotValue(hz, slotT[k], slotBounds[k]); }),
      spanStart: spanStart, spanEnd: spanEnd, slots: slotBounds, overallMedian: overallMedian,
    };
  }

  // ---- learned pattern choice (js/accent-model.js) ---------------------
  //
  // The model-free decoder above decides WHETHER a take carries a
  // trustworthy accent contrast (its evidence guard, incl. the heavy-
  // syllable rule, so flat attempts stay all-'unclear'). WHICH valid
  // pattern it is is then chosen by a small learned table: one diagonal
  // Gaussian over the F0-ratio vector (cents step between adjacent mora
  // slots; Ishi, Minematsu & Hirose 2001) per (mora count, pattern),
  // maximum likelihood with equal class priors (it can't favour a pattern
  // just because it's common). 838 numbers, trained on one JSUT speaker's
  // read speech (tools/build-accent-model.js). Held-out, this guarded
  // hybrid matches the model-free decoder on 16 unseen native speakers'
  // isolated words (kappa 0.349 both) and beats it on connected speech
  // (0.242 -> 0.374), with flat attempts still rejected -- see
  // docs/paper/2026-09-25-interspeech-plan.md.
  //
  // OPT-IN ONLY (opts.useModel === true), and the app does not load it: the
  // table was learned from connected read speech, where accentual F0 events
  // arrive about a mora late, so it EXPECTS that lag -- a clean, on-time
  // step (exactly what the target diagram shows a learner) is misread by one
  // mora. tools/synthetic-regression.js: clean isolated words fall from
  // ~100% to 45-55% exact-match with it on. Kept for research and for a
  // future model trained on isolated, on-time productions.
  function learnedPattern(slotMedians) {
    if (!ACCENT_MODEL || !ACCENT_MODEL.models) return null;
    var classes = ACCENT_MODEL.models[slotMedians.length];
    if (!classes) return null;
    // Features: interpolate interior gaps, copy edge gaps, cents steps.
    var n = slotMedians.length, idx = [], i;
    for (i = 0; i < n; i++) if (slotMedians[i] != null) idx.push(i);
    if (idx.length < 2) return null;
    var w = slotMedians.slice();
    for (i = 0; i < n; i++) {
      if (w[i] != null) continue;
      var l = i - 1; while (l >= 0 && slotMedians[l] == null) l--;
      var r = i + 1; while (r < n && slotMedians[r] == null) r++;
      w[i] = l < 0 ? slotMedians[r] : r >= n ? slotMedians[l] : slotMedians[l] + ((slotMedians[r] - slotMedians[l]) * (i - l)) / (r - l);
    }
    var x = [];
    for (i = 1; i < n; i++) x.push(1200 * Math.log2(w[i] / w[i - 1]));
    var best = null, bestLL = -Infinity;
    for (var pat in classes) {
      var g = classes[pat], ll = 0;
      for (i = 0; i < x.length; i++) ll += -0.5 * Math.log(g.v[i]) - ((x[i] - g.mu[i]) * (x[i] - g.mu[i])) / (2 * g.v[i]);
      if (ll > bestLL) { bestLL = ll; best = pat; }
    }
    return best ? best.split('') : null;
  }

  function segmentByMora(trace, moraCount, opts) {
    opts = opts || {};
    if (!moraCount || moraCount < 1) return { pattern: [] };

    var c = computeSlots(trace, moraCount);
    if (!c) {
      var pattern = [];
      for (var i = 0; i < moraCount; i++) pattern.push('unclear');
      return { pattern: pattern, spanStart: null, spanEnd: null, slots: null, overallMedian: null };
    }
    var result = decodeAccentPattern(c.slotMedians, { heavyInitial: heavyInitial(opts.morae) });
    // opts.useModel === true: once the guard has accepted the take, the
    // learned table picks the pattern (see learnedPattern -- opt-in only).
    // No-data slots stay 'unclear'.
    var answered = false;
    for (var k = 0; k < result.length; k++) if (result[k] !== 'unclear') { answered = true; break; }
    if (answered && opts.useModel === true) {
      var learned = learnedPattern(c.slotMedians);
      if (learned) result = learned.map(function (lv, j) { return result[j] === 'unclear' ? 'unclear' : lv; });
    }
    return { pattern: result, spanStart: c.spanStart, spanEnd: c.spanEnd, slots: c.slots, overallMedian: c.overallMedian };
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
    _classifyLevels: classifyLevels, // retired from segmentByMora; kept for tools/pitch-accuracy-experiment.js and its tests
    _decodeAccentPattern: decodeAccentPattern, // exposed for testing
    _gateQuietFrames: gateQuietFrames, // exposed for testing
    _heavyInitial: heavyInitial, // exposed for testing
    _computeSlots: computeSlots, // exposed for research tools (alternative decoders on production slots)
    _learnedPattern: learnedPattern, // exposed for testing
    _hasModel: !!(ACCENT_MODEL && ACCENT_MODEL.models),
  };
});
