// paper-exp-learned-lib.js -- the Ishi-style F0ratio Gaussian classifier
// (one diagonal Gaussian per (mora count, pattern), equal class priors) on
// production slot values, as a reusable module for tools/paper-exp-*.js.
'use strict';
const PD = require('../js/pitch-diagram.js');
const MS = require('../js/mora-segment.js');

function fill(v) {
  const n = v.length, idx = [];
  v.forEach((x, i) => { if (x != null) idx.push(i); });
  if (idx.length < 2) return null;
  const w = v.slice();
  for (let i = 0; i < n; i++) {
    if (w[i] != null) continue;
    let l = i - 1; while (l >= 0 && v[l] == null) l--;
    let r = i + 1; while (r < n && v[r] == null) r++;
    w[i] = l < 0 ? v[r] : r >= n ? v[l] : v[l] + ((v[r] - v[l]) * (i - l)) / (r - l);
  }
  return w.map((x) => 1200 * Math.log2(x));
}
function features(s) {
  const c = MS._computeSlots(s.trace, s.moraCount);
  const f = c && fill(c.slotMedians);
  return f ? f.slice(1).map((x, i) => x - f[i]) : null;
}
function trainGauss(train) {
  const m = new Map();
  for (const s of train) {
    if (s.moraCount < 2) continue;
    const x = features(s); if (!x) continue;
    const pat = PD.pitchLevels(s.moraCount, s.accents[0]).slice(0, s.moraCount).join('');
    if (!m.has(s.moraCount)) m.set(s.moraCount, new Map());
    const g = m.get(s.moraCount).get(pat) || { s: x.map(() => 0), q: x.map(() => 0), n: 0 };
    x.forEach((xi, i) => { g.s[i] += xi; g.q[i] += xi * xi; }); g.n++;
    m.get(s.moraCount).set(pat, g);
  }
  return m;
}
// -> {pat, margin} (log-likelihood margin best vs second best) or null.
function gaussWithMargin(model, s) {
  const x = features(s), m = model.get(s.moraCount);
  if (!x || !m) return null;
  const lls = [];
  for (const [pat, g] of m) {
    if (g.n < 10) continue;
    let ll = 0;
    for (let i = 0; i < x.length; i++) { const mu = g.s[i] / g.n; const vr = Math.max(2500, g.q[i] / g.n - mu * mu); ll += -0.5 * Math.log(vr) - (x[i] - mu) ** 2 / (2 * vr); }
    lls.push({ pat, ll });
  }
  if (!lls.length) return null;
  lls.sort((a, b) => b.ll - a.ll);
  return { pat: lls[0].pat, margin: lls.length > 1 ? lls[0].ll - lls[1].ll : Infinity };
}
function paramCount(model) {
  let k = 0;
  for (const m of model.values()) for (const g of m.values()) if (g.n >= 10) k += 2 * g.s.length;
  return k;
}
module.exports = { trainGauss, gaussWithMargin, features, paramCount };
