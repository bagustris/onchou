#!/usr/bin/env python3
"""paper-fa.py -- option #8 (upper bound, NOT shippable in onchou): CTC
forced alignment of UME-JRF Set D words, to get REAL mora boundaries for
isolated words (JSUT has jsut-label's Julius alignment; UME-JRF has none).

Uses the cached multilingual phoneme CTC model facebook/wav2vec2-xlsr-53-
espeak-cv-ft: each word's known kana reading is converted to its phoneme
tokens (one group per mora), aligned with torchaudio's CTC forced_align,
and each mora's span taken from its tokens' frames (gaps split at the
midpoint). Output: tools/tmp/umejrf-fa.json, {wavPath: [[start, end], ...]}
in seconds, one entry per mora.

Run with a CUDA torch + transformers environment, e.g.:
  /home/bagustris/github/sf-ssl/.venv/bin/python tools/paper-fa.py
"""
import json, os, glob
import numpy as np
import soundfile as sf
import torch, torchaudio
from transformers import Wav2Vec2ForCTC

TMP = os.path.join(os.path.dirname(__file__), 'tmp')
snap = glob.glob(os.path.expanduser('~/.cache/huggingface/hub/models--facebook--wav2vec2-xlsr-53-espeak-cv-ft/snapshots/*/vocab.json'))[0]
vocab = json.load(open(snap))
model = Wav2Vec2ForCTC.from_pretrained('facebook/wav2vec2-xlsr-53-espeak-cv-ft').cuda().eval()

# ---- kana -> phoneme tokens (one list per mora)
VOW = {'a': 'a', 'i': 'i', 'u': 'ɯ', 'e': 'e', 'o': 'o'}
def h(s):  # katakana -> hiragana
    return ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in s)
BASE = {}
rows = {'': 'あいうえお', 'k': 'かきくけこ', 's': 'さしすせそ', 't': 'たちつてと', 'n': 'なにぬねの',
        'h': 'はひふへほ', 'm': 'まみむめも', 'r': 'らりるれろ', 'g': 'がぎぐげご', 'z': 'ざじずぜぞ',
        'd': 'だぢづでど', 'b': 'ばびぶべぼ', 'p': 'ぱぴぷぺぽ'}
for c, kana in rows.items():
    for k, v in zip(kana, 'aiueo'): BASE[k] = (c, v)
BASE.update({'や': ('j', 'a'), 'ゆ': ('j', 'u'), 'よ': ('j', 'o'), 'わ': ('w', 'a'), 'を': ('', 'o')})
CONS = {('s', 'i'): ['ɕ'], ('t', 'i'): ['tɕ'], ('t', 'u'): ['ts'], ('h', 'i'): ['ç'], ('h', 'u'): ['ɸ'],
        ('n', 'i'): ['ɲ'], ('z', 'i'): ['dʑ'], ('d', 'i'): ['dʑ'], ('z', 'u'): ['z'], ('d', 'u'): ['z'], ('r', ''): ['ɾ']}
SMALL = {'ゃ': 'a', 'ゅ': 'u', 'ょ': 'o', 'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o'}
PALATAL = {'s': ['ɕ'], 't': ['tɕ'], 'z': ['dʑ'], 'd': ['dʑ'], 'h': ['ç'], 'n': ['ɲ']}
def mora_tokens(mora, prev_vowel):
    m = h(mora)
    if m == 'ん': return ['ɴ'], prev_vowel
    if m == 'っ': return ['ʔ'], prev_vowel
    if m == 'ー': return [VOW[prev_vowel]], prev_vowel
    c, v = BASE[m[0]]
    # The eSpeak CTC vocabulary spells /g/ with the IPA letter ɡ (U+0261) and
    # has no ASCII 'g': without this, every が-row mora raised KeyError and
    # all 12 such words were silently dropped as "alignment failures".
    if c == 'g': c = '\u0261'
    if len(m) > 1 and m[1] in SMALL:  # yōon
        v = SMALL[m[1]]
        cons = PALATAL.get(c, ([c, 'j'] if c else ['j']))
        return [t for t in cons if t] + [VOW[v]], v
    cons = CONS.get((c, v), CONS.get((c, ''), [c] if c else []))
    return [t for t in cons if t] + [VOW[v]], v

def mora_split(r):
    out = []
    for ch in r:
        if ch in SMALL or ch in 'ゃゅょャュョァィゥェォ':
            out[-1] += ch
        else: out.append(ch)
    return out

words = json.load(open(os.path.join(os.path.dirname(__file__), 'umejrf-dset-words.json')))
exp = [json.loads(l) for l in open(os.path.join(TMP, 'slots-export.jsonl'))]
wavs = sorted({s['wav'] for s in exp if s['split'].startswith('ume.')})
print(len(wavs), 'UME files', flush=True)

out, fails = {}, 0
for k, wav in enumerate(wavs):
    idx = int(os.path.basename(wav)[3:6]) - 1
    morae = mora_split(h(words[idx][1]))
    toks, owner, pv = [], [], 'a'
    try:
        for mi, mo in enumerate(morae):
            t, pv = mora_tokens(mo, pv)
            for tt in t:
                toks.append(vocab[tt]); owner.append(mi)
    except KeyError:
        fails += 1; continue
    x, sr = sf.read(wav, dtype='float32')
    t = torch.from_numpy(x)
    if sr != 16000: t = torchaudio.functional.resample(t, sr, 16000)
    with torch.no_grad():
        lp = torch.log_softmax(model(t[None].cuda()).logits, -1)
    try:
        ali, _ = torchaudio.functional.forced_align(lp, torch.tensor([toks], device='cuda'), blank=vocab['<pad>'])
    except Exception:
        fails += 1; continue
    ali = ali[0].cpu().numpy()
    # token spans: consecutive frames with the same non-blank label, in order
    spans, j = [], 0
    prev = None
    for f, a in enumerate(ali):
        if a == vocab['<pad>']: prev = None; continue
        if prev is None or a != prev or (spans and f != spans[-1][1] + 1):
            spans.append([f, f])
        else:
            spans[-1][1] = f
        prev = a
    if len(spans) != len(toks):
        fails += 1; continue
    ms = [[None, None] for _ in morae]
    for (a, b), o in zip(spans, owner):
        if ms[o][0] is None: ms[o][0] = a
        ms[o][1] = b + 1
    fr = 0.02
    b = [[ms[i][0] * fr, ms[i][1] * fr] for i in range(len(morae))]
    for i in range(len(b) - 1):  # split gaps (closures, blanks) at the midpoint
        mid = (b[i][1] + b[i + 1][0]) / 2
        b[i][1] = b[i + 1][0] = mid
    out[wav] = b
    if k % 2000 == 0: print(f'  {k}/{len(wavs)}', flush=True)
json.dump(out, open(os.path.join(TMP, 'umejrf-fa.json'), 'w'))
print(f'aligned {len(out)}, failed {fails}', flush=True)
