#!/usr/bin/env python3
"""paper-fa-check.py -- validates the CTC forced aligner used by
tools/paper-fa.py against a trusted reference: jsut-label's Julius mora
boundaries on JSUT. Aligns each sentence's FIRST accent phrase (the
app-like 'initial' samples: real leading silence, like a single word) from
its jsut-label phones, then reports the signed error of every interior
mora boundary (aligned - Julius). A systematic offset or a large spread
means the aligner's mora boundaries can't serve as an "oracle".

  JSUT_LABEL_DIR=... /home/bagustris/github/sf-ssl/.venv/bin/python tools/paper-fa-check.py
"""
import json, os, glob, sys
import numpy as np
import soundfile as sf
import torch, torchaudio
from transformers import Wav2Vec2ForCTC

sys.path.insert(0, os.path.dirname(__file__))
TMP = os.path.join(os.path.dirname(__file__), 'tmp')
snap = glob.glob(os.path.expanduser('~/.cache/huggingface/hub/models--facebook--wav2vec2-xlsr-53-espeak-cv-ft/snapshots/*/vocab.json'))[0]
vocab = json.load(open(snap))
model = Wav2Vec2ForCTC.from_pretrained('facebook/wav2vec2-xlsr-53-espeak-cv-ft').cuda().eval()

# jsut-label (Julius) phone -> espeak tokens, matching tools/paper-fa.py's kana mapping
P = {'a': ['a'], 'i': ['i'], 'u': ['ɯ'], 'e': ['e'], 'o': ['o'], 'N': ['ɴ'], 'cl': ['ʔ'],
     'sh': ['ɕ'], 'ch': ['tɕ'], 'ts': ['ts'], 'j': ['dʑ'], 'f': ['ɸ'], 'y': ['j'], 'r': ['ɾ'], 'g': ['ɡ'],
     'ky': ['k', 'j'], 'gy': ['ɡ', 'j'], 'ny': ['ɲ'], 'hy': ['ç'], 'by': ['b', 'j'], 'py': ['p', 'j'],
     'my': ['m', 'j'], 'ry': ['ɾ', 'j'], 'dy': ['d', 'j'], 'ty': ['t', 'j'], 'v': ['b'], 'z': ['z']}
for c in 'kstnhmwdbp': P.setdefault(c, [c])

def parse_lab(path):
    """-> list of accent phrases, each a list of moras (start, end, [phones]), via the same
    phrase grouping as tools/jsut-lab-parser.js (a2 = mora position; the whole F field is
    the phrase key, plus a split wherever a2 resets)."""
    import re
    phones = []
    for line in open(path):
        p = line.split()
        if len(p) < 3: continue
        ctx = p[2]
        m = re.match(r'^(.+?)\^(.+?)-(.+?)\+(.+?)=(.+?)/', ctx)
        a = re.search(r'/A:([^+]+)\+([^+]+)\+([^/]+)/', ctx)
        f = re.search(r'/F:([^_]+)_([^#]+)#', ctx)
        # Group by the WHOLE F field: (f1, f2) alone is not a unique phrase key --
        # adjacent phrases can share it (BASIC5000_4989: F:4_4...@1_2 then F:4_4...@2_1).
        full = re.search(r'/F:([^/]+)/', ctx)
        key = full.group(1) if (f and 'xx' not in (f.group(1), f.group(2))) else 'xx'
        phones.append((int(p[0]) / 1e7, int(p[1]) / 1e7, m.group(3), a.group(2) if a else 'xx', key))
    groups, cur = [], None
    for s, e, ph, a2, key in phones:
        if key == 'xx': cur = None; continue
        # new phrase on a changed F field, or when the mora position resets
        reset = cur is not None and cur['ph'] and a2 != 'xx' and cur['ph'][-1][3] != 'xx' and int(a2) < int(cur['ph'][-1][3])
        if cur is None or cur['key'] != key or reset: cur = {'key': key, 'ph': []}; groups.append(cur)
        cur['ph'].append((s, e, ph, a2))
    out = []
    for g in groups:
        moras = {}
        order = []
        for s, e, ph, a2 in g['ph']:
            if a2 not in moras: moras[a2] = [s, e, []]; order.append(a2)
            moras[a2][1] = e; moras[a2][2].append(ph)
        out.append([moras[k] for k in sorted(order, key=int)])
    return out

lab_dir = os.environ['JSUT_LABEL_DIR']
if not os.path.exists(os.path.join(lab_dir, 'BASIC5000_0001.lab')): lab_dir = os.path.join(lab_dir, 'labels', 'basic5000')
errs, fails, n = [], 0, 0
for k in range(1, 1001):  # first 1000 sentences are plenty for an offset estimate
    sid = f'BASIC5000_{k:04d}'
    ph = parse_lab(os.path.join(lab_dir, sid + '.lab'))
    if not ph: continue
    moras = ph[0]
    toks, owner = [], []
    try:
        for mi, (_, _, pp) in enumerate(moras):
            for p in pp:
                for t in P[p]: toks.append(vocab[t]); owner.append(mi)
    except KeyError:
        fails += 1; continue
    x, sr = sf.read(f'/data/jsut_ver1.1/basic5000/wav/{sid}.wav', dtype='float32')
    end = int((moras[-1][1] + 0.3) * sr)
    t = torchaudio.functional.resample(torch.from_numpy(x[:end]), sr, 16000)
    with torch.no_grad():
        lp = torch.log_softmax(model(t[None].cuda()).logits, -1)
    try:
        ali, _ = torchaudio.functional.forced_align(lp, torch.tensor([toks], device='cuda'), blank=vocab['<pad>'])
    except Exception:
        fails += 1; continue
    ali = ali[0].cpu().numpy()
    spans, prev = [], None
    for f, a in enumerate(ali):
        if a == vocab['<pad>']: prev = None; continue
        if prev is None or a != prev or (spans and f != spans[-1][1] + 1): spans.append([f, f])
        else: spans[-1][1] = f
        prev = a
    if len(spans) != len(toks): fails += 1; continue
    starts = {}
    for (a, _), o in zip(spans, owner): starts.setdefault(o, a * 0.02)
    for mi in range(1, len(moras)):  # interior boundaries: start of mora mi
        errs.append(starts[mi] - moras[mi][0])
    n += 1
errs = np.array(errs) * 1000
print(f'phrases aligned {n}, failed {fails}; {len(errs)} interior mora boundaries')
print(f'signed error (aligned - Julius), ms: mean {errs.mean():.1f}  median {np.median(errs):.1f}  '
      f'p10 {np.percentile(errs, 10):.1f}  p90 {np.percentile(errs, 90):.1f}  |err|<20ms {np.mean(np.abs(errs) < 20):.1%}  |err|<50ms {np.mean(np.abs(errs) < 50):.1%}')
