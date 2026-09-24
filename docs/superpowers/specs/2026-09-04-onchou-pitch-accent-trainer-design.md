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
2. Lets the learner hear a reference pronunciation via the browser's built-in
   Japanese TTS voice, so they have something to imitate before recording.
3. Records the learner saying the word via the microphone.
4. Extracts an F0 contour from the recording, segments it per mora, and
   reduces it to the same H/L representation as the target pattern.
5. Renders the learner's detected pattern with the same diagram renderer,
   side by side with the target, and shows per-mora agreement.

Non-goals for v1: segmental (consonant/vowel) accuracy scoring, sentence-level
practice, and any cloud/model/server dependency.

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

### 2026-09-05 addendum: word pool narrowed to kotoba only

The implementation of the above build step revealed that jed's
`data/words/*.json` is effectively an unfiltered JMdict dump, not a curated
study list — unioning it in made the Kanjium intersection almost a no-op
(107,018 of ~108k Kanjium entries survived, a 6.3MB `data/words.json` fully
precached by the service worker on install). kotoba's vocab alone carries
`frequencyRank` and reads like an actual study list, so **v1 ships with
Kanjium ∩ kotoba only** (jed dropped from the union): 1,967 entries, 112KB.

`tools/build-words.js` keeps `jedPairsFromEntries` exported and tested (in
case a future revision wants to reintroduce a filtered subset of jed), but
`main()` no longer calls it. A future revision could reconsider a larger
pool (e.g. jed filtered by frequency/JLPT level rather than unioned in
whole) if 1,967 words proves too small in practice.

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

## Reference audio (TTS)

`js/reference-audio.js` wraps `window.speechSynthesis`: on "Play", speaks the
word's reading with a `ja-JP` voice (picked via `speechSynthesis.getVoices()`
filtered to `lang.startsWith('ja')`, same voice-selection approach
`ai-pronunciation-trainer`'s offline-first mode uses). No server-side
fallback (unlike `ai-pronunciation-trainer`'s sherox fallback) — staying
serverless is a hard requirement for this app, so a missing/absent Japanese
voice on the learner's system means "Play" is disabled with an inline note,
not a silent failure.

Known trade-off, accepted for v1: most competent Japanese TTS voices derive
prosody from an internal accent dictionary and get common words right, but
occasionally a lightweight/local voice will sound flat or wrong on rarer
words. The pitch-accent diagram (from `accentNum`, Kanjium-sourced) remains
the authoritative target the learner is scored against — TTS audio is a
listening aid, not the ground truth.

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

### 2026-09-24 addendum: H/L rule changed from a population-median threshold to a 2-cluster split

A synthetic-audio validation experiment (`tools/pitch-accuracy-experiment.js`,
run offline, not part of the shipped app) found that the rule above —
comparing each mora's median Hz to the recording's own overall median — is
structurally unable to avoid exact ties whenever one H/L class is a
plurality of the word's morae: the population median then lands exactly ON
that class's own value, tying every one of its slots against the very
threshold it's compared to. Atamadaka (H,L,L — two of three morae L) came
back `['H','H','H']` from a perfect, noiseless synthetic trace. No choice of
tie-breaking direction (nor routing exact ties to `'unclear'`, tried and
measured first) fixes this without instead breaking whichever *other*
pattern makes the opposite class the majority — heiban, this app's single
largest accent class (~47% of `data/words.json`), is H-majority and hit the
same failure mode from the other side.

`segmentByMora` now classifies each word's own per-mora medians (in log2 Hz)
as a 1D two-cluster problem instead: try every possible split point across
the sorted values and keep whichever minimizes total within-group
sum-of-squared deviations (1D 2-means / Otsu thresholding), rather than
testing each slot against a single population-wide number. The split
boundary is a computed midpoint between clusters, not one of the observed
values, so it can't coincide with either class by construction — unless
there's no contrast to find at all (every present slot the same value,
including every 1-mora word, which only ever has one slot), which correctly
stays `'unclear'` rather than guessing.

Measured on synthetic audio across all 33 `(moraCount, accentNum)` strata
actually present in `data/words.json`, 25 seeds each, weighted by real word
frequency, using a wide, roughly-fixed test gap (150Hz/100Hz, ~700 cents —
this experiment's own synthetic parameter, NOT a measurement of what real
learners' pitch actually does): exact-word-match rose from 35–85% (85% for
odaka, 35–47% for the other three classes) to 97–100% across every accent
class, and — unlike the old rule, whose accuracy degraded further under
added declination or per-mora jitter — held flat at ~99% across every
noise/declination condition tested at that gap size. `overallMedian` in
`segmentByMora`'s return value is unchanged (still the raw population
median): `js/pitch-contour.js` depends on that exact value to normalize the
learner's raw trace for its contour rendering, and this change only touches
the H/L decision, not that contract.

That first measurement's gap is wide and roughly fixed across conditions — a
"ceiling" case that doesn't say how the new rule holds up as the genuine
accent contrast gets *smaller*, e.g. a soft-spoken or careful learner whose
pitch doesn't swing as far as scripted audio does. A follow-up sweep varied
the H/L ratio itself (1.05 to 1.3, i.e. ~84 to ~455 cents) crossed with
declination (0, -5%, -10%), using oracle traces (`_estimatePitch` was
already validated separately) directly against `segmentByMora`'s exported
`_classifyLevels`:

| H/L ratio | declination | OLD exact% | NEW exact% |
|---|---|---|---|
| 1.05 (~84¢) | 0 / -5% / -10% | 56 / 39 / 14 | 35 / 19 / 16 |
| 1.1 (~165¢) | 0 / -5% / -10% | 56 / 51 / 36 | 99 / 83 / 36 |
| 1.2 (~316¢) | 0 / -5% / -10% | 56 / 50 / 44 | 99 / 99 / 99 |
| 1.3 (~455¢) | 0 / -5% / -10% | 58 / 50 / 45 | 99 / 99 / 99 |

NEW is essentially unchanged from the 150Hz/100Hz ceiling result once the
ratio reaches 1.2, and clearly better than OLD at 1.1 except under the most
severe combined stress (heavy declination on top of an already-subtle
contrast). At 1.05 — a contrast weak enough that even a perfect, noiseless
signal barely clears the noise floor any per-mora-median method has to work
with — NEW is *worse* than OLD; this is an accepted, disclosed loss (see
`MIN_SPLIT_CENTS` below), not an oversight.

**A second, distinct risk surfaced by that same follow-up work:** a 2-cluster
split, unlike a population-median comparison, always finds *some* division
of the data — even a recording with no real H/L contrast at all (a flat
attempt, or pure mic noise) gets partitioned into two groups, just a weak
one. This is most severe for a 2-mora word: with only two slots, the result
can only ever be `LH` or `HL`, and *every* 2-mora accent target in
`data/words.json` (291 of the level-"2" pool) is one of exactly those two
shapes — so a flat, no-accent attempt isn't a rare fluke away from an exact
match, it's close to a coin flip. Measured directly, using the SAME per-mora
(2%) + per-frame (1%) jitter model as the ratio sweep above (not an easier
noise floor than those real-contrast numbers): a genuinely flat trace (no
declination) scored a false "exact match" 3–52% of the time under the old
rule, across every mora count (2/3/4) and every target shape tested, and an
early, unguarded version of the new rule inherited that unchanged.

Fix: `classifyLevels` now computes the winning split's high/low gap in cents
and, below `MIN_SPLIT_CENTS` (100, picked from this same measurement — see
the comment above `classifyLevels` in `js/mora-segment.js`), reports every
present slot `'unclear'` instead of asserting a pattern that's plausibly
just noise. Effect at the genuine no-contrast condition (no declination):
false-exact-match fell to **0.0%** at every mora count and target shape
tested, while the ratio-sweep table above confirms a gap of 1.2 and up
(~316 cents) is essentially unaffected.

That same measurement, with declination added to the otherwise-flat trace,
surfaces a separate, pre-existing ambiguity worth naming plainly rather than
averaging away: a genuinely *declining* trend (not noise — a real, monotonic
drop across the recording) reads a lot like atamadaka's H-then-sustained-L
shape to any method working from per-mora medians alone. At -10%
declination scored specifically against an atamadaka target, the new rule's
false-positive rate is measurably *higher* than the old rule's at 3 morae
(28% vs 18%) and 4 morae (18% vs 1%) — though still much lower at 2 morae
(41% vs 100%), and lower than the old rule for every OTHER target shape
(heiban/nakadaka/odaka) at the same declination. This is not something
`MIN_SPLIT_CENTS` can fix by being tuned higher or lower: declination is a
genuine trend, not noise a stricter threshold filters out. It's a real
limitation of the time-proportional/no-forced-alignment approach itself (see
this file's "Method" note above), inherited by whichever H/L rule sits on
top of it.

`MIN_SPLIT_CENTS` was tuned entirely against synthetic audio and would
benefit from recalibration once real recorded takes are available (see the
"Caveat" below and `docs/2026-09-05-pitch-accent-evaluation-research-plan.md`).

**Downstream UI fix required by this same change:** `js/app.js`'s
`handleTrace` previously showed "Couldn't detect your voice clearly" for any
recording whose pattern came out all-`'unclear'`. Once a 1-mora word (which
always has no internal contrast to find) or a genuinely flat/careful attempt
can legitimately reach that same all-`'unclear'` state despite the mic
working fine, that message became actively wrong. `handleTrace` now checks
`segmented.spanStart == null` (literally zero voiced frames) for the
mic-failure message, and shows a distinct, accurate message — "single mora,
no relative pitch to compare, use ⇄ Compare instead" for a 1-mora word, "no
clear high/low difference detected, try exaggerating the pitch swing" for a
multi-mora take with nothing scoreable — rather than either dead-ending or
showing a misleadingly bad "0 of N matched" score.

Caveat: all measurement here is synthetic audio (additive harmonic stacks +
Gaussian noise), not recorded human speech — it validates the pipeline's
logic under known-ground-truth conditions, not real-speech accuracy.

### Scoring

Per-mora comparison of the learner's pattern against the target pattern from
`pitchLevels(moraCount, accentNum)`: a mora is a match if both are `H` or
both are `L`; an `unclear` mora is neither right nor wrong, shown as such
rather than counted against the learner. Score displayed as "N of M morae
matched" plus the two diagrams stacked for visual comparison — no single
opaque percentage.

## UI flow

1. Word card: kanji/kana word + reading + target pitch diagram + "▶ Play"
   button (TTS reference, disabled with an inline note if no Japanese voice
   is available).
2. "Record" button → mic permission prompt (first time) → recording state
   (visual indicator, e.g. pulsing dot) → learner taps "Stop" (or a max
   duration auto-stop, e.g. 3s, to bound memory/processing).
3. On stop: run `pitch-detect` + `mora-segment` → render learner's diagram
   directly under the target diagram → per-mora match/mismatch/unclear
   highlighting → "N of M matched" text.
4. "Next word" advances; "Retry" re-records the same word. "▶ Play" remains
   available at every step to re-listen.

## Error handling

- No `ja-JP` (or `ja-*`) voice available via `speechSynthesis.getVoices()` →
  "▶ Play" is disabled with an inline note ("no Japanese voice found on this
  device/browser") rather than speaking in the wrong language or silently
  no-op'ing. The pitch diagram remains the primary reference regardless.
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
