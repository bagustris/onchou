#!/usr/bin/env python3
"""paper-devoicing-ume.py -- acoustic devoicing in ISOLATED words (UME-JRF
Set D natives, onchou's actual input), mora by mora.

Mora intervals come from the CTC forced aligner (tools/paper-fa.py ->
tools/tmp/umejrf-fa.json; coarse, ~+40ms late vs Julius on JSUT), the voiced
share of each from pYIN (librosa; WORLD harvest over-voices devoiced vowels,
see tools/paper-devoicing.py). For every devoiceable mora (i/u vowel with
a voiceless onset) it reports how often it is acoustically devoiced, split
by the kana rule's verdict and by position, so the rule's word-final case
(from utterances like です, where it is near-categorical) can be checked on
isolated nouns.

Usage: python3 tools/paper-devoicing-ume.py  (needs tools/tmp/slots-export.jsonl, umejrf-fa.json)
"""
import os, json, collections
from multiprocessing import Pool
import numpy as np

TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tmp')
DEVOICEABLE = set('きくしすちつひふぴぷ') | {'きゅ', 'しゅ', 'ちゅ', 'ひゅ', 'ぴゅ'}
VL_ONSET = set('かきくけこさしすせそたちつてとはひふへほぱぴぷぺぽ')


def rule(morae, final=True, consecutive_block=True):
    """js/mora-segment.js silentMorae, devoicing part only (geminates excluded)."""
    n, out = len(morae), [False] * len(morae)
    for i, m in enumerate(morae):
        if m not in DEVOICEABLE: continue
        if consecutive_block and i > 0 and out[i - 1]: continue
        nxt = morae[i + 1] if i + 1 < n else None
        if nxt == 'っ': nxt = morae[i + 2] if i + 2 < n else None
        out[i] = (final and i == n - 1) if nxt is None else nxt[0] in VL_ONSET
    return out


def fracs(item):
    """pYIN voiced share per mora interval (harvest over-voices devoiced
    vowels; see tools/paper-devoicing.py)."""
    import soundfile as sf, librosa
    from scipy.signal import resample_poly
    wav, iv = item
    x, sr = sf.read(wav)
    if x.ndim > 1: x = x[:, 0]
    if sr != 16000: x = resample_poly(x, 16000, sr)
    _, vflag, _ = librosa.pyin(np.ascontiguousarray(x, dtype=np.float64), fmin=60, fmax=500, sr=16000, frame_length=1024, hop_length=80)
    t = librosa.times_like(vflag, sr=16000, hop_length=80)
    out = []
    for s, e in iv:
        m = (t >= s) & (t < e)
        out.append(float(vflag[m].mean()) if m.any() else 0.0)
    return wav, out


def main():
    fa = json.load(open(os.path.join(TMP, 'umejrf-fa.json')))
    ex = [json.loads(l) for l in open(os.path.join(TMP, 'slots-export.jsonl'))]
    nat = [s for s in ex if s['split'] in ('ume.A', 'ume.B') and fa.get(s['wav']) and len(fa[s['wav']]) == len(s['morae'])]
    cache = os.path.join(TMP, 'devoicing-ume-fracs-pyin.json')
    vf = json.load(open(cache)) if os.path.exists(cache) else {}
    todo = [(s['wav'], fa[s['wav']]) for s in nat if s['wav'] not in vf]
    if todo:
        with Pool(max(1, os.cpu_count() - 2)) as pool:
            for w, r in pool.imap_unordered(fracs, todo, chunksize=8): vf[w] = r
        json.dump(vf, open(cache, 'w'))
    print(f'{len(nat)} native takes with a mora alignment')
    thr = float(os.environ.get('THR', '0.3'))
    tab = collections.defaultdict(list)
    per_word = collections.defaultdict(list)
    for s in nat:
        mo, v = s['morae'], vf[s['wav']]
        r = rule(mo)
        for i, m in enumerate(mo):
            if m not in DEVOICEABLE: continue
            pos = 'initial' if i == 0 else 'final' if i == len(mo) - 1 else 'medial'
            tab[(pos, 'rule:devoiced' if r[i] else 'rule:voiced')].append(v[i] < thr)
            per_word[(''.join(mo), i, r[i])].append(v[i] < thr)
    print(f'\ndevoiceable morae (voiceless onset + i/u): share acoustically devoiced (voiced frames < {thr})')
    for k in sorted(tab): print(f'  {k[0]:8s} {k[1]:14s} {100 * np.mean(tab[k]):5.1f}%  (n={len(tab[k])})')
    # control: morae the rule can never flag (voiced onset or non-high vowel) -- the measurement floor
    ctl = []
    for s in nat:
        for i, m in enumerate(s['morae']):
            if m not in DEVOICEABLE and m not in ('っ', 'ん', 'ー') and m[0] not in VL_ONSET: ctl.append(vf[s['wav']][i] < thr)
    print(f'  control: voiced-onset morae read as devoiced {100 * np.mean(ctl):.1f}% (n={len(ctl)}) -- alignment/tracker floor')
    print('\nper word (devoiceable mora, rule verdict, % devoiced across speakers):')
    for (w, i, rv), g in sorted(per_word.items(), key=lambda kv: -np.mean(kv[1])):
        print(f'  {w:8s} mora {i + 1} {"R" if rv else "-"} {100 * np.mean(g):4.0f}%  n={len(g)}')


if __name__ == '__main__':
    main()
