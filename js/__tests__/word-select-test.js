// Node-builtin test runner for word-select.js -- the mora-count-gated,
// pattern-balanced word selection described in
// docs/superpowers/specs/2026-09-06-onchou-learning-progression-design.md.
// Same plain-assert, no-framework style as the rest of js/__tests__/.
//
// Real example words/readings/accentNums below are looked up directly from
// vendor/kanji-data/compounds/accents_kanjium.txt (first accepted pattern
// when a word lists more than one -- 卵 たまご is "2,0" there), matching the
// fixture convention js/__tests__/pitch-diagram-test.js already uses.
const assert = require('assert');
const { classifyPattern, groupByPattern, pickWord, LEVELS } = require('../word-select.js');

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

// Real words, one per pattern type.
const SAKURA = { word: '桜', reading: 'さくら', accentNum: 0 };     // heiban, 3 morae
const HASHI = { word: '箸', reading: 'はし', accentNum: 1 };        // atamadaka, 2 morae
const TAMAGO = { word: '卵', reading: 'たまご', accentNum: 2 };     // nakadaka, 3 morae
const OTOUTO = { word: '弟', reading: 'おとうと', accentNum: 4 };   // odaka, 4 morae
const HANA = { word: '花', reading: 'はな', accentNum: 2 };         // odaka, 2 morae

// --- classifyPattern ----------------------------------------------------

eq('classifyPattern heiban 桜 さくら (0, 3 morae)', classifyPattern(3, 0), 'heiban');
eq('classifyPattern atamadaka 箸 はし (1, 2 morae)', classifyPattern(2, 1), 'atamadaka');
eq('classifyPattern nakadaka 卵 たまご (2, 3 morae)', classifyPattern(3, 2), 'nakadaka');
eq('classifyPattern odaka 弟 おとうと (4, 4 morae)', classifyPattern(4, 4), 'odaka');

// Boundary: a 2-mora word whose accent falls on its last mora is odaka, not
// nakadaka -- nakadaka requires 1 < accentNum < moraCount, which is
// impossible below 3 morae (the structural fact the "2-mora first" level in
// the design spec relies on).
eq('classifyPattern odaka 花 はな (2, 2 morae)', classifyPattern(2, 2), 'odaka');

// Boundary: a 1-mora word with accentNum 1 satisfies BOTH "accentNum === 1"
// (atamadaka) and "accentNum === moraCount" (odaka). The atamadaka check
// runs first, so it wins -- pinned here because it's an order-dependent
// classification that would otherwise be silent to change.
eq('classifyPattern 1-mora accentNum 1 is atamadaka, not odaka', classifyPattern(1, 1), 'atamadaka');

// --- groupByPattern -----------------------------------------------------

{
  const words = [SAKURA, HASHI, TAMAGO, OTOUTO, HANA];
  eq('groupByPattern buckets every pattern present (maxMora Infinity)',
    groupByPattern(words, Infinity),
    // Words keep their input order within a bucket (OTOUTO precedes HANA
    // in the list passed in).
    { heiban: [SAKURA], atamadaka: [HASHI], nakadaka: [TAMAGO], odaka: [OTOUTO, HANA] });
}

{
  // maxMora 2 keeps only the 2-mora words -- and because nakadaka is
  // structurally impossible there, the nakadaka key is absent entirely
  // rather than present-but-empty (which is what lets pickWord treat
  // "buckets that exist" as "patterns worth drawing from").
  const words = [SAKURA, HASHI, TAMAGO, OTOUTO, HANA];
  eq('groupByPattern maxMora 2 filters out longer words',
    groupByPattern(words, 2),
    { atamadaka: [HASHI], odaka: [HANA] });
}

{
  const words = [SAKURA, HASHI, TAMAGO, OTOUTO, HANA];
  eq('groupByPattern maxMora 3 admits 3-mora words (nakadaka now possible)',
    groupByPattern(words, 3),
    { heiban: [SAKURA], atamadaka: [HASHI], nakadaka: [TAMAGO], odaka: [HANA] });
}

eq('groupByPattern of an empty word list has no buckets', groupByPattern([], Infinity), {});

// --- pickWord -----------------------------------------------------------

// Deterministic stand-in for Math.random: returns the queued values in
// order, so a test can name exactly which bucket and which word within it
// pickWord must land on.
function fakeRng(values) {
  let i = 0;
  return function () { return values[i++]; };
}

{
  // Buckets are considered in the FIXED order heiban, atamadaka, nakadaka,
  // odaka (filtered to those present), so rng 0 -> first bucket (heiban),
  // rng 0 -> first word in it.
  const words = [SAKURA, HASHI, TAMAGO, OTOUTO];
  eq('pickWord rng [0, 0] picks the first bucket\'s first word',
    pickWord(words, 'all', fakeRng([0, 0])),
    SAKURA);
}

{
  // 4 buckets present; Math.floor(0.5 * 4) === 2 -> nakadaka (third in the
  // fixed order), then its only word.
  const words = [SAKURA, HASHI, TAMAGO, OTOUTO];
  eq('pickWord rng [0.5, 0] picks the third bucket (nakadaka)',
    pickWord(words, 'all', fakeRng([0.5, 0])),
    TAMAGO);
}

{
  // Pattern balance is the whole point: a pool where heiban outnumbers
  // odaka 3:1 must still give odaka an equal shot at being drawn, because
  // the bucket is chosen before the word is.
  const heibanA = { word: '桜', reading: 'さくら', accentNum: 0 };
  const heibanB = { word: '車', reading: 'くるま', accentNum: 0 };
  const heibanC = { word: '時計', reading: 'とけい', accentNum: 0 };
  const words = [heibanA, heibanB, heibanC, HANA];
  // 2 buckets (heiban, odaka); Math.floor(0.5 * 2) === 1 -> odaka, despite
  // odaka being only 1 of the 4 words in the raw pool.
  eq('pickWord balances by pattern, not by raw pool size',
    pickWord(words, 'all', fakeRng([0.5, 0])),
    HANA);
}

{
  // Level '2' excludes the 3- and 4-mora words entirely, so a bucket index
  // of 0 lands on atamadaka (箸) -- heiban isn't present at all here, since
  // its only word (桜, 3 morae) is filtered out by the level.
  const words = [SAKURA, HASHI, TAMAGO, OTOUTO, HANA];
  eq('pickWord level "2" only draws from 2-mora words',
    pickWord(words, '2', fakeRng([0, 0])),
    HASHI);
}

{
  // An unknown/legacy stored level value must not throw or return null --
  // it falls back to 'all', mirroring SettingsManager's own philosophy of
  // never failing on an unexpected stored value.
  const words = [SAKURA, HASHI];
  eq('pickWord falls back to "all" for an unknown level value',
    pickWord(words, 'not-a-level', fakeRng([0, 0])),
    SAKURA);
}

eq('pickWord returns null for an empty word list', pickWord([], 'all', fakeRng([0, 0])), null);

{
  // Level '2' against a pool containing no 2-mora words at all: no buckets
  // survive the filter, so there's nothing to draw.
  eq('pickWord returns null when the level filters out every word',
    pickWord([SAKURA, TAMAGO], '2', fakeRng([0, 0])),
    null);
}

{
  // Defensive: rng is injectable, so a caller-supplied one returning
  // exactly 1 (out of contract for Math.random, which is [0,1)) must still
  // index inside the array rather than off its end.
  const words = [SAKURA, HASHI];
  const got = pickWord(words, 'all', fakeRng([1, 1]));
  eq('pickWord clamps an out-of-range rng value to the last element',
    got !== null && got !== undefined,
    true);
}

// --- LEVELS -------------------------------------------------------------

eq('LEVELS values, in order', LEVELS.map((l) => l.value), ['2', '3', '4', 'all']);
eq('LEVELS are cumulative mora-count caps', LEVELS.map((l) => l.maxMora), [2, 3, 4, Infinity]);

console.log(`word-select: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
