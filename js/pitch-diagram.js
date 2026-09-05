// Pitch-accent dot-and-line diagram — ported from jlpt/js/app.js's
// `pitchLevels`/`pitchAccentSVG` (search those names there for the
// original), generalized so it can render either the target pattern
// (computed from a Kanjium `accentNum`) or an arbitrary detected `H`/`L`/
// `unclear` array (the learner's recording, from js/mora-segment.js), in a
// different color per `opts.variant` so the two diagrams are visually
// distinguishable when shown stacked.
//
// Mora-splitting rule (small kana attach to the preceding character; っ/ー
// are their own mora) is ported from kotoba/js/pitch-accent.js's
// `moraSplit` (search "moraSplit" there) rather than jlpt's narrower
// `PITCH_SMALL_KANA` set — kotoba's set additionally includes ゎ/ヮ, which
// the task instructions call out explicitly as the rule to reuse.
const PitchDiagram = (function () {
  'use strict';

  // Small-kana yōon (ゃゅょぁぃぅぇぉゎ and katakana equivalents) merge into
  // the preceding mora instead of counting as their own. っ/ん/ー are real
  // morae on their own and are deliberately NOT in this set.
  const SMALL_KANA = new Set([...'ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ']);

  // Splits a kana reading into morae, kotoba's rule exactly: a small kana
  // merges into the previous mora (if any); everything else starts a new
  // mora.
  function moraSplit(reading) {
    const moras = [];
    for (const ch of reading || '') {
      if (SMALL_KANA.has(ch) && moras.length > 0) moras[moras.length - 1] += ch;
      else moras.push(ch);
    }
    return moras;
  }

  // One 'H'/'L' per mora, standard Japanese pitch-accent rule, plus one
  // trailing pseudo-mora for whatever follows the word: high only for
  // heiban (accentNum 0), the one pattern where the pitch never falls.
  // That trailing entry is what visually tells heiban apart from odaka
  // (accentNum === moraCount) — the two are identical across the word's
  // own morae and differ only in what happens right after it. Ported
  // verbatim from jlpt/js/app.js's `pitchLevels`.
  function pitchLevels(moraCount, accentNum) {
    const levels = [];
    for (let i = 0; i < moraCount; i++) {
      if (accentNum === 0) levels.push(i === 0 ? 'L' : 'H');
      else if (accentNum === 1) levels.push(i === 0 ? 'H' : 'L');
      else levels.push(i === 0 ? 'L' : (i < accentNum ? 'H' : 'L'));
    }
    levels.push(accentNum === 0 ? 'H' : 'L');
    return levels;
  }

  // Renders an explicit level array (as produced by `pitchLevels`, or by
  // js/mora-segment.js for a learner's detected attempt) as a small inline
  // dot-and-line SVG. Does NOT take an accentNum — callers compute levels
  // first, so the same renderer serves both the target diagram and the
  // learner's diagram.
  //
  // opts:
  //   - variant: 'target' | 'learner' (default 'target') — selects the CSS
  //     class (and thus the CSS variable / color) used for the dots and
  //     connecting line, so the two diagrams read as visually distinct
  //     even when stacked directly on top of each other.
  //   - trailing: whether the last entry in `levels` is a trailing
  //     pseudo-mora, rendered hollow/smaller like jlpt's original (default
  //     true — matches `pitchLevels`' output shape). Pass false when
  //     `levels` has no trailing entry (e.g. a learner pattern that's
  //     exactly one entry per mora with nothing appended).
  //   - label: aria-label text for the <svg> (default: derived from the
  //     level sequence).
  //
  // 'unclear' level handling (a third state, distinct from 'H'/'L', used
  // by js/mora-segment.js for morae where no voiced pitch was detected):
  // rendered as a smaller, greyed dot (class `pitch-dot-unclear`) at a
  // fixed mid-height between the H and L rows, and — since there's no
  // meaningful pitch to place it relative to a neighbor at — the
  // connecting line simply does not extend to/from an unclear dot's exact
  // point; the line path still runs mora-to-mora but an unclear point sits
  // at mid-height, which visually breaks the H/L step shape at that mora
  // without a special-cased line gap. This keeps the renderer simple (one
  // path, no path-splitting) while still reading clearly as "no data here"
  // rather than a false H or L.
  function renderSVG(levels, opts) {
    opts = opts || {};
    const variant = opts.variant === 'learner' ? 'learner' : 'target';
    const hasTrailing = opts.trailing !== false;
    if (!levels || levels.length === 0) return '';

    const stepX = 14;
    const padX = 6;
    const topY = 6;
    const midY = 12;
    const bottomY = 18;
    const width = padX * 2 + stepX * levels.length;
    const height = 24;
    const wordMoraCount = hasTrailing ? levels.length - 1 : levels.length;

    const xAt = (i) => padX + stepX * i;
    const yAt = (level) => (level === 'H' ? topY : level === 'L' ? bottomY : midY);

    const path = levels.map((level, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(level)}`).join(' ');

    const dots = levels.map((level, i) => {
      const isTrailing = hasTrailing && i >= wordMoraCount;
      const isUnclear = level === 'unclear';
      const classes = ['pitch-dot', `pitch-dot-${variant}`];
      if (isTrailing) classes.push('pitch-dot-trailing');
      if (isUnclear) classes.push('pitch-dot-unclear');
      const r = isUnclear ? 2 : (isTrailing ? 2.5 : 3);
      return `<circle cx="${xAt(i)}" cy="${yAt(level)}" r="${r}" class="${classes.join(' ')}" />`;
    }).join('');

    const label = opts.label != null ? opts.label : levels.join('');
    const labelAttr = String(label).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

    return `<svg class="pitch-plot pitch-plot-${variant}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${labelAttr}">` +
      `<path d="${path}" class="pitch-line pitch-line-${variant}" fill="none" />${dots}</svg>`;
  }

  return { moraSplit, pitchLevels, renderSVG };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PitchDiagram;
