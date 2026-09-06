# onchou — Pitch-Accent Detection: Evaluation & Research Plan

Status: future work, not yet started. Target horizon: 2-3 years from
2026-09-05. This is a research/evaluation plan, distinct from
`docs/superpowers/specs/2026-09-04-onchou-pitch-accent-trainer-design.md`
(the shipped app's design contract) — that spec covers what the app *does*;
this file covers how to later *prove* the pitch-detection method is correct,
toward an academic paper.

## Motivation

The shipped method (`js/pitch-detect.js` + `js/mora-segment.js`) is currently
validated only against synthetic sine-wave input (known frequency in, known
Hz out) and hand-written H/L test fixtures — see the design spec's
"Testing" section. That's sufficient to ship a learning tool, but not
sufficient to claim the method is *correct* at detecting real learners'
pitch accent, which is what a paper would need to demonstrate.

## Two layers of validation needed

Correctness here isn't one number — it splits into a signal-level claim and
a decision-level claim, and a paper needs both argued separately so a
failure in one isn't hidden by the other.

### 1. Signal-level: is the F0 estimate itself correct?

- Benchmark the app's autocorrelation-based F0 estimator against an
  established reference extractor (Praat, YIN reference implementation,
  CREPE, or WORLD) on the *same* real speech recordings (not just synthetic
  tones, which the current unit tests already cover).
- Metric: Gross Pitch Error (GPE) and RMSE in cents, per frame, against the
  reference extractor's output.
- This isolates raw DSP accuracy from everything built on top of it
  (mora segmentation, H/L thresholding) — a paper's F0-accuracy claim
  should not be conflated with its accent-classification claim.

### 2. Decision-level: is the per-mora H/L/unclear classification correct?

- Needs a ground-truth corpus: recordings of words with an independently
  known correct pitch-accent pattern (Kanjium `accentNum`, cross-checked
  against a second source such as NHK's accent dictionary where possible).
- Metrics: per-mora accuracy, precision/recall/F1 for H vs L, full confusion
  matrix, all broken down **by accent type** (heiban / atamadaka / nakadaka
  / odaka) — nakadaka is the case most likely to expose the current
  time-proportional (non-forced-aligned) mora segmentation's weakness,
  since it has no fixed boundary to anchor to the way onset/final-mora
  drops do.
- Also break down by speaker group (native vs L2 learner) and by recording
  condition (quiet room vs phone mic vs background noise), since the app's
  real deployment context is a learner's own device, not a studio.

### 3. Perceptual validation (the layer a purely signal-processing eval would miss)

Pitch accent correctness is ultimately a *perceptual* judgment, not only a
signal-processing one. "Matches Kanjium's canonical pattern" and "sounds
correct to a native ear" are not guaranteed to coincide (natural variation,
dialectal accent, disfluency). Plan:

- Independent native-speaker raters judge a sample of recordings for
  perceived accent correctness, blind to the algorithm's output.
- Report inter-rater agreement (Cohen's κ, or Fleiss' κ for 3+ raters).
- Report correlation (e.g. Pearson or Spearman) between the algorithm's
  per-mora match score and the human raters' judgment, not just agreement
  with the canonical Kanjium pattern alone.

## Data collection: labeled native-speaker recordings

This is the current hard dependency and the reason for the 2-3 year
horizon — the above evaluation cannot start without it.

### Known gap this motivates: no real trailing-particle pitch data

The app's "Your attempt" pitch diagram (`js/app.js`'s `handleTrace`) shows a
trailing hollow dot after the learner's own morae, mirroring the *target*
diagram's trailing dot purely for visual/positional symmetry between the two
— it is not a measurement. The target's trailing dot represents the
analytically-known pitch of whatever follows the word (derived from the
Kanjium accent rule in `PitchDiagram.pitchLevels`), but the app's mic
recording captures only the word itself (bounded by
`PitchDetect.startRecording`'s max duration), so there is no equivalent real
detected value for the learner. Any future recording protocol for the
data-collection effort above should consider having speakers continue
slightly past the target word (e.g. into a following particle like は/が/を)
so a *real* detected trailing pitch becomes available to validate — or
replace — this mirrored placeholder.

Open questions to resolve before collection begins (not yet decided):

- **Scope**: how many speakers, how many words per speaker, and what
  coverage across heiban/atamadaka/nakadaka/odaka and mora-count buckets
  (short vs long words) is needed for statistically meaningful per-type
  breakdowns.
- **Sourcing**: fully self-collected vs. partially reusing an existing
  licensed corpus (if one with per-mora accent ground truth and usable
  license terms exists) vs. NHK accent dictionary audio (licensing must be
  checked before any use — do not assume it's usable).
- **Ethics/consent**: recording identifiable human voices requires informed
  consent and likely IRB/ethics review depending on venue/institution
  requirements — this must be resolved before any recording session, not
  after.
- **Annotation**: who assigns/verifies the ground-truth accent pattern per
  recording (a second source beyond Kanjium, to catch Kanjium errors or
  regional variants), and how disagreements get resolved.
- **Format/storage**: raw audio format, sample rate, anonymization approach,
  and where the corpus lives (this repo should probably not vendor raw
  speech recordings the way it vendors `accents_kanjium.txt` — a separate
  data-only repo or dataset host is more likely appropriate once this is
  scoped).

## Rough sequencing (not a committed timeline, revisit as this firms up)

1. Resolve data-collection scope + ethics/consent process.
2. Collect a pilot batch (small speaker count) and run the signal-level +
   decision-level eval end to end on it, before committing to full-scale
   collection — cheap way to catch methodology problems early.
3. Scale up collection based on pilot learnings.
4. Run full signal-level, decision-level, and perceptual evaluation.
5. Write up — target venue not yet decided; likely a speech/language-
   learning-technology venue given the CALL (computer-assisted language
   learning) angle rather than a pure speech-processing venue, but revisit
   once results are in hand.

## Non-goals for this plan

- This is not a plan to change the shipped app's algorithm preemptively —
  any algorithm change (e.g. replacing time-proportional mora segmentation
  with forced alignment) should be driven by what the evaluation in this
  plan actually finds, not done speculatively ahead of having eval data.
- Not a commitment to a specific venue, corpus size, or timeline — those
  are open items to resolve as the plan is executed, tracked above rather
  than guessed at now.
