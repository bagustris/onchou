#!/usr/bin/env node
// paper-exp-selective.js -- a system that may abstain ('unclear') can't be
// compared with one that always answers by kappa alone: kappa counts every
// abstention as a miss. This compares them as selective predictors: strict
// (whole-word) accuracy on the takes each system ANSWERS, at matched
// coverage, plus the full risk-coverage curve for the learned model.
//   coverage = fraction of takes answered with no 'unclear' mora
//   selective accuracy = strict accuracy among answered takes
// The learned Gaussians (trained on JSUT only -- cross-corpus) get a
// confidence = log-likelihood margin between their best and second-best
// pattern; the shipped decoder abstains by its own evidence guard.
'use strict';
const H = require('./paper-harness.js');
const PD = require('../js/pitch-diagram.js');
const MS = H.shipped;
const D = H.load();
const L = require('./paper-exp-learned-lib.js');

const gauss = L.trainGauss([].concat(D.jsutApp.train, D.jsutPhrase.train));

function evalSet(set) {
  const shipped = [], learned = [];
  for (const s of set) {
    if (!s.trace.some((f) => f && f.hz != null) || s.moraCount < 2) continue;
    const tgts = s.accents.map((a) => PD.pitchLevels(s.moraCount, a).slice(0, s.moraCount).join(''));
    const p = MS.segmentByMora(s.trace, s.moraCount, { morae: s.morae }).pattern;
    shipped.push({ answered: !p.includes('unclear'), correct: tgts.includes(p.join('')) });
    const g = L.gaussWithMargin(gauss, s);
    learned.push(g ? { margin: g.margin, correct: tgts.includes(g.pat) } : { margin: -Infinity, correct: false });
  }
  const cov = shipped.filter((x) => x.answered).length / shipped.length;
  const accShip = shipped.filter((x) => x.answered && x.correct).length / shipped.filter((x) => x.answered).length;
  const sorted = learned.slice().sort((a, b) => b.margin - a.margin);
  const accAt = (c) => { const k = Math.max(1, Math.round(c * sorted.length)); return sorted.slice(0, k).filter((x) => x.correct).length / k; };
  return { n: shipped.length, cov, accShip, accLearnedMatched: accAt(cov), curve: [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3].map((c) => [c, accAt(c)]) };
}
const pct = (x) => (100 * x).toFixed(1) + '%';
for (const [name, set] of [['UME natives B', D.ume.B], ['UME natives all', D.ume.all], ['JSUT app test', D.jsutApp.test], ['UME learners', D.ume.learners]]) {
  const r = evalSet(set);
  console.log(`${name} (n=${r.n}): shipped answers ${pct(r.cov)} with ${pct(r.accShip)} whole-word accuracy; ` +
    `learned (JSUT-trained) at the SAME coverage: ${pct(r.accLearnedMatched)}`);
  console.log('   learned risk-coverage: ' + r.curve.map(([c, a]) => `${Math.round(100 * c)}%:${pct(a)}`).join('  '));
}
