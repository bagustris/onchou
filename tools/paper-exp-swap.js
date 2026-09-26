#!/usr/bin/env node
// paper-exp-swap.js -- error detection on resynthesized WRONG-ACCENT takes
// with known answers (tools/paper-swap.py): no raters needed.
//
// Every native take appears once as 'selfswap' (its own accent, same WORLD
// round trip: a CORRECT attempt) and once per other valid pattern (a WRONG
// attempt whose produced pattern is known). A tutor's decision per take:
//   accept  = decoded pattern equals the word's target
//   abstain = all morae 'unclear' (the app asks for a retry)
//   flag    = anything else
// Reported per split (natives A = choosing, B = reporting), speaker-
// bootstrap 95% CIs:
//   detection   % of wrong takes NOT accepted (flag or abstain) / flagged
//   false alarm % of correct takes NOT accepted / flagged
//   diagnosis   % of wrong takes decoded as exactly the produced pattern
//   Youden J    detection - false alarm (a decoder rejecting everything
//               scores 0, not 100)
// and detection by error type (fall 1 mora early/late, fall removed, fall
// added, other).
//   UMEJRF_DIR=... node tools/paper-exp-swap.js
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./paper-harness.js');
const L = require('./paper-exp-learned-lib.js');
const PD = require('../js/pitch-diagram.js');
const { readWavSync } = require('./wav-reader.js');
const { buildTrace } = require('./evaluate-jsut-accuracy.js');
const ROOT = process.env.UMEJRF_DIR;
const TMP = path.join(__dirname, 'tmp');
const B = +(process.env.BOOT || 500);

const manifest = fs.readFileSync(path.join(TMP, 'swap-manifest.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const cacheFile = path.join(TMP, 'swap-traces.json');
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
let added = 0;
const samples = [];
for (const r of manifest) {
  const key = `${r.swap}/${r.rel}`;
  if (!cache[key]) {
    const f = path.join(ROOT, 'wav48', 'swap', r.swap, r.rel);
    if (!fs.existsSync(f)) continue;
    const w = readWavSync(f);
    cache[key] = buildTrace(w.samples, w.sampleRate, 0, w.samples.length / w.sampleRate);
    if (++added % 2000 === 0) console.error(`  traced ${added}`);
  }
  const [, site, spk] = r.rel.split('/');
  samples.push({ ...r, trace: cache[key], speaker: `${site}/${spk}`, cluster: `${site}/${spk}` });
}
if (added) fs.writeFileSync(cacheFile, JSON.stringify(cache));

const D = H.load();
const gauss = L.trainGauss([].concat(D.jsutApp.train, D.jsutPhrase.train));
const systems = {
  'proposed (shipped)': H.predictShipped(),
  'proposed without silent morae': H.predictShipped(H.variant({ SILENT_MORAE: false })),
  'Gaussians [Ishi 2001], forced choice': (s) => { const g = L.gaussWithMargin(gauss, s); return g ? g.pat.split('') : new Array(s.moraCount).fill('unclear'); },
};

const fallOf = (p) => { for (let i = 0; i + 1 < p.length; i++) if (p[i] === 'H' && p[i + 1] === 'L') return i; return -1; };
function errType(orig, neu) {
  const a = fallOf(orig.split('')), b = fallOf(neu.split(''));
  if (a >= 0 && b < 0) return 'fall removed';
  if (a < 0 && b >= 0) return 'fall added';
  if (Math.abs(a - b) === 1) return b > a ? 'fall 1 mora late' : 'fall 1 mora early';
  return 'fall moved 2+ morae';
}
function decide(s, p) {
  const target = PD.pitchLevels(s.moraCount, s.accents[0]).slice(0, s.moraCount).join('');
  if (p.every((x) => x === 'unclear')) return 'abstain';
  return p.join('') === target ? 'accept' : 'flag';
}

function stats(items) { // items: {s, d, exact}
  const c = { wN: 0, wNotAcc: 0, wFlag: 0, wExact: 0, cN: 0, cNotAcc: 0, cFlag: 0 };
  for (const it of items) {
    if (it.s.swap === 'selfswap') { c.cN++; if (it.d !== 'accept') c.cNotAcc++; if (it.d === 'flag') c.cFlag++; }
    else { c.wN++; if (it.d !== 'accept') c.wNotAcc++; if (it.d === 'flag') c.wFlag++; if (it.exact) c.wExact++; }
  }
  return { J: c.wNotAcc / c.wN - c.cNotAcc / c.cN, det: c.wNotAcc / c.wN, detFlag: c.wFlag / c.wN, fa: c.cNotAcc / c.cN, faFlag: c.cFlag / c.cN, diag: c.wExact / c.wN, wN: c.wN, cN: c.cN };
}
function boot(items, key) {
  const by = new Map();
  items.forEach((it) => { if (!by.has(it.s.cluster)) by.set(it.s.cluster, []); by.get(it.s.cluster).push(it); });
  const keys = [...by.keys()];
  let seed = 20260927;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const v = [];
  for (let b = 0; b < B; b++) { const res = []; for (let i = 0; i < keys.length; i++) res.push(...by.get(keys[Math.floor(rnd() * keys.length)])); v.push(stats(res)[key]); }
  v.sort((x, y) => x - y);
  return [v[Math.floor(0.025 * (B - 1))], v[Math.floor(0.975 * (B - 1))]];
}
const pc = (x) => (100 * x).toFixed(1);
const out = {};
for (const split of ['ume.A', 'ume.B']) {
  const set = samples.filter((s) => s.split === split && s.trace.some((f) => f.hz != null));
  console.log(`\n## ${split === 'ume.A' ? 'natives A (choosing)' : 'natives B (reporting)'}: ${set.filter((s) => s.swap === 'selfswap').length} correct takes, ${set.filter((s) => s.swap !== 'selfswap').length} wrong takes, ${new Set(set.map((s) => s.speaker)).size} speakers`);
  console.log('| system | Youden J = detection - false alarm [CI] | detection (not accepted) [CI] | of which flagged | false alarm on correct [CI] | of which flagged | exact diagnosis [CI] |\n|---|---|---|---|---|---|---|');
  for (const [name, fn] of Object.entries(systems)) {
    const items = set.map((s) => { const p = fn(s); return { s, d: decide(s, p), exact: p.join('') === s.new }; });
    const st = stats(items);
    const ci = (k) => boot(items, k).map(pc).join(', ');
    out[split + '|' + name] = { st, items: items.map((it) => ({ swap: it.s.swap, orig: it.s.orig, d: it.d, exact: it.exact, moraCount: it.s.moraCount })) };
    console.log(`| ${name} | ${pc(st.J)} [${ci('J')}] | ${pc(st.det)} [${ci('det')}] | ${pc(st.detFlag)} | ${pc(st.fa)} [${ci('fa')}] | ${pc(st.faFlag)} | ${pc(st.diag)} [${ci('diag')}] |`);
  }
  console.log('\ndetection (not accepted) by error type:');
  const types = ['fall 1 mora early', 'fall 1 mora late', 'fall moved 2+ morae', 'fall removed', 'fall added'];
  console.log('system'.padEnd(38) + types.map((t) => t.padStart(22)).join(''));
  for (const name of Object.keys(systems)) {
    const its = out[split + '|' + name].items.filter((it) => it.swap !== 'selfswap');
    console.log(name.padEnd(38) + types.map((t) => { const sub = its.filter((it) => errType(it.orig, it.swap) === t); return sub.length ? `${pc(sub.filter((it) => it.d !== 'accept').length / sub.length)}% (n=${sub.length})`.padStart(22) : '-'.padStart(22); }).join(''));
  }
  console.log('\nshipped, by mora count (detection / false alarm):');
  const its = out[split + '|proposed (shipped)'].items;
  for (const n of [...new Set(its.map((i) => i.moraCount))].sort()) {
    const w = its.filter((i) => i.moraCount === n && i.swap !== 'selfswap'), c = its.filter((i) => i.moraCount === n && i.swap === 'selfswap');
    console.log(`  ${n} morae: ${pc(w.filter((i) => i.d !== 'accept').length / w.length)}% / ${pc(c.filter((i) => i.d !== 'accept').length / c.length)}%  (wrong n=${w.length}, correct n=${c.length})`);
  }
}
fs.writeFileSync(path.join(TMP, 'paper-swap-results.json'), JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.st])), null, 2));
