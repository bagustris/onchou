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
   `getUserMedia`/Web Audio.
3. `js/mora-segment.js` (`MoraSegment`) — pure, DOM-free functions turning
   a raw pitch trace into a per-mora H/L/unclear pattern and scoring it
   against a target pattern; unit-tested against synthetic traces.
4. `js/pitch-contour.js` (`PitchContour`) — pure builders turning the raw
   per-frame F0 trace into a continuous learner curve (normalized to the
   recording's own median, in octaves, clamped; unvoiced frames break the
   line rather than dipping to zero) overlaid with a stylized step-line for
   the target H/L pattern. Supplementary to the dot diagram above, hidden
   behind a setting (`showContour`, off by default). Its `renderSVG` is a
   thin templating wrapper left to manual verification, matching
   `pitch-diagram.js`'s own tested-builders/untested-renderer split.
5. `js/reference-audio.js` (`ReferenceAudio`) — the "▶ Play" button's
   backing module, via `window.speechSynthesis` only (no server-side TTS
   fallback); pure voice filtering/ranking helpers are Node-testable, live
   `speechSynthesis` calls are browser-only.
6. `js/settings.js` (`SettingsManager`) — `localStorage`-backed user
   preferences (`autoPlayReference`, `showContour`, `level`) under the
   `onchou-settings` key, surfaced by the hamburger settings panel ported
   from the sibling apps. A thin wrapper with no branching logic, so (like
   jlpt's own `settings.js`) it has no test file.
7. `js/word-select.js` (`WordSelect`) — pure, DOM-free next-word selection:
   caps word length by the learner's chosen level (cumulative, so level "3"
   includes 2-mora words) and balances the draw across whichever accent
   patterns that level makes available, since heiban otherwise dominates
   the pool. Takes an injectable `rng` so the balancing is deterministically
   testable. Depends on `PitchDiagram` for mora-splitting — note it must be
   referenced by bare identifier, not `window.PitchDiagram`, because
   `pitch-diagram.js` declares it with `const` (script-scoped binding, not a
   `window` property). See
   `docs/superpowers/specs/2026-09-06-onchou-learning-progression-design.md`.
8. `js/app.js` — orchestrator with no exported global; owns DOM/state,
   wires `data/words.json` + the modules above into the word-card UI
   (play reference → record → detect pitch → segment into moras → diagram
   + score the learner's attempt against the target), owns the settings
   dialog and PWA install prompt, and drives
   `#unsupported-notice` / `#quiz` visibility via `PitchDetect.isSupported()`.

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

### Shared CSS tokens

`style.css`'s `:root` custom properties (`--bg`, `--fg`, `--accent`,
`--accent-dark`, `--card-bg`, `--border`, `--correct`, `--incorrect`,
`--radius`, etc.) are copied verbatim from `jlpt/style.css` /
`kotoba/style.css` so visual conventions stay identical across the
collection. One addition specific to onchou: `--accent-learner`, a second
accent color (distinct from `--accent`) reserved for drawing the learner's
detected pitch pattern in a different color from the target pattern once
the two diagrams are rendered side by side.
