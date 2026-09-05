// Node-builtin test runner for pitch-diagram.js's `pitchLevels` (ported
// from jlpt/js/app.js — see that file's own "Pitch accent plot" section)
// and `moraSplit` (ported from kotoba/js/pitch-accent.js). Real example
// words/readings/accentNums below are looked up directly from
// vendor/kanji-data/compounds/accents_kanjium.txt (first accepted pattern
// when a word lists more than one, same "use only the first" rule the
// design spec's data-build step applies) — matching jed's plain-assert,
// no-framework test style.
const assert = require('assert');
const { moraSplit, pitchLevels } = require('../pitch-diagram.js');

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

// --- moraSplit --------------------------------------------------------
// Plain morae, no small kana.
eq('moraSplit(さくら)', moraSplit('さくら'), ['さ', 'く', 'ら']);
// Small kana (ょ) attaches to the preceding character.
eq('moraSplit(がっこう) っ is its own mora', moraSplit('がっこう'), ['が', 'っ', 'こ', 'う']);
eq('moraSplit(でしょう) small ょ attaches', moraSplit('でしょう'), ['で', 'しょ', 'う']);
// ー (long vowel mark) is its own mora.
eq('moraSplit(コーヒー) ー is its own mora', moraSplit('コーヒー'), ['コ', 'ー', 'ヒ', 'ー']);
// ゎ (rare small-wa) also merges, per kotoba's set.
eq('moraSplit(でんわ) plain わ is not small', moraSplit('でんわ'), ['で', 'ん', 'わ']);
eq('moraSplit(くゎ) small ゎ attaches', moraSplit('くゎ'), ['くゎ']);
eq('moraSplit empty reading', moraSplit(''), []);

// --- pitchLevels --------------------------------------------------------
// 桜 (さくら) — heiban, accentNum 0, moraCount 3: pitch never drops within
// the word or on the trailing pseudo-mora (this is what distinguishes it
// from odaka, which is otherwise identical across the word's own morae).
eq('pitchLevels heiban 桜 さくら (0, 3 morae)',
  pitchLevels(3, 0),
  ['L', 'H', 'H', 'H']);

// 箸 (はし) — atamadaka, accentNum 1, moraCount 2: only the first mora is
// high, everything after (including the trailing pseudo-mora) is low.
eq('pitchLevels atamadaka 箸 はし (1, 2 morae)',
  pitchLevels(2, 1),
  ['H', 'L', 'L']);

// 卵 (たまご) — nakadaka, accentNum 2, moraCount 3 (2 is strictly between 1
// and moraCount): pitch rises after the first mora and drops after the
// second, before the end of the word.
eq('pitchLevels nakadaka 卵 たまご (2, 3 morae)',
  pitchLevels(3, 2),
  ['L', 'H', 'L', 'L']);

// 弟 (おとうと) — odaka, accentNum === moraCount (4, 4): pitch stays high
// across the whole word, same as heiban would look within the word, but
// the trailing pseudo-mora drops — the detail that tells odaka apart from
// heiban.
eq('pitchLevels odaka 弟 おとうと (4, 4 morae)',
  pitchLevels(4, 4),
  ['L', 'H', 'H', 'H', 'L']);

console.log(`pitch-diagram: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
