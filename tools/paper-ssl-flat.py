#!/usr/bin/env python3
"""paper-ssl-flat.py -- the flat-attempt check for the WavLM upper bound
(tools/paper-ssl.py): the same layer-8 per-mora classifier, trained on JSUT
(cross-corpus regime), scored on natives-B words resynthesized with no
accent (tools/paper-flatten.py / tools/paper-exp-flat.js export). A forced-
choice SSL scorer has no abstention, so this measures how often it calls a
take with NO accent "correct".

  /home/bagustris/github/sf-ssl/.venv/bin/python tools/paper-ssl-flat.py
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
L = 8

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

train_rows = [json.loads(l) for l in open(os.path.join(TMP, 'slots-export.jsonl'))]
F = load_features('wavlm-large', L, os.path.join(TMP, 'slots-export.jsonl'))

def pitch_levels(n, a):
    return [('L' if i == 0 else 'H') if a == 0 else (('H' if i == 0 else 'L') if a == 1 else ('L' if i == 0 else ('H' if i < a else 'L'))) for i in range(n)]
def valid(n):
    out = [[0] + [1] * (n - 1), [1] + [0] * (n - 1)]
    for d in range(2, n): out.append([0] + [1 if i < d else 0 for i in range(1, n)])
    return out
def rows(Fi):
    n = len(Fi); out = []
    for i in range(n):
        prev = Fi[i] - Fi[i - 1] if i > 0 else np.zeros_like(Fi[i])
        nxt = Fi[i + 1] - Fi[i] if i < n - 1 else np.zeros_like(Fi[i])
        out.append(np.concatenate([Fi[i], prev, nxt, np.array([i == 0, i == n - 1, i / max(1, n - 1)], np.float32)]))
    return out

X, y = [], []
for i, s in enumerate(train_rows):
    if s['split'] not in ('jsutApp.train', 'jsutPhrase.train'): continue
    for r, lab in zip(rows(F[i].astype(np.float32)), pitch_levels(s['moraCount'], s['accents'][0])):
        X.append(r); y.append(lab == 'H')
X, y = np.array(X), np.array(y)
sc = StandardScaler().fit(X); pca = PCA(256, random_state=0).fit(sc.transform(X))
clf = LogisticRegression(max_iter=2000, C=0.1).fit(pca.transform(sc.transform(X)), y)
print('trained on', len(y), 'JSUT morae', flush=True)

model = AutoModel.from_pretrained('microsoft/wavlm-large').cuda().eval().half()
ev = [json.loads(l) for l in open(os.path.join(TMP, 'flat-export.jsonl'))]
acc = collections.defaultdict(lambda: [0, 0])
for s in ev:
    x, sr = sf.read(s['wav'], dtype='float32')
    t = torch.from_numpy(x)
    if sr != 16000: t = torchaudio.functional.resample(t, sr, 16000)
    t = (t - t.mean()) / (t.std() + 1e-7)
    with torch.no_grad():
        h = model(t[None].cuda().half(), output_hidden_states=True).hidden_states[L][0].float().cpu().numpy()
    c = np.arange(len(h)) * 0.02 + 0.0125
    Fi = []
    for a, b in s['slots']:
        m = (c >= a) & (c < b)
        if not m.any(): m = np.zeros(len(h), bool); m[min(len(h) - 1, max(0, int(round((a + b) / 2 / 0.02))))] = True
        Fi.append(h[m].mean(0))
    lp = clf.predict_log_proba(pca.transform(sc.transform(np.array(rows(np.stack(Fi))))))
    best = max(valid(s['moraCount']), key=lambda t_: sum(lp[k, t_[k]] for k in range(len(t_))))
    pred = ['H' if v else 'L' for v in best]
    ok = any(pitch_levels(s['moraCount'], a) == pred for a in s['accents'])
    key = (s['split'], 'no-fall' if s['noFall'] else 'accented')
    acc[key][1] += 1; acc[key][0] += ok
print('\nWavLM L8 (JSUT-trained): % of natives-B words scored fully CORRECT')
for v in ('flat.copy', 'flat.flat', 'flat.decl'):
    a, n = acc[(v, 'accented')], acc[(v, 'no-fall')]
    print(f'  {v:10s} accented {100 * a[0] / a[1]:5.1f}%   no-fall {100 * n[0] / n[1]:5.1f}%')
