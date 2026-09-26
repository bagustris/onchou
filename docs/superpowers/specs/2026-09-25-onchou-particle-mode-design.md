# onchou — Particle-Attached Practice Mode — Design

## Problem

Heiban (accentNum 0) and odaka (accentNum === moraCount) are pronounced
*identically* across a word's own morae — the standard pitch-accent rule
(`PitchDiagram.pitchLevels`) already encodes this: both patterns' only
difference is the trailing pseudo-mora representing what happens on a
following particle (H for heiban, L for odaka). `pitchLevels` has always
computed that trailing entry, and the target diagram has always rendered it
(hollow, smaller, `pitch-dot-trailing`) — but the app only ever asks the
learner to record the bare word. `js/app.js`'s `handleTrace` explicitly
appends that trailing level to the learner's diagram as a decorative,
unmeasured dot (see its comment at the `trailingLevel` line) "purely for
visual alignment... not a claim about anything actually measured." A learner
can currently say a heiban and an odaka word identically and score 100% on
both — the app cannot teach or test the one contrast that actually
distinguishes them. `docs/2026-09-05-pitch-accent-evaluation-research-plan.md`
names this the same gap ("no real trailing-particle pitch data").

As a side effect, this also makes every 1-mora word unscoreable today
(`classifyLevels` always returns `'unclear'` for a single slot — no other
mora to be relatively higher/lower than), which `handleTrace` currently
papers over with a dedicated "no relative pitch to compare" message.

## Goal

An opt-in setting, **off by default** (matching `showContour`'s precedent —
an additive mode hidden until the learner asks for it, not a change to the
default flow): when on, the learner says the word *plus* the particle が
instead of the bare word, and that trailing mora is scored for real instead
of being decorative. This fixes both problems above: heiban/odaka become
distinguishable, and a 1-mora word gains a second, real, scoreable mora.

が (not は) is used, with no alternative offered — が is the conventional
citation particle in Japanese pitch-accent references (NHK accent
dictionary, OJAD), and offering a choice of particle would be speculative
complexity ahead of any actual need (same reasoning the learning-progression
spec already applied to skip accuracy-tracking infrastructure).

Non-goals: no new particle choices (は etc.), no change to `data/words.json`
or the accent-classification rule itself, no sentence-/phrase-level practice.

## Key existing fact this design leans on

`PitchDiagram.pitchLevels(moraCount, accentNum)` **already** returns
`moraCount + 1` entries — one per mora plus that trailing pseudo-mora
representing が's own pitch (H only for heiban; L otherwise, including
odaka). So the *target* side of this feature requires zero new logic: the
full, unsliced return value of `targetLevelsFor(word)` (already computed
today) is exactly the correct target pattern for particle mode. Only the
*learner* side — recording, segmentation, and diagram rendering — needs to
change.

## Design

### `js/settings.js`

Add `particleMode: false` to `DEFAULTS`, with a comment matching the
existing style (why it defaults off).

### `index.html`

- A new checkbox row in the settings panel, alongside auto-play/show-contour:
  `id="setting-particle-mode"`, label "助詞つき練習 — Practice with a
  trailing が particle".
- A new `<span id="word-reading-particle" class="word-reading-particle"
  hidden>＋ が</span>` immediately after `#word-reading`, toggled by
  `renderWord()` so the learner sees what to actually say.

### `style.css`

`.word-reading-particle`: small, muted, `--accent`-tinted suffix text next
to `.word-reading` (visually marks が as *added*, not part of the word's own
reading). No changes needed to the pitch-dot/mora-chip rules — a filled
(non-`trailing`) dot and a `が`-labeled chip both already fit the existing
styles (`.mora-chip` is a pill with `min-width`, not a fixed-width circle).

### `js/app.js`

- `var PARTICLE_MORA = 'が';`
- New module-level `var particleModeForWord = false;`, snapshotted from
  `SettingsManager.get('particleMode')` inside `renderWord()` — same
  "settings changes take effect from the next word, not retroactively"
  convention `level`/`autoPlayReference` already follow (see the
  learning-progression spec's Non-goals), and necessary here specifically so
  the displayed "＋ が" suffix and what actually gets scored can never
  disagree for a single word on screen (toggling the setting mid-card must
  not silently change what's being scored without changing what's shown).
- `renderWord()`: sets `particleModeForWord`; toggles
  `els.wordReadingParticle.hidden = !particleModeForWord`.
- `playReference()` / `compareWithReference()`: speak
  `currentWord.reading + (particleModeForWord ? PARTICLE_MORA : '')` instead
  of the bare reading, so the TTS reference and Compare's reference leg
  demonstrate the particle too.
- `handleTrace(word)`:
  - `var scoringMoraCount = particleModeForWord ? moraCount + 1 : moraCount;`
    passed to `MoraSegment.segmentByMora` instead of the bare `moraCount` —
    the recording is now expected to contain one more mora, so the
    time-proportional slot split divides across `moraCount + 1` slots.
  - The 1-mora "no relative pitch to compare" branch keys off
    `scoringMoraCount === 1` (not `moraCount === 1` as today) — with particle
    mode on, a 1-mora word now has 2 scoreable slots, so that message no
    longer applies to it.
  - `targetPattern`: `particleModeForWord ? fullTargetLevels :
    fullTargetLevels.slice(0, moraCount)` — particle mode scores against the
    full, unsliced pattern (see "Key existing fact" above); the non-particle
    path is completely unchanged.
  - Learner diagram: `particleModeForWord` renders `learnerPattern` directly
    with `{variant: 'learner', trailing: false}` (all `moraCount + 1` slots
    are real measured data, so none should get the hollow/decorative
    `pitch-dot-trailing` treatment) instead of today's
    `learnerPattern.concat([trailingLevel])` with default (hollow) trailing.
  - Mora chips (`score.perMora`): label the last chip `'が'` instead of
    `moraCount + 1` when `particleModeForWord`, so the feedback row reads as
    "1 2 3 が" rather than an unexplained extra number.
  - `PitchContour` (when `showContour` is also on): **does** need a change —
    `buildTargetSteps` always dropped `targetLevels`' trailing entry and
    divided the recorded span across `moraCount` word-only steps, which is
    wrong once the span itself covers `moraCount + 1` real morae (particle
    mode). Gains an `opts.includeTrailing` flag, threaded through
    `renderSVG`, that keeps the trailing level in the division instead of
    excluding it; `handleTrace` passes `{ includeTrailing: particleModeForWord }`.
    Omitting `opts` (or passing `includeTrailing: false`) is unchanged from
    today's behavior. (Caught in review of the initial implementation —
    recorded here since the rest of this doc was written before the fix.)

### `sw.js`

Bump `CACHE_VERSION` (no new files added to `CORE_ASSETS` — only existing
cached files' contents change).

## UI flow (particle mode on)

1. Word card shows word + reading + "＋ が" suffix + target diagram (already
   showing the correct trailing dot for heiban vs. odaka — unchanged
   rendering, now meaningfully scored instead of decorative).
2. "▶ Play" speaks reading + が.
3. Learner records themselves saying reading + が.
4. Scoring and both diagrams cover `moraCount + 1` morae; the extra chip is
   labeled が instead of a number.

## Testing

`MoraSegment.segmentByMora`/`scorePattern` are reused unchanged with a
different `moraCount` argument, already covered by their existing tests for
arbitrary mora counts. `PitchContour.buildTargetSteps`'s new
`opts.includeTrailing` flag gets a direct fixture test (existing 4-entry
levels array, divided into 4 steps instead of 3) alongside its existing
default-behavior cases. The `js/app.js` wiring above (DOM state, snapshot
timing, chip labeling) is DOM/browser-only and gets manual in-browser
verification, matching this codebase's existing convention for `app.js` (it
has no test file today).

## Future extension

`docs/2026-09-05-pitch-accent-evaluation-research-plan.md`'s
"no real trailing-particle pitch data" gap can now start closing — a learner
opting into this mode is exactly the source of the labeled particle-pitch
recordings that plan calls for.
