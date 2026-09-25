#!/usr/bin/env python3
"""paper-flatten.py -- realistic MONOTONE attempts for the flat-attempt check:
each held-out native UME-JRF word (natives B) is resynthesized with the WORLD
vocoder keeping its spectral envelope and aperiodicity (same voice, same
segments, same timing) but replacing its F0 contour with
  flat:  the utterance's own median F0 on every voiced frame
  decl:  the same, with a linear 15% fall across the voiced span
          (a monotone speaker with ordinary declination)
  copy:  CONTROL -- the original F0, same WORLD round trip, so any drop on
          flat/decl can be attributed to the missing pitch, not the vocoder
(select with VARIANTS=flat,decl,copy)
A system that marks these "correct" is rewarding a learner who produced no
accent at all. Output: $UMEJRF_DIR/flat/{flat,decl}/<same relative path>.wav
(16kHz; resample to 48kHz afterwards, like the originals).

  UMEJRF_DIR=... python3 tools/paper-flatten.py
"""
import json, os
import numpy as np
import soundfile as sf
import pyworld as pw

TMP = os.path.join(os.path.dirname(__file__), 'tmp')
root = os.environ['UMEJRF_DIR']
wav_root = os.path.join(root, 'UME-JRF', 'wav')
exp = [json.loads(l) for l in open(os.path.join(TMP, 'slots-export.jsonl'))]
wavs = sorted({s['wav'] for s in exp if s['split'] == os.environ.get('SPLIT', 'ume.B')})
print(len(wavs), os.environ.get('SPLIT', 'ume.B'), 'files')
for k, w in enumerate(wavs):
    x, sr = sf.read(w, dtype='float64')
    f0, t = pw.harvest(x, sr, frame_period=5.0)
    sp = pw.cheaptrick(x, f0, t, sr)
    ap = pw.d4c(x, f0, t, sr)
    voiced = f0 > 0
    if voiced.sum() < 3: continue
    med = np.median(f0[voiced])
    idx = np.where(voiced)[0]
    for variant in os.environ.get('VARIANTS', 'flat,decl').split(','):
        g = np.zeros_like(f0)
        if variant == 'copy':  # control: WORLD round trip with the ORIGINAL F0
            g = f0.copy()
        elif variant == 'flat':
            g[voiced] = med
        else:
            frac = (np.arange(len(f0)) - idx[0]) / max(1, idx[-1] - idx[0])
            g[voiced] = med * (1.075 - 0.15 * frac[voiced])  # +7.5% .. -7.5% around the median
        y = pw.synthesize(g, sp, ap, sr, frame_period=5.0)
        out = os.path.join(root, 'flat', variant, os.path.relpath(w, wav_root))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        sf.write(out, np.clip(y, -1, 1).astype(np.float32), sr, subtype="PCM_16")
    if k % 300 == 0: print(f'  {k}/{len(wavs)}', flush=True)
print('done')
