#!/usr/bin/env node
// paper-exp-heiban.js -- fixes for native heiban words read as accented
// (the largest source of false rejections; tools/paper-exp-errors.js).
// Three causes, one js/mora-segment.js knob each (see its comments):
//   MIN_SPLIT_HEAVY_HEAD_CENTS   heavy-initial heiban (starts high, declines) read as atamadaka
//   RISE_WAIVE_VOICELESS_INITIAL rise on a voiceless first mora can't be heard -> all-unclear
//   FINAL_DROP_CAP_CENTS         phrase-final lowering read as a late fall
// Every setting is judged on the CHOOSING data only -- natives A (kappa,
// heiban acceptance, swap-test Youden J, flat/drift false acceptance) and
// JSUT app-like train (kappa) -- then the chosen one is reported on natives
// B, JSUT app test, JVS and learners, with the same guards on natives B.
// Needs tools/tmp/swap-traces.json + swap-manifest.jsonl (tools/paper-
// exp-swap.js) and tools/tmp/flat-traces.json (tools/paper-exp-augment.js).
//   node tools/paper-exp-heiban.js            (sweep)
//   REPORT='{"FINAL_DROP_CAP_CENTS":100}' node tools/paper-exp-heiban.js   (held-out report)
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./paper-harness.js');
const PD = require('../js/pitch-diagram.js');
const D = H.load();
const TMP = path.join(__dirname, 'tmp');

const swapTraces = JSON.parse(fs.readFileSync(path.join(TMP, 'swap-traces.json'), 'utf8'));
const manifest = fs.readFileSync(path.join(TMP, 'swap-manifest.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const flatTraces = JSON.parse(fs.readFileSync(path.join(TMP, 'flat-traces.json'), 'utf8'));
const relOf = (s) => { const [site, spk] = s.speaker.split('/'); return path.join(s.group, site, spk, `D1_${String(s.wordIdx).padStart(3, '0')}.wav`); };
const shapeOf = (n, a) => PD.pitchLevels(n, a).slice(0, n).join('');

function swapJ(set, fn) {
  const rels = new Set(set.map(relOf));
  let wN = 0, wNot = 0, cN = 0, cNot = 0;
  for (const r of manifest) {
    if (!rels.has(r.rel)) continue;
    const tr = swapTraces[`${r.swap}/${r.rel}`]; if (!tr || !tr.some((f) => f.hz != null)) continue;
    const p = fn({ trace: tr, moraCount: r.moraCount, accents: r.accents, morae: r.morae }).join(''), target = shapeOf(r.moraCount, r.accents[0]);
    if (r.swap === 'selfswap') { cN++; if (p !== target) cNot++; } else { wN++; if (p !== target) wNot++; }
  }
  return { J: wNot / wN - cNot / cN, det: wNot / wN, fa: cNot / cN };
}
function flatFA(set, fn) {
  const acc = { flat: [0, 0], decl: [0, 0] };
  for (const s of set) {
    if (s.moraCount < 2) continue;
    if (s.accents.some((a) => { const p = shapeOf(s.moraCount, a); return p.lastIndexOf('H') === s.moraCount - 1 && p[0] === 'L'; })) continue;
    for (const v of ['flat', 'decl']) {
      const tr = flatTraces[`${v}/${relOf(s)}`]; if (!tr || !tr.some((f) => f.hz != null)) continue;
      const p = fn({ ...s, trace: tr }).join('');
      acc[v][1]++; if (s.accents.some((a) => shapeOf(s.moraCount, a) === p)) acc[v][0]++;
    }
  }
  return { flat: acc.flat[0] / acc.flat[1], decl: acc.decl[0] / acc.decl[1] };
}
// Single-accent heiban entries only: a word listing heiban among several
// accepted accents (白檀 [2/0], 銅貨 [1/0], 額 [0/2]) has no unambiguous
// heiban ground truth.
const heibanOK = (set, fn) => { const h = set.filter((s) => s.accents.length === 1 && s.accents[0] === 0 && s.moraCount >= 2 && s.trace.some((f) => f.hz != null)); return h.filter((s) => fn(s).join('') === shapeOf(s.moraCount, 0)).length / h.length; };
const pc = (x) => (100 * x).toFixed(1);

if (!process.env.REPORT) {
  const grid = [{}];
  for (const v of [150, 200, 250, 300]) grid.push({ MIN_SPLIT_HEAVY_HEAD_CENTS: v });
  grid.push({ RISE_WAIVE_VOICELESS_INITIAL: true });
  for (const v of [50, 100, 150, 200]) grid.push({ FINAL_DROP_CAP_CENTS: v });
  for (const h of [200, 250]) for (const f of [100, 150]) grid.push({ MIN_SPLIT_HEAVY_HEAD_CENTS: h, FINAL_DROP_CAP_CENTS: f, RISE_WAIVE_VOICELESS_INITIAL: true });
  console.log('Choosing data only. κ = within-mora-count Cohen\'s kappa; heiban OK = % of native takes of single-accent heiban words accepted;');
  console.log('swap J = detection − false alarm (%) on natives-A accent swaps; flat/drift FA = % of accent-removed natives-A takes accepted.\n');
  console.log('| setting | natives A κ | heiban OK | swap J | swap det / FA | flat FA | drift FA | JSUT app train κ |\n|---|---|---|---|---|---|---|---|');
  for (const g of grid) {
    const fn = H.predictShipped(Object.keys(g).length ? H.variant(g) : undefined);
    const k = H.metrics(D.ume.A, fn), sj = swapJ(D.ume.A, fn), ff = flatFA(D.ume.A, fn), kj = H.metrics(D.jsutApp.train, fn);
    console.log(`| ${Object.keys(g).length ? JSON.stringify(g) : 'shipped'} | ${k.kappa.toFixed(3)} | ${pc(heibanOK(D.ume.A, fn))} | ${pc(sj.J)} | ${pc(sj.det)} / ${pc(sj.fa)} | ${pc(ff.flat)} | ${pc(ff.decl)} | ${kj.kappa.toFixed(3)} |`);
  }
} else {
  const g = JSON.parse(process.env.REPORT);
  const base = H.predictShipped(), fix = H.predictShipped(H.variant(g));
  console.log(`Held-out report for ${JSON.stringify(g)}. κ = within-mora-count Cohen's kappa [cluster-bootstrap 95% CI]; Δ = paired bootstrap vs shipped.\n`);
  console.log('| set | shipped κ | fixed κ | Δκ [95% CI] | shipped heiban OK | fixed heiban OK |\n|---|---|---|---|---|---|');
  for (const [name, set] of [['UME natives B', D.ume.B], ['JSUT app-like test', D.jsutApp.test], ['JVS (98 spk)', D.jvs.all], ['UME learners (agreement)', D.ume.learners]]) {
    const r = H.bootstrap(set, base, 300, fix), rf = H.bootstrap(set, fix, 300);
    console.log(`| ${name} | ${r.point.kappa.toFixed(3)} | ${rf.point.kappa.toFixed(3)} [${rf.ci[0].toFixed(3)}, ${rf.ci[1].toFixed(3)}] | ${r.diff.point >= 0 ? '+' : ''}${r.diff.point.toFixed(3)} [${r.diff.ci[0].toFixed(3)}, ${r.diff.ci[1].toFixed(3)}] | ${pc(heibanOK(set, base))} | ${pc(heibanOK(set, fix))} |`);
  }
  console.log('\nGuards on natives B (swap J = detection − false alarm, %; FA = % of accent-removed takes accepted):');
  console.log('| system | swap J | swap det / FA | flat FA | drift FA |\n|---|---|---|---|---|');
  for (const [name, fn] of [['shipped', base], ['fixed', fix]]) { const sj = swapJ(D.ume.B, fn), ff = flatFA(D.ume.B, fn); console.log(`| ${name} | ${pc(sj.J)} | ${pc(sj.det)} / ${pc(sj.fa)} | ${pc(ff.flat)} | ${pc(ff.decl)} |`); }
}
