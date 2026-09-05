// Plain-assert tests for tools/build-words.js's pure intersection logic,
// run via a plain `node` script (no framework), matching jed's
// js/__tests__/ style. Exercises small inline fixtures standing in for
// accents_kanjium.txt / kotoba's data/words/*.json / jed's data/words/*.json
// -- never the real 124k-line file.
const assert = require('assert');
const {
  parseKanjium,
  kotobaPairsFromEntries,
  jedPairsFromEntries,
  intersectWords,
} = require('../../tools/build-words.js');

let pass = 0, fail = 0;
function ok(desc, cond) {
  if (cond) pass++;
  else { fail++; console.error(`FAIL: ${desc}`); }
}

// --- parseKanjium ---

const kanjiumFixture = [
  '橋\tはし\t2',
  '箸\tはし\t1,3',
  '雨\tあめ\t1',
  '\t\t', // malformed line, must be skipped
  'nope\tnoreading\t', // missing accentNum, must be skipped
].join('\n');

const parsed = parseKanjium(kanjiumFixture);
ok('parseKanjium keeps 3 well-formed lines', parsed.length === 3);
assert.deepStrictEqual(parsed[0], { word: '橋', reading: 'はし', accentNum: 2 });
ok('parseKanjium uses only the first accentNum when comma-separated',
  parsed[1].accentNum === 1 && parsed[1].word === '箸');
assert.deepStrictEqual(parsed[2], { word: '雨', reading: 'あめ', accentNum: 1 });

// --- kotobaPairsFromEntries ---

const kotobaFixture = [
  { word: '橋', reading: 'はし', meaning: 'bridge', frequencyRank: 1 },
  { word: '雨', reading: 'あめ', meaning: 'rain', frequencyRank: 2 },
  { word: 'missingReading' },
];
const kotobaPairs = kotobaPairsFromEntries(kotobaFixture);
ok('kotobaPairsFromEntries extracts 2 valid pairs, skips malformed entry',
  kotobaPairs.size === 2 &&
  kotobaPairs.has('橋\tはし') &&
  kotobaPairs.has('雨\tあめ'));

// --- jedPairsFromEntries ---

const jedFixture = {
  '1000200': { k: [{ t: '箸', c: false, tg: [] }], r: [{ t: 'はし', c: false, tg: [] }] },
  '1000210': { k: [], r: [{ t: 'あめ', c: false, tg: [] }] }, // kana-only entry
  '1000225': { k: [{ t: 'X' }, { t: 'Y' }], r: [{ t: 'x' }, { t: 'y' }] }, // cross product
};
const jedPairs = jedPairsFromEntries(jedFixture);
ok('jedPairsFromEntries extracts kanji/reading pair', jedPairs.has('箸\tはし'));
ok('jedPairsFromEntries falls back to reading-as-word when k is empty',
  jedPairs.has('あめ\tあめ'));
ok('jedPairsFromEntries expands full k x r cross product',
  jedPairs.has('X\tx') && jedPairs.has('X\ty') && jedPairs.has('Y\tx') && jedPairs.has('Y\ty'));
ok('jedPairsFromEntries produces exactly 6 pairs total', jedPairs.size === 6);

// --- intersectWords ---

const result = intersectWords(parsed, [kotobaPairs, jedPairs]);
// 橋/はし: only in kotoba -> kept.
// 箸/はし: only in jed -> kept.
// 雨/あめ: in kotoba (雨 あめ) but jed only has あめ/あめ (different word) -> still kept via kotoba.
ok('intersectWords keeps entries found in kotoba only', result.some((r) => r.word === '橋' && r.reading === 'はし'));
ok('intersectWords keeps entries found in jed only', result.some((r) => r.word === '箸' && r.reading === 'はし'));
ok('intersectWords keeps entries found via either source (union of vocab, not intersection of sources)',
  result.some((r) => r.word === '雨' && r.reading === 'あめ'));
ok('intersectWords result length is exactly 3', result.length === 3);
ok('intersectWords preserves accentNum from the Kanjium record',
  result.find((r) => r.word === '橋').accentNum === 2);

// Dedup: a Kanjium fixture with a duplicate (word, reading) line must not
// produce duplicate output entries.
const dupKanjium = parseKanjium('橋\tはし\t2\n橋\tはし\t2');
const dupResult = intersectWords(dupKanjium, [kotobaPairs, jedPairs]);
ok('intersectWords de-duplicates repeated Kanjium (word, reading) pairs',
  dupResult.filter((r) => r.word === '橋' && r.reading === 'はし').length === 1);

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
