#!/usr/bin/env python3
"""jsut-signal-level-check.py -- signal-level cross-check (research plan
item 1: docs/2026-09-05-pitch-accent-evaluation-research-plan.md) for
onchou's shipped F0 estimator (js/pitch-detect.js's _estimatePitch), on
real JSUT audio.

Reads a trace dump produced by:
    node tools/evaluate-jsut-accuracy.js --dump-traces N --dump-traces-out FILE
(each entry: {sentenceId, moraCount, accentType, spanStartSec, spanEndSec,
trace: [{tMs, hz|null}, ...]} -- the trace is exactly what the SHIPPED
_estimatePitch produced on real PCM, not a reimplementation).

For each phrase, re-extracts the same audio span and runs librosa.pyin (an
established, independent reference F0 extractor -- a YIN variant) at a
matching frame/hop configuration, aligns its frames to the same tMs grid
onchou's trace uses, and reports:
  - GPE (Gross Pitch Error): fraction of frames where BOTH extractors call
    voiced but disagree by >20% relative Hz (the standard GPE threshold).
  - RMSE in cents, on frames both extractors call voiced and agree closely
    enough to not be a gross (likely octave) error -- reported separately
    from GPE since averaging a few octave errors into an RMSE would make an
    otherwise-accurate estimator look far worse than it is; see printed
    breakdown.
  - Voicing agreement: how often the two extractors agree on voiced-vs-not.

Usage:
    python3 tools/jsut-signal-level-check.py tools/tmp/jsut-trace-dump.json
"""
import json
import sys
import math

import numpy as np
import librosa
import soundfile as sf

JSUT_WAV_DIR = '/data/jsut_ver1.1/basic5000/wav'

# Must match js/pitch-detect.js's own constants (see that file's header
# comment for why these values were chosen) so the reference extractor is
# evaluated on a comparable frame/hop shape, not an easier or harder one.
FRAME_SIZE = 1024
HOP_MS = 20
MIN_HZ = 70
MAX_HZ = 400
GPE_RELATIVE_THRESHOLD = 0.20


def reference_f0_trace(samples, sr, span_start_sec, span_end_sec):
    """Runs librosa.pyin over [span_start_sec, span_end_sec] of `samples`,
    returns a list of (tMs, hz|None) aligned the same way
    tools/evaluate-jsut-accuracy.js's buildTrace() aligns onchou's own
    trace: hop i's timestamp is i*HOP_MS, hz is the pyin frame whose window
    ends closest to that absolute sample position."""
    start_sample = max(0, round(span_start_sec * sr))
    end_sample = min(len(samples), round(span_end_sec * sr))
    hop_length = round(sr * HOP_MS / 1000)

    clip = samples[start_sample:end_sample]
    if len(clip) < FRAME_SIZE:
        return []

    f0, voiced_flag, _ = librosa.pyin(
        clip, fmin=MIN_HZ, fmax=MAX_HZ, sr=sr,
        frame_length=FRAME_SIZE, hop_length=hop_length, center=False,
    )
    # librosa.pyin's frame i (center=False) covers samples
    # [i*hop_length, i*hop_length+frame_length) -- its END is the closest
    # equivalent to onchou's own "window ending at this hop's absolute
    # position" definition.
    out = []
    for i, hz in enumerate(f0):
        window_end_sample = i * hop_length + FRAME_SIZE
        tMs = round((window_end_sample / sr) * 1000)
        out.append((tMs, float(hz) if voiced_flag[i] and not math.isnan(hz) else None))
    return out


NO_MATCH = object()  # sentinel: no reference frame close enough in time


def nearest_hz(trace_pairs, tMs, tolerance_ms=15):
    """trace_pairs: list of (tMs, hz|None). Returns the hz (None = the matched
    reference frame is UNVOICED) of the closest frame within tolerance_ms, or
    NO_MATCH when no reference frame is that close -- which must be skipped,
    not counted as reference-unvoiced (it would inflate the frame count and
    the voicing-agreement rate at clip edges)."""
    best = NO_MATCH
    best_dist = tolerance_ms + 1
    for t, hz in trace_pairs:
        d = abs(t - tMs)
        if d < best_dist:
            best_dist = d
            best = hz
    return best if best_dist <= tolerance_ms else NO_MATCH


def main():
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <trace-dump.json>', file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1]) as f:
        phrases = json.load(f)

    both_voiced = 0
    both_voiced_gpe = 0
    agree_voicing = 0
    total_compared = 0
    unmatched = 0
    cents_errors = []  # only for non-GPE (fine) agreements
    wav_cache = {}

    for phrase in phrases:
        sid = phrase['sentenceId']
        if sid not in wav_cache:
            samples, sr = sf.read(f'{JSUT_WAV_DIR}/{sid}.wav', dtype='float32')
            wav_cache[sid] = (samples, sr)
        samples, sr = wav_cache[sid]

        ref_trace = reference_f0_trace(samples, sr, phrase['spanStartSec'], phrase['spanEndSec'])
        if not ref_trace:
            continue

        for frame in phrase['trace']:
            ours_hz = frame['hz']
            ref_hz = nearest_hz(ref_trace, frame['tMs'])
            if ref_hz is NO_MATCH:
                unmatched += 1
                continue
            ours_voiced = ours_hz is not None
            ref_voiced = ref_hz is not None

            total_compared += 1
            if ours_voiced == ref_voiced:
                agree_voicing += 1
            if ours_voiced and ref_voiced:
                both_voiced += 1
                rel_err = abs(ours_hz - ref_hz) / ref_hz
                if rel_err > GPE_RELATIVE_THRESHOLD:
                    both_voiced_gpe += 1
                else:
                    cents_errors.append(1200 * math.log2(ours_hz / ref_hz))

    print(f'Phrases processed: {len(phrases)}')
    print(f'Frames compared: {total_compared} (skipped {unmatched} with no reference frame within 15ms)')
    print(f'Voicing agreement (both voiced or both unvoiced): {agree_voicing / total_compared * 100:.1f}%')
    if both_voiced:
        print(f'Both-voiced frames: {both_voiced} ({both_voiced / total_compared * 100:.1f}% of compared)')
        print(f'GPE (>{GPE_RELATIVE_THRESHOLD*100:.0f}% relative error, likely octave/gross errors): '
              f'{both_voiced_gpe / both_voiced * 100:.1f}% of both-voiced frames')
        if cents_errors:
            rmse_cents = math.sqrt(sum(e * e for e in cents_errors) / len(cents_errors))
            print(f'RMSE (cents, excl. GPE frames): {rmse_cents:.1f} cents, n={len(cents_errors)}')
    else:
        print('No both-voiced frames found -- check MIN_HZ/MAX_HZ/frame alignment.')


if __name__ == '__main__':
    main()
