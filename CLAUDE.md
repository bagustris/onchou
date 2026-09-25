# CLAUDE.md

This file provides guidance to Claude Code when working with code in this
repository.

## What this is

onchou (音調) is a Japanese pitch-accent trainer: plain HTML/CSS/JS, no
framework, no build step, no `package.json`. It's a PWA (installable,
offline-capable via `sw.js`) deployed as a static site to GitHub Pages,
matching the shape of its sibling apps
([kanji-drill](https://github.com/bagustris/kanji-drill),
[kotoba](https://github.com/bagustris/kotoba),
[jlpt](https://github.com/bagustris/jlpt),
[jed](https://github.com/bagustris/jed),
[wanikanji](https://github.com/bagustris/wanikanji)).

Unlike those siblings, which quiz kanji/vocab/reading recognition, onchou is
the only one that scores a *spoken* attempt: it plays a TTS reference, records
the learner's mic input, extracts an F0 contour client-side (no ML model,
no server), and compares the resulting per-mora high/low pattern against
the word's known target pattern.

The authoritative design contract is
`docs/superpowers/specs/2026-09-04-onchou-pitch-accent-trainer-design.md` —
read it before making structural changes; this file is a short pointer, not
a substitute.

## Running locally

Data is loaded via `fetch()`, so opening `index.html` directly (`file://`)
will fail to load quiz data — always serve it:

```bash
python3 -m http.server 8000
```

Microphone recording needs `getUserMedia`, which browsers generally refuse
outside `localhost`/HTTPS — serving over plain HTTP on another host won't
let you test recording.

There is no build, lint, or type-check command. Tests are plain-JS asserts
under `js/__tests__/`, matching jed's style (no framework):

```bash
for f in js/__tests__/*-test.js; do node "$f"; done
```

**Service worker caching**: `sw.js`'s `CORE_ASSETS` list is the app shell.
If you add or rename a file under `js/` or `data/`, update that list too,
and bump `CACHE_VERSION` whenever any cached file changes, or offline
installs keep the stale copy.

## Architecture

`index.html` loads the `js/` modules as plain `<script>` tags, in
dependency order, each an IIFE-scoped global:

1. `js/pitch-diagram.js` (`PitchDiagram`) — pure rendering of the
   dot-and-line pitch-accent SVG diagram, for either the target pattern
   (from a Kanjium `accentNum`) or an arbitrary detected `H`/`L`/`unclear`
   array, in a variant-specific color so target/learner diagrams are
   visually distinct when stacked. Ported from jlpt's `pitchAccentSVG`;
   mora-splitting rule ported from kotoba's `moraSplit`.
2. `js/pitch-detect.js` (`PitchDetect`) — mic capture + per-frame F0
   estimation (`getUserMedia` → `AudioContext` → `AnalyserNode`, polled via
   `setInterval` rather than `requestAnimationFrame` so recording doesn't
   silently truncate in a backgrounded tab). Also exposes
   `PitchDetect.isSupported()`, used by `app.js` to show
   `#unsupported-notice` instead of the quiz UI on browsers without
   `getUserMedia`/Web Audio. A `MediaRecorder` tap on the *same* stream the
   analyser reads hands the caller a playable `Blob` of the take via
   `opts.onAudio` (so playback is exactly the audio that was scored), always
   *after* the trace — MediaRecorder flushes its last chunk asynchronously —
   and `null` on browsers where it isn't available (`playbackSupported()`),
   which must never gate recording itself. Each trace frame is
   `{tMs, hz, rms}` — `rms` feeds mora-segment.js's voice gate.
3. `js/mora-segment.js` (`MoraSegment`) — pure, DOM-free functions turning
   a raw pitch trace into a per-mora H/L/unclear pattern and scoring it
   against a target pattern; unit-tested against synthetic traces.
   `segmentByMora` gates frames more than `VOICE_GATE_DB` (15) below the
   take's loudest frame (the estimator reports pitch on silence), reads each
   equal-width slot `PEAK_DELAY_MS` (20) late (accent F0 events are realized
   late), and decodes with `decodeAccentPattern` — valid Tokyo patterns
   only, fit jointly with a bounded declination slope, all-'unclear' below
   `MIN_SPLIT_CENTS` (100). This replaced the 2-cluster `classifyLevels`
   (kept exported only for `tools/pitch-accuracy-experiment.js`) after it
   measured at chance on real speech — see the 2026-09-25 addendum in the
   design spec. The no-fall shape's initial-rise requirement is waived for
   a heavy SONORANT first syllable (`heavyInitial`: ん, ー, long vowel or
   diphthong -- not っ, per the phonology), from `opts.morae`, which
   `app.js` passes, because natives don't rise there. The declination slope
   bound is 75 cents/mora, but 50 for 2-mora words, where slope and rise
   are confounded. `js/accent-model.js` (a small learned pattern-choice
   table, built by `tools/build-accent-model.js`) is OPT-IN only
   (`opts.useModel: true`) and is not loaded by `index.html`: it was
   learned from connected read speech and misreads on-time accent steps by
   one mora, and it's derived from research-only JSUT audio. Every constant there
   was tuned on held-out real audio AND re-checked against
   `tools/synthetic-regression.js`; change them only with both.
4. `js/pitch-contour.js` (`PitchContour`) — pure builders turning the raw
   per-frame F0 trace into a continuous learner curve (normalized to the
   recording's own median, in octaves, clamped; unvoiced frames break the
   line rather than dipping to zero) overlaid with a stylized step-line for
   the target H/L pattern. Supplementary to the dot diagram above, hidden
   behind a setting (`showContour`, off by default). Its `renderSVG` is a
   thin templating wrapper left to manual verification, matching
   `pitch-diagram.js`'s own tested-builders/untested-renderer split. The
   target step-line sits on `segmentByMora`'s returned `slots` (the delayed
   windows actually scored), not a re-derived equal division.
5. `js/reference-audio.js` (`ReferenceAudio`) — the "▶ Play" button's
   backing module, via `window.speechSynthesis` only (no server-side TTS
   fallback); pure voice filtering/ranking helpers are Node-testable, live
   `speechSynthesis` calls are browser-only. `cancel()` is called by
   `app.js` on every word change and at the start of every recording — an
   utterance still playing is picked up by the mic and scored as the
   learner's own voice — so `speak()` resolves (rather than rejects) on the
   `canceled`/`interrupted` error the browser reports for a deliberate stop.
   Any other `SpeechSynthesisErrorEvent` code is run through
   `speechErrorMessage()` before it reaches `speak()`'s rejection — a raw
   spec code like `not-allowed` or `audio-busy` is not learner-facing text,
   and without this mapping it would surface verbatim under the Play
   button.
6. `js/settings.js` (`SettingsManager`) — `localStorage`-backed user
   preferences (`autoPlayReference`, `showContour`, `level`, `particleMode`)
   under the `onchou-settings` key, surfaced by the hamburger settings panel
   ported from the sibling apps. A thin wrapper with no branching logic, so
   (like jlpt's own `settings.js`) it has no test file.
   `particleMode` (off by default) has the learner say the target word plus
   the が particle instead of the bare word, and scores that trailing mora
   for real — the only way heiban and odaka (identical across a word's own
   morae, differing only in what happens on a following particle) become
   distinguishable, and incidentally the only way a 1-mora word becomes
   scoreable at all (a single mora otherwise has nothing else to be
   relatively higher/lower than). `js/app.js`'s `particleModeForWord` is
   snapshotted per word (not read live) so the "＋ が" prompt shown and what
   gets scored can't disagree if the setting is toggled mid-card. See
   `docs/superpowers/specs/2026-09-25-onchou-particle-mode-design.md`.
7. `js/word-select.js` (`WordSelect`) — pure, DOM-free next-word selection:
   caps word length by the learner's chosen level (cumulative, so level "3"
   includes 2-mora words) and balances the draw across whichever accent
   patterns that level makes available, since heiban otherwise dominates
   the pool. Takes an injectable `rng` so the balancing is deterministically
   testable, and an optional `exclude` (the word already on screen, compared
   by identity) so "Next word" can't immediately repeat it — except when
   `exclude` is the only word left after filtering, since a level whose
   bucket for some pattern holds exactly one word must still return it
   rather than fail the draw. Depends on `PitchDiagram` for mora-splitting —
   note it must be referenced by bare identifier, not `window.PitchDiagram`, because
   `pitch-diagram.js` declares it with `const` (script-scoped binding, not a
   `window` property). See
   `docs/superpowers/specs/2026-09-06-onchou-learning-progression-design.md`.
8. `js/app.js` — orchestrator with no exported global; owns DOM/state,
   wires `data/words.json` + the modules above into the word-card UI
   (play reference → record → detect pitch → segment into moras → diagram
   + score the learner's attempt against the target), owns the settings
   dialog and PWA install prompt, and drives
   `#unsupported-notice` / `#quiz` visibility via `PitchDetect.isSupported()`.
   Also owns attempt playback (`#playback-row`): "⇄ Compare" plays the
   reference then the learner's own take back to back (the comparison, not
   either clip alone, is what tells the learner where their drop landed),
   with "▶ Your voice" for the recording alone. Deliberately not behind a
   setting — self-monitoring is core to the exercise, and hearing the take
   is the only way to tell a real mispronunciation apart from an F0-tracking
   artifact or a too-quiet mora. An `attemptSeq` counter guards the async
   `Blob` arrival: object URLs are revoked and the sequence bumped on every
   word change/Retry/Record, so a late `Blob` can't be offered as playback
   of an attempt already cleared. The same `attemptSeq` snapshot also guards
   Compare/"▶ Your voice" themselves: each click captures the live `seq`,
   and every step of that async chain (the reference leg, the gap, the
   attempt playback, its error note, the final re-enable) checks it's still
   current before touching shared UI, so a Record/Retry that lands mid-chain
   can't have a stale rejection re-show a "Could not play" note against an
   attempt that's already been discarded. Also: a mouse click on any quiz
   button blurs it afterward (`e.detail > 0` distinguishes a pointer click
   from a keyboard activation, which reports `0`) — without that, the
   Space-to-record shortcut's own focus guard sees that button still
   focused and re-activates IT instead of toggling Record.

`tutorial/index.html` is a static prose page (linked from the settings
About block, served at `/onchou/tutorial`) explaining moras, the accent
number, the four patterns and minimal pairs. Its example diagrams are
generated at load time through `PitchDiagram` itself rather than hand-drawn
SVG, so they can't drift from what the quiz renders. Note `sw.js`'s fetch
handler special-cases navigations: returning a *redirected* response (e.g.
`/tutorial` → `/tutorial/`) from `respondWith()` fails a navigate-mode
request outright (`ERR_FAILED`), so those are re-issued as a synthesized
`Response.redirect`.

`index.html` also registers `sw.js` inline (feature-detected,
`http`/`https` only) after the module scripts, matching the sibling-app
pattern.

`sw.js` precaches `CORE_ASSETS` (the app shell plus `data/words.json`,
since onchou's whole dataset is one small flat file) on install, and
serves same-origin GETs stale-while-revalidate; bump `CACHE_VERSION`
whenever a cached file's contents change.

### Data pipeline

`tools/build-words.js` builds `data/words.json` — the intersection of the
vendored Kanjium pitch-accent database
(`vendor/kanji-data/compounds/accents_kanjium.txt`) with vocab already used
by the sibling `kotoba` checkout (read from `../kotoba/`, not fetched at
runtime). jed was originally unioned in too but was dropped (jed's vocab
data turned out to be an unfiltered JMdict dump, not curated, making the
intersection almost a no-op) — see the design spec's "2026-09-05 addendum"
under its "Data" section for why, and for the exported-but-unused
`jedPairsFromEntries` helper's future-reuse rationale. Runtime code only
ever reads the built `data/words.json`.

### Data

`vendor/kanji-data/compounds/accents_kanjium.txt` is vendored Kanjium
pitch-accent data (see `vendor/kanji-data/NOTE.md` for why it's currently a
manual copy rather than a real git submodule, and the README for
attribution). Runtime code reads only `data/words.json`, built from it by a
`tools/` script — see the design spec's "Data" section.

### Real-audio pitch-accuracy evaluation (research tooling, not runtime code)

`tools/evaluate-jsut-accuracy.js` (+ `tools/wav-reader.js`,
`tools/jsut-lab-parser.js`, `tools/jsut-signal-level-check.py`) run the
shipped `js/pitch-detect.js`/`js/mora-segment.js` pipeline, unmodified,
against the real JSUT speech corpus and jsut-label's manually-annotated
accent labels. `tools/build-applike-set.js` builds the "app-like" set
(phrases with their real surrounding silence); `tools/accent-decoders.js` +
`tools/evaluate-decoders.js` + `tools/evaluate-pipeline.js` compare decoder
variants on held-out sentences (4001–5000; tuning only ever sees 1–4000);
`tools/synthetic-regression.js` is the synthetic guard any change to
`segmentByMora` must also pass. `tools/build-umejrf-set.js` +
`tools/evaluate-umejrf.js` test isolated words from 33 native speakers and
141 learners (UME-JRF Set D, dictionary targets, speaker-bootstrap CIs) --
the only multi-speaker, isolated-word check. `tools/paper-*.js` /
`tools/paper-*.py` hold the Interspeech experiments (see
`docs/paper/2026-09-25-interspeech-plan.md`), including the monotone
resynthesis test (`paper-flatten.py`), which any change to the decoder's
evidence guards should be re-checked against. `tools/rating/` is a
LOCAL-ONLY native-rater tool (UME-JRF audio is research-only: never host or
publish it). Headline metric is within-mora-count
Cohen's κ, NOT per-mora accuracy (a no-audio constant guess scores ~66%
per-mora on this corpus) — see
`docs/superpowers/specs/2026-09-25-onchou-jsut-real-audio-eval-design.md`
for the full design, results, and honest scope caveats (this is decision-
and signal-level validation on one native studio speaker's continuous
speech, not a learner-recording or perceptual-validation study — see
`docs/2026-09-05-pitch-accent-evaluation-research-plan.md`, which this
partially, not fully, closes). Output/caches under `tools/tmp/` are
reproducible, `.gitignore`d, and never committed.

### Shared CSS tokens

`style.css`'s `:root` custom properties (`--bg`, `--fg`, `--accent`,
`--accent-dark`, `--card-bg`, `--border`, `--correct`, `--incorrect`,
`--radius`, etc.) are copied verbatim from `jlpt/style.css` /
`kotoba/style.css` so visual conventions stay identical across the
collection. One addition specific to onchou: `--accent-learner`, a second
accent color (distinct from `--accent`) reserved for drawing the learner's
detected pitch pattern in a different color from the target pattern once
the two diagrams are rendered side by side.
