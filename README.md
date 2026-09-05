# onchou (音調) — Japanese Pitch-Accent Trainer

A static, browser-only trainer for Japanese pitch accent: shows a word with
its target high/low pitch pattern (as a dot-and-line diagram, the same
convention [kotoba](https://github.com/bagustris/kotoba) and
[jlpt](https://github.com/bagustris/jlpt) already use to *display* pitch
accent), lets you hear a reference pronunciation via the browser's built-in
Japanese TTS voice, then records your own attempt via the microphone,
extracts its pitch contour client-side, and shows how your per-mora
high/low pattern compares to the target — no server, no ML model.

Plain HTML/CSS/JS, no framework, no build step — designed to run as-is on
GitHub Pages, matching the shape of its sibling apps
([kanji-drill](https://github.com/bagustris/kanji-drill),
[kotoba](https://github.com/bagustris/kotoba),
[jlpt](https://github.com/bagustris/jlpt),
[jed](https://github.com/bagustris/jed),
[wanikanji](https://github.com/bagustris/wanikanji)).

See the full design spec:
[docs/superpowers/specs/2026-09-04-onchou-pitch-accent-trainer-design.md](docs/superpowers/specs/2026-09-04-onchou-pitch-accent-trainer-design.md).

## Status

Repo skeleton only — data vendoring, PWA shell, and shared styling are in
place; the quiz UI, pitch-detection pipeline, and `js/app.js` wiring are not
implemented yet (see the design spec for the full plan).

## Running locally

Data is loaded via `fetch()`, so opening `index.html` directly (`file://`)
will fail to load quiz data — always serve it:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/`. Recording requires microphone
permission and works best served over `localhost` or HTTPS (browsers
generally block `getUserMedia` on plain HTTP for any other origin).

There is no build, lint, or type-check command — there's no toolchain to
run.

## Data

`vendor/kanji-data/compounds/accents_kanjium.txt` is vendored pitch-accent
data from the [Kanjium](https://github.com/mifunetoshiro/kanjium) project
(via [kanji-data](https://github.com/bagustris/kanji-data) — see that
repo's `CREDITS.md` for the licensing/attribution caveat). `data/words.json`
— the flat `{word, reading, accentNum}` list the app actually reads at
runtime — is generated from it by a one-time build script under `tools/`
(not yet implemented); see the design spec's "Data" section for the exact
build steps.
