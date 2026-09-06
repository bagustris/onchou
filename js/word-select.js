// word-select.js -- picks the next quiz word: gated by a mora-count level
// the learner chooses in Settings, and balanced so every pitch-accent
// pattern available at that level gets equal practice time regardless of
// how skewed the raw word pool is.
//
// Why balancing is needed at all: heiban dominates data/words.json from 3
// morae up (313 of 625 three-mora words, 457 of 686 four-mora words), so a
// plain random draw badly under-practices nakadaka/odaka. See
// docs/superpowers/specs/2026-09-06-onchou-learning-progression-design.md
// for the full distribution table and the decisions behind this design.
//
// Pure and DOM-free (no Web Audio, no document, no localStorage) -- the
// caller reads the learner's level from SettingsManager and passes it in --
// so all of it is unit-testable from Node against fixture word lists.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./pitch-diagram.js'));
  } else {
    // js/pitch-diagram.js declares `const PitchDiagram`, and a top-level
    // `const` creates a script-scoped global BINDING rather than a property
    // on window/self -- so it has to be referenced by bare identifier here.
    // `root.PitchDiagram` would be undefined (this is also why js/app.js
    // uses the bare name).
    root.WordSelect = factory(PitchDiagram);
  }
})(typeof self !== 'undefined' ? self : this, function (PitchDiagram) {
  'use strict';

  // Cumulative mora-count caps: level '3' means "3 morae AND SHORTER", not
  // "exactly 3 morae", so earlier patterns keep getting practiced as the
  // learner widens the pool. 'all' lifts the cap entirely.
  var LEVELS = [
    { value: '2', maxMora: 2 },
    { value: '3', maxMora: 3 },
    { value: '4', maxMora: 4 },
    { value: 'all', maxMora: Infinity },
  ];

  var DEFAULT_LEVEL = 'all';

  // Fixed iteration order for bucket selection -- NOT object-key order.
  // Pinning it here is what makes pickWord's rng-driven choice reproducible
  // (and therefore testable) instead of depending on insertion order.
  var PATTERN_ORDER = ['heiban', 'atamadaka', 'nakadaka', 'odaka'];

  // classifyPattern(moraCount, accentNum) -> pattern name
  //
  // The standard four-way Japanese pitch-accent classification, from the
  // same Kanjium accent-kernel number js/pitch-diagram.js's pitchLevels
  // already consumes. Order matters at one boundary: a 1-mora word with
  // accentNum 1 satisfies both the atamadaka and the odaka test, and the
  // atamadaka check running first is what decides it (pinned by a test).
  function classifyPattern(moraCount, accentNum) {
    if (accentNum === 0) return 'heiban';
    if (accentNum === 1) return 'atamadaka';
    if (accentNum === moraCount) return 'odaka';
    return 'nakadaka';
  }

  function moraCountFor(word) {
    return PitchDiagram.moraSplit(word.reading).length;
  }

  // groupByPattern(words, maxMora) -> { <pattern>: [word, ...], ... }
  //
  // Filters to words of at most maxMora morae, then buckets them by
  // pattern. A pattern with no matching words is ABSENT as a key rather
  // than present as an empty array -- pickWord relies on "the keys that
  // exist" being exactly "the patterns worth drawing from", which is how a
  // 2-mora level ends up with no nakadaka bucket without special-casing
  // (nakadaka needs 1 < accentNum < moraCount, impossible below 3 morae).
  function groupByPattern(words, maxMora) {
    var buckets = {};
    (words || []).forEach(function (word) {
      var moraCount = moraCountFor(word);
      if (moraCount > maxMora) return;
      var pattern = classifyPattern(moraCount, word.accentNum);
      if (!buckets[pattern]) buckets[pattern] = [];
      buckets[pattern].push(word);
    });
    return buckets;
  }

  function maxMoraFor(levelValue) {
    for (var i = 0; i < LEVELS.length; i++) {
      if (LEVELS[i].value === levelValue) return LEVELS[i].maxMora;
    }
    // Unknown or missing value (a level from a future/older version left in
    // localStorage, say) falls back to the widest pool rather than throwing
    // or quietly selecting nothing -- same never-fail-on-stored-input
    // philosophy js/settings.js's load() uses.
    return maxMoraFor(DEFAULT_LEVEL);
  }

  // Uniform index into an array of length `len`. Clamped because `rng` is
  // injectable: Math.random() is [0,1) so it can't overflow, but a
  // caller-supplied one returning exactly 1 would otherwise index off the
  // end and yield undefined.
  function randomIndex(len, rng) {
    var i = Math.floor(rng() * len);
    if (i >= len) i = len - 1;
    if (i < 0) i = 0;
    return i;
  }

  // pickWord(words, levelValue, rng) -> word | null
  //
  // Picks the PATTERN first and the word second -- that ordering is the
  // whole balancing mechanism, since it makes each available pattern
  // equally likely no matter how many words back it. Returns null when the
  // level leaves nothing to draw from (empty list, or every word filtered
  // out), mirroring what the plain random pick this replaced did for an
  // empty list.
  function pickWord(words, levelValue, rng) {
    var random = rng || Math.random;
    var buckets = groupByPattern(words, maxMoraFor(levelValue));
    var keys = PATTERN_ORDER.filter(function (pattern) { return buckets[pattern]; });
    if (!keys.length) return null;

    var bucket = buckets[keys[randomIndex(keys.length, random)]];
    return bucket[randomIndex(bucket.length, random)];
  }

  return {
    LEVELS: LEVELS,
    classifyPattern: classifyPattern,
    groupByPattern: groupByPattern,
    pickWord: pickWord,
  };
});
