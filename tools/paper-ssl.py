#!/usr/bin/env python3
"""paper-ssl.py -- option #8 (upper bound, NOT shippable in onchou): self-
supervised speech features instead of a hand-made F0 front end.

For every sample exported by tools/paper-export-slots.js (same splits, same
PRODUCTION mora-slot windows: voice gate + 20ms delay, no forced alignment),
WavLM-large hidden states are mean-pooled over each mora slot. A per-mora
H/L logistic-regression classifier (features: the slot, its differences to
the neighbouring slots, relative position) is trained, and each take is
decoded CONSTRAINED to the n+1 valid Tokyo patterns (max summed log-prob) --
the same structure as the shipped decoder, so only the evidence differs.

Training regimes mirror tools/paper-exp-learned.js:
  cross-corpus: JSUT train (app-like + phrase)  -> UME natives B, JSUT app test
  in-domain:    UME natives A                    -> UME natives B
  pooled:       JSUT train + UME natives A       -> both
The layer is chosen on the choosing split (UME natives A, trained on JSUT).
Metrics match tools/paper-harness.js: within-mora-count kappa, strict
accuracy; plus selective accuracy at the shipped decoder's own coverage
(confidence = log-prob margin between best and second-best valid pattern).

Run with a CUDA torch + transformers environment, e.g.:
  /home/bagustris/github/sf-ssl/.venv/bin/python tools/paper-ssl.py
"""
import json, os, sys, collections
import numpy as np
import soundfile as sf
import torch, torchaudio
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA

TMP = os.path.join(os.path.dirname(__file__), 'tmp')
EXPORT = os.path.join(TMP, 'slots-export.jsonl')
MODEL = os.environ.get('SSL_MODEL', 'microsoft/wavlm-large')
LAYERS = [int(x) for x in os.environ.get('SSL_LAYERS', '4,8,12,16,20,24').split(',')]
tag = MODEL.split('/')[-1]

samples = [json.loads(l) for l in open(EXPORT)]
print(f'{len(samples)} samples; model {MODEL}; layers {LAYERS}', flush=True)

# ---------------------------------------------------------------- features
# The cache holds one feature array per export line, aligned BY POSITION, so
# it is only valid for the exact export (and model/layers) it was built
# from: a fingerprint of those is stored with it, and a mismatch rebuilds.
import hashlib
def export_fingerprint():
    h = hashlib.sha1(open(EXPORT, 'rb').read())
    h.update(f'|{MODEL}|{sorted(LAYERS)}'.encode())
    return h.hexdigest()
FP = export_fingerprint()
cache = os.path.join(TMP, f'ssl-{tag}-slots.npz')
z = np.load(cache, allow_pickle=True) if os.path.exists(cache) else None
if z is not None and 'fingerprint' in z.files and str(z['fingerprint']) == FP and all(f'L{L}' in z.files for L in LAYERS):
    feats = {L: list(z[f'L{L}']) for L in LAYERS}
else:
    if z is not None: print('feature cache is stale (export/model/layers changed) -- rebuilding', flush=True)
    from transformers import AutoModel
    dev = 'cuda'
    model = AutoModel.from_pretrained(MODEL).to(dev).eval().half()
    by_wav = collections.defaultdict(list)
    for i, s in enumerate(samples): by_wav[s['wav']].append(i)
    feats = {L: [None] * len(samples) for L in LAYERS}
    for k, (wav, idxs) in enumerate(by_wav.items()):
        x, sr = sf.read(wav, dtype='float32')
        if x.ndim > 1: x = x[:, 0]
        t = torch.from_numpy(x)
        if sr != 16000: t = torchaudio.functional.resample(t, sr, 16000)
        t = (t - t.mean()) / (t.std() + 1e-7)
        with torch.no_grad():
            hs = model(t[None].to(dev).half(), output_hidden_states=True).hidden_states
        nfr = hs[0].shape[1]
        # frame j covers ~[j*0.02, j*0.02+0.025]; use centre j*0.02+0.0125
        centres = np.arange(nfr) * 0.02 + 0.0125
        for L in LAYERS:
            h = hs[L][0].float().cpu().numpy()
            for i in idxs:
                rows = []
                for a, b in samples[i]['slots']:
                    m = (centres >= a) & (centres < b)
                    if not m.any(): m = np.zeros(nfr, bool); m[min(nfr - 1, max(0, int(round((a + b) / 2 / 0.02))))] = True
                    rows.append(h[m].mean(0))
                feats[L][i] = np.stack(rows).astype(np.float16)
        if k % 500 == 0: print(f'  {k}/{len(by_wav)} files', flush=True)
    np.savez(cache, fingerprint=FP, **{f'L{L}': np.array(feats[L], dtype=object) for L in LAYERS})

# ---------------------------------------------------------------- helpers
def pitch_levels(n, a):
    lv = []
    for i in range(n):
        if a == 0: lv.append('L' if i == 0 else 'H')
        elif a == 1: lv.append('H' if i == 0 else 'L')
        else: lv.append('L' if i == 0 else ('H' if i < a else 'L'))
    return lv
def valid_patterns(n):
    out = [[0] + [1] * (n - 1), [1] + [0] * (n - 1)]
    for d in range(2, n): out.append([0] + [1 if i < d else 0 for i in range(1, n)])
    return out

def mora_rows(F):
    n = len(F)
    rows = []
    for i in range(n):
        prev = F[i] - F[i - 1] if i > 0 else np.zeros_like(F[i])
        nxt = F[i + 1] - F[i] if i < n - 1 else np.zeros_like(F[i])
        pos = np.array([i == 0, i == n - 1, i / max(1, n - 1)], dtype=np.float32)
        rows.append(np.concatenate([F[i], prev, nxt, pos]))
    return rows

def build(idxs, L):
    X, y = [], []
    for i in idxs:
        s = samples[i]
        tgt = pitch_levels(s['moraCount'], s['accents'][0])
        for r, lab in zip(mora_rows(feats[L][i].astype(np.float32)), tgt):
            X.append(r); y.append(1 if lab == 'H' else 0)
    return np.array(X), np.array(y)

def fit(idxs, L):
    X, y = build(idxs, L)
    sc = StandardScaler().fit(X)
    pca = PCA(n_components=min(256, X.shape[1]), random_state=0).fit(sc.transform(X))
    clf = LogisticRegression(max_iter=2000, C=0.1).fit(pca.transform(sc.transform(X)), y)
    return (sc, pca, clf)

def decode(m, i, L):
    sc, pca, clf = m
    s = samples[i]
    lp = clf.predict_log_proba(pca.transform(sc.transform(np.array(mora_rows(feats[L][i].astype(np.float32))))))
    scores = sorted(((sum(lp[k, t[k]] for k in range(len(t))), t) for t in valid_patterns(s['moraCount'])), key=lambda z: -z[0])
    best = scores[0]
    margin = best[0] - scores[1][0] if len(scores) > 1 else np.inf
    return ['H' if v else 'L' for v in best[1]], margin

def metrics(idxs, preds):
    by = collections.defaultdict(lambda: {'t': collections.Counter(), 'p': collections.Counter(), 'a': 0, 'N': 0})
    strict = 0
    for i, p in zip(idxs, preds):
        s = samples[i]
        tg = pitch_levels(s['moraCount'], s['accents'][0])
        for a in s['accents']:
            if pitch_levels(s['moraCount'], a) == p: tg = p
        g = by[s['moraCount']]; tl, pl = ''.join(tg), ''.join(p)
        g['t'][tl] += 1; g['p'][pl] += 1; g['N'] += 1
        if tl == pl: g['a'] += 1; strict += 1
    ks = kw = 0
    for g in by.values():
        if g['N'] < 20 or len(g['t']) < 2: continue
        pe = sum((c / g['N']) * (g['p'][l] / g['N']) for l, c in g['t'].items())
        ks += g['N'] * ((g['a'] / g['N'] - pe) / (1 - pe)); kw += g['N']
    return ks / kw, strict / len(idxs)

def selective(idxs, preds, margins):
    """Strict accuracy at the shipped decoder's own coverage on this set."""
    answered = [not any(x == 'unclear' for x in samples[i]['shipped']) for i in idxs]
    cov = sum(answered) / len(idxs)
    ok_ship = [samples[i]['shipped'] in [pitch_levels(samples[i]['moraCount'], a) for a in samples[i]['accents']] for i in idxs]
    acc_ship = sum(o for o, a in zip(ok_ship, answered) if a) / max(1, sum(answered))
    ok = [p in [pitch_levels(samples[i]['moraCount'], a) for a in samples[i]['accents']] for i, p in zip(idxs, preds)]
    order = np.argsort(-np.array(margins))
    k = max(1, int(round(cov * len(idxs))))
    return cov, acc_ship, float(np.mean([ok[j] for j in order[:k]]))

split = collections.defaultdict(list)
for i, s in enumerate(samples): split[s['split']].append(i)
jsut_train = split['jsutApp.train'] + split['jsutPhrase.train']

# ---------------------------------------------------------------- layer choice
print('\nlayer choice: train JSUT, evaluate on UME natives A (choosing split)', flush=True)
best_L, best_k = None, -1
for L in LAYERS:
    m = fit(jsut_train, L)
    preds = [decode(m, i, L)[0] for i in split['ume.A']]
    k, st = metrics(split['ume.A'], preds)
    print(f'  layer {L:2d}: kappa={k:.3f} strict={st:.3f}', flush=True)
    if k > best_k: best_L, best_k = L, k
print(f'chosen layer {best_L}', flush=True)

# ---------------------------------------------------------------- report
L = best_L
regimes = [('cross-corpus (JSUT)', jsut_train), ('in-domain (UME A)', split['ume.A']), ('pooled (JSUT+UME A)', jsut_train + split['ume.A'])]
results = {}
for name, tr in regimes:
    m = fit(tr, L)
    for test in ['ume.B', 'jsutApp.test', 'ume.learners']:
        out = [decode(m, i, L) for i in split[test]]
        preds, margins = [o[0] for o in out], [o[1] for o in out]
        k, st = metrics(split[test], preds)
        cov, acc_ship, acc_sel = selective(split[test], preds, margins)
        results[f'{name}|{test}'] = dict(kappa=k, strict=st, coverage=cov, shipped_sel=acc_ship, ssl_sel=acc_sel)
        print(f'{name:22s} -> {test:13s} kappa={k:.3f} strict={st:.3f} | at shipped coverage {cov:.3f}: shipped {acc_ship:.3f} vs SSL {acc_sel:.3f}', flush=True)
json.dump({'model': MODEL, 'layer': L, 'results': results}, open(os.path.join(TMP, f'ssl-{tag}-results.json'), 'w'), indent=2)
