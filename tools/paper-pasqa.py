#!/usr/bin/env python3
"""paper-pasqa.py -- external comparison: PASQA (Kawamura et al., Interspeech
2026; https://huggingface.co/ly-corporation/PASQA, Apache-2.0), an SSL-based
MOS predictor for synthesized Japanese speech focused on pitch-accent
correctness. It takes audio + the katakana mora list (NOT the target accent)
and returns one quality score (~1-5) plus per-frame error probabilities --
no H/L pattern, so within-mora-count kappa can't be computed for it. It is
compared instead on the binary decision a tutor makes ("is this accent
right?"), on data with known answers:

  T1 accent-removed detection (UME-JRF natives B, ACCENTED-target words):
     correct = the word vocoded with its own F0 ('copy'), wrong = the same
     word vocoded with the accent removed ('flat' / 'decl'; tools/paper-
     flatten.py). Vocoded vs vocoded, so a quality model can't win by
     detecting vocoder artifacts. Reported: PASQA AUC, and PASQA's
     acceptance of correct words at the SAME false-acceptance rate as the
     proposed decoder (threshold picked on this test data -- an optimistic,
     oracle threshold for PASQA, disclosed).
  T2 criterion validity: speaker-level mean score, natives B vs the 141
     learners, AUC (proposed decoder: 0.914; tools/paper-exp-validity.js).

Morae: our orthographic readings are converted to PASQA's pronunciation-
style vocab (う after an o/u-row mora -> ー, い after an e-row mora -> ー,
ヂ/ヅ -> ジ/ズ).

Run in PASQA's own environment (Python 3.10, pinned torch/s3prl):
  git clone https://github.com/lycorp-jp/PASQA && cd PASQA && uv sync
  # download checkpoint-100000steps.pkl + config.yml into pretrained/
  PASQA_DIR=... .venv/bin/python /path/to/onchou/tools/paper-pasqa.py
Needs tools/tmp/slots-export.jsonl and flat-export.jsonl (tools/paper-
export-slots.js, tools/paper-exp-flat.js).
"""
import json, os, sys, collections
import numpy as np

TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tmp')
PASQA_DIR = os.environ['PASQA_DIR']
sys.path.insert(0, os.path.join(PASQA_DIR, 'src'))
from pasqa import PasqaPredictor  # noqa: E402

def kata(s):
    return ''.join(chr(ord(c) + 0x60) if 'ぁ' <= c <= 'ゖ' else c for c in s)
ROW = {}
for v, chars in {'a': 'アカサタナハマヤラワガザダバパャァ', 'i': 'イキシチニヒミリギジヂビピィ', 'u': 'ウクスツヌフムユルグズヅブプュゥ',
                 'e': 'エケセテネヘメレゲゼデベペェ', 'o': 'オコソトノホモヨロヲゴゾドボポョォ'}.items():
    for c in chars: ROW[c] = v
def pasqa_morae(morae):
    out = []
    for m in (kata(x) for x in morae):
        m = m.replace('ヂ', 'ジ').replace('ヅ', 'ズ')
        prev = ROW.get(out[-1][-1]) if out else None
        if m == 'ウ' and prev in ('o', 'u'): m = 'ー'
        elif m == 'イ' and prev == 'e': m = 'ー'
        out.append(m)
    return out

def pl(n, a):
    return [('L' if i == 0 else 'H') if a == 0 else (('H' if i == 0 else 'L') if a == 1 else ('L' if i == 0 else ('H' if i < a else 'L'))) for i in range(n)]

pred = PasqaPredictor(checkpoint=os.path.join(PASQA_DIR, 'pretrained', 'checkpoint-100000steps.pkl'))
exp = [json.loads(l) for l in open(os.path.join(TMP, 'slots-export.jsonl'))]
flat = [json.loads(l) for l in open(os.path.join(TMP, 'flat-export.jsonl'))]
morae_of = {}  # UME wav basename key -> morae, from the main export
for s in exp:
    if s['split'].startswith('ume.'): morae_of[s['wav'].split('UME-JRF/wav/')[1]] = s['morae']

cache_path = os.path.join(TMP, 'pasqa-scores.json')
scores = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
def score(wav, morae):
    if wav not in scores:
        scores[wav] = pred.predict(wav_path=wav, mora=pasqa_morae(morae))['mos']
    return scores[wav]

todo = [(s['wav'], s['morae']) for s in exp if s['split'] in ('ume.B', 'ume.learners')]
todo += [(s['wav'], morae_of[s['wav'].split('/flat/')[1].split('/', 1)[1]]) for s in flat]
for k, (w, m) in enumerate(todo):
    score(w, m)
    if k % 3000 == 0: print(f'  {k}/{len(todo)}', flush=True); json.dump(scores, open(cache_path, 'w'))
json.dump(scores, open(cache_path, 'w'))

def auc(pos, neg):
    pos, neg = np.array(pos), np.array(neg)
    return float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean())

# ---- T1: accent-removed detection on accented-target words
by = collections.defaultdict(list)
for s in flat:
    if s['noFall']: continue
    by[s['split']].append(score(s['wav'], morae_of[s['wav'].split('/flat/')[1].split('/', 1)[1]]))
copy = by['flat.copy']
print(f"\nT1 accent-removed detection (natives B, accented targets; n={len(copy)} per condition)")
# the proposed decoder's operating point on the same words (tools/paper-exp-flat.js, corrected run)
ours = {'copy': 0.611, 'flat.flat': 0.068, 'flat.decl': 0.142}
for neg in ('flat.flat', 'flat.decl'):
    a = auc(copy, by[neg])
    thr = np.quantile(by[neg], 1 - ours[neg])  # PASQA threshold giving the SAME false acceptance as ours
    tpr = float((np.array(copy) > thr).mean())
    print(f"  copy vs {neg.split('.')[1]:4s}: PASQA AUC={a:.3f} | at our false-acceptance {100*ours[neg]:.1f}%: "
          f"PASQA accepts {100*tpr:.1f}% of correct words (ours {100*ours['copy']:.1f}%)")
print(f"  mean MOS: copy {np.mean(copy):.3f}, flat {np.mean(by['flat.flat']):.3f}, decl {np.mean(by['flat.decl']):.3f}")

# ---- T2: speaker-level native vs learner separation
spk = collections.defaultdict(list)
for s in exp:
    if s['split'] in ('ume.B', 'ume.learners'):
        spk[(s['split'], s['cluster'])].append(score(s['wav'], s['morae']))
nat = [np.mean(v) for (sp, _), v in spk.items() if sp == 'ume.B']
lea = [np.mean(v) for (sp, _), v in spk.items() if sp == 'ume.learners']
print(f"\nT2 speaker-level native vs learner: PASQA AUC={auc(nat, lea):.3f} "
      f"(mean MOS natives {np.mean(nat):.3f}, learners {np.mean(lea):.3f}; {len(nat)} vs {len(lea)} speakers; proposed decoder 0.914)")
