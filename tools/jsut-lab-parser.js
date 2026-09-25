// jsut-lab-parser.js -- pure, DOM-free parser for jsut-label's HTS-style
// full-context phoneme labels (https://github.com/sarulab-speech/jsut-label),
// used by tools/evaluate-jsut-accuracy.js to build a real-audio ground-truth
// set for onchou's pitch-detection pipeline. Not part of the shipped app --
// a research/evaluation tool only (see
// docs/2026-09-05-pitch-accent-evaluation-research-plan.md and
// docs/superpowers/specs/2026-09-25-onchou-jsut-real-audio-eval-design.md).
//
// Each .lab line is one phoneme, timed in HTK's standard 100ns units:
//   <startUnits> <endUnits> <context-string>
// where <context-string> is (NIT/HTS Japanese full-context label format,
// the same format Open JTalk and this corpus's Julius-based forced aligner
// both use):
//   p1^p2-p3+p4=p5/A:a1+a2+a3/B:.../C:.../D:.../E:.../F:f1_f2#.../G:.../H:.../I:.../J:.../K:...
// Fields actually used here:
//   - p3 (between '-' and '+' in the leading phoneme context) -- the
//     CURRENT phoneme identity.
//   - A:a1+a2+a3 -- a2 is the current mora's 1-based position within its
//     accent phrase (multiple consecutive phones can share one a2, e.g. a
//     consonant+vowel pair belonging to the same mora).
//   - F:f1_f2#... -- f1 is the CURRENT accent phrase's own mora count, f2
//     its accent type (Kanjium's exact accentNum convention: 0 = heiban/no
//     drop, N = pitch drops immediately after mora N -- verified against
//     vendor/kanji-data/compounds/accents_kanjium.txt for unambiguous words
//     during this tool's development, e.g. 木曜日/もくようび = 3 both places).
//     'xx' for either sub-field marks a non-accent-phrase phone (silence,
//     pause) rather than a real value.
//
// This module deliberately does NOT resolve accent phrases back to
// dictionary words (would need a morphological analyzer/dictionary lookup
// this environment doesn't have, e.g. MeCab) -- an accent phrase (a run of
// phones sharing one (f1, f2) key) is used directly as the scoring unit,
// which is exactly what onchou's own pipeline operates on (some mora count
// + one target accentNum + an audio span), independent of whether that
// span happens to be one dictionary word, a word plus an attached particle,
// or a compound. This also sidesteps needing to resolve which words in a
// phrase like "わたしが" are "the word" vs "the particle" -- the phrase
// AS A WHOLE is simply one more (moraCount, accentType) sample, the same
// shape onchou already scores in particle mode.
'use strict';

const HTK_UNITS_PER_SECOND = 1e7; // HTK label times are in 100ns units

// Matches the leading phoneme-context quintuple "p1^p2-p3+p4=p5" and
// captures p3 (the phone this line is actually timing).
const PHONE_RE = /^(.+?)\^(.+?)-(.+?)\+(.+?)=(.+?)\//;
// A:a1+a2+a3 -- a1/a3 unused here, but the regex must still consume them
// (a1 can be negative, e.g. "-2") to anchor correctly on a2.
const A_FIELD_RE = /\/A:([^+]+)\+([^+]+)\+([^/]+)\//;
// F:f1_f2#... -- only the leading two sub-fields are needed.
const F_FIELD_RE = /\/F:([^_]+)_([^#]+)#/;

// Phones that mark a boundary rather than real speech content within an
// accent phrase -- both silence/pause labels AND any phone whose F-field
// came back 'xx' (utterance-edge phones jsut-label doesn't assign an accent
// phrase to at all).
function isBoundaryPhone(entry) {
  return entry.f1 === null || entry.f2 === null;
}

// parsePhoneLine(line) -> { startSec, endSec, phone, a2, f1, f2 } | null
// f1/f2 are numbers, or null for a boundary phone (see isBoundaryPhone).
// Returns null for a line that doesn't match the expected 3-column shape at
// all (defensive -- not expected to trigger on real jsut-label data).
function parsePhoneLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const [startUnits, endUnits, ...rest] = parts;
  const context = rest.join(' ');

  const phoneMatch = context.match(PHONE_RE);
  if (!phoneMatch) return null;
  const phone = phoneMatch[3];

  const aMatch = context.match(A_FIELD_RE);
  const a2 = aMatch && aMatch[2] !== 'xx' ? Number(aMatch[2]) : null;

  const fMatch = context.match(F_FIELD_RE);
  const f1raw = fMatch ? fMatch[1] : 'xx';
  const f2raw = fMatch ? fMatch[2] : 'xx';
  const f1 = f1raw !== 'xx' ? Number(f1raw) : null;
  const f2 = f2raw !== 'xx' ? Number(f2raw) : null;

  return {
    startSec: Number(startUnits) / HTK_UNITS_PER_SECOND,
    endSec: Number(endUnits) / HTK_UNITS_PER_SECOND,
    phone: phone,
    a2: a2,
    f1: f1,
    f2: f2,
  };
}

// parseAccentPhrases(labText) -> [
//   { moraCount, accentType, startSec, endSec,
//     moras: [{ startSec, endSec }, ...], phones: ['m','i',...] },
//   ...
// ]
//
// Groups consecutive non-boundary phone lines sharing the same (f1, f2)
// into one accent-phrase record, then sub-groups each phrase's phones by
// their shared a2 into per-mora time spans (a mora's span is its first
// phone's start to its last phone's end). A phrase whose actual number of
// distinct a2 groups doesn't match its own f1 is dropped rather than
// reported -- a defensive guard against a parsing edge case producing a
// mora count that would silently desync from the accentType's own implied
// range (accentType must be between 0 and moraCount inclusive).
function parseAccentPhrases(labText) {
  const lines = (labText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const phones = lines.map(parsePhoneLine).filter(Boolean);

  const rawGroups = [];
  let current = null;
  for (const p of phones) {
    if (isBoundaryPhone(p)) { current = null; continue; }
    const key = p.f1 + '_' + p.f2;
    if (!current || current.key !== key) {
      current = { key: key, f1: p.f1, f2: p.f2, phones: [] };
      rawGroups.push(current);
    }
    current.phones.push(p);
  }

  const phrases = [];
  for (const g of rawGroups) {
    const moraOrder = [];
    const moraMap = new Map();
    for (const p of g.phones) {
      if (!moraMap.has(p.a2)) { moraMap.set(p.a2, []); moraOrder.push(p.a2); }
      moraMap.get(p.a2).push(p);
    }
    // a2 values are 1-based mora positions within the phrase -- sort so
    // moras come out in speech order regardless of Map insertion order
    // (insertion order already matches speech order in practice, but this
    // makes that an explicit guarantee rather than an assumption).
    moraOrder.sort((x, y) => x - y);
    const moras = moraOrder.map((a2) => {
      const ps = moraMap.get(a2);
      return { startSec: ps[0].startSec, endSec: ps[ps.length - 1].endSec, phones: ps.map((p) => p.phone) };
    });

    if (moras.length !== g.f1) continue; // defensive: see doc comment above
    if (g.f2 < 0 || g.f2 > g.f1) continue; // defensive: accentType out of range

    phrases.push({
      moraCount: g.f1,
      accentType: g.f2,
      startSec: moras[0].startSec,
      endSec: moras[moras.length - 1].endSec,
      moras: moras,
      phones: g.phones.map((p) => p.phone),
    });
  }
  return phrases;
}

module.exports = { parsePhoneLine, parseAccentPhrases, isBoundaryPhone };
