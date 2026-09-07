// Node-builtin test runner for reference-audio.js's pure helpers (the live
// speechSynthesis wrapper is browser-only and untestable here).
const assert = require('assert');
const { isJapaneseVoice, pickJapaneseVoice, supported, cancel } = require('../reference-audio.js');

let pass = 0, fail = 0;
function eq(name, got, expected) {
  try { assert.deepStrictEqual(got, expected); pass++; }
  catch (e) { fail++; console.error(`FAIL: ${name} => ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`); }
}

// isJapaneseVoice
eq('ja: exact ja-JP', isJapaneseVoice({ lang: 'ja-JP' }), true);
eq('ja: bare ja', isJapaneseVoice({ lang: 'ja' }), true);
eq('ja: other ja-* region', isJapaneseVoice({ lang: 'ja-XX' }), true);
eq('ja: english voice rejected', isJapaneseVoice({ lang: 'en-US' }), false);
eq('ja: a language merely containing "ja" substring rejected (must be prefix)', isJapaneseVoice({ lang: 'sja-JP' }), false);
eq('ja: missing lang', isJapaneseVoice({}), false);
eq('ja: null voice', isJapaneseVoice(null), false);

// pickJapaneseVoice: prefers a local/offline voice over a remote one
eq('pick: no voices -> null', pickJapaneseVoice([]), null);
eq('pick: undefined voices -> null', pickJapaneseVoice(undefined), null);
eq('pick: filters out non-japanese voices', pickJapaneseVoice([{ lang: 'en-US', localService: true }]), null);

const remoteJa = { lang: 'ja-JP', name: 'Google 日本語', localService: false };
const localJa = { lang: 'ja-JP', name: 'Kyoko', localService: true };
eq('pick: single remote ja voice used when it is the only option', pickJapaneseVoice([remoteJa]), remoteJa);
eq('pick: local voice preferred over remote when both present', pickJapaneseVoice([remoteJa, localJa]), localJa);
eq('pick: local voice preferred regardless of array order', pickJapaneseVoice([localJa, remoteJa]), localJa);
eq('pick: ignores non-japanese voices mixed in', pickJapaneseVoice([{ lang: 'en-US', localService: true }, remoteJa]), remoteJa);

// supported(): just shouldn't throw in Node (no `self`/window)
eq('supported: false outside a browser', supported(), false);

// cancel() is called unconditionally by app.js on every word change and at
// the start of every recording, including on browsers with no
// speechSynthesis at all -- it must be a no-op there, not a throw.
eq('cancel: no-op (no throw) when speechSynthesis is absent', (function () {
  try { cancel(); return 'ok'; } catch (e) { return 'threw: ' + e.message; }
})(), 'ok');

console.log(`reference-audio: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
