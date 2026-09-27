# onchou — Real-Audio Pitch-Accuracy Evaluation (JSUT) — Design & Results

> **Status update (Round 3):** the per-mora accuracy used in the Round 1–2
> sections below turned out to reward the corpus's pattern skew rather than
> accent discrimination (a no-audio guess scores ~66%). Re-measured with
> within-mora-count κ, the old shipped classifier was at chance, and three
> literature-derived changes — a relative voice gate, a 40ms peak-delay
> window shift, and constrained template decoding with joint declination —
> are now SHIPPED in `js/mora-segment.js` (held-out κ −0.04 → 0.29 on
> app-like audio). Round 4 confirmed it transfers to 33 native speakers
> saying isolated words (UME-JRF) and added a heavy-first-syllable rule
> (natives κ 0.029 → 0.353, 'unclear' 33% → 13%). See "Round 3" and
> "Round 4" near the end; earlier sections are kept as the record of how
> that was reached.

> **Correction (2026-09-26, PR review):** `tools/jsut-lab-parser.js` grouped
> phones into accent phrases by `(f1, f2)` only, which merged ADJACENT
> phrases sharing a mora count and accent type (e.g. BASIC5000_4989:
> こばやし `F:4_4...@1_2` then いさむわ `F:4_4...@2_1`, no pause). 1,153 of
> the corpus's 34,974 phrases (3.3%, 994 sentences) were merged into their
> predecessor, producing samples whose mora spans crossed the boundary. It
> now groups by the whole F field and splits wherever the mora position
> resets. All experiments were re-run on the corrected data (tools/tmp/v5
> outputs); changes are small (e.g. shipped decoder on JSUT app-like test
> κ 0.242 → 0.236; JSUT-trained Gaussians on UME-JRF natives B 0.530 →
> 0.514; the signal-level figures below are updated), UME-JRF-only results
> are unaffected, and every shipped constant still wins under the
> criterion it was chosen by. Other JSUT figures quoted in the round-by-
> round sections below are the PRE-correction values, kept as the
> historical record of how each decision was reached.

## Problem

`docs/2026-09-05-pitch-accent-evaluation-research-plan.md` names the shipped
pitch pipeline's biggest open gap: it has only ever been validated against
synthetic sine-wave input (`tools/pitch-accuracy-experiment.js`) and
hand-written H/L fixtures. That plan treats real-audio validation as
future work blocked on a 2-3 year data-collection effort (consent, ethics
review, recording a labeled learner corpus from scratch).

That blocker turns out to be partly avoidable now: this session has local
access to the JSUT speech corpus (`/data/jsut_ver1.1`, a real, single-
speaker Japanese corpus already used elsewhere on this machine) and to
[jsut-label](https://github.com/sarulab-speech/jsut-label), which provides
**manually-annotated, forced-aligned** phonetic/prosodic labels (CC-BY-SA
4.0) for JSUT's `basic5000` subset (5000 sentences) — the only subset
jsut-label currently covers.

## What this evaluation is, and isn't

This closes part of the research plan's "decision-level" validation layer
(per-mora H/L classification accuracy against a known-correct pattern) using
**real recorded speech** for the first time — a genuine advance over
synthetic-only validation. It is explicitly **not**:

- **A learner-recording evaluation.** JSUT is one professional native
  speaker reading news-style sentences fluently in a studio — not a learner
  practicing an isolated word into a phone mic. The research plan's
  "native vs L2 learner" and "recording condition" breakdowns, and its
  perceptual-validation layer (native-rater judgments), are still open.
- **An isolated-word evaluation.** onchou's actual UI asks the learner to
  say ONE word (or word+が in particle mode) in isolation. JSUT's accent
  phrases are embedded in continuous, multi-phrase sentences, so they carry
  real sentence-level declination and coarticulation across phrase
  boundaries that an isolated citation-form utterance would not have. This
  is a **harder** regime than onchou's real deployment context, not an
  equivalent one — see "Key finding" below.
- **A signal-level (F0-estimator-vs-reference-extractor) benchmark.** The
  research plan's item 1 (GPE/RMSE against Praat/YIN/CREPE/WORLD) is not
  covered here; this evaluation runs the shipped estimator alone, on real
  audio, and checks its *classification* output against ground truth.

Despite these caveats, this is real, non-synthetic, native-speaker,
per-mora-labeled audio — a substantive step beyond what the app had before.

## Ground truth: jsut-label as an accent-phrase-level dictionary

jsut-label's HTS-style full-context phoneme labels (`tools/jsut-lab-parser.js`
parses these) carry a `F:f1_f2#...` field per phoneme giving the CURRENT
accent phrase's own mora count (`f1`) and accent type (`f2`) — and `f2` uses
**exactly Kanjium's `accentNum` convention** (0 = heiban/no drop, N = pitch
drops immediately after mora N). Verified during development against
`vendor/kanji-data/compounds/accents_kanjium.txt` for an unambiguous word
(木曜日/もくようび → accentNum 3 in both places; see the test fixture in
`js/__tests__/jsut-lab-parser-test.js`). A phoneme's `A:a1+a2+a3` field's
`a2` gives that phoneme's 1-based mora position within its accent phrase,
letting consecutive same-`a2` phones be grouped into per-mora time spans
(forced-aligned via Julius per jsut-label's own README).

**Design choice: score whole accent phrases, not dictionary words.** An
accent phrase (e.g. わたしが, "I" + subject particle, one prosodic unit) is
used directly as the scoring unit — `moraCount = f1`, target pattern =
`PitchDiagram.pitchLevels(f1, f2).slice(0, f1)` — rather than trying to
resolve it back to a single dictionary headword. This sidesteps needing a
morphological analyzer (no MeCab available in this environment) and is
actually a **closer match** to onchou's own particle-mode feature than
scoring bare dictionary words would be: a phrase like わたしが is exactly
"word + attached が" in miniature, with a single accentNum governing the
whole span, precisely the shape `particleMode` (see
`docs/superpowers/specs/2026-09-25-onchou-particle-mode-design.md`) targets.

## Pipeline (real, unmodified production code)

`tools/evaluate-jsut-accuracy.js`:

1. **`tools/wav-reader.js`** — dependency-free PCM WAV decoder (JSUT is
   mono/16-bit/48kHz; confirmed via `soxi`). No npm dependency, matching
   every other `tools/*.js` script in this repo (there is no `package.json`
   at all).
2. **`tools/jsut-lab-parser.js`** — parses `.lab` files into accent-phrase
   records (see above). Pure, DOM-free, unit-tested
   (`js/__tests__/jsut-lab-parser-test.js`).
3. For each accent phrase, `buildTrace()` extracts a `{tMs, hz|null}` trace
   using the **exact production constants and estimator**:
   `PitchDetect._FRAME_SIZE`, `PitchDetect._HOP_MS`, and
   `PitchDetect._estimatePitch()` itself (not a reimplementation) — run
   against real PCM samples windowed to end at each hop's absolute sample
   position, the same "most recent FRAME_SIZE samples up to now" shape
   `AnalyserNode.getFloatTimeDomainData` polled via `setInterval` produces
   in the browser (see `js/pitch-detect.js`'s own header comment on that
   choice). A small silence pad (`--pad-ms`, default 50, tunable) is added
   on each side of the phrase's labeled span before extraction, clipped to
   the sentence's own audio bounds.
4. `MoraSegment.segmentByMora()` + `MoraSegment.scorePattern()` — the
   **exact shipped functions**, run against the phrase's real trace and its
   jsut-label-derived target pattern.
5. `WordSelect.classifyPattern()` — the exact shipped function — buckets
   each phrase into heiban/atamadaka/nakadaka/odaka for the breakdown.

For the `--sweep` flag (MIN_SPLIT_CENTS parameter search), a **separate,
explicitly-labeled copy** of `classifyLevels` lives in the eval script
(`classifyLevelsWithThreshold`) rather than changing `js/mora-segment.js`'s
signature to accept an override — this keeps the shipped module's behavior
completely unchanged while the sweep is exploratory, at the cost of needing
to trust the copy is faithful. `selfTest()` (run automatically before every
evaluation) cross-checks this copy against the shipped
`MoraSegment._classifyLevels` at `minSplitCents=100` (today's shipped
default) on representative fixtures, so a divergence would fail loudly
rather than silently skew the sweep.

## Metrics reported

Matching the research plan's decision-level metrics: per-mora accuracy
(excluding `unclear` from the denominator, per the app's own "unclear is
neither right nor wrong" convention, and a pessimistic variant counting
`unclear` as wrong), exact-phrase-match rate, `unclear` rate, all broken
down by accent type and by mora count. Full per-phrase raw data is also
written to JSON (`--out`, default `tools/tmp/jsut-accuracy-<timestamp>.json`)
for closer inspection.

## Pilot finding (20 sentences, 97 phrases) — methodology validation

Before running the full corpus, a 20-sentence pilot both validated the
pipeline is wired correctly (spot-checked against hand-traced examples,
e.g. 木曜日/もくようび scored a clean exact match: real F0 trace → `L,H,H,L,L`
learner pattern == target) and surfaced accuracy far below the ~97-100%
seen on `tools/pitch-accuracy-experiment.js`'s synthetic audio (~54-56%
per-mora, `--pad-ms 0` vs `50` moving the number by under 2 points — ruling
out padding artifacts as the main driver).

**Key finding: this gap is exactly the declination risk the synthetic
experiments already predicted, now confirmed on real speech.** The
2026-09-24 addendum in
`docs/superpowers/specs/2026-09-04-onchou-pitch-accent-trainer-design.md`
found (on *synthetic* declining traces) that a genuine monotonic pitch drop
across a recording "looks a lot like atamadaka's H-then-sustained-L shape to
any method working from per-mora medians alone," and is "a real limitation
of the time-proportional/no-forced-alignment approach itself... not
eliminated by raising or lowering MIN_SPLIT_CENTS." JSUT's sentence-embedded
accent phrases carry exactly this: real, continuous-speech declination
across the whole utterance, which a single accent phrase's own local
2-cluster split can't distinguish from that phrase's own accentual
contrast. A manually-inspected failure case
(ていせんかいだんわ, 9 morae, accentType 5) showed real audio produced
`H,H,H,H,H,H,L,L,L` against a target of `L,H,H,H,H,L,L,L,L` — a pattern
entirely consistent with a declining baseline shifting the 2-cluster split
point rightward, not a nonsensical or buggy result.

This means the pilot's low numbers should **not** be read as "the shipped
algorithm doesn't work" — they reflect testing on continuous, sentence-
embedded speech, which is harder than and different from onchou's actual
isolated-word use case, and the failure mode observed is the SAME one the
design spec already disclosed as an accepted, unresolved limitation of
time-proportional segmentation. See "Non-goals" below for what this does
and doesn't justify changing.

## Full-corpus results (5000 sentences, basic5000)

All 5000 `basic5000` sentences, 33,821 accent-phrase samples, 165,227 morae
scored (`tools/tmp/jsut-accuracy-full.json` has the raw per-stratum counts).

### Decision-level: shipped algorithm, unmodified (MIN_SPLIT_CENTS=100)

| Metric | Value |
|---|---|
| Per-mora accuracy (excl. unclear) | **56.8%** (n=161,984 of 165,227) |
| Per-mora accuracy (unclear counted wrong) | 55.7% |
| Unclear rate | 2.0% |
| Exact-phrase-match rate | 14.4% (n=33,821 phrases) |

By accent type (per-mora accuracy / exact-match rate):

| Type | Per-mora acc. | Exact match | n (phrases) |
|---|---|---|---|
| odaka | 48.6% | 19.7% | 10,706 |
| nakadaka | 61.6% | 6.0% | 14,308 |
| atamadaka | 56.3% | 21.7% | 8,807 |

(No heiban phrases appear in this table at all — 0 of 33,821 (0 of 34,974 with the corrected parser), confirmed by
grepping the raw `.lab` files directly for `F:N_0#`, zero hits corpuswide.
This is not a parser bug — see "jsut-label cannot express heiban distinctly
from odaka" below, which also explains why this is harmless for the
headline per-mora numbers above despite affecting this one breakdown.)

By mora count, accuracy is worst at 2-6 morae (53-57%) and rises somewhat
for longer phrases (60-74% at 7-14 morae, though n drops off sharply there —
the 15-17 mora rows, n≤4, are noise). 1-mora phrases (n=35) trivially show
100% "exact match" — a metric artifact, not a real result: with no second
mora to compare against, every position is `unclear`, so there are zero
`mismatch`es to fail the exact-match check on. This matches the app's own
existing "single mora, no relative pitch to compare" message (see
`js/app.js`'s `handleTrace` and the particle-mode design spec, which
specifically extends scoreability to 1-mora words via the particle).

### MIN_SPLIT_CENTS sweep: essentially flat — not the real-audio bottleneck

| MIN_SPLIT_CENTS | Per-mora acc. | Pessimistic | Exact match | Unclear rate |
|---|---|---|---|---|
| 0 | 56.7% | 56.6% | 12.4% | 0.2% |
| 100 (shipped) | 56.8% | 55.7% | 14.4% | 2.0% |
| 200 | 57.0% | 53.4% | 18.7% | 6.2% |
| 300 | 57.0% | 50.0% | 24.7% | 12.3% |
| 400 | 56.6% | 45.4% | 31.7% | 19.7% |

Per-mora accuracy (excluding unclear) barely moves across the **entire**
0-400 cent grid (56.6-57.0%, under half a point of spread) — a stark
contrast with the synthetic experiments in
`docs/superpowers/specs/2026-09-04-onchou-pitch-accent-trainer-design.md`,
where this same threshold was the difference between 35-85% and 97-100%
exact-match. **Conclusion: on real, sentence-embedded speech,
MIN_SPLIT_CENTS is not the lever that determines accuracy.** The rising
exact-match rate at higher thresholds is a coverage/unclear-rate trade-off,
not a real accuracy gain: a higher threshold reclassifies more borderline
calls as `unclear` (up to 19.7% of all morae at 400 cents) rather than
guessing, and an `unclear` mora can't fail the exact-match check the way a
wrong guess can — so exact-match rises largely because the metric is
answering fewer questions, not because it's answering them better
(pessimistic accuracy, which does count `unclear` against the phrase, falls
steadily instead, from 56.6% to 45.4% over the same range, confirming this).

**Recommendation: do not change the shipped `MIN_SPLIT_CENTS=100`** based on
this data. It was tuned against synthetic isolated-word traces — the actual
regime onchou's UI operates in (a learner records ONE word/word+が in
isolation) — and this real-audio evaluation, run on continuous
sentence-embedded speech (a harder, different regime — see "What this
evaluation is, and isn't"), shows no real-audio evidence that a different
value would help *and* provides positive evidence it wouldn't hurt (the
sweep is flat either way). Changing it now would be optimizing for a metric
artifact on a mismatched-register evaluation, not a real improvement.

### jsut-label cannot express heiban distinctly from odaka

`accentType=0` (heiban) never appears anywhere in the corpus (verified both
via the parser and by grepping the raw `.lab` files directly). This is a
genuine property of the label scheme, not a bug, and it has a real
linguistic explanation directly connected to onchou's own particle-mode
feature (`docs/superpowers/specs/2026-09-25-onchou-particle-mode-design.md`):
**heiban and odaka are acoustically identical across a phrase's own morae —
they differ only in what happens on whatever follows.**
`PitchDiagram.pitchLevels(moraCount, 0)` and
`PitchDiagram.pitchLevels(moraCount, moraCount)` produce byte-identical
`L,H,H,...,H` word-internal patterns (differing only in the trailing
pseudo-mora this evaluation already slices off, matching the app's
non-particle scoring path) — so an annotation scheme built from
phrase-internal acoustics alone has no way to write "heiban" as anything
other than "accentType = moraCount," the same value odaka gets. That
explains why 0 never appears: **the "odaka" row above is really an
"odaka-or-heiban" bucket** — some fraction of those 10,706 phrases are
lexically heiban words whose phrase happened not to reveal it.

This is harmless for every per-mora accuracy number reported here, because
scoring is done against the sliced, word-internal-only target pattern,
which is identical either way — a phrase mislabeled "odaka" instead of
"heiban" (or vice versa) scores exactly the same. It only means the
by-accent-type breakdown's "odaka" label should be read as "odaka/heiban,"
not pure odaka. Disambiguating the two would need cross-phrase context
(whether pitch stays high into the next phrase) that this evaluation
doesn't attempt to use — out of scope here, and exactly the gap
particle-mode's "＋ が" recording is designed to give the learner-facing app
a real answer to instead.

### Why it's flat: declination confounds the classifier, confirmed on real audio

Manual inspection of a representative failure (BASIC5000_0002's second
accent phrase, ていせんかいだんわ, 9 morae, target accentType 5) showed
real F0 producing `H,H,H,H,H,H,L,L,L` against a target of
`L,H,H,H,H,L,L,L,L` — the shape of a declining baseline shifting the
2-cluster split point rightward, not a nonsensical result. This is *exactly*
the risk the synthetic-audio addendum already disclosed and explicitly
declined to try to fix via `MIN_SPLIT_CENTS` ("declination is a genuine
trend, not noise a stricter threshold filters out... a real limitation of
the time-proportional/no-forced-alignment approach itself"). This
evaluation is the first *real-audio* confirmation that prediction holds.

**Tried and did NOT help: linear detrending before clustering.** Since
sentence-embedded declination was the leading hypothesis, one targeted,
cheap experiment was run: fit a least-squares line through each phrase's own
per-mora log-Hz medians (vs. mora index) and 2-cluster-split the residuals
instead of the raw values (`classifyLevelsDetrended` in
`tools/evaluate-jsut-accuracy.js`, run via `--detrend`). Result, confirmed
at full-corpus scale across the whole threshold grid: detrending
**consistently reduces** per-mora accuracy by about 2.2-2.4 points relative
to the non-detrended baseline at every MIN_SPLIT_CENTS value tried:

| MIN_SPLIT_CENTS | Non-detrended acc. | Detrended acc. | Δ |
|---|---|---|---|
| 0 | 56.7% | 54.3% | −2.4 |
| 100 | 56.8% | 54.6% | −2.2 |
| 200 | 57.0% | 54.7% | −2.3 |

The likely reason: fitting a line across ALL of a phrase's slots —
including the ones that carry the genuine H/L step, not just the ones
carrying only declination — partially absorbs that step into the fitted
slope rather than isolating a pure declination component, so it removes
some real accentual signal along with (at best) some real declination,
netting a loss rather than a gain. This was a bounded, evidence-driven
experiment (not a speculative rewrite), and its negative result is itself
useful: it rules out the simplest fix and narrows what a future structural
change (e.g. forced-alignment-based mora boundaries instead of
time-proportional slicing, which wouldn't need to guess and subtract a
global trend at all) would need to do differently. **This idea is not
recommended for adoption** — it was evaluated and rejected, not shipped.

### Tried and did NOT help: energy-based mora boundary refinement

A real forced aligner (Julius/Kaldi/MFA-style, as jsut-label's own ground
truth was built with) needs a trained acoustic model — incompatible with
onchou's "no ML model, no server" architecture for a client-side, real-time
recorder. A cheap, model-free proxy was tried instead: each frame's RMS
energy (free from the same samples `_estimatePitch` already reads — no
extra audio pass, no model) was used to snap each naive equal-width slot
boundary to the nearest local energy minimum within a bounded search
window, on the theory that inter-mora gaps and consonant closures tend to
show as real energy dips (`segmentByMoraEnergyAligned` in
`tools/evaluate-jsut-accuracy.js`, run via `--energy-align`).

**Result: also a loss**, smaller than detrending's but still a loss, at
every threshold tried (full corpus, 165,227 morae):

| MIN_SPLIT_CENTS | Baseline acc. | Energy-aligned acc. | Δ |
|---|---|---|---|
| 0 | 56.7% | 55.0% | −1.7 |
| 100 | 56.8% | 55.0% | −1.8 |
| 200 | 57.0% | 55.2% | −1.8 |

A follow-up **confidence-gated** variant (`segmentByMoraEnergyGated`) only
accepts a snap when the found dip is at least `dipRatio` below the energy
at the naive guess itself, otherwise keeps the naive boundary unchanged —
so it can only do as much damage as the baseline in the worst case, never
more. Sweeping `dipRatio` (reusing the already-cached traces, no
re-extraction needed) gives a clean, decisive answer:

| dipRatio (stricter →) | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 |
|---|---|---|---|---|---|---|---|---|---|
| Per-mora acc. | 55.2% | 55.4% | 55.6% | 55.9% | 56.3% | 56.4% | 56.7% | 56.7% | 56.8% |

Accuracy **monotonically converges to exactly the baseline (56.8%) as the
gate gets stricter** — i.e., as the heuristic snaps less and less often.
There is no operating point where any amount of energy-based snapping beats
simply not doing it; the best achievable is "as good as the naive method,"
approached only by making the heuristic inactive. This is a clean, decisive
negative result, not an inconclusive one: it rules out RMS energy as a
useful free signal for mora-boundary refinement in this form, likely
because energy dips correlate more with specific consonant identity
(voiceless stops/fricatives create large dips regardless of position) than
with true mora-boundary timing, so snapping to "the nearest dip" chases
noise as often as it finds a real boundary.

### Oracle check: how much does mora-boundary imprecision cost, on its own?

jsut-label's own per-mora time boundaries (from Julius forced alignment)
were parsed and kept all along (`parseAccentPhrases`'s `moras` field) but
not yet used for scoring — every result above used onchou's own
time-proportional (or energy-based) *guess* at where each mora falls, even
though the *real* boundary was sitting right there in the ground truth.
Re-scoring the exact same real F0 traces, but bucketing each frame into its
**real, forced-aligned mora** instead of a proportionally-guessed slot,
answers a precise question this evaluation couldn't otherwise separate:
how much of the ~57% ceiling is *segmentation* error (which forced
alignment fixes) versus *classification* error (which it doesn't)?

| MIN_SPLIT_CENTS | Time-proportional (guessed) | Oracle boundaries (real) | Δ |
|---|---|---|---|
| 0 | 56.7% | 60.8% | **+4.1** |
| 100 | 56.8% | 61.1% | **+4.3** |
| 200 | 57.0% | 61.4% | **+4.4** |

**This is the single most decisive number in this evaluation, and it cuts
both ways:**

- **Forced alignment would genuinely help** — a consistent, real ~4-point
  gain, not noise or a metric artifact (same trace, same classifier, only
  the slot boundaries differ). This validates that segmentation error is a
  real, non-trivial contributor, and that the "next step" hypothesis this
  session set out to test was directionally correct.
- **But it is nowhere near sufficient on its own.** Even with *perfect*
  (oracle, forced-aligned) mora boundaries, real-audio accuracy is still
  only ~61% — a world away from the ~97-100% synthetic-audio ceiling. Of
  the roughly 36-40 points separating synthetic from real-audio accuracy,
  **only about 4 are attributable to segmentation/boundary imprecision; the
  remaining ~32-36 points are the classification/declination issue already
  diagnosed above**, which forced alignment does not touch — perfect
  timing on a phrase that has real declination running through it still
  confuses a per-mora-median 2-cluster split.

This reframes the earlier "most valuable next step" recommendation: forced
alignment (however it might eventually be achieved within or around
onchou's "no ML model, no server" constraint — e.g. a tiny WASM-based
aligner, if one existed that stayed acceptably small/fast, was ever judged
worth the architectural trade-off) would be a real, worthwhile, ~4-point
improvement — but pursuing it WITHOUT also addressing declination would
leave the large majority of the real-audio gap unaddressed. The
declination/classification problem is the dominant lever; boundary
precision is a real but secondary one.

### Follow-up check: is this cumulative sentence declination, or per-phrase?

If the confound were mostly *cumulative* declination building up across a
sentence, phrases later in a sentence should score noticeably worse than
phrases near the start. Bucketing all 33,821 phrases by their position
within their own sentence (first/middle/last third) and re-scoring (reusing
the cached traces, no re-extraction) shows this is **not** the case:

| Position | Per-mora acc. | Exact match | n |
|---|---|---|---|
| First third | 57.1% | 14.1% | 13,010 |
| Middle third | 57.8% | 16.0% | 7,800 |
| Last third | 56.0% | 13.8% | 13,010 |

Only ~1.8 points of spread, no clear monotonic trend. This means the
confound is better described as **local, per-phrase declination** — the
natural intonational fall a single accentual phrase carries on its own over
its ~200-800ms span (a well-documented feature of Japanese phrase prosody),
not an accumulating sentence-level drift. Practically, this tempers the
earlier framing: an isolated single-word (or word+が) recording, as onchou's
UI actually asks for, would still carry this SAME local declination
tendency even though it isn't embedded in a longer sentence — so this
evaluation's ~57% shouldn't be read as "isolated-word accuracy is much
higher than this," only that sentence-embedding specifically (as opposed to
declination in general) isn't the main extra burden continuous speech adds.
What continuous speech still plausibly adds beyond this (not measured here):
faster/coarticulated speech rate and no clear boundary pauses, both typical
of fluent read-aloud narration and both likely to differ from a learner's
slower, more deliberate citation-form attempt.

### Signal-level (research plan item 1): the estimator itself is not the problem

Independent cross-check against `librosa.pyin` (`tools/jsut-signal-level-check.py`)
on 400 real accent-phrase clips (~14,600 frames):

| Metric | Value |
|---|---|
| Voicing agreement | 78.5% (was 74.2% before frames with no reference within 15ms were excluded) |
| Both-voiced frames | 63.4% of compared |
| GPE (>20% relative error) | 1.2% of both-voiced frames |
| RMSE (excl. GPE frames) | 24.1 cents |

Near-zero gross/octave errors and ~24 cents RMSE (a quarter of a semitone)
against an independent reference extractor, on real speech, is a clean
result — `js/pitch-detect.js`'s lightweight autocorrelation estimator is
**not** the bottleneck. This cleanly separates the two validation layers the
research plan calls for: the raw F0 signal is trustworthy; the per-mora
decision layer (segmentation + classification) is where real-audio accuracy
is actually lost, and specifically to declination, not to threshold tuning
or bad pitch tracking.

## Round 3: literature-derived improvements (SHIPPED)

**Read this first — it corrects the metric every section above relies on.**
All of the per-mora numbers above (≈57%) turn out to be dominated by the
corpus's skewed accent-pattern distribution, not by anything the audio
says. A decoder that ignores the audio entirely and always outputs the most
frequent pattern for each mora count scores **66.1% per-mora and 41.1%
strict** (every mora right) on the held-out split — higher than the shipped
classifier, and higher than every audio-based variant tried in the rounds
above. Such a decoder is useless to a learner (it gives the same verdict
whatever they say). So the metric used from here on is **Cohen's κ between
the predicted and target pattern, computed within each mora count and
averaged weighted by support** (a constant guess scores exactly 0; pooling
mora counts would hand every decoder free agreement for knowing the mora
count). Strict whole-pattern accuracy and per-mora accuracy are still
reported alongside. Measured this way, **the shipped classifier had
κ = 0.004 on continuous phrases** — essentially no accent discrimination.

### Protocol

- Every parameter is tuned ONLY on sentences BASIC5000_0001–4000; every
  reported result is on held-out sentences 4001–5000.
- Two real-audio test sets: **phrase** (every accent phrase, 30ms pad —
  continuous-speech context) and **applike** (`tools/build-applike-set.js`:
  a sentence's first accent phrase with up to 300ms of its REAL leading
  silence, and its last with up to 300ms of real trailing silence — the
  closest JSUT gets to an onchou take, where the learner taps Record, pauses,
  speaks, pauses). The phrase set could never expose how the pipeline
  handles silence: in connected speech the 30ms pad is always voiced.
- Contrast guard fixed at `MIN_SPLIT_CENTS = 100` for every production
  candidate: JSUT has no flat/monotone attempts, so tuning it on JSUT would
  always pick 0 and discard the protection the synthetic flat-trace study
  established.
- Every production candidate re-checked against the synthetic contract
  (`tools/synthetic-regression.js`): clean isolated words with ZERO peak
  delay at 150ms and 250ms morae, and flat-attempt false positives.

### Literature consulted

- **Ishi, Minematsu & Hirose (2001)**, *Recognition of accent and
  intonation types of Japanese using F0 parameters related to human pitch
  perception* (ISCA Prosody workshop) — one representative F0 per mora
  (best: the regression "target" at mora end, or the VC-unit average,
  i.e. measured LATE in the mora), F0ratio = semitone step between adjacent
  morae, accent-TYPE identification restricted to the valid Tokyo types:
  75% on continuous speech (vs 65% for frame-level F0 HMMs).
- **Short, Hirose & Minematsu (SLaTE 2011)**, *Rule-based method for pitch
  level classification for a Japanese pitch accent CALL system* — the F0 at
  the END of the first mora of a pair is what decides the perceived H/L
  transition; also argues learners can produce patterns outside the Tokyo
  set (the trade-off noted below).
- **Fujisaki command–response model** — log F0 as the sum of a slow phrase
  component (declination) and step-like accent components; the basis for
  fitting declination JOINTLY with the accent step rather than first.
- General finding across the Minematsu/Hirose line of work: the accent
  nucleus is the mora immediately before a rapid, local pitch fall.

### What was built and tried (`tools/accent-decoders.js`, `tools/evaluate-decoders.js`, `tools/evaluate-pipeline.js`)

Mora value: `median` (shipped), `late` (second half of the slot), `target`
(Ishi et al.'s regression-to-slot-end). Decoder: `twoMeans` (shipped
`classifyLevels`, re-implemented and verified byte-identical on all 33,786
multi-mora phrases), `template` (valid Tokyo patterns only, least squares),
`templateTrend` (same, fit jointly with a bounded declination slope),
`nucleus` (largest fall relative to the median step). Plus, from
diagnostics described below: a relative-energy **voice gate** and a
**peak-delay** window shift.

Key held-out results on the **phrase** set with the shipped proportional
slots (κ / strict): shipped 0.004 / 11.1%; median+template 0.099 / 32.8%;
late+templateTrend 0.107 / 33.1%; nucleus ≤ 0.087. With oracle
(forced-aligned) slots the best hand-specified decoder reaches κ 0.18.

**A trained reference model shows how much the features carry.** Ishi et
al.'s own recipe — one diagonal Gaussian per (mora count, pattern) over the
F0ratio vector, fit on the training split, equal class priors so it can't
exploit the skew — reaches **κ 0.35 / 53% strict / 81% per-mora** on the
held-out phrases with the SAME proportional slots. It isn't shippable
(it's a trained model, and trained on one fast native speaker), but it
proved the gap was in the decision rule's assumed shape, not the audio.

### Two diagnostic findings that drove the shipped changes

**1. F0 peak delay, measured against real mora boundaries.** Averaging the
per-mora F0 steps by target pattern shows realized accent events landing
about a mora LATER than the labels — and this holds with jsut-label's own
forced-aligned boundaries, not just proportional slots (e.g. atamadaka
H,L,L realizes as a +159-cent *rise* into mora 2 before its fall). Label
timing was checked and is sound (median energy onset +10ms from the
labeled first phone). This is the known phonetic effect Ishi et al.'s
late-measured mora values compensate for: the accentual peak/fall is
realized at the end of the accented mora or in the following one, and the
phrase-initial rise eats into mora 1. Binning by speaking rate, the best
delay is roughly constant in **milliseconds** (≈125–150ms) rather than in
fractions of a mora, and a ms-parameterized delay beat the fractional one
in every rate bin — which matters because onchou's input (one slow word) has
much longer morae than JSUT's read speech.

**2. The shipped estimator reports pitch on silence.** On JSUT's leading
'sil', `_estimatePitch` returns random 70–400Hz values on frames 25–58dB
below the take's loudest frame (real voiced speech: 0–9dB below). In an
onchou take — silence around the word — those frames stretch the "voiced
span" that every mora slot is cut from. On the applike set the shipped
pipeline scores **κ = −0.037 (below chance), 7.3% strict, 43% per-mora**.

### Shipped configuration and held-out results

`js/mora-segment.js`'s `segmentByMora` now: (1) gates frames more than
**15dB** below the take's loudest frame (`VOICE_GATE_DB`; train optimum was
12dB on a flat 10–15dB plateau, 15 chosen for headroom on quiet morae);
(2) reads each equal-width slot **40ms late** (`PEAK_DELAY_MS`, capped at
half a slot); (3) decodes with **constrained templates + joint declination**
(`decodeAccentPattern`: valid Tokyo patterns only, v = a + b·i + c·T,
c ≥ 0, −50 ≤ b ≤ 0 cents/mora, lowest residual wins, all-'unclear' if
c < 100 cents); slots with no voiced frames stay 'unclear'.
`js/pitch-detect.js` now records per-frame `rms` in the trace.

Why 40ms and not the real-audio optimum (75ms applike / 125ms phrase):
clean synthetic isolated words have ZERO peak delay, the worst case for a
late window. 75ms drops their exact-match to 36–82% at 150ms morae; 50ms
passed the trace-level suite but `tools/pitch-accuracy-experiment.js`
Stage 2 (synthesized audio through the real estimator) caught it dropping
to 92.1% on words with 40ms pitch glides at mora boundaries; 40ms keeps
every Stage 2 pass at 100%. Between 40 and 50, the choice was made on the
TRAINING split (κ 0.236 vs 0.255 applike) plus that synthetic constraint —
the held-out numbers below were computed once, for 40ms only. The glide
condition has since been added to `tools/synthetic-regression.js`.

Held-out, the ACTUAL shipped function (not the harness replica):

| Set | Pipeline | κ | strict | per-mora | unclear |
|---|---|---|---|---|---|
| applike | old | −0.037 | 7.3% | 43.2% | 0.0% |
| applike | **new** | **0.285** | **43.8%** | **80.0%** | 9.9% |
| phrase | old | 0.004 | 11.1% | 57.5% | 2.1% |
| phrase | **new** | **0.234** | **39.6%** | **79.3%** | 8.8% |

Ablation on applike (harness, held-out κ): voice gate alone 0.075;
constrained templates alone 0.012; gate + templates 0.181; + 75ms delay
0.301 — the gate and templates only pay off together, and the delay roughly
doubles the rest.

Synthetic contract (`tools/synthetic-regression.js`, old → new, exact-match,
150ms morae): weak contrast (H/L 1.1) with 10% declination 38.9% → 86.5%
(34.4% → 83.3% with 40ms glides); strong contrast unchanged at 100%; weak
contrast without declination 99.7% → 98.3% (the one small regression).
Flat-attempt false exact matches: 2-mora with −10% declination 14.3% →
5.7%, 3-mora 7.4% → 0.4%; 2-mora with no declination 0.0% → 1.6% (the one
small increase). `tools/pitch-accuracy-experiment.js` Stage 2 (synthesized
audio → real estimator → new `segmentByMora`): 100% on every pass.

Verified end to end in headless Chrome with a real JSUT clip (みずを) fed
through the fake-microphone path: all trace frames carry `rms`, the voiced
span starts after the ~300ms of leading silence rather than inside it, and
the decoded pattern (L,H,H) matches jsut-label's accent type 3.

### Honest caveats

- Still one native speaker's read speech. The applike set is the best
  available proxy for an onchou take, not a learner recording.
- 44% strict / κ 0.29 is a large step up from chance, not a solved problem;
  the trained reference (κ 0.35 on phrases) marks roughly where the same
  features top out with a learned rule.
- **Constrained decoding hides out-of-set learner errors.** Short et al.
  (2011) point out that learners can produce patterns no Tokyo word has
  (e.g. H,L,H,L); the new decoder maps such a take to the nearest valid
  pattern. The old unconstrained split could in principle report them, but
  on real speech its output carried essentially no accent information
  (κ ≈ 0), so it wasn't reporting them reliably either. Revisit if learner
  recordings become available.
- The 40ms delay is a compromise between fast read speech (wants
  ~75–125ms) and zero-delay synthetic words (tolerate at most ~40ms).
  Isolated-word recordings with labels would settle it.

## Round 4: multi-speaker isolated words (UME-JRF) and the heavy-syllable rule (SHIPPED)

### Why, and what data

Every number through Round 3 came from ONE speaker reading continuous
sentences, and all of Round 3's constants were tuned on her. The corpus
originally hoped for, CSJ, turned out to be an empty directory on this
machine (`/data/CSJ_5th` and `/mnt/storage/data/CSJ_5th`). But `/data`
holds **UME-JRF** (NII-SRC, *Japanese Speech Database Read by Foreign
Students*): Set D is 115 words read ONE AT A TIME -- onchou's actual use
case -- by **33 native Tokyo-dialect speakers (JJ)** and **141 learners
(FJ)**, 16kHz, recorded at several universities.

It has no accent labels (its teacher ratings target segmental items, e.g.
gemination in 酸っぱい). The target is therefore the dictionary accent
(vendored Kanjium) -- a sound reference for native Tokyo speakers, and
exactly what onchou scores learners against. For learners the result is
agreement with the target, not detection accuracy. Word list:
`tools/umejrf-dset-words.json` (from `doc/FJrecord/D1.pdf`); 104 of 115
words have a Kanjium accent (11 loanwords/onomatopoeia/a surname
excluded rather than guessed; words with several accepted accents count
as correct on any of them). Audio resampled to 48kHz first, since
`_estimatePitch`'s fixed 1024-sample frame makes sample rate matter.
Built by `tools/build-umejrf-set.js`, evaluated by `tools/evaluate-umejrf.js`
(speaker-level bootstrap 95% CIs).

### Transfer: Round 3 generalizes

Nothing was tuned on UME-JRF. Natives, 3,431 words: old algorithm κ 0.029
[0.018, 0.048]; Round 3 κ **0.300 [0.271, 0.330]** -- the same level as
JSUT's app-like set (0.285) with 33 new speakers, isolated words and a
different microphone. Learners: 0.112, far below natives, as a valid
measure should be.

### New failure found: heavy-initial heiban words

Round 3 left **33% of native morae 'unclear'**. 964 of the 965 all-unclear
native words were the contrast guard (fitted step < 100 cents), and the
words were almost all heiban with a heavy first syllable -- 禁煙 31/33
speakers, 病院 30/33, 歓迎 30/33, 肝臓 28/33, 船員 28/33, 品名 27/33. This
is a known Tokyo-Japanese fact: the phrase-initial low on mora 1 is weak or
absent when the first syllable is heavy (a long vowel, diphthong, ん or っ
as mora 2), so natives say きんえん close to H,H,H,H -- correctly. The guard
read correct native speech as "no contrast".

### Fix

The accent is the FALL; heiban means no fall. `decodeAccentPattern` now
guards the two claims separately: a fall still needs 100 cents
(`MIN_SPLIT_CENTS`); the no-fall shape needs an initial rise of 100 cents
(`MIN_RISE_CENTS`) EXCEPT when the first syllable is heavy
(`MIN_RISE_HEAVY_CENTS = 0`, detected from the word's kana by
`heavyInitial`); and a fall claim too weak to trust falls back to "no fall"
when that shape qualifies (`FALLBACK_TO_NO_FALL`). `segmentByMora` takes
the morae via an optional `opts.morae`; `js/app.js` passes
`PitchDiagram.moraSplit(reading)` (plus が in particle mode). Callers that
pass nothing keep the stricter light-syllable rule.

Chosen on JSUT's training split + native speakers half A (alternate
speakers, sorted); reported on the rest:

| light rise | heavy rise | fallback | JSUT app-like test κ | natives B κ | natives B unclear | learners κ | flat take scored correct: light-heiban / heavy-heiban / accented |
|---|---|---|---|---|---|---|---|
| 100 | 100 | off (Round 3) | 0.285 | 0.270 | 33.2% | 0.112 | 0.3% / 0.3% / 1.0% |
| **100** | **0** | **on (shipped)** | **0.300** | **0.317** | **13.4%** | 0.112 | **0.3% / 98.6% / 1.0%** |
| 50 | 0 | on | 0.310 | 0.352 | 10.0% | 0.127 | 7.2% / 98.6% / 1.0% |
| 0 | 0 | on | 0.359 | 0.423 | 3.8% | 0.169 | 98.6% / 98.6% / 1.0% |

The shipped row keeps the flat-attempt guard exactly as before for
light-initial heiban and every accented word, and relaxes it ONLY for
heavy-initial heiban words, where native speakers were measured not to
rise. Lower light-syllable thresholds score higher κ, but only by accepting
flat takes on light-initial heiban words (e.g. さかな said monotone) --
a pedagogical policy choice, not an accuracy fix, so not taken.

Final shipped numbers: UME-JRF natives, all 33 speakers, κ **0.353
[0.317, 0.385]**, strict 59.3%, per-mora 80.6%, unclear 12.8% (half those
speakers informed the choice; the clean held-out half is 0.317). Learners
0.112 [0.099, 0.131]. JSUT unchanged when no morae are passed (app-like
test 0.287; 0.300 with morae). Synthetic contract unchanged (synthetic
traces carry no morae); Stage 2 100% on every pass. Verified end to end in
headless Chrome.

## Round 5: silent morae -- geminates and high-vowel devoicing (SHIPPED, 2026-09-26)

### Why

Error analysis of the shipped decoder on the choosing speakers (UME natives
A, `tools/paper-exp-errors.js`): 65% of native takes correct; the rest
mostly heiban words read with a spurious fall (20% of heiban takes), and
takes left partly/all 'unclear' by morae with no F0 at all -- the closure of
a geminate っ (はっぽう, せっき, いっつう: an empty slot) and devoiced high
vowels at a word edge (きやく, ふぞく, ひかく: outside the voiced span, so
every equal slot is cut one mora out of place).

### Which vowels are really devoiced? (`tools/paper-devoicing.py`)

The devoicing rule comes from github.com/bagustris/ASR_JA_Vowel_Devoicing:
i/u with a voiceless onset before a voiceless onset, or utterance-final.
That repo's Conformer is trained on the rule's labels, so its devoicing
F1 (97%) measures agreement with the rule. Here every i/u vowel in JSUT
basic5000 gets an acoustic label instead: its jsut-label phone segment, and
the share of frames pYIN calls voiced (devoiced below 0.5). WORLD harvest
was tried first and dropped. It over-extends voicing into devoiced vowels:
on a 120-utterance sample it called 47% of the rule's candidates voiced,
where pYIN and DIO, agreeing with each other, called 17-18%. With pYIN the
split is clean: 82% of rule-environment vowels have under 10% voiced
frames, and 16% are over 90% voiced.

Test split of that repo (500 utterances, 5,452 i/u vowels, 14.8% devoiced):

| predictor | P | R | F1 | F1 with DIO as reference |
|---|---|---|---|---|
| rule (the report's labels) | 81.8 | 86.0 | 83.8 | 82.3 |
| the report's ASR model | 81.6 | 86.6 | 84.0 | 82.8 |
| OpenJTalk devoicing | 87.9 | 77.5 | 82.4 | 80.0 |
| rule + consecutive-devoicing blocking | 83.8 | 80.9 | 82.4 | 80.0 |
| rule, not on an accent phrase's last mora | 85.1 | 80.6 | 82.8 | 80.1 |
| rule, not on the accent nucleus | 83.0 | 76.9 | 79.8 | 77.5 |
| **learned** (boosted trees, text-only context + accent, trained on acoustic labels of the train split) | 91.1 | 88.4 | **89.7** | **87.4** |

Paired utterance bootstrap: learned − rule +5.9 F1 [+4.4, +7.3]. Learned −
ASR +5.7 [+4.3, +7.3]. ASR − rule +0.1 [−0.4, +0.6]. The ASR model is
statistically identical to the rule it was trained on. Training on acoustic
labels, not rule labels, is what gains. The learned model picks up
utterance-final whispering after voiced onsets (…い。, …る。), which the
rule excludes by construction, and lower devoicing at phrase ends (52% in
the rule's environment) and on the accent nucleus (73% vs 83%).

Isolated words (`tools/paper-devoicing-ume.py`). The UME-JRF natives are
measured through the coarse CTC mora alignment, so a floor applies:
voiced-onset morae read as devoiced 17% of the time. Word-initial
candidates are devoiced 84% of the time. Word-final ones depend on the word:
あし 97%, いき 82%, but final く in ひかく, ふそく and きやく only 24%.

### What shipped (`js/mora-segment.js`, `SILENT_MORAE`)

`silentMorae(morae)` flags っ always, plus i/u devoicing by the rule on kana.
Devoicing is assumed only when at least three morae keep a voice (all of
them, in shorter words). Silent edge morae are left out of the voiced span's
division; silent medial morae keep their share of time but no value. Every
silent mora is shown at the level the decoded pattern gives it, not as
'unclear'. The app already passes the morae, with が appended in particle
mode, which correctly makes a word-final mora non-final.

These settings were chosen on natives A plus JSUT app-like train
(`tools/tmp/paper-silent-sweep.txt`). Two alternatives scored lower than the
plain rule:
- confirming edge devoicing per take from voiceless energy beyond the
  voiced span;
- dropping the word-final case.

Consecutive-devoicing blocking scored lower on both natives A and the JSUT
acoustics, so the rule doesn't block.

MIN_VOICED_MORAE = 3, rather than 2 (natives A κ 0.475 vs 0.458), was chosen
to hold the monotone false-acceptance rate on natives-B resynthesis
(`tools/paper-exp-flat.js`). With 2, 3-mora atamadaka words like てんき were
decoded from two values, and flat false acceptance rose from 6.8% to 8.9%.
With 3 it's 7.1% (drifting: 14.2% → 14.6%). This is a guard-driven choice
that looked at natives-B audio, and it's disclosed as such. The synthetic
regression is unchanged, since synthetic words carry no kana.

### Held-out results (`tools/paper-exp-silent.js`, paired cluster bootstrap)

| split | before | + geminates | + geminates + devoicing | Δκ total [95% CI] |
|---|---|---|---|---|
| UME natives B | 0.351 | 0.373 | **0.388** | +0.036 [0.023, 0.050] |
| JSUT app-like test | 0.236 | 0.262 | **0.278** | +0.042 [0.033, 0.055] |
| UME learners (agreement) | 0.113 | 0.118 | 0.126 | +0.012 [0.009, 0.016] |

On natives B, strict accuracy rises from 60.0% to 64.1% and 'unclear' falls
from 12.8% to 11.2%. The native-vs-learner speaker AUC is unchanged at 0.914.
Accepted correct words on the vocoded copies rise: accented 61.1% → 63.2%,
no-fall 52.4% → 56.8%.

### Not done / next

- The learned devoicing predictor isn't in the app. It was trained on
  research-only JSUT, and the app ships no learned models. A text-only
  table built from licence-clean recordings could replace the rule.
- A heiban word whose first mora is silent can't show its initial rise, so
  its remaining morae are level and it stays 'unclear'.
- The biggest remaining native error is the spurious final fall on heiban
  words, especially heavy-initial ones.

## Round 6: error detection on resynthesized wrong-accent takes (no raters; 2026-09-27)

### Method (`tools/paper-swap.py`, `tools/paper-exp-swap.js`)

Each native take of a single-accent word (UME natives A and B, 3,298 takes)
is resynthesized with WORLD. The voice, timing and F0 micro-prosody stay the
native speaker's own, but the accent is moved to every other valid shape.
Morae whose level differs are shifted by the speaker's typical accent fall
(the median H−L gap over that speaker's accented takes, 217–523 cents), with
40 ms ramps at CTC mora boundaries. That gives 6,992 wrong takes with a
known produced pattern. Each take also goes through the same code with zero
shift ('selfswap'), a correct control with the identical vocoder round trip.

A first pass used each take's own gap instead. That was wrong: a heiban
take's own gap is only its initial rise (median −4 cents), so fall-added
errors were synthesized at the 100-cent floor and too often accepted.

Decision per take: accept (decoded pattern equals the target), abstain
(all 'unclear'), or flag. **Detection** is the share of wrong takes not
accepted. **False alarm** is the share of correct takes not accepted.
**Youden's J** is detection minus false alarm, so rejecting everything
scores 0. **Diagnosis** is the share of wrong takes decoded as exactly the
produced pattern.

### Results, natives B (reporting; speaker-bootstrap 95% CIs)

| system | J | detection | false alarm | exact diagnosis |
|---|---|---|---|---|
| proposed (shipped) | **39.0** [31.4, 45.3] | 81.0 [78.7, 83.3] | 42.0 [36.6, 48.0] | **44.0** [40.8, 47.1] |
| proposed without silent morae | 37.8 [30.7, 43.9] | 83.5 | 45.8 | 43.2 |
| F0-ratio Gaussians (JSUT-trained), forced choice | 24.0 [19.1, 29.3] | 52.2 | 28.2 | 23.9 |

On natives A (choosing), the shipped decoder scores J 52.0, detection 83.8
and false alarm 31.8.

Detection by error type (shipped, natives B):

| error | detection |
|---|---|
| fall one mora early | 92.7% |
| fall added | 83.2% |
| fall moved two or more morae | 80.2% |
| fall one mora late | 74.4% |
| fall removed | 74.3% |

The Gaussians miss 60% of late falls. Having learned connected speech's peak
lag, they read a late fall as correct.

### Reading

- **Detection isn't the bottleneck.** Four of five wrong accents are caught,
  and the error the learner made is named exactly 44% of the time.
- **False alarms on correct native takes are the bottleneck:** 42% here,
  about 36% on the original audio. The remaining work is accepting correct
  speech more reliably, above all the spurious final fall on heiban words
  (Round 5, "Not done").
- **The learned table's apparent κ advantage** on natives (Round 4) comes
  from accepting more of everything: its J is lower (24.0 vs 39.0).
- The shipped-vs-previous gap on J (+1.2) is within the CIs.
- **Hardest errors:** a fall one mora late, and a fall removed. Both are
  closest to natural variation (peak delay; weak falls).

### Caveats

- The errors are synthetic. Real learners' errors may differ in size and
  timing: the shifts follow CTC boundaries (about 40 ms late) and use a
  native-sized fall.
- WORLD harvest re-voices some devoiced vowels, which blunts the silent-mora
  handling on this set.
- The rater study is still what validates transfer to real learner errors.

## Round 7: learned models on isolated words, more voices, fall-first feedback (2026-09-27)

### #5 A learned classifier trained on native isolated words (`tools/paper-exp-augment.js`) -- NOT shipped

The model is multinomial logistic regression per mora count, 190 numbers in
all, on production slot values (silent morae included), trained on natives
A only.

| system | natives B κ | learners κ | JSUT app test κ | swap J (B) | flat FA | drift FA | synthetic on-time |
|---|---|---|---|---|---|---|---|
| shipped model-free | 0.388 | 0.126 | 0.278 | **39.0** | **7.1%** | **14.6%** | **100%** |
| LR, natives only | **0.569** | **0.216** | 0.152 | 35.0 | 10.9% | 20.1% | 56% |
| LR + accent-swap and flat augmentation | 0.143 | 0.054 | 0.040 | 11.8 | 10.1% | 11.3% | 6% |
| guarded hybrid (shipped guard, LR picks the pattern) | 0.411 | 0.153 | 0.170 | 29.8 | 10.2% | 16.8% | 56% |

- **The natives-only model is the familiar trap.** Trained on native words,
  it matches natives much better (κ +0.18). But it accepts more
  accent-removed takes, catches fewer misplaced accents (J 35.0 vs 39.0),
  and misreads 44% of clean on-time synthetic words. The same happened with
  the JSUT-trained Gaussians (Round 6).
- **Augmenting with WORLD accent swaps and flat takes fails.** The model
  learns the resynthesis rather than the accent: it scores 6% on clean
  synthetic words, and on words not seen in training it scores κ 0.01.
- **The flat-rejection threshold (TAU = 0.7) was chosen on natives A.**
  Speaker-grouped cross-validation, best κ with flat and drift false
  acceptance no higher than the shipped decoder's.
- **Verdict: keep the model-free decoder.** A higher κ against native
  takes isn't evidence of a better tutor; the swap and flat checks are what
  expose the difference.

### #6 More voices from LaboroTVSpeech with OpenJTalk labels (`tools/build-ltv-set.py`, `tools/ojt-label-noise.py`) -- negative

- **Label quality.** Against jsut-label's manual accents, OpenJTalk's
  phrase shape agrees for 93% of 2-mora, 85% of 3–4-mora and about 60% of
  6–7-mora phrases.
- **The set.** 9,423 short single-phrase TV utterances (2–5 morae,
  containing a kanji; no interjections). A first pass without the kanji
  filter was dominated by laughter and onomatopoeia.
- **Every system is at chance on it:**

  | system | κ |
  |---|---|
  | shipped | 0.028 |
  | shipped without silent morae | 0.033 |
  | JSUT Gaussians | −0.008 |

- **The pitch doesn't follow the labels.** The median adjacent-slot step is
  about 0 cents whatever the label. UME natives, by contrast, show −448
  cents for HL and +213 for LH.
- **The voiced span isn't just the phrase.** It averages 245 ms per mora
  against UME's 130, so the TV segments carry music or other speech around
  the phrase.
- **Not usable without speech separation and alignment.** LaboroTV also
  has no speaker ids. JVS (100 clean studio speakers) is the right corpus;
  see the next section.

### #6 redone with JVS: 98 speakers, manual labels (`tools/build-jvs-set.js`)

JVS's nonpara30 recordings include 3,071 readings of JSUT basic5000
sentences by its 100 professional speakers. jsut-label's manual accents are
combined with JVS's automatic phone alignments, which exist for 1,804
recordings. 429 of those were skipped because the automatic reading differs,
for example なに vs なん. That leaves 2,750 app-like phrases (first and last
phrase with real silence) from 98 speakers, all held out. The labels are
the JSUT speaker's accents, so another speaker may occasionally use a
different accepted accent.

The labels match the audio: median adjacent-slot steps are −457 cents on
HLL's second step and +207 on LHH's first. Compare LaboroTV's ≈0.

| system | JVS κ [speaker-bootstrap CI] | strict | unclear |
|---|---|---|---|
| original 2-cluster | 0.009 [−0.003, 0.020] | 9.5% | 0.5% |
| shipped without silent morae | 0.128 [0.111, 0.147] | 28.3% | 8.4% |
| **shipped** | **0.178** [0.157, 0.200] | 34.5% | 6.6% |
| JSUT-trained Gaussians (connected speech, lag learned) | 0.316 [0.293, 0.336] | 47.7% | 0.4% |

**Silent morae generalize across speakers** (+0.05).

**The peak delay depends on speaking style, across 98 speakers** (a
descriptive sweep; nothing was re-tuned):

| delay | 0 | 20 (shipped) | 40 | 60 | 80 | 100 |
|---|---|---|---|---|---|---|
| JVS (connected, 98 speakers) | 0.146 | 0.178 | 0.234 | 0.267 | 0.269 | 0.270 |
| JSUT app-like test (connected, 1 speaker) | 0.226 | 0.278 | 0.342 | 0.365 | 0.378 | 0.377 |
| UME natives B (isolated words, 16 speakers) | 0.359 | **0.388** | 0.366 | 0.320 | 0.280 | 0.268 |

Connected read speech wants 60–100 ms and isolated words 20 ms, now shown
on 98 speakers rather than one. The app's input is isolated words, so 20 ms
stays.

**Best method on JVS (research; learned models allowed).** The metric is
within-mora-count Cohen's κ with a speaker-bootstrap 95% CI.

JVS reads basic5000 sentences 1–3096, all inside JSUT train. Rows trained on
JSUT are therefore also given with every JVS sentence removed from training
("text-disjoint"). The WavLM rows come from `tools/paper-export-jvs.js` and
`tools/paper-ssl-jvs.py`: WavLM-large layer 8, mean-pooled over the
production slots, decoding constrained to the valid patterns.

| system | trained on | JVS, all 98 speakers (n≈2,750) | JVS-B, 49 speakers (n≈1,380) |
|---|---|---|---|
| model-free, shipped (20 ms) | – | 0.178 [0.157, 0.200] | 0.165 [0.133, 0.199] |
| model-free, 100 ms delay | – | 0.270 [0.248, 0.296] | 0.258 [0.221, 0.292] |
| F0-ratio Gaussians | JSUT, text-disjoint | 0.315 [0.291, 0.338] | 0.299 [0.261, 0.335] |
| F0-ratio Gaussians | JVS-A | (includes training speakers) | 0.249 [0.219, 0.278] |
| **WavLM-large L8 probe** | **JSUT, text-disjoint** | **0.495 [0.469, 0.520]** | **0.482 [0.437, 0.523]** |
| WavLM-large L8 probe | JSUT, all (saw the text) | 0.498 [0.474, 0.525] | – |
| WavLM-large L8 probe | JVS-A | – | 0.476 [0.431, 0.519] |
| WavLM-large L8 probe | JSUT text-disjoint + JVS-A | – | 0.480 [0.435, 0.522] |

- **Best on JVS: the WavLM probe**, with κ ≈ 0.49 on 98 unseen speakers.
- **Text overlap doesn't inflate it** (0.498 vs 0.495). Many different
  sentences give little room for the lexical shortcut, unlike 104 repeated
  words on UME-JRF.
- **Training on 49 JVS speakers adds nothing** over one JSUT speaker (0.476
  vs 0.482).
- **WavLM was not run on the swap/flat tutor checks for JVS.** On UME-JRF,
  the learned models trail the model-free decoder there (Rounds 6–7).

### #7 Fall-first feedback (`MoraSegment.fallFeedback`, `js/app.js`) -- SHIPPED

The result's headline is now one sentence about the fall, for example:

- "Your pitch fell after mora 3 「う」 -- it should fall right after mora 2
  「よ」 (1 mora earlier)."
- "Your pitch didn't fall -- …"
- "Your pitch fell after … -- this word stays high to the end, with no
  fall. Keep it level."
- "Right: your pitch fell after mora 2 「し」."

A take whose fall is right but whose first mora isn't low counts as right,
with a soft note. Tokyo speakers' initial rise is weak, and absent after a
heavy syllable. When unclear morae hide the drop's position, the headline
says so and points to ⇄ Compare. The per-mora chips and "N of M matched"
stay underneath as detail.

Rationale (Round 6): the decoder names a misplaced fall's exact position
far more reliably than it gets every mora's level right. A learner acts on
"one mora earlier", not on "2 of 4 matched".

## Conclusions and recommendations

(Rounds 1–2 conclusions, updated by Round 3.)

1. **The F0 estimator's pitch values are accurate** (~24 cents RMSE, ~1%
   GPE vs `librosa.pyin`) **but its voicing decision is not**: it reports
   pitch on silence. Fixed downstream by the relative voice gate rather
   than by changing `_estimatePitch` itself.
2. **Per-mora accuracy is the wrong headline metric on this corpus** — use
   within-mora-count κ (or balanced accuracy); a no-audio guess beats the
   old shipped classifier on per-mora accuracy.
3. **`MIN_SPLIT_CENTS` stays at 100**, now applied to the fitted accent
   step; it remains the flat-attempt guard.
4. **Rejected, with evidence**: linear detrending before clustering,
   energy-based boundary snapping (both forms), and the `nucleus` decoder
   (below the template decoders on κ). Declination has to be fit jointly
   with the accent step, not removed first.
5. **Shipped**: voice gate + 40ms peak delay + constrained templates with
   joint declination (Round 3) — κ −0.04 → 0.29 on app-like held-out
   audio, with the synthetic contract preserved.
6. **Next steps**: (a) Round 4 found multi-speaker isolated-word data
   (UME-JRF) and confirmed transfer -- still open is a delay sweep on it
   (isolated words may want less than 40ms) and accent-labeled LEARNER
   speech, which UME-JRF doesn't have; (b) a small shape-learned model
   (Ishi-style Gaussians reach κ 0.35) if a tiny, data-table-sized model
   ever becomes acceptable under the app's no-model rule; (c) forced
   alignment remains worth ~+4 points of per-mora accuracy on its own but
   needs an acoustic model.

## Non-goals

- **Not a re-tuning of `js/pitch-detect.js`'s F0-estimator constants**
  (`VOICING_THRESHOLD`, `MIN_HZ`/`MAX_HZ`). Round 3's voicing problem was
  fixed downstream with a relative energy gate instead, which doesn't
  depend on mic gain the way an absolute estimator threshold would.
- **Not a claim about learner accuracy.** See "What this evaluation is, and
  isn't" above.
- **Not a plan to abandon time-proportional segmentation.** Round 3 kept
  it (adding a fixed peak delay) rather than reintroducing forced alignment
  / an ASR dependency, which the original design avoids to stay
  model/server-free.

## Reproducing

```bash
git clone https://github.com/sarulab-speech/jsut-label /path/to/jsut-label
export JSUT_LABEL_DIR=/path/to/jsut-label
node tools/evaluate-jsut-accuracy.js --sweep --pad-ms 30   # phrase set + trace cache (~6 min)
node tools/build-applike-set.js                            # applike set (~2 min)
node tools/evaluate-decoders.js                            # Round 3 decoder comparison
node tools/evaluate-pipeline.js                            # Round 3 end-to-end, held-out
node tools/synthetic-regression.js                         # synthetic contract check
# Round 4 (UME-JRF Set D, isolated words): unzip Set D, resample to 48kHz
# (command in tools/build-umejrf-set.js's header), then:
UMEJRF_DIR=/path/to/extracted node tools/build-umejrf-set.js  # ~4.5 min
node tools/evaluate-umejrf.js                              # natives + learners, bootstrap CIs
```

JSUT audio itself (`/data/jsut_ver1.1`) is a pre-existing local dataset on
this machine, not vendored into this repo (unlike `accents_kanjium.txt`,
which the app depends on at build time) — get it from
https://sites.google.com/site/shinnosuketakamichi/publication/jsut if
reproducing elsewhere.
