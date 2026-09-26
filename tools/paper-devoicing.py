#!/usr/bin/env python3
"""paper-devoicing.py -- which high vowels are REALLY devoiced, and who
predicts that best?

github.com/bagustris/ASR_JA_Vowel_Devoicing labels JSUT's i/u vowels with a
voiceless-consonant rule and trains an ASR model on those labels, so its
F1 (97%) measures agreement with the rule, not with the audio. Here every
i/u vowel in JSUT basic5000 gets an ACOUSTIC label instead: its segment from
jsut-label's phone timings, and the share of its frames pYIN finds voiced
(edges trimmed 5ms; TRACKER=dio for WORLD DIO instead). Then, against that reference:

  rule      the report's rule (transcript_phone3_rev.txt)
  ojt       OpenJTalk's devoicing (transcript_phone3_ojt.txt)
  asr       the report's Conformer (val+test utterances only: it was trained
            on the rest; hypotheses from dump_asr, aligned by edit distance)
  rule+     the rule with consecutive-devoicing blocking
  rule-pl / rule-nuc / rule-both   the rule, except on an accent phrase's
            last mora / on the accent nucleus / either (text-only too)
  learned   gradient-boosted trees on the context the rule uses plus accent
            (H/L, nucleus) and position, trained on ACOUSTIC labels of the
            report's train split. Text-only features -- usable where the app
            needs it (kana in, no audio model).

All scored on the report's own stratified TEST split (500 utterances).

Usage (python3 with pyworld, soundfile, sklearn):
  JSUT_WAV=~/data/jsut_ver1.1/basic5000/wav JSUT_LABEL_DIR=.../jsut-label \
  DEVOICING_REPO=~/github/ASR_JA_Vowel_Devoicing python3 tools/paper-devoicing.py
Needs tools/tmp/asr-devoicing-hyp.json for the asr row (optional).
"""
import os, re, json, sys, csv, difflib
from multiprocessing import Pool
import numpy as np

TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tmp')
WAV = os.path.expanduser(os.environ['JSUT_WAV'])
LAB = os.environ['JSUT_LABEL_DIR']
LAB = LAB if os.path.exists(os.path.join(LAB, 'BASIC5000_0001.lab')) else os.path.join(LAB, 'labels', 'basic5000')
REPO = os.path.expanduser(os.environ['DEVOICING_REPO'])
DATA = os.path.join(REPO, 'dataset', 'jsut_ver1.1', 'basic5000')
VOICELESS = {'k', 'ky', 's', 'sh', 't', 'ts', 'ch', 'h', 'hy', 'f', 'p', 'py'}
VOWELS = set('aiueo') | {'I', 'U'}
TRACK = 1 if os.environ.get('TRACKER') == 'dio' else 0  # voiced-share reference: 0 = pYIN, 1 = DIO


def parse_lab(uid):
    out = []
    for line in open(os.path.join(LAB, uid + '.lab')):
        s, e, ctx = line.split()
        ph = re.search(r'-(.+?)\+', ctx).group(1)
        if ph in ('sil', 'pau'):
            out.append({'ph': ph, 's': int(s) / 1e7, 'e': int(e) / 1e7}); continue
        a = re.search(r'/A:([-\d]+)\+(\d+)\+(\d+)', ctx)
        f = re.search(r'/F:(\d+)_(\d+)#', ctx)
        a1, a2 = int(a.group(1)), int(a.group(2))
        n, acc = int(f.group(1)), int(f.group(2))
        hi = (a2 == 1) if acc == 1 else ((a2 > 1) if acc == 0 else (1 < a2 <= acc))
        out.append({'ph': ph, 's': int(s) / 1e7, 'e': int(e) / 1e7, 'a1': a1, 'a2': a2, 'n': n, 'acc': acc, 'hi': hi})
    return out


def voiced_fracs(uid):
    """Voiced-frame share of each i/u vowel by two trackers: pYIN (librosa;
    the reference) and WORLD DIO (robustness). WORLD harvest was tried first
    and dropped: it over-extends voicing into devoiced vowels (on a 120-
    utterance sample it called 47% of the rule's candidates voiced where
    pYIN and DIO, agreeing with each other, called 17-18%)."""
    import pyworld, soundfile as sf, librosa
    from scipy.signal import resample_poly
    x, sr = sf.read(os.path.join(WAV, uid + '.wav'))
    x = resample_poly(x, 1, sr // 16000).astype(np.float64); sr = 16000
    f0d, td = pyworld.dio(x, sr, f0_floor=60, f0_ceil=500, frame_period=5.0)
    _, vflag, _ = librosa.pyin(x, fmin=60, fmax=500, sr=sr, frame_length=1024, hop_length=80)
    tp = librosa.times_like(vflag, sr=sr, hop_length=80)
    res = []
    for p in parse_lab(uid):
        if p['ph'] not in ('i', 'u'): continue
        s, e = p['s'], p['e']
        if e - s > 0.03: s, e = s + 0.005, e - 0.005
        mp, md = (tp >= s) & (tp < e), (td >= s) & (td < e)
        res.append([float(vflag[mp].mean()) if mp.any() else 0.0, float((f0d[md] > 0).mean()) if md.any() else 0.0])
    return uid, res


def load_tx(name):
    d = {}
    for line in open(os.path.join(DATA, name), encoding='utf-8'):
        if ':' in line:
            u, t = line.rstrip('\n').split(':', 1); d[u] = t.split()
    return d


def main():
    ids = sorted(f[:-4] for f in os.listdir(LAB) if f.endswith('.lab'))
    cache = os.path.join(TMP, 'devoicing-voiced-fracs-pyin-dio.json')
    vf = json.load(open(cache)) if os.path.exists(cache) else {}
    todo = [u for u in ids if u not in vf]
    if todo:
        with Pool(max(1, os.cpu_count() - 2)) as pool:
            for k, (u, r) in enumerate(pool.imap_unordered(voiced_fracs, todo, chunksize=8)):
                vf[u] = r
                if k % 500 == 0: print(f'  harvest {k}/{len(todo)}', flush=True)
        json.dump(vf, open(cache, 'w'))

    rule, ojt = load_tx('transcript_phone3_rev.txt'), load_tx('transcript_phone3_ojt.txt')
    asr = json.load(open(os.path.join(TMP, 'asr-devoicing-hyp.json'))) if os.path.exists(os.path.join(TMP, 'asr-devoicing-hyp.json')) else None
    split = {}
    for row in csv.DictReader(open(os.path.join(DATA, 'stratified_manifest.csv'))):
        split[row.get('utt_id') or row.get('id') or list(row.values())[0]] = row.get('split')
    if asr: split = {u: s for s, us in asr['split'].items() for u in us}

    rows = []
    mism = 0
    for u in ids:
        lab = parse_lab(u)
        seq = [p for p in lab if p['ph'] not in ('sil',)]
        phones = [p['ph'] for p in seq]
        ref_rule = [t for t in rule.get(u, [])]
        if [t.lower() if t in ('I', 'U') else t for t in ref_rule] != phones:
            mism += 1; continue
        ref_ojt = ojt.get(u, [])
        ojt_ok = [t.lower() if t in ('I', 'U') else t for t in ref_ojt] == phones
        hyp_dv = {}
        if asr and u in asr['hyp']:
            h = [t.strip('[]') for t in asr['hyp'][u].replace(',', 'pau').split()]
            sm = difflib.SequenceMatcher(a=phones, b=[t.lower() if t in ('I', 'U') else t for t in h], autojunk=False)
            for a0, b0, size in sm.get_matching_blocks():
                for k in range(size): hyp_dv[a0 + k] = h[b0 + k] in ('I', 'U')
        vi = 0
        for j, p in enumerate(seq):
            if p['ph'] not in ('i', 'u'): continue
            prev = phones[j - 1] if j > 0 else 'START'
            nxt = phones[j + 1] if j + 1 < len(phones) else 'END'
            nn = phones[j + 2] if j + 2 < len(phones) else 'END'
            nxt_eff = nn if nxt == 'cl' else nxt
            prev_v = None  # previous vowel's rule label, for consecutive environments
            for q in range(j - 1, -1, -1):
                if phones[q] in ('i', 'u', 'a', 'e', 'o'): prev_v = ref_rule[q] in ('I', 'U'); break
                if phones[q] == 'pau': break
            rows.append({
                'u': u, 'split': split.get(u, '?'), 'vf': vf[u][vi][TRACK], 'dur': p['e'] - p['s'],
                'rule': ref_rule[j] in ('I', 'U'), 'ojt': (ref_ojt[j] in ('I', 'U')) if ojt_ok else None,
                'asr': hyp_dv.get(j) if asr and u in asr['hyp'] else None,
                'rule_prev': bool(prev_v),
                'f': {'v': p['ph'], 'prev': prev, 'prevVL': prev in VOICELESS, 'next': nxt_eff, 'nextVL': nxt_eff in VOICELESS,
                      'nextKind': 'END' if nxt == 'END' else 'pau' if nxt == 'pau' else 'cl' if nxt == 'cl' else 'N' if nxt == 'N' else ('V' if nxt in VOWELS else ('VL' if nxt in VOICELESS else 'VD')),
                      'hi': p['hi'], 'nucleus': p['acc'] > 0 and p['a2'] == p['acc'], 'nextNucleus': p['acc'] > 0 and p['a2'] + 1 == p['acc'],
                      'phraseFirst': p['a2'] == 1, 'phraseLast': p['a2'] == p['n'], 'n': p['n'], 'acc0': p['acc'] == 0,
                      'prevDevEnv': bool(prev_v)},
            })
            vi += 1
    print(f'{len(rows)} i/u vowels from {len(ids) - mism} utterances ({mism} skipped: transcript/label phone mismatch)')

    vfa = np.array([r['vf'] for r in rows])
    env = np.array([r['f']['prevVL'] and (r['f']['nextVL'] or r['f']['nextKind'] == 'END') for r in rows])
    print('\nvoiced-frame share histogram (i/u between voiceless consonants vs all other i/u):')
    bins = np.linspace(0, 1, 11)
    for lab_, m in (('devoicing env', env), ('other', ~env)):
        h, _ = np.histogram(vfa[m], bins=bins)
        print(f'  {lab_:14s} ' + ' '.join(f'{100 * c / max(1, m.sum()):4.0f}' for c in h) + f'   (n={m.sum()}; bins of 0.1)')

    # rule+: consecutive blocking, left to right, as in js/mora-segment.js
    last_u, last_dv = None, False
    for r in rows:
        dv = r['rule'] and not (r['rule_prev'] and last_dv and last_u == r['u'])
        r['rule+'] = dv; last_dv, last_u = dv, r['u']

    # learned: text-only features -> acoustic label (threshold THR), trained on train split
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.feature_extraction import DictVectorizer
    THRS = [float(x) for x in os.environ.get('THRS', '0.3,0.5').split(',')]
    test = [r for r in rows if r['split'] == 'test']
    train = [r for r in rows if r['split'] == 'train']
    feats = lambda r: {k: (str(v) if isinstance(v, str) else float(v)) for k, v in r['f'].items()}
    dvz = DictVectorizer(sparse=False)
    Xtr = dvz.fit_transform([feats(r) for r in train]); Xte = dvz.transform([feats(r) for r in test])

    def prf(pred, gold):
        pred, gold = np.array(pred, bool), np.array(gold, bool)
        tp = (pred & gold).sum(); p = tp / max(1, pred.sum()); rc = tp / max(1, gold.sum())
        return p, rc, 2 * p * rc / max(1e-9, p + rc), (pred == gold).mean()
    print(f'\nTEST split ({len(test)} i/u vowels, {len(set(r["u"] for r in test))} utterances). acoustic label: devoiced = voiced share < thr')
    for thr in THRS:
        gold_tr = np.array([r['vf'] < thr for r in train]); gold = np.array([r['vf'] < thr for r in test])
        clf = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, random_state=0).fit(Xtr, gold_tr)
        learned = clf.predict(Xte)
        print(f'\n thr={thr}: {100 * gold.mean():.1f}% of test i/u acoustically devoiced')
        print(f'   {"predictor":10s} {"P":>6s} {"R":>6s} {"F1":>6s} {"acc":>6s}  n')
        for name, get in (('rule', lambda r: r['rule']), ('rule+', lambda r: r['rule+']), ('ojt', lambda r: r['ojt']), ('asr', lambda r: r['asr']),
                          ('rule-pl', lambda r: r['rule'] and not r['f']['phraseLast']),
                          ('rule-nuc', lambda r: r['rule'] and not r['f']['nucleus']),
                          ('rule-both', lambda r: r['rule'] and not r['f']['phraseLast'] and not r['f']['nucleus'])):
            sub = [(get(r), r['vf'] < thr) for r in test if get(r) is not None]
            if not sub: continue
            p, rc, f1, acc = prf([a for a, _ in sub], [b for _, b in sub])
            print(f'   {name:10s} {100 * p:6.1f} {100 * rc:6.1f} {100 * f1:6.1f} {100 * acc:6.1f}  {len(sub)}')
        p, rc, f1, acc = prf(learned, gold)
        print(f'   {"learned":10s} {100 * p:6.1f} {100 * rc:6.1f} {100 * f1:6.1f} {100 * acc:6.1f}  {len(test)}')
        # paired utterance-level bootstrap of F1 differences (asr rows: only
        # vowels the ASR hypothesis aligned, for both sides of that pair)
        utts = sorted(set(r['u'] for r in test)); by = {u: [] for u in utts}
        for k, r in enumerate(test): by[r['u']].append(k)
        rng = np.random.default_rng(20260926)
        preds = {'rule': np.array([r['rule'] for r in test]), 'learned': np.array(learned, bool),
                 'ojt': np.array([bool(r['ojt']) for r in test]),
                 'asr': np.array([bool(r['asr']) for r in test]), 'asr_ok': np.array([r['asr'] is not None for r in test])}
        def f1of(pr, gd): tp = (pr & gd).sum(); return 2 * tp / max(1, pr.sum() + gd.sum())
        for a, b in (('learned', 'rule'), ('learned', 'asr'), ('asr', 'rule'), ('ojt', 'rule')):
            ds = []
            for _ in range(1000):
                idx = np.concatenate([by[u] for u in rng.choice(utts, len(utts))])
                m = preds['asr_ok'][idx] if 'asr' in (a, b) else np.ones(len(idx), bool)
                ds.append(f1of(preds[a][idx][m], gold[idx][m]) - f1of(preds[b][idx][m], gold[idx][m]))
            m = preds['asr_ok'] if 'asr' in (a, b) else np.ones(len(test), bool)
            d0 = f1of(preds[a][m], gold[m]) - f1of(preds[b][m], gold[m])
            print(f'   dF1 {a} - {b}: {100 * d0:+.1f} [{100 * np.quantile(ds, .025):+.1f}, {100 * np.quantile(ds, .975):+.1f}]')
        # where the rule disagrees with the audio
        if thr == THRS[-1]:
            from collections import Counter
            fn = Counter(); fp = Counter()
            for r in test:
                g = r['vf'] < thr
                key = f"{r['f']['prev']}-{r['f']['v']}-{r['f']['nextKind']}{'(' + r['f']['next'] + ')' if r['f']['nextKind'] in ('VL', 'VD') else ''}"
                if g and not r['rule']: fn[key] += 1
                if r['rule'] and not g: fp[key] += 1
            print('   rule misses (acoustically devoiced, rule says voiced):', fn.most_common(8))
            print('   rule false alarms (rule says devoiced, audio voiced):  ', fp.most_common(8))
            # accent effect in the rule's own environment
            envr = [r for r in test if r['rule']]
            for k in ('nucleus', 'hi', 'phraseLast'):
                a = [r['vf'] < thr for r in envr if r['f'][k]]; b = [r['vf'] < thr for r in envr if not r['f'][k]]
                print(f'   in the rule environment, devoiced rate when {k}: {100 * np.mean(a):.0f}% (n={len(a)}) vs not: {100 * np.mean(b):.0f}% (n={len(b)})')
            nxt = [r for r in envr if r['f']['nextKind'] == 'END']
            print(f'   rule environment, utterance-final: devoiced {100 * np.mean([r["vf"] < thr for r in nxt]):.0f}% (n={len(nxt)})')
    json.dump({'features': dvz.feature_names_}, open(os.path.join(TMP, 'devoicing-features.json'), 'w'))


if __name__ == '__main__':
    main()
