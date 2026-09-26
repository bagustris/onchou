#!/usr/bin/env node
// paper-exp-errors.js -- error analysis of the shipped decoder on the
// CHOOSING split (UME-JRF natives A; natives B is never looked at here).
// Natives saying words correctly are labelled data: every non-match is a
// decoder error. Breaks errors down by
//   1. outcome class per target shape (all-unclear / fall shifted by k /
//      fall missed / spurious fall ...),
//   2. word (the worst offenders),
//   3. predicted high-vowel devoicing (the voiceless-consonant rule from
//      github.com/bagustris/ASR_JA_Vowel_Devoicing, ported to kana in
//      js/mora-segment.js silentMorae (geminates included)), with the voiced-frame share of each mora slot
//      as a direct check of whether the flagged morae are really voiceless.
'use strict';
const H = require('./paper-harness.js');
const PD = require('../js/pitch-diagram.js');
const DV = { devoicedMorae: (m) => H.shipped._silentMorae(m) }; // geminates + predicted devoicing
const MS = H.shipped;
const D = H.load();
const set = process.env.SPLIT === 'learners' ? D.ume.learners : D.ume.A;

const fallOf = (p) => { // index of the last H before an L (0-based mora of the accent), -1 = no fall
  for (let i = 0; i + 1 < p.length; i++) if (p[i] === 'H' && p[i + 1] === 'L') return i;
  return -1;
};
function outcome(s, p) {
  const tg = H.targetFor(s, p);
  if (p.join('') === tg.join('')) return 'correct';
  if (p.every((x) => x === 'unclear')) return 'all-unclear';
  if (p.some((x) => x === 'unclear')) return 'partly-unclear';
  const ft = fallOf(tg), fp = fallOf(p);
  if (ft === fp) return 'rise-wrong'; // same fall, initial low/high differs
  if (ft < 0) return 'spurious-fall';
  if (fp < 0) return 'missed-fall';
  return `fall-shift${fp - ft > 0 ? '+' : ''}${fp - ft}`;
}
const shape = (s) => { const a = s.accents[0]; return a === 0 ? 'heiban' : a === 1 ? 'atamadaka' : a === s.moraCount ? 'odaka' : 'nakadaka'; };

const rows = [];
for (const s of set) {
  if (!s.trace.some((f) => f && f.hz != null)) continue;
  const p = MS.segmentByMora(s.trace, s.moraCount, { morae: s.morae }).pattern;
  const c = MS._computeSlots(s.trace, s.moraCount);
  rows.push({ s, p, o: outcome(s, p), dv: DV.devoicedMorae(s.morae), c });
}
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '-').padStart(5);
const tally = (arr, key) => { const m = new Map(); for (const r of arr) m.set(key(r), (m.get(key(r)) || 0) + 1); return m; };

console.log(`split: ${process.env.SPLIT || 'natives A'}, ${rows.length} takes, ${new Set(rows.map((r) => r.s.speaker)).size} speakers\n`);
console.log('## 1. Outcome by target shape (% of takes)');
const outs = [...tally(rows, (r) => r.o).entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
console.log('shape'.padEnd(11) + 'n'.padStart(5) + outs.map((o) => o.padStart(15)).join(''));
for (const sh of ['heiban', 'atamadaka', 'nakadaka', 'odaka', null]) {
  const sub = rows.filter((r) => sh == null || shape(r.s) === sh);
  const t = tally(sub, (r) => r.o);
  console.log((sh || 'ALL').padEnd(11) + String(sub.length).padStart(5) + outs.map((o) => pct(t.get(o) || 0, sub.length).padStart(15)).join(''));
}
console.log('\n## 1b. Outcome by mora count');
for (const n of [...new Set(rows.map((r) => r.s.moraCount))].sort()) {
  const sub = rows.filter((r) => r.s.moraCount === n), t = tally(sub, (r) => r.o);
  console.log(`${n} morae`.padEnd(11) + String(sub.length).padStart(5) + outs.map((o) => pct(t.get(o) || 0, sub.length).padStart(15)).join(''));
}

console.log('\n## 2. Worst words (correct rate, most common error)');
const byWord = new Map();
for (const r of rows) { const k = `${r.s.word} ${r.s.reading} [${r.s.accents.join('/')}]`; if (!byWord.has(k)) byWord.set(k, []); byWord.get(k).push(r); }
const wordStats = [...byWord.entries()].map(([k, rs]) => {
  const t = tally(rs, (r) => r.o), err = [...t.entries()].filter(([o]) => o !== 'correct').sort((a, b) => b[1] - a[1])[0];
  return { k, n: rs.length, ok: (t.get('correct') || 0) / rs.length, err: err ? `${err[0]} (${err[1]})` : '', dv: DV.devoicedMorae(rs[0].s.morae) };
}).sort((a, b) => a.ok - b.ok);
for (const w of wordStats.slice(0, 25)) console.log(`${(100 * w.ok).toFixed(0).padStart(4)}%  ${w.k.padEnd(22)} ${w.err.padEnd(22)} devoiced: ${w.dv.map((x, i) => (x ? i + 1 : '')).filter(Boolean).join(',') || '-'}`);

console.log('\n## 3. Predicted devoicing (rule: i/u with voiceless onset before a voiceless onset, or word-final after one)');
const where = (r) => {
  const d = r.dv, n = d.length;
  if (!d.some(Boolean)) return 'none';
  const tags = [];
  if (d[0]) tags.push('initial');
  if (d[n - 1]) tags.push('final');
  if (d.slice(1, n - 1).some(Boolean)) tags.push('medial');
  return tags.join('+');
};
for (const [k, sub] of [...Map.groupBy ? Map.groupBy(rows, where) : (() => { const m = new Map(); rows.forEach((r) => { const w = where(r); if (!m.has(w)) m.set(w, []); m.get(w).push(r); }); return m; })()].sort((a, b) => b[1].length - a[1].length)) {
  const t = tally(sub, (r) => r.o), words = new Set(sub.map((r) => r.s.reading));
  console.log(`${k.padEnd(22)} words ${String(words.size).padStart(3)} takes ${String(sub.length).padStart(4)}  correct ${pct(t.get('correct') || 0, sub.length)}%  all-unclear ${pct(t.get('all-unclear') || 0, sub.length)}%  wrong ${pct(sub.length - (t.get('correct') || 0) - (t.get('all-unclear') || 0), sub.length)}%`);
}

// Is the flagged mora actually voiceless? Voiced-frame share of the word's
// voiced span attributable to each mora is not observable without
// alignment; instead compare the voiced span to the energy span (voiced +
// voiceless frication): a devoiced edge mora shortens the voiced span but
// not the energy span.
function spans(s) {
  const e = s.trace.map((f) => f.rms != null ? f.rms : f.energy);
  const maxE = Math.max(...e.filter((x) => x != null));
  const floor = maxE * Math.pow(10, -25 / 20);
  const loud = s.trace.filter((f, i) => e[i] != null && e[i] >= floor);
  const g = MS._gateQuietFrames(s.trace).filter((f) => f.hz != null);
  if (!loud.length || !g.length) return null;
  return { eS: loud[0].tMs, eE: loud[loud.length - 1].tMs, vS: g[0].tMs, vE: g[g.length - 1].tMs };
}
console.log('\n   median ms of energy (-25dB) beyond the voiced span, at each edge:');
for (const [label, pred] of [['final mora flagged', (d) => d[d.length - 1]], ['final i/u NOT flagged', null], ['initial mora flagged', (d) => d[0]], ['nothing flagged', (d) => !d.some(Boolean)]]) {
  let sub;
  if (pred) sub = rows.filter((r) => pred(r.dv));
  else sub = rows.filter((r) => !r.dv[r.dv.length - 1] && /[いきしちにひみりぎじびぴうくすつぬふむるぐずぶぷ]$/.test(r.s.reading));
  const pre = [], post = [];
  for (const r of sub) { const sp = spans(r.s); if (sp) { pre.push(sp.vS - sp.eS); post.push(sp.eE - sp.vE); } }
  const md = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
  console.log(`   ${label.padEnd(24)} n=${String(sub.length).padStart(4)}  before voicing ${String(md(pre)).padStart(4)}ms  after voicing ${String(md(post)).padStart(4)}ms`);
}
