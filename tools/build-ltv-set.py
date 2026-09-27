#!/usr/bin/env python3
"""build-ltv-set.py -- a large multi-speaker set of short single-accent-
phrase utterances from LaboroTVSpeech (TV broadcast speech, research use
only; never redistribute the audio), labelled by OpenJTalk's accent
prediction. Noisy labels (tools/ojt-label-noise.py: OpenJTalk's phrase shape
matches JSUT's manual labels for ~93% of 2-mora and ~85% of 3-4-mora
phrases), but thousands of voices, where UME-JRF has 33.

Selection: utterances of at most 3 words, no interjection/filler, at least
one noun/verb/adjective, containing a kanji, that OpenJTalk parses as exactly ONE accent phrase
of 2-5 morae with no pause, 0.3-1.5 s long. LaboroTV has no speaker or
program ids, so no speaker-level split is possible; the first 80% of
selected ids (sorted) are 'train', the rest 'test'.

Output: tools/tmp/ltv-short.jsonl {id, wav, text, morae (hiragana), moraCount,
accents: [a] (heiban/odaka written 0 -- same shape over the phrase)}.

  LTV_DIR=/data/LaboroTVSpeech/data ~/.venvs/onchou-ojt/bin/python tools/build-ltv-set.py
"""
import os, re, json, wave
import pyopenjtalk

TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tmp')
LTV = os.environ.get('LTV_DIR', '/data/LaboroTVSpeech/data')
LIMIT = int(os.environ.get('LIMIT', '30000'))
SMALL = set('ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ')


def kata2hira(s):
    return ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in s)


def mora_split(kana):
    out = []
    for c in kana:
        if c in SMALL and out: out[-1] += c
        else: out.append(c)
    return out


def phrase(text):
    """-> (moraCount, accentType) if OpenJTalk gives exactly one accent phrase, else None."""
    keys, a2prev = [], None
    for l in pyopenjtalk.extract_fullcontext(text):
        ph = re.search(r'-(.+?)\+', l).group(1)
        if ph == 'pau': return None
        f = l.split('/F:')[1].split('/')[0]
        if f.startswith('xx'): continue
        m = re.match(r'(\d+)_(\d+)#', f)
        keys.append((int(m.group(1)), int(m.group(2))))
    keys = set(keys)
    return keys.pop() if len(keys) == 1 else None


def main():
    rows, seen = [], 0
    for split in ('dev', 'train'):
        for line in open(os.path.join(LTV, split, 'text.csv'), encoding='utf-8'):
            uid, toks = line.rstrip('\n').split(',', 1)
            toks = toks.split()
            if len(toks) > 3 or not toks: continue
            pos = [t.rsplit('+', 1)[1] for t in toks if '+' in t]
            if any(p in ('感動詞', 'フィラー', '記号') for p in pos): continue
            if not any(p in ('名詞', '動詞', '形容詞') for p in pos): continue
            text = ''.join(t.rsplit('+', 1)[0] for t in toks)
            # a dictionary content word (kanji) is required: katakana-only /
            # kana-only short utterances are mostly laughter, onomatopoeia
            # and slang, which OpenJTalk defaults to atamadaka
            if not re.search(r'[\u4e00-\u9fff]', text): continue
            seen += 1
            ph = phrase(text)
            if not ph or not 2 <= ph[0] <= 5: continue
            n, a = ph
            morae = mora_split(kata2hira(pyopenjtalk.g2p(text, kana=True)))
            if len(morae) != n: continue
            wav = os.path.join(LTV, split, 'wav', uid + '.wav')
            try:
                with wave.open(wav) as w: dur = w.getnframes() / w.getframerate()
            except Exception:
                continue
            if not 0.3 <= dur <= 1.5: continue
            rows.append({'id': uid, 'wav': wav, 'text': text, 'morae': morae, 'moraCount': n, 'accents': [0 if a == n else a], 'dur': dur})
            if len(rows) >= LIMIT: break
        if len(rows) >= LIMIT: break
    rows.sort(key=lambda r: r['id'])
    cut = int(0.8 * len(rows))
    for i, r in enumerate(rows): r['split'] = 'ltv.train' if i < cut else 'ltv.test'
    with open(os.path.join(TMP, 'ltv-short.jsonl'), 'w') as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False) + '\n')
    import collections
    print(f'{len(rows)} utterances kept of {seen} short candidates scanned')
    print('by mora count:', dict(collections.Counter(r['moraCount'] for r in rows)))
    print('by shape:', collections.Counter((r['moraCount'], r['accents'][0]) for r in rows).most_common(12))


if __name__ == '__main__':
    main()
