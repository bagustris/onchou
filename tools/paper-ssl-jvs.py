#!/usr/bin/env python3
"""paper-ssl-jvs.py -- SSL upper bound on JVS (98 speakers, manual JSUT
accents; tools/build-jvs-set.js + tools/paper-export-jvs.js).

Same method as tools/paper-ssl.py: hidden states of one layer mean-pooled
over each PRODUCTION mora slot, a per-mora H/L logistic regression (slot,
neighbour differences, position), decoding constrained to the valid Tokyo
patterns. Regimes:
  JSUT-trained  (JSUT app-like + phrase, sentences 1-4000) -> JVS. JVS reads
                basic5000 sentences 1-3096 -- all inside JSUT train -- so a
                model can recognise text it was trained on instead of hearing
                the accent (the lexical shortcut found on UME-JRF, C7). The fair
                rows train on JSUT MINUS every sentence JVS reads.
  JVS-A-trained (49 speakers)   -> JVS-B (49 other speakers; nonpara30 texts
                differ between speakers, overlap reported)
  pooled        (JSUT text-disjoint + JVS-A) -> JVS-B
Metric: within-mora-count Cohen's kappa (as tools/paper-harness.js), with a
speaker-bootstrap 95% CI, and strict (whole-phrase) accuracy.

  SSL_MODEL=microsoft/wavlm-large SSL_LAYER=8 \\
    /home/bagustris/github/sf-ssl/.venv/bin/python tools/paper-ssl-jvs.py
"""
import json, os, collections, hashlib
import numpy as np
import soundfile as sf
import torch, torchaudio
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA

TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tmp')
MODEL = os.environ.get('SSL_MODEL', 'microsoft/wavlm-large')
L = int(os.environ.get('SSL_LAYER', '8'))
tag = MODEL.split('/')[-1]

jsut = [json.loads(l) for l in open(os.path.join(TMP, 'slots-export.jsonl'))]
jsut = [s for s in jsut if s['split'] in ('jsutApp.train', 'jsutPhrase.train')]
for s in jsut: s['speaker'] = 'JSUT'; s['sentence'] = int(s['cluster'].split('_')[-1])
jvs = [json.loads(l) for l in open(os.path.join(TMP, 'jvs-slots-export.jsonl'))]
samples = jsut + jvs
print(f'{len(jsut)} JSUT train samples, {len(jvs)} JVS samples; {MODEL} layer {L}', flush=True)

# ---- features (cached, fingerprinted by the exports + model + layer)
fp = hashlib.sha1()
for p in ('slots-export.jsonl', 'jvs-slots-export.jsonl'): fp.update(open(os.path.join(TMP, p), 'rb').read())
fp.update(f'|{MODEL}|{L}'.encode()); FP = fp.hexdigest()
cache = os.path.join(TMP, f'ssl-jvs-{tag}-L{L}.npz')
z = np.load(cache, allow_pickle=True) if os.path.exists(cache) else None
if z is not None and str(z['fingerprint']) == FP:
    feats = list(z['F'])
else:
    from transformers import AutoModel
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'  # CPU fallback (float32) when no usable GPU
    model = AutoModel.from_pretrained(MODEL).to(dev).eval()
    if dev == 'cuda': model = model.half()
    print(f'  extracting on {dev}', flush=True)
    feats = [None] * len(samples)
    by_wav = collections.defaultdict(list)
    for i, s in enumerate(samples): by_wav[s['wav']].append(i)
    for k, (w, idxs) in enumerate(by_wav.items()):
        x, sr = sf.read(w, dtype='float32')
        t = torch.from_numpy(x)
        if sr != 16000: t = torchaudio.functional.resample(t, sr, 16000)
        t = (t - t.mean()) / (t.std() + 1e-7)
        with torch.no_grad():
            inp = t[None].to(dev)
            if dev == 'cuda': inp = inp.half()
            h = model(inp, output_hidden_states=True).hidden_states[L][0].float().cpu().numpy()
        c = np.arange(len(h)) * 0.02 + 0.0125
        for i in idxs:
            rows = []
            for a, b in samples[i]['slots']:
                m = (c >= a) & (c < b)
                if not m.any(): m = np.zeros(len(h), bool); m[min(len(h) - 1, max(0, int(round((a + b) / 2 / 0.02))))] = True
                rows.append(h[m].mean(0))
            feats[i] = np.stack(rows).astype(np.float16)
        if k % 250 == 0: print(f'  {k}/{len(by_wav)} files', flush=True)
    np.savez(cache, fingerprint=FP, F=np.array(feats, dtype=object))


def pitch_levels(n, a):
    return ['L' if i == 0 else 'H' for i in range(n)] if a == 0 else (['H' if i == 0 else 'L' for i in range(n)] if a == 1 else ['L' if i == 0 else ('H' if i < a else 'L') for i in range(n)])
def valid_patterns(n):
    out = [[0] + [1] * (n - 1), [1] + [0] * (n - 1)]
    for d in range(2, n): out.append([0] + [1 if i < d else 0 for i in range(1, n)])
    return out
def mora_rows(F):
    n = len(F); rows = []
    for i in range(n):
        prev = F[i] - F[i - 1] if i > 0 else np.zeros_like(F[i])
        nxt = F[i + 1] - F[i] if i < n - 1 else np.zeros_like(F[i])
        rows.append(np.concatenate([F[i], prev, nxt, np.array([i == 0, i == n - 1, i / max(1, n - 1)], dtype=np.float32)]))
    return rows
def fit(idxs):
    X, y = [], []
    for i in idxs:
        for r, lab in zip(mora_rows(feats[i].astype(np.float32)), pitch_levels(samples[i]['moraCount'], samples[i]['accents'][0])):
            X.append(r); y.append(1 if lab == 'H' else 0)
    X = np.array(X); sc = StandardScaler().fit(X)
    pca = PCA(n_components=min(256, X.shape[1]), random_state=0).fit(sc.transform(X))
    return sc, pca, LogisticRegression(max_iter=2000, C=0.1).fit(pca.transform(sc.transform(X)), np.array(y))
def decode(m, i):
    sc, pca, clf = m
    lp = clf.predict_log_proba(pca.transform(sc.transform(np.array(mora_rows(feats[i].astype(np.float32))))))
    best = max(valid_patterns(samples[i]['moraCount']), key=lambda t: sum(lp[k, t[k]] for k in range(len(t))))
    return ['H' if v else 'L' for v in best]
def kappa(items):  # items: [(sample, pred)]
    by = collections.defaultdict(lambda: {'t': collections.Counter(), 'p': collections.Counter(), 'a': 0, 'N': 0})
    strict = 0
    for s, p in items:
        tg = pitch_levels(s['moraCount'], s['accents'][0])
        g = by[s['moraCount']]; tl, pl = ''.join(tg), ''.join(p)
        g['t'][tl] += 1; g['p'][pl] += 1; g['N'] += 1
        if tl == pl: g['a'] += 1; strict += 1
    ks = kw = 0
    for g in by.values():
        if g['N'] < 20 or len(g['t']) < 2: continue
        pe = sum((c / g['N']) * (g['p'][l] / g['N']) for l, c in g['t'].items())
        ks += g['N'] * ((g['a'] / g['N'] - pe) / (1 - pe)); kw += g['N']
    return ks / kw, strict / len(items)
def report(name, m, idxs):
    items = [(samples[i], decode(m, i)) for i in idxs]
    k, st = kappa(items)
    spk = collections.defaultdict(list)
    for it in items: spk[it[0]['speaker']].append(it)
    keys = sorted(spk); rng = np.random.default_rng(20260927); bs = []
    for _ in range(300):
        res = [it for kk in rng.choice(keys, len(keys)) for it in spk[kk]]
        bs.append(kappa(res)[0])
    print(f'| {name} | {len(idxs)} | {k:.3f} [{np.quantile(bs, .025):.3f}, {np.quantile(bs, .975):.3f}] | {100 * st:.1f}% |', flush=True)


idx = collections.defaultdict(list)
for i, s in enumerate(samples): idx[s['split']].append(i)
jsut_tr = idx['jsutApp.train'] + idx['jsutPhrase.train']
jvs_all = idx['jvs.A'] + idx['jvs.B']
jvs_sent = {samples[i]['sentence'] for i in jvs_all}
jsut_tr_dis = [i for i in jsut_tr if samples[i]['sentence'] not in jvs_sent]  # JSUT train minus every sentence JVS reads
sentA = {samples[i]['sentence'] for i in idx['jvs.A']}
overlap = sum(samples[i]['sentence'] in sentA for i in idx['jvs.B'])
print(f'\nJVS reads {len(jvs_sent)} distinct basic5000 sentences (all within JSUT train, 1-4000); text-disjoint JSUT train keeps {len(jsut_tr_dis)} of {len(jsut_tr)} samples')
print(f'JVS-B phrases whose sentence also appears among JVS-A speakers: {overlap}/{len(idx["jvs.B"])}')
print(f'\n{tag} layer {L} -- within-mora-count Cohen\'s kappa [speaker-bootstrap 95% CI], strict = whole-phrase accuracy')
print('| training -> test | n | κ [95% CI] | strict |\n|---|---|---|---|')
report('JSUT train (all; saw every JVS sentence\'s text) -> JVS all', fit(jsut_tr), jvs_all)
m_dis = fit(jsut_tr_dis)
report('JSUT train minus JVS sentences (text-disjoint) -> JVS all', m_dis, jvs_all)
report('JSUT train minus JVS sentences (text-disjoint) -> JVS-B', m_dis, idx['jvs.B'])
report('JVS-A (49 spk) -> JVS-B (49 other spk)', fit(idx['jvs.A']), idx['jvs.B'])
report('JSUT (text-disjoint) + JVS-A -> JVS-B', fit(jsut_tr_dis + idx['jvs.A']), idx['jvs.B'])
