#!/usr/bin/env python3
"""paper-swap.py -- realistic WRONG-ACCENT attempts with known answers, for
measuring error detection without raters.

Each native UME-JRF Set D take (a correct production of a single-accent
word) is resynthesized with WORLD, keeping its spectral envelope,
aperiodicity, timing and its own F0 micro-prosody, but with the accent moved
to every OTHER valid Tokyo pattern for that word length: each mora whose
level differs between the native pattern P and the new pattern P' is shifted
by the speaker's typical accent fall (median over their accented takes of
H-morae minus L-morae F0, in cents, clipped to 100..600), with 40ms cosine ramps between morae. Mora
spans come from the CTC forced aligner (tools/tmp/umejrf-fa.json).

Usage is two passes: the first (no tools/tmp/swap-speaker-gaps.json yet)
measures every take's gap; MAKE_SPEAKER_GAPS=1 turns that manifest into
per-speaker fall sizes; the second pass resynthesizes with them.

The result is a set of learner-like errors -- the fall one mora early/late,
a fall removed or added -- whose correct answer is known exactly. A
'selfswap' control rebuilds the take through the same code with P' = P
(zero shift), so detection rates can't come from vocoder artifacts: the
same WORLD round trip is in every condition.

Output: $UMEJRF_DIR/swap/<P'>/<relative path>.wav (16kHz; tools resample
to 48kHz afterwards like the originals) + tools/tmp/swap-manifest.jsonl.

  UMEJRF_DIR=... SPLITS=ume.A,ume.B python3 tools/paper-swap.py
"""
import json, os
from multiprocessing import Pool
import numpy as np

TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tmp')
ROOT = os.environ['UMEJRF_DIR']
WAV_ROOT = os.path.join(ROOT, 'UME-JRF', 'wav')
FRAME = 5.0  # ms
_gp = os.path.join(TMP, 'swap-speaker-gaps.json')
SPK_GAP = json.load(open(_gp)) if os.path.exists(_gp) and os.environ.get('SPEAKER_GAPS', '1') == '1' else None


def levels(n, a):
    """js/pitch-diagram.js pitchLevels over the word's own n morae (1 = H)."""
    if a == 0: return [0] + [1] * (n - 1)
    if a == 1: return [1] + [0] * (n - 1)
    return [0] + [1 if i < a else 0 for i in range(1, n)]


def shapes(n):
    """Distinct within-word shapes (heiban and odaka coincide over the word)."""
    seen, out = set(), []
    for a in range(0, n + 1):
        p = tuple(levels(n, a))
        if p not in seen: seen.add(p); out.append(p)
    return out


def job(item):
    import soundfile as sf, pyworld as pw
    wav, iv, P, alts, rel = item
    spk = '/'.join(rel.split('/')[1:3])
    x, sr = sf.read(wav, dtype='float64')
    if x.ndim > 1: x = x[:, 0]
    f0, t = pw.harvest(x, sr, frame_period=FRAME)
    voiced = f0 > 0
    if voiced.sum() < 3: return []
    sp = pw.cheaptrick(x, f0, t, sr)
    ap = pw.d4c(x, f0, t, sr)
    cents = np.where(voiced, 1200 * np.log2(np.maximum(f0, 1e-9)), np.nan)
    mora_of = np.full(len(t), -1)
    for i, (s, e) in enumerate(iv): mora_of[(t >= s) & (t < e)] = i
    hi = [c for c, m in zip(cents, mora_of) if m >= 0 and not np.isnan(c) and P[m] == 1]
    lo = [c for c, m in zip(cents, mora_of) if m >= 0 and not np.isnan(c) and P[m] == 0]
    gap_raw = float(np.median(hi) - np.median(lo)) if hi and lo else float('nan')
    # Shift size: the SPEAKER's typical accent fall (median gap over their
    # accented takes, from a first pass -- SPEAKER_GAPS), not this take's own
    # gap: a heiban take's own gap is only its initial rise (median -4 cents
    # over the natives, vs 315 for accented takes), so a fall added to it
    # would be far weaker than any fall that speaker actually makes.
    gap = SPK_GAP.get(spk) if SPK_GAP else None
    if gap is None: gap = gap_raw if not np.isnan(gap_raw) else 100.0
    gap = float(np.clip(gap, 100, 600))
    out = []
    for Q in [P] + alts:
        # per-frame target offset in cents: step at mora boundaries (before the
        # first mora -> mora 0's offset, after the last -> last mora's), then
        # 40ms cosine-weighted smoothing so steps become natural glides
        off_m = [(Q[i] - P[i]) * gap for i in range(len(P))]
        off = np.zeros(len(t))
        for k in range(len(t)):
            m = mora_of[k]
            if m < 0: m = 0 if t[k] < iv[0][0] else len(P) - 1
            off[k] = off_m[m]
        w = np.hanning(int(40 / FRAME) * 2 + 1); w /= w.sum()
        off = np.convolve(np.pad(off, len(w) // 2, mode='edge'), w, mode='valid')
        g = np.where(voiced, f0 * 2 ** (off / 1200), 0.0)
        y = pw.synthesize(g, sp, ap, sr, frame_period=FRAME)
        name = 'selfswap' if Q == P else ''.join('H' if q else 'L' for q in Q)
        dst = os.path.join(ROOT, 'swap', name, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        sf.write(dst, np.clip(y, -1, 1).astype(np.float32), sr, subtype='PCM_16')
        out.append({'swap': name, 'rel': rel, 'orig': ''.join('H' if p else 'L' for p in P),
                    'new': ''.join('H' if q else 'L' for q in Q), 'gapRaw': None if np.isnan(gap_raw) else gap_raw, 'gap': gap})
    return out


def speaker_gaps():
    """From a first pass's manifest: each speaker's median H-L gap (cents)
    over their accented (atamadaka/nakadaka) takes."""
    import collections
    by = collections.defaultdict(list)
    for l in open(os.path.join(TMP, 'swap-manifest.jsonl')):
        r = json.loads(l)
        if r['swap'] != 'selfswap' or r['gapRaw'] is None or 'HL' not in r['orig']: continue
        if r['orig'][0] == 'L' and r['orig'][-1] == 'H': continue
        by['/'.join(r['rel'].split('/')[1:3])].append(r['gapRaw'])
    g = {k: float(np.median(v)) for k, v in by.items()}
    json.dump(g, open(_gp, 'w'), indent=1)
    return g


def main():
    if os.environ.get('MAKE_SPEAKER_GAPS') == '1':
        print('speaker gaps:', {k: round(v) for k, v in speaker_gaps().items()}); return
    fa = json.load(open(os.path.join(TMP, 'umejrf-fa.json')))
    exp = [json.loads(l) for l in open(os.path.join(TMP, 'slots-export.jsonl'))]
    splits = os.environ.get('SPLITS', 'ume.A,ume.B').split(',')
    items, meta = [], {}
    for s in exp:
        if s['split'] not in splits or len(s['accents']) != 1 or s['moraCount'] < 2: continue
        iv = fa.get(s['wav'])
        if not iv or len(iv) != s['moraCount']: continue
        n, P = s['moraCount'], tuple(levels(s['moraCount'], s['accents'][0]))
        alts = [q for q in shapes(n) if q != P]
        rel = os.path.relpath(s['wav'], WAV_ROOT)
        items.append((s['wav'], iv, P, alts, rel))
        meta[rel] = {'split': s['split'], 'moraCount': n, 'accents': s['accents'], 'morae': s['morae']}
    print(f'{len(items)} native takes -> {sum(1 + len(i[3]) for i in items)} resynthesized files', flush=True)
    rows = []
    with Pool(max(1, os.cpu_count() - 2)) as pool:
        for k, r in enumerate(pool.imap_unordered(job, items, chunksize=4)):
            for x in r: rows.append({**x, **meta[x['rel']]})
            if k % 500 == 0: print(f'  {k}/{len(items)}', flush=True)
    with open(os.path.join(TMP, 'swap-manifest.jsonl'), 'w') as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False) + '\n')
    print('done', len(rows))


if __name__ == '__main__':
    main()
