#!/usr/bin/env python3
"""ojt-label-noise.py -- how noisy are OpenJTalk's predicted accents as
labels? Compares pyopenjtalk's accent phrases for every JSUT basic5000
sentence with jsut-label's manually corrected ones (same text).

Phrases are compared only where the two segmentations agree (same sequence
of phrase mora counts); a phrase's label is its pitch shape over its own
morae (js/pitch-diagram.js pitchLevels, sliced), so heiban vs odaka -- which
OpenJTalk's labels don't distinguish without a following particle, and which
share a shape over the phrase itself -- never counts as an error.

  JSUT_TEXT=~/data/jsut_ver1.1/basic5000/transcript_utf8.txt JSUT_LABEL_DIR=... \\
    ~/.venvs/onchou-ojt/bin/python tools/ojt-label-noise.py
Also reports agreement for single-phrase short utterances only, the case
tools/build-ltv-set.py uses.
"""
import os, re, collections
import pyopenjtalk

LAB = os.environ['JSUT_LABEL_DIR']
LAB = LAB if os.path.exists(os.path.join(LAB, 'BASIC5000_0001.lab')) else os.path.join(LAB, 'labels', 'basic5000')


def shape(n, a):
    if a == 0: return 'L' + 'H' * (n - 1)
    if a == 1: return 'H' + 'L' * (n - 1)
    return 'L' + ''.join('H' if i < a else 'L' for i in range(1, n))


def phrases_from_labels(lines):
    """[(moraCount, accentType)] from full-context label lines (F field),
    one entry per accent phrase in order."""
    out, last = [], None
    for l in lines:
        if '/F:' not in l: continue
        f = l.split('/F:')[1].split('/')[0]
        if f.startswith('xx'): last = None; continue
        m = re.match(r'(\d+)_(\d+)#', f)
        key = (int(m.group(1)), int(m.group(2)))
        # a new phrase starts when the position-in-phrase counter (A:a2) resets to 1
        a2 = int(re.search(r'/A:[-\d]+\+(\d+)\+', l).group(1))
        if last is None or (a2 == 1 and prev_a2 != 1):
            out.append(key)
        last, prev_a2 = key, a2
    return out


def main():
    text = dict(l.rstrip('\n').split(':', 1) for l in open(os.path.expanduser(os.environ['JSUT_TEXT']), encoding='utf-8'))
    agree = tot = segok = sents = 0
    by_n = collections.defaultdict(lambda: [0, 0])
    conf = collections.Counter()
    for uid in sorted(text):
        p = os.path.join(LAB, uid + '.lab')
        if not os.path.exists(p): continue
        ref = phrases_from_labels([l.split()[2] for l in open(p)])
        hyp = phrases_from_labels(pyopenjtalk.extract_fullcontext(text[uid]))
        sents += 1
        if [n for n, _ in ref] != [n for n, _ in hyp]: continue
        segok += 1
        for (n, a), (_, b) in zip(ref, hyp):
            if n < 2: continue
            sa, sb = shape(n, a), shape(n, b if b != n else 0)
            ok = sa == sb
            agree += ok; tot += 1; by_n[n][0] += ok; by_n[n][1] += 1
            if not ok: conf[(sa, sb)] += 1
    print(f'{sents} sentences; phrase segmentation identical in {segok} ({100 * segok / sents:.0f}%)')
    print(f'phrase shape agreement (OpenJTalk vs manual), >=2 morae: {100 * agree / tot:.1f}% of {tot} phrases')
    for n in sorted(by_n):
        if by_n[n][1] >= 50: print(f'  {n} morae: {100 * by_n[n][0] / by_n[n][1]:.1f}% (n={by_n[n][1]})')
    print('most common disagreements (manual -> OpenJTalk):', conf.most_common(8))


if __name__ == '__main__':
    main()
