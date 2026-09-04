# onchou (音調) — Japanese Pitch-Accent Trainer — Design

## Problem

Existing apps in this collection (kanji-drill, kotoba, jlpt, jed, wanikanji)
cover kanji, vocabulary, and reading, and kotoba/jlpt already *display* a
word's pitch-accent pattern as a static diagram. None of them, and no other
app in this collection, lets a learner *practice* pitch accent by recording
their own voice and checking whether they produced the right high/low
pattern.

`ai-pronunciation-trainer` (a separate, model-based project) already scores
segmental pronunciation accuracy via a server-side ASR model (sherox) and
phoneme forced-alignment. That approach doesn't extend cleanly to pitch
accent, and going server/model-based would break from this collection's
static-PWA-only pattern. Pitch accent, unlike segmental accuracy, is
tractable fully client-side: it only requires an F0 (fundamental frequency)
contour, extractable in-browser via the Web Audio API with no ML model.

## Goal

A static PWA, matching kotoba/jlpt/jed/wanikanji's shape exactly (plain
HTML/CSS/JS, no build step, no backend, installable/offline via a service
worker), that:

1. Shows a word, its reading, and its correct pitch-accent pattern as a
   dot-and-line diagram (reusing the existing convention from jlpt/kotoba).
2. Records the learner saying the word via the microphone.
3. Extracts an F0 contour from the recording, segments it per mora, and
   reduces it to the same H/L representation as the target pattern.
4. Renders the learner's detected pattern with the same diagram renderer,
   side by side with the target, and shows per-mora agreement.

Non-goals for v1: segmental (consonant/vowel) accuracy scoring, sentence-level
practice, reference audio playback (TTS), and any cloud/model dependency.

## Data

### Source

`accents_kanjium.txt` (from the [Kanjium](https://github.com/mifunetoshiro/kanjium)
project, CC BY-SA-style attribution basis — same caveat already documented in
`kanji-data`'s `CREDITS.md`: no formal license file upstream, reused
elsewhere such as Yomichan/Yomitan on an attribution basis) is vendored the
same way jlpt/kanji-drill/wanikanji already do it: a `vendor/kanji-data` git
submodule pointing at `https://github.com/bagustris/kanji-data`.

Each line is `word<TAB>reading<TAB>accentNum[,accentNum...]` — `accentNum` is
the Kanjium accent-kernel position (0 = heiban, no drop; N = pitch drop after
mora N), not a pre-expanded H/L array. A word may have more than one accepted
accent (comma-separated); onchou uses only the first for v1.

### Build step: `data/words.json`

A one-time (re-run manually when source vocab changes, not part of the
runtime app) Node/bash script under `tools/` — mirroring jed's/kanji-drill's
`tools/` scripts — that:

1. Parses `accents_kanjium.txt` into `{word, reading, accentNum}` records.
2. Collects the vocab word set already used by kotoba (`data/words/*.json`,
   field `word`) and jed (`data/words/*.json`, field `k`/`r`), read from
   sibling checkouts at build time (script input, not a runtime fetch).
3. Intersects: keeps only Kanjium entries whose `(word, reading)` also
   appears in that combined vocab set.
4. Writes the result to `data/words.json` as a flat array:
   `[{word, reading, accentNum}, ...]`.

Runtime app code only ever reads `data/words.json` — it has no dependency on
kotoba/jed being present on the deployed site, only at data-build time on the
developer's machine.

## Pitch-accent diagram (reused, not new)

Ported from `jlpt/js/app.js`'s existing `pitchLevels(moraCount, accentNum)`
and `pitchAccentSVG(reading, accentNum)`:

- `pitchLevels` derives one `'H'`/`'L'` per mora from the standard Japanese
  pitch-accent rule (heiban / atamadaka / nakadaka / odaka), plus one
  trailing level representing the pitch on a following particle — the detail
  that visually distinguishes heiban (trailing H) from odaka (trailing L,
  accentNum === moraCount) even though their in-word pattern is identical.
- `pitchAccentSVG` renders one dot per mora (plus the trailing dot, hollow)
  joined by straight lines, high pitch drawn higher — the same SVG
  convention kotoba/jlpt already use.
- Mora-splitting reuses kotoba's `moraSplit` rule (small kana ゃゅょ etc.
  attach to the preceding character; っ and ー are their own mora).

`js/pitch-diagram.js` in onchou is this ported logic, parameterized so it
can render either the target pattern (from `accentNum`) or an arbitrary
detected `H`/`L` array (the learner's attempt), in a different CSS color
(`--accent` for target, a new `--accent-learner` token for the recording) so
the two are visually distinguishable when shown together.

## Recording & pitch-detection pipeline (the new part)

### `js/pitch-detect.js`

- `getUserMedia({audio: true})` to get a mic stream.
- `AudioContext` + `AnalyserNode` (or `ScriptProcessorNode`/`AudioWorklet` —
  implementation detail decided during implementation) pulling time-domain
  samples in fixed-size frames (e.g. 1024 samples) at the stream's sample
  rate.
- Per frame, autocorrelation-based F0 estimation (a compact YIN or
  normalized-autocorrelation implementation, no external library) yielding
  either a frequency in Hz or "unvoiced" for that frame.
- Output: a raw trace `[{tMs, hz | null}, ...]` for the whole recording.

### `js/mora-segment.js`

- Takes the raw trace and the word's mora count (from `pitchAccentSVG`'s
  existing `moraSplit`).
- Divides the recording's voiced span evenly into that many mora-slots (a
  simple time-proportional split for v1 — no forced alignment/ASR, since
  that would reintroduce a model dependency).
- Per mora-slot: median Hz over voiced frames in that slot (ignoring
  unvoiced frames); slots with no voiced frames are marked `unclear`.
- Converts the per-mora median-Hz sequence to relative `H`/`L` by comparison
  to the *recording's own* median Hz (not absolute Hz, not the target
  pattern) — necessary because absolute pitch varies by speaker. A mora
  above the recording's median is `H`, below is `L`.
- Output: `{pattern: ['H'|'L'|'unclear', ...]}` for the learner's attempt,
  same shape `pitchLevels()` produces for the target.

### Scoring

Per-mora comparison of the learner's pattern against the target pattern from
`pitchLevels(moraCount, accentNum)`: a mora is a match if both are `H` or
both are `L`; an `unclear` mora is neither right nor wrong, shown as such
rather than counted against the learner. Score displayed as "N of M morae
matched" plus the two diagrams stacked for visual comparison — no single
opaque percentage.

## UI flow

1. Word card: kanji/kana word + reading + target pitch diagram.
2. "Record" button → mic permission prompt (first time) → recording state
   (visual indicator, e.g. pulsing dot) → learner taps "Stop" (or a max
   duration auto-stop, e.g. 3s, to bound memory/processing).
3. On stop: run `pitch-detect` + `mora-segment` → render learner's diagram
   directly under the target diagram → per-mora match/mismatch/unclear
   highlighting → "N of M matched" text.
4. "Next word" advances; "Retry" re-records the same word.

## Error handling

- Mic permission denied → inline message ("Microphone access is needed to
  practice pronunciation — allow it and try again"), card stays otherwise
  usable (diagram still visible).
- `getUserMedia`/Web Audio unsupported (rare) → feature-detected at load,
  whole app shows a static "unsupported browser" notice instead of the quiz
  UI.
- No voiced frames detected at all (silence, or mic muted) → all morae
  `unclear`, explicit "couldn't detect your voice clearly — try again"
  message rather than a false score.

## Testing

Plain-JS asserts under `js/__tests__/`, matching jed's existing test style
(no framework, run via a plain `node` script):

- `pitchLevels`/`pitchAccentSVG` (ported logic): same cases as jlpt's own
  tests for heiban/atamadaka/nakadaka/odaka, since this is a port not new
  logic.
- `mora-segment`'s time-proportional mora splitting and median-relative H/L
  conversion, against synthetic Hz traces with known expected output.
- The `tools/` data-build script's intersection logic, against small fixture
  inputs standing in for `accents_kanjium.txt`/kotoba/jed vocab.
- F0 extraction itself (autocorrelation/YIN) is verified against synthetic
  sine-wave input at known frequencies (not against real recorded speech,
  which isn't practical in an automated test) — real-mic behavior is
  verified manually in-browser.

## Open items for implementation time (not blocking spec approval)

- Exact choice between `AnalyserNode` polling vs. `AudioWorklet` for frame
  capture — a performance/complexity trade-off best resolved while writing
  the code, not the spec.
- Exact initial word-list size after the kotoba/jed intersection (unknown
  until the build script actually runs against real data).
