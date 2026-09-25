#!/usr/bin/env python3
"""paper-ssl-extra.py -- two checks on the SSL upper bounds (tools/paper-ssl.py):

1. LEXICAL SHORTCUT. In the in-domain regime (UME natives A -> B) train and
   test share the same 104 words, so an SSL model that recognizes the word
   can learn word -> accent without using pitch. Re-run with a WORD-disjoint
   split as well as a speaker-disjoint one: train on natives A saying words in
   one half of the list, test on natives B saying the OTHER half. The JSUT-
   trained (cross-corpus) model is scored on the same test words.
2. MONOTONE TEST for each model: natives-B words resynthesized with no accent
   (tools/paper-flatten.py); % of accented-target words still scored correct.

Uses the cached slot features from tools/paper-ssl.py (per model/layer).
  /home/bagustris/github/sf-ssl/.venv/bin/python tools/paper-ssl-extra.py
"""
import json, os, collections
import numpy as np
import soundfile as sf
import torch, torchaudio
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA
from transformers import AutoModel

TMP = os.path.join(os.path.dirname(__file__), 'tmp')
MODELS = [('microsoft/wavlm-large', 8), ('reazon-research/japanese-hubert-base-k2', 8)]

def load_features(tag, L, export_path):
    """Cached SSL slot features from tools/paper-ssl.py -- refused unless they
    were built from exactly this export (features are aligned by position)."""
    import hashlib
    path = os.path.join(TMP, f'ssl-{tag}-slots.npz')
    z = np.load(path, allow_pickle=True)
    if 'fingerprint' not in z.files:
        raise SystemExit(f'{path} has no fingerprint -- rebuild it with tools/paper-ssl.py')
    model = {'wavlm-large': 'microsoft/wavlm-large', 'japanese-hubert-base-k2': 'reazon-research/japanese-hubert-base-k2'}[tag]
    layers = sorted(int(k[1:]) for k in z.files if k.startswith('L'))
    h = hashlib.sha1(open(export_path, 'rb').read()); h.update(f'|{model}|{layers}'.encode())
    if str(z['fingerprint']) != h.hexdigest():
        raise SystemExit(f'{path} is stale for {export_path} -- re-run tools/paper-ssl.py')
    return z[f'L{L}']

samples = [json.loads(l) for l in open(os.path.join(TMP, 'slots-export.jsonl'))]
flat = [json.loads(l) for l in open(os.path.join(TMP, 'flat-export.jsonl'))]

def pl(n, a):
    return [('L' if i == 0 else 'H') if a == 0 else (('H' if i == 0 else 'L') if a == 1 else ('L' if i == 0 else ('H' if i < a else 'L'))) for i in range(n)]
def valid(n):
    out = [[0] + [1] * (n - 1), [1] + [0] * (n - 1)]
    for d in range(2, n): out.append([0] + [1 if i < d else 0 for i in range(1, n)])
    return out
def rows(Fi):
    n = len(Fi); o = []
    for i in range(n):
        pv = Fi[i] - Fi[i - 1] if i > 0 else np.zeros_like(Fi[i]); nx = Fi[i + 1] - Fi[i] if i < n - 1 else np.zeros_like(Fi[i])
        o.append(np.concatenate([Fi[i], pv, nx, np.array([i == 0, i == n - 1, i / max(1, n - 1)], np.float32)]))
    return o
def fit(F, idxs):
    X, y = [], []
    for i in idxs:
        for r, lab in zip(rows(F[i].astype(np.float32)), pl(samples[i]['moraCount'], samples[i]['accents'][0])): X.append(r); y.append(lab == 'H')
    X = np.array(X); sc = StandardScaler().fit(X); pca = PCA(256, random_state=0).fit(sc.transform(X))
    return sc, pca, LogisticRegression(max_iter=2000, C=0.1).fit(pca.transform(sc.transform(X)), np.array(y))
def decode(m, Fi, n):
    sc, pca, clf = m
    lp = clf.predict_log_proba(pca.transform(sc.transform(np.array(rows(Fi.astype(np.float32))))))
    return ['H' if v else 'L' for v in max(valid(n), key=lambda t: sum(lp[k, t[k]] for k in range(len(t))))]
def kappa(idxs, preds):
    by = collections.defaultdict(lambda: {'t': collections.Counter(), 'p': collections.Counter(), 'a': 0, 'N': 0}); st = 0
    for i, p in zip(idxs, preds):
        s = samples[i]; tg = pl(s['moraCount'], s['accents'][0])
        for a in s['accents']:
            if pl(s['moraCount'], a) == p: tg = p
        g = by[s['moraCount']]; g['t'][''.join(tg)] += 1; g['p'][''.join(p)] += 1; g['N'] += 1
        if tg == p: g['a'] += 1; st += 1
    ks = kw = 0
    for g in by.values():
        if g['N'] < 20 or len(g['t']) < 2: continue
        pe = sum((c / g['N']) * (g['p'][l] / g['N']) for l, c in g['t'].items()); ks += g['N'] * ((g['a'] / g['N'] - pe) / (1 - pe)); kw += g['N']
    return ks / kw, st / len(idxs)

word_of = lambda s: os.path.basename(s['wav'])[3:6]
split = collections.defaultdict(list)
for i, s in enumerate(samples): split[s['split']].append(i)
jsut = split['jsutApp.train'] + split['jsutPhrase.train']
W1 = lambda s: int(word_of(s)) % 2 == 0
for name, L in MODELS:
    tag = name.split('/')[-1]
    F = load_features(tag, L, os.path.join(TMP, 'slots-export.jsonl'))
    trA_all = split['ume.A']; trA_w1 = [i for i in trA_all if W1(samples[i])]
    teB_w2 = [i for i in split['ume.B'] if not W1(samples[i])]; teB_w1 = [i for i in split['ume.B'] if W1(samples[i])]
    lrn_w2 = [i for i in split['ume.learners'] if not W1(samples[i])]
    print(f'\n== {name} layer {L}', flush=True)
    for label, tr in [('in-domain, words SHARED (A all)', trA_all), ('in-domain, WORD-disjoint (A, words W1)', trA_w1), ('cross-corpus (JSUT)', jsut)]:
        m = fit(F, tr)
        for tl, te in [('B words W1', teB_w1), ('B words W2', teB_w2), ('learners W2', lrn_w2)]:
            k, st = kappa(te, [decode(m, F[i], samples[i]['moraCount']) for i in te])
            print(f'  train {label:40s} -> {tl:12s} kappa={k:.3f} strict={st:.3f}', flush=True)
    # monotone test with the JSUT-trained model
    m = fit(F, jsut)
    enc = AutoModel.from_pretrained(name).cuda().eval().half()
    acc = collections.defaultdict(lambda: [0, 0])
    for s in flat:
        x, sr = sf.read(s['wav'], dtype='float32'); t = torch.from_numpy(x)
        if sr != 16000: t = torchaudio.functional.resample(t, sr, 16000)
        t = (t - t.mean()) / (t.std() + 1e-7)
        with torch.no_grad(): h = enc(t[None].cuda().half(), output_hidden_states=True).hidden_states[L][0].float().cpu().numpy()
        c = np.arange(len(h)) * 0.02 + 0.0125; Fi = []
        for a, b in s['slots']:
            mm = (c >= a) & (c < b)
            if not mm.any(): mm = np.zeros(len(h), bool); mm[min(len(h) - 1, max(0, int(round((a + b) / 2 / 0.02))))] = True
            Fi.append(h[mm].mean(0))
        p = decode(m, np.stack(Fi), s['moraCount'])
        ok = any(pl(s['moraCount'], a) == p for a in s['accents'])
        k = (s['split'], 'no-fall' if s['noFall'] else 'accented'); acc[k][1] += 1; acc[k][0] += ok
    for v in ('flat.copy', 'flat.flat', 'flat.decl'):
        a = acc[(v, 'accented')]; print(f'  monotone test (JSUT-trained) {v:10s}: accented-target scored correct {100 * a[0] / a[1]:.1f}%', flush=True)
