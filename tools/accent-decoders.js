// accent-decoders.js -- pure, DOM-free candidate replacements for
// js/mora-segment.js's classifyLevels(), evaluated on real JSUT audio by
// tools/evaluate-decoders.js. Everything here is model-free (no trained
// weights, no server) so any winner can be ported into the shipped app
// without breaking its "no ML model, no server" constraint.
//
// Two independent axes, each drawn from the literature:
//
// 1. How one representative F0 value per mora is taken ("mora value"):
//    - 'median': median of all voiced frames in the slot (what the shipped
//      segmentByMora does today).
//    - 'late': median of voiced frames in the slot's second half.
//    - 'target': a least-squares line through the slot's frames, evaluated
//      at the slot's END -- Ishi, Minematsu & Hirose (2001) "CV-tgt", the
//      best-performing mora-F0 representation in their accent-type study
//      (75.5% vs 68.0% for the plain CV average). Motivated by listeners'
//      pitch judgements tracking where F0 is heading, not its mean (see also
//      Short, Hirose & Minematsu, SLaTE 2011: the F0 at the END of the first
//      mora of a pair is what decides the perceived H/L transition).
//
// 2. How those per-mora values become an H/L pattern ("decoder"):
//    - 'twoMeans': the shipped classifyLevels (unconstrained 1D 2-cluster
//      split) -- baseline.
//    - 'template': only the n+1 valid Tokyo accent patterns are allowed
//      (Ishi et al. 2001 and every accent-TYPE identifier in that line of
//      work restricts to these); each is fit as v_i = a + c*T_i (c >= 0) and
//      the lowest-residual pattern wins. Rules out impossible outputs like
//      H,H,L,H that an independent per-mora split can produce.
//    - 'templateTrend': the same, but fit JOINTLY with a declination term,
//      v_i = a + b*i + c*T_i with c >= 0 and b in [-maxDeclCents, 0]. The
//      earlier linear-detrend experiment failed because it fit the trend
//      FIRST, alone, letting the line soak up part of the accent step;
//      fitting both at once (the same idea as the Fujisaki model's split
//      of log F0 into a phrase component and an accent component) lets the
//      step term claim the step and the trend term claim only the
//      remaining slope.
//    - 'nucleus': the accent nucleus is the mora just before the largest
//      LOCAL fall (Minematsu/Hirose line of work; F0ratio = semitone step
//      between adjacent morae, Ishi et al. 2001 eq. 1). Declination shows up
//      as a small, roughly uniform negative step everywhere, so each step
//      is measured relative to the median step, and a fall only counts as
//      the nucleus if it exceeds that baseline by at least minFallCents.
//
// All decoders return the same shape as classifyLevels:
// ['H'|'L'|'unclear', ...], length == slotValues.length, and report every
// slot 'unclear' when there's no contrast worth trusting (the same honesty
// rule MIN_SPLIT_CENTS enforces in production).
'use strict';

// ---------------------------------------------------------------- patterns

// Every valid Tokyo pattern over n slots, as 0/1 arrays (1 = H), paired with
// the accentNum that produces it. For n slots this is: heiban/odaka
// (L,H,...,H -- identical across the slots themselves), atamadaka
// (H,L,...,L), and a drop after slot d for each 2 <= d <= n-1. The same set
// covers particle mode unchanged (word + が = n slots): see
// docs/superpowers/specs/2026-09-25-onchou-particle-mode-design.md.
function validPatterns(n) {
  const out = [];
  if (n < 2) return out;
  const flat = [0]; for (let i = 1; i < n; i++) flat.push(1);
  out.push({ drop: 0, t: flat }); // no drop inside the slots (heiban/odaka)
  const head = [1]; for (let i = 1; i < n; i++) head.push(0);
  out.push({ drop: 1, t: head }); // atamadaka
  for (let d = 2; d <= n - 1; d++) {
    const t = [0];
    for (let i = 1; i < n; i++) t.push(i < d ? 1 : 0);
    out.push({ drop: d, t: t });
  }
  return out;
}

function toLabels(t) { return t.map((x) => (x ? 'H' : 'L')); }
function allUnclear(n) { return new Array(n).fill('unclear'); }

// ------------------------------------------------------------ voice gate

// gateTrace(trace, gateDb) -> a copy of `trace` with hz set to null on every
// frame whose RMS energy is more than gateDb below the take's loudest frame.
// The shipped estimator reports pitch on near-silence (measured on JSUT's
// leading 'sil': random 70-400Hz values at -25..-58dB re the loudest frame,
// vs. -0..-9dB for real voiced speech), and a single such frame in the
// silence before or after a word stretches segmentByMora's "voiced span" --
// which every mora slot is cut from -- into that silence. Relative (not
// absolute) so mic gain doesn't matter; computable in the app because
// segmentation only runs after the recording has stopped.
function gateTrace(trace, gateDb) {
  if (gateDb == null) return trace;
  let maxE = 0;
  for (const f of trace) if (f && f.energy != null && f.energy > maxE) maxE = f.energy;
  if (maxE <= 0) return trace;
  const floor = maxE * Math.pow(10, -gateDb / 20);
  return trace.map((f) => (f && f.hz != null && f.energy != null && f.energy < floor ? { tMs: f.tMs, hz: null, energy: f.energy } : f));
}

// ---------------------------------------------------------- mora values

function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

// frames: [{t, logHz}] for ONE slot (voiced only), slotStart/slotEnd in the
// same time unit. Returns a log2-Hz value or null.
// Median taken in Hz, then logged -- matches js/mora-segment.js exactly
// (for an even count, the mean of the two middle values differs slightly
// between the Hz and log domains).
function medianLog(frames) {
  return Math.log2(median(frames.map((f) => Math.pow(2, f.logHz))));
}

function moraValue(frames, slotStart, slotEnd, method) {
  if (!frames.length) return null;
  if (method === 'late') {
    const mid = (slotStart + slotEnd) / 2;
    const late = frames.filter((f) => f.t >= mid);
    return medianLog(late.length ? late : frames);
  }
  if (method === 'target') {
    if (frames.length < 3) return medianLog(frames);
    const n = frames.length;
    let mx = 0, my = 0;
    for (const f of frames) { mx += f.t; my += f.logHz; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0;
    for (const f of frames) { sxy += (f.t - mx) * (f.logHz - my); sxx += (f.t - mx) * (f.t - mx); }
    const slope = sxx > 0 ? sxy / sxx : 0;
    const v = my + slope * (slotEnd - mx);
    // Clamp extrapolation to the slot's own observed range: one noisy edge
    // frame shouldn't send the "target" an octave past anything measured.
    let lo = Infinity, hi = -Infinity;
    for (const f of frames) { if (f.logHz < lo) lo = f.logHz; if (f.logHz > hi) hi = f.logHz; }
    return Math.min(hi, Math.max(lo, v));
  }
  return medianLog(frames);
}

// trace: [{tMs, hz}], boundaries: [b0, b1, ..., bn] in tMs (n slots).
// Returns n log2-Hz values (null where a slot has no voiced frame).
function moraValuesFromBoundaries(trace, boundaries, method) {
  const n = boundaries.length - 1;
  const slots = Array.from({ length: n }, () => []);
  for (const f of trace) {
    if (!f || f.hz == null) continue;
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      if (f.tMs >= boundaries[i] && (f.tMs < boundaries[i + 1] || (last && f.tMs <= boundaries[i + 1]))) {
        slots[i].push({ t: f.tMs, logHz: Math.log2(f.hz) });
        break;
      }
    }
  }
  return slots.map((fr, i) => moraValue(fr, boundaries[i], boundaries[i + 1], method));
}

// Equal-width slotting with the EXACT index formula js/mora-segment.js's
// segmentByMora uses (floor of the span fraction times n, clamped), so the
// 'median' + 'twoMeans' combination reproduces the shipped output exactly
// rather than differing on frames that sit right on a slot edge.
//
// shift (default 0): delay every slot window by `shift` x (one slot width),
// i.e. slot i covers [s + (i+shift)w, s + (i+1+shift)w). Compensates for
// the realized accentual F0 events landing LATER than the mora they belong
// to (the accentual fall is realized at the end of the accented mora or in
// the following one; the phrase-initial rise eats into mora 1 while its
// consonant is often unvoiced). This is the same idea as Ishi, Minematsu &
// Hirose (2001)'s "VC unit" -- measuring each mora from its vowel through
// the next consonant, roughly half a mora later than the CV unit -- applied
// to time-proportional slots since onchou has no phone alignment. Frames
// before the first shifted window are ignored; the last window simply runs
// out at the end of the voiced span. With shift=0 this is byte-for-byte the
// shipped slotting.
//
// shiftMs (optional, overrides shift): the same delay in absolute
// milliseconds instead of a fraction of a slot. Peak delay measured as a
// fraction of a mora on FAST read speech would over-shift a slow, careful
// single-word recording (onchou's actual use case, where morae are much
// longer); a fixed time delay shrinks automatically as a fraction of a
// longer mora, so it's the safer parameterization to transfer.
function moraValuesProportional(trace, n, method, shift, shiftMs) {
  shift = shift || 0;
  if (shiftMs) {
    const vv = trace.filter((f) => f && f.hz != null);
    if (vv.length) {
      const sp = vv[vv.length - 1].tMs - vv[0].tMs;
      shift = sp > 0 ? (shiftMs * n) / sp : 0;
    }
  }
  const voiced = trace.filter((f) => f && f.hz != null);
  if (!voiced.length) return null;
  let s = Infinity, e = -Infinity;
  for (const f of voiced) { if (f.tMs < s) s = f.tMs; if (f.tMs > e) e = f.tMs; }
  const span = e - s;
  const slots = Array.from({ length: n }, () => []);
  for (const f of voiced) {
    let idx;
    if (span <= 0) idx = 0;
    else if (shift === 0) idx = Math.floor(((f.tMs - s) / span) * n);
    else {
      const pos = ((f.tMs - s) / span) * n - shift;
      if (pos < 0) continue; // before the first (delayed) window
      idx = Math.floor(pos);
    }
    if (idx >= n) idx = n - 1;
    if (idx < 0) idx = 0;
    slots[idx].push({ t: f.tMs, logHz: Math.log2(f.hz) });
  }
  const w = span / n;
  return slots.map((fr, i) => moraValue(fr, s + (i + shift) * w, s + (i + 1 + shift) * w, method));
}

// Shift arbitrary boundaries (e.g. forced-aligned ones) later, either by a
// fraction of each mora's own duration or by a fixed number of ms.
function shiftedBoundaries(bounds, frac, ms) {
  const n = bounds.length - 1;
  return bounds.map((b, i) => {
    const d = i < n ? bounds[i + 1] - bounds[i] : bounds[n] - bounds[n - 1];
    return b + (ms != null ? ms : frac * d);
  });
}

// Same equal-width slotting the shipped segmentByMora uses: the voiced span
// (first..last voiced frame) cut into n equal slots.
function proportionalBoundaries(trace, n) {
  const voiced = trace.filter((f) => f && f.hz != null);
  if (!voiced.length) return null;
  let s = Infinity, e = -Infinity;
  for (const f of voiced) { if (f.tMs < s) s = f.tMs; if (f.tMs > e) e = f.tMs; }
  const b = [];
  for (let i = 0; i <= n; i++) b.push(s + ((e - s) * i) / n);
  return b;
}

// --------------------------------------------------------------- decoders

// Shipped algorithm (js/mora-segment.js classifyLevels), on log2 values.
function decodeTwoMeans(v, opts) {
  const minCents = opts.minContrastCents;
  const labels = allUnclear(v.length);
  const present = [];
  v.forEach((x, i) => { if (x != null) present.push({ i, x }); });
  if (present.length < 2) return labels;
  const sorted = present.slice().sort((a, b) => a.x - b.x);
  let best = -1, bestCost = Infinity;
  const ss = (arr) => { const m = arr.reduce((a, b) => a + b, 0) / arr.length; return arr.reduce((a, b) => a + (b - m) * (b - m), 0); };
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k - 1].x === sorted[k].x) continue;
    const cost = ss(sorted.slice(0, k).map((p) => p.x)) + ss(sorted.slice(k).map((p) => p.x));
    if (cost < bestCost) { bestCost = cost; best = k; }
  }
  if (best < 0) return labels;
  const lo = sorted.slice(0, best), hi = sorted.slice(best);
  const gap = 1200 * (hi.reduce((a, p) => a + p.x, 0) / hi.length - lo.reduce((a, p) => a + p.x, 0) / lo.length);
  if (gap < minCents) return labels;
  sorted.forEach((p, idx) => { labels[p.i] = idx < best ? 'L' : 'H'; });
  return labels;
}

// Least squares of y on the given regressor columns (each an array over the
// present indices). Tiny normal-equation solve; returns {coef, sse} or null
// if singular.
function lstsq(cols, y) {
  const k = cols.length, n = y.length;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const rhs = new Array(k).fill(0);
  for (let r = 0; r < n; r++) {
    for (let i = 0; i < k; i++) {
      rhs[i] += cols[i][r] * y[r];
      for (let j = 0; j < k; j++) A[i][j] += cols[i][r] * cols[j][r];
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]]; [rhs[c], rhs[p]] = [rhs[p], rhs[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j < k; j++) A[r][j] -= f * A[c][j];
      rhs[r] -= f * rhs[c];
    }
  }
  const coef = rhs.map((x, i) => x / A[i][i]);
  let sse = 0;
  for (let r = 0; r < n; r++) {
    let pred = 0;
    for (let i = 0; i < k; i++) pred += coef[i] * cols[i][r];
    sse += (y[r] - pred) * (y[r] - pred);
  }
  return { coef, sse };
}

// Fit y = a + b*x + c*t with c >= 0 and b in [bMin, bMax] (bMin <= 0 <= bMax
// in log2 units per slot); an active constraint is handled by clamping that
// coefficient and refitting the rest (exact for this small, convex problem
// when checked over the few active-set combinations below).
function fitConstrained(y, x, t, bMin, bMax, useTrend) {
  const ones = y.map(() => 1);
  const candidates = [];
  const tryFit = (fixB, fixC) => {
    const cols = [ones];
    const yAdj = y.slice();
    if (useTrend && fixB == null) cols.push(x);
    if (fixC == null) cols.push(t);
    for (let r = 0; r < y.length; r++) {
      if (useTrend && fixB != null) yAdj[r] -= fixB * x[r];
      if (fixC != null) yAdj[r] -= fixC * t[r];
    }
    const res = lstsq(cols, yAdj);
    if (!res) return;
    let idx = 1;
    const b = !useTrend ? 0 : (fixB != null ? fixB : res.coef[idx++]);
    const c = fixC != null ? fixC : res.coef[idx++];
    if (c < -1e-12) return;
    if (useTrend && (b < bMin - 1e-12 || b > bMax + 1e-12)) return;
    candidates.push({ b, c, sse: res.sse });
  };
  tryFit(null, null);
  if (useTrend) { tryFit(bMin, null); tryFit(bMax, null); }
  tryFit(null, 0);
  if (useTrend) { tryFit(bMin, 0); tryFit(bMax, 0); }
  if (!candidates.length) return null;
  candidates.sort((p, q) => p.sse - q.sse);
  return candidates[0];
}

function decodeTemplate(v, opts, useTrend) {
  const n = v.length;
  const labels = allUnclear(n);
  const idx = [];
  v.forEach((x, i) => { if (x != null) idx.push(i); });
  if (idx.length < 2 || n < 2) return labels;
  const y = idx.map((i) => v[i]);
  const x = idx.map((i) => i);
  const maxDecl = (opts.maxDeclCents || 0) / 1200; // per slot, log2 units
  let best = null;
  for (const p of validPatterns(n)) {
    const t = idx.map((i) => p.t[i]);
    // A pattern whose template is constant over the PRESENT slots can't be
    // told apart from "no contrast" -- skip it rather than let it win ties.
    if (t.every((z) => z === t[0])) continue;
    const fit = fitConstrained(y, x, t, -maxDecl, 0, useTrend);
    if (!fit) continue;
    if (!best || fit.sse < best.sse - 1e-15) best = { p, c: fit.c, sse: fit.sse };
  }
  if (!best) return labels;
  if (1200 * best.c < opts.minContrastCents) return labels;
  return toLabels(best.p.t);
}

function decodeNucleus(v, opts) {
  const n = v.length;
  const labels = allUnclear(n);
  // Fill interior gaps by linear interpolation so steps stay adjacent;
  // leading/trailing gaps copy the nearest present value.
  const present = [];
  v.forEach((x, i) => { if (x != null) present.push(i); });
  if (present.length < 2 || n < 2) return labels;
  const w = v.slice();
  for (let i = 0; i < n; i++) {
    if (w[i] != null) continue;
    let l = i - 1; while (l >= 0 && v[l] == null) l--;
    let r = i + 1; while (r < n && v[r] == null) r++;
    if (l < 0) w[i] = v[r];
    else if (r >= n) w[i] = v[l];
    else w[i] = v[l] + ((v[r] - v[l]) * (i - l)) / (r - l);
  }
  const steps = [];
  for (let i = 1; i < n; i++) steps.push(1200 * (w[i] - w[i - 1])); // cents
  // Baseline step = declination. Median is robust to the one big accent
  // fall and the one initial rise; with <= 2 steps there's no usable
  // baseline, so it's taken as 0 (no declination correction).
  const base = steps.length >= 3 ? median(steps) : 0;
  const baseClamped = Math.max(-(opts.maxDeclCents || 0), Math.min(0, base));
  const rel = steps.map((s) => s - baseClamped);
  let j = -1, fall = 0;
  rel.forEach((r, i) => { if (-r > fall) { fall = -r; j = i; } });
  const rise = rel.length ? Math.max(0, rel[0]) : 0;
  const minFall = opts.minFallCents;
  let drop;
  if (j >= 0 && fall >= minFall) drop = j + 1; // step j is between slot j and j+1 (0-based) => drop after slot j+1 (1-based)
  else drop = 0;
  // Nothing to report at all: no qualifying fall AND no initial rise.
  if (drop === 0 && rise < opts.minContrastCents) return labels;
  const pat = validPatterns(n).find((p) => p.drop === drop);
  return pat ? toLabels(pat.t) : labels;
}

function decode(v, decoder, opts) {
  switch (decoder) {
    case 'twoMeans': return decodeTwoMeans(v, opts);
    case 'template': return decodeTemplate(v, opts, false);
    case 'templateTrend': return decodeTemplate(v, opts, true);
    case 'nucleus': return decodeNucleus(v, opts);
    default: throw new Error('unknown decoder ' + decoder);
  }
}

module.exports = {
  validPatterns, moraValue, moraValuesFromBoundaries, moraValuesProportional, proportionalBoundaries,
  shiftedBoundaries, gateTrace,
  decode, decodeTwoMeans, decodeTemplate, decodeNucleus, fitConstrained, lstsq,
};
