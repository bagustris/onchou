// Plain-assert tests for tools/jsut-lab-parser.js, matching this codebase's
// no-framework js/__tests__/ style. Fixtures are real lines lifted from
// jsut-label's BASIC5000_0002.lab (see tools/jsut-lab-parser.js's header) --
// the 木曜日 (moku-yo-o-bi) accent phrase, whose accentType this codebase
// independently cross-checked against
// vendor/kanji-data/compounds/accents_kanjium.txt (木曜日/もくようび -> 3)
// during development, so it's a reliable known-good fixture rather than an
// arbitrary one.
const assert = require('assert');
const { parsePhoneLine, parseAccentPhrases, isBoundaryPhone } = require('../../tools/jsut-lab-parser.js');

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
function ok(desc, cond) {
  if (cond) pass++;
  else { fail++; console.error(`FAIL: ${desc}`); }
}

// --- parsePhoneLine ---------------------------------------------------

eq('parses start/end (100ns units -> seconds) and the center phone (p3)',
  parsePhoneLine('3000000 3400000 xx^sil-m+i=z/A:-2+1+3/B:xx-xx_xx/C:xx_xx+xx/D:xx+xx_xx/E:xx_xx!xx_xx-xx/F:3_3#0_xx@1_4|1_23/G:7_2%0_xx_0/H:xx_xx/I:4-23@1+1&1-4|1+23/J:xx_xx/K:1+4-23'),
  { startSec: 0.3, endSec: 0.34, phone: 'm', a2: 1, f1: 3, f2: 3, fKey: '3_3#0_xx@1_4|1_23' });

eq('a boundary phone (F field xx_xx) parses with f1/f2 both null',
  parsePhoneLine('0 3000000 xx^xx-sil+m=i/A:xx+xx+xx/B:xx-xx_xx/C:xx_xx+xx/D:xx+xx_xx/E:xx_xx!xx_xx-xx/F:xx_xx#0_xx@xx_xx|xx_xx/G:3_3%0_xx_0/H:xx_xx/I:xx-xx@xx+xx&xx-xx|xx+xx/J:4_23/K:1+4-23'),
  { startSec: 0, endSec: 0.3, phone: 'sil', a2: null, f1: null, f2: null, fKey: 'xx_xx#0_xx@xx_xx|xx_xx' });

ok('isBoundaryPhone true when f1/f2 are null',
  isBoundaryPhone({ f1: null, f2: null }));
ok('isBoundaryPhone false for a real accent-phrase phone',
  !isBoundaryPhone({ f1: 3, f2: 3 }));

eq('malformed line (fewer than 3 columns) returns null', parsePhoneLine('0 3000000'), null);

// --- parseAccentPhrases -------------------------------------------------

// 木曜日 (mo-ku-yo-o-bi, 5 morae), accentType 3 -- the first accent phrase
// of BASIC5000_0002.lab, preceded by a leading silence boundary phone.
const MOKUYOOBI_LAB = [
  '0 3000000 xx^xx-sil+m=o/A:xx+xx+xx/F:xx_xx#0_xx@xx_xx|xx_xx',
  '3000000 4000000 xx^sil-m+o=k/A:-4+1+5/F:5_3#0_xx@1_6|1_35',
  '4000000 5000000 sil^m-o+k=u/A:-4+1+5/F:5_3#0_xx@1_6|1_35',
  '5000000 6000000 m^o-k+u=y/A:-3+2+4/F:5_3#0_xx@1_6|1_35',
  '6000000 7000000 o^k-u+y=o/A:-3+2+4/F:5_3#0_xx@1_6|1_35',
  '7000000 8000000 k^u-y+o=o/A:-2+3+3/F:5_3#0_xx@1_6|1_35',
  '8000000 9000000 u^y-o+o=b/A:-2+3+3/F:5_3#0_xx@1_6|1_35',
  '9000000 10000000 y^o-o+b=i/A:-1+4+2/F:5_3#0_xx@1_6|1_35',
  '10000000 11000000 o^o-b+i=xx/A:0+5+1/F:5_3#0_xx@1_6|1_35',
].join('\n');

const phrases = parseAccentPhrases(MOKUYOOBI_LAB);
eq('one accent phrase found (leading silence excluded)', phrases.length, 1);
eq('moraCount == f1', phrases[0].moraCount, 5);
eq('accentType == f2 (matches Kanjium 木曜日/もくようび == 3)', phrases[0].accentType, 3);
eq('5 moras grouped by shared a2, in speech order (with each mora\'s phones)',
  phrases[0].moras,
  [
    { startSec: 0.3, endSec: 0.5, phones: ['m', 'o'] },
    { startSec: 0.5, endSec: 0.7, phones: ['k', 'u'] },
    { startSec: 0.7, endSec: 0.9, phones: ['y', 'o'] },
    { startSec: 0.9, endSec: 1.0, phones: ['o'] },
    { startSec: 1.0, endSec: 1.1, phones: ['b'] }, // fixture above is trimmed after the 'b' of 'bi'
  ]);
eq('phrase span covers first to last mora', [phrases[0].startSec, phrases[0].endSec], [0.3, 1.1]);

// A phrase whose actual mora-group count doesn't match its own f1 is
// dropped rather than reported (defensive guard against a parsing edge
// case producing a desynced moraCount/accentType pair) -- simulate by
// giving F:5_3 (claims 5 morae) but only 2 distinct a2 groups.
const MISMATCHED_LAB = [
  '0 1000000 xx^a-b+c=d/A:0+1+2/F:5_3#0_xx@1_1|1_1',
  '1000000 2000000 a^b-c+d=e/A:0+2+1/F:5_3#0_xx@1_1|1_1',
].join('\n');
eq('a phrase whose mora-group count disagrees with f1 is dropped',
  parseAccentPhrases(MISMATCHED_LAB).length, 0);

// accentType out of the valid [0, moraCount] range is dropped too.
const OUT_OF_RANGE_LAB = [
  '0 1000000 xx^a-b+c=d/A:0+1+1/F:1_9#0_xx@1_1|1_1',
].join('\n');
eq('a phrase whose accentType exceeds moraCount is dropped',
  parseAccentPhrases(OUT_OF_RANGE_LAB).length, 0);

// Two ADJACENT phrases with the same (f1, f2) and no pause between them --
// real lines from BASIC5000_4989.lab (こばやし, then いさむわ; both F:4_4,
// distinguished only by the rest of the F field). They must stay two
// phrases, not merge into one whose mora spans cross the boundary.
const ADJ = [
  '0 1000000 xx^xx-sil+k=o/A:xx+xx+xx/F:xx_xx#xx_xx@xx_xx|xx_xx',
  '1000000 2000000 xx^sil-k+o=b/A:-3+1+4/F:4_4#0_xx@1_2|1_8',
  '2000000 3000000 sil^k-o+b=a/A:-3+1+4/F:4_4#0_xx@1_2|1_8',
  '3000000 4000000 k^o-b+a=y/A:-2+2+3/F:4_4#0_xx@1_2|1_8',
  '4000000 5000000 o^b-a+y=a/A:-2+2+3/F:4_4#0_xx@1_2|1_8',
  '5000000 6000000 b^a-y+a=sh/A:-1+3+2/F:4_4#0_xx@1_2|1_8',
  '6000000 7000000 a^y-a+sh=i/A:-1+3+2/F:4_4#0_xx@1_2|1_8',
  '7000000 8000000 y^a-sh+i=i/A:0+4+1/F:4_4#0_xx@1_2|1_8',
  '8000000 9000000 a^sh-i+i=s/A:0+4+1/F:4_4#0_xx@1_2|1_8',
  '9000000 10000000 sh^i-i+s=a/A:-3+1+4/F:4_4#0_xx@2_1|5_4',
  '10000000 11000000 i^i-s+a=m/A:-2+2+3/F:4_4#0_xx@2_1|5_4',
  '11000000 12000000 i^s-a+m=u/A:-2+2+3/F:4_4#0_xx@2_1|5_4',
  '12000000 13000000 s^a-m+u=w/A:-1+3+2/F:4_4#0_xx@2_1|5_4',
  '13000000 14000000 a^m-u+w=a/A:-1+3+2/F:4_4#0_xx@2_1|5_4',
  '14000000 15000000 m^u-w+a=pau/A:0+4+1/F:4_4#0_xx@2_1|5_4',
  '15000000 16000000 u^w-a+pau=sh/A:0+4+1/F:4_4#0_xx@2_1|5_4',
].join('\n');
{
  const ps = parseAccentPhrases(ADJ);
  eq('adjacent same-(f1,f2) phrases stay separate', ps.length, 2);
  eq('first phrase ends where the second begins', ps[0].endSec, ps[1].startSec);
  eq('second phrase starts at its own first mora', ps[1].startSec, 0.9);
  eq('no mora span crosses the boundary', ps[0].moras.every((m) => m.endSec <= 0.9), true);
}

console.log(`jsut-lab-parser: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
