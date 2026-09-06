# onchou — Mora-Count-Gated Learning Progression — Design

## Problem

onchou currently picks a fully random word from `data/words.json` on every
"Next word" (`pickRandomWord()` in `js/app.js`). This has two problems for a
learner starting out:

1. Word length (mora count) isn't graded — a beginner can be handed a
   6-mora nakadaka word on their very first attempt.
2. Even restricting by word length doesn't help on its own: at 3+ morae,
   heiban dominates the raw pool heavily (see table below), so a plain
   random draw rarely surfaces the harder pattern types by chance.

## Goal

Let a learner start on short, structurally-simpler words and gradually
widen to longer ones, while ensuring that whichever pattern types
(heiban/atamadaka/nakadaka/odaka) are in play at a given level get roughly
equal practice time regardless of how skewed the raw word pool is.

## Data: mora-count / pattern-type distribution in `data/words.json`

Gathered directly from the shipped word list (1,967 entries); this is the
evidence the design below is based on.

| Mora count | Total | heiban | atamadaka | nakadaka | odaka |
|---|---|---|---|---|---|
| 1  | 14  | 4   | 10  | –   | –  |
| 2  | 291 | 93  | 126 | –   | 72 |
| 3  | 625 | 313 | 132 | 140 | 40 |
| 4  | 686 | 457 | 65  | 155 | 9  |
| 5  | 211 | 63  | 3   | 138 | 7  |
| 6  | 105 | 24  | 1   | 76  | 4  |
| 7  | 20  | 1   | –   | 19  | –  |
| 8  | 11  | –   | –   | 11  | –  |
| 9  | 3   | –   | –   | 3   | –  |
| 10 | 1   | –   | –   | 1   | –  |

Resulting cumulative pool per level (verified against the shipped data —
note each level includes everything shorter, so level "2" also picks up the
14 one-mora words):

| Level | Pool | Patterns available |
|---|---|---|
| 2   | 305  | heiban 97, atamadaka 136, odaka 72 (no nakadaka) |
| 3   | 930  | heiban 410, atamadaka 268, nakadaka 140, odaka 112 |
| 4   | 1616 | heiban 867, atamadaka 333, nakadaka 295, odaka 121 |
| All | 1967 | heiban 955, atamadaka 337, nakadaka 543, odaka 132 |

Two structural facts this table confirms:

- **Nakadaka is impossible below 3 morae** (it requires `1 < accentNum <
  moraCount`), so a 2-mora-only level naturally excludes the hardest
  pattern type without any special-casing.
- **Heiban dominates the raw pool from 3 morae up** (313/625 at 3 morae,
  457/686 at 4 morae) — a plain random draw would under-practice
  nakadaka/odaka even once they're structurally possible. This motivates
  pattern-balanced sampling, not just mora-count gating, as the actual
  mechanism.

## Decisions (resolved during brainstorming)

- **Advancement is manual**: a segmented control in Settings
  ("2 / 3 / 4 / All"), not automatic/performance-based. Simple, transparent,
  no accuracy-tracking infrastructure needed (that's explicitly out of scope
  — see Non-goals).
- **Levels are cumulative**: level "3" means `moraCount <= 3` (2-mora words
  keep appearing), not "only exactly 3-mora words" — keeps reinforcing
  earlier patterns while introducing new ones.
- **Pattern-balanced sampling applies at every level, including the default
  "All"**: one consistent selection mechanism, not two parallel behaviors
  for "gated" vs "ungated" levels. This is a deliberate behavior change from
  today's raw-random selection — the actual goal is practice weighted
  toward what's structurally harder, not merely gating by word length.
- **Default level is "All"**: an existing user who's never touched this
  setting keeps seeing every mora count they always have (the *pattern
  balancing* still applies to them, per the point above — only the
  mora-count *gate* is unchanged/absent at this level).

## Components

### New `js/word-select.js` (pure, DOM-free — same style/testability as
`js/mora-segment.js` and `js/pitch-contour.js`)

```js
LEVELS = [
  { value: '2',   maxMora: 2 },
  { value: '3',   maxMora: 3 },
  { value: '4',   maxMora: 4 },
  { value: 'all', maxMora: Infinity },
]

classifyPattern(moraCount, accentNum) -> 'heiban'|'atamadaka'|'nakadaka'|'odaka'
// accentNum === 0            -> 'heiban'
// accentNum === 1            -> 'atamadaka'
// accentNum === moraCount    -> 'odaka'
// otherwise                  -> 'nakadaka'

groupByPattern(words, maxMora) -> {
  heiban?: [word, ...], atamadaka?: [word, ...],
  nakadaka?: [word, ...], odaka?: [word, ...],
}
// Filters `words` to moraCount <= maxMora (moraCount computed via
// PitchDiagram.moraSplit(word.reading).length, same helper app.js already
// uses), classifies each via classifyPattern, groups into buckets. A
// pattern with zero matching words is simply absent as a key (not present
// as an empty array) -- e.g. level "2"'s result never has a `nakadaka` key.

pickWord(words, levelValue, rng) -> word | null
// rng: () => number in [0,1), defaults to Math.random. Injectable so tests
// can assert exactly which bucket/word gets picked deterministically,
// rather than only eyeballing distribution over many runs.
// 1. Resolve levelValue to its maxMora via LEVELS (unknown/missing value
//    falls back to 'all', matching SettingsManager's own defaulting
//    philosophy of never throwing on a bad stored value).
// 2. groupByPattern(words, maxMora).
// 3. If no buckets (empty pool): return null (mirrors today's
//    pickRandomWord's `if (!words.length) return null`).
// 4. Pick one bucket key uniformly at random (via rng), then one word
//    from that bucket uniformly at random (via rng again). Bucket keys are
//    considered in the FIXED order ['heiban', 'atamadaka', 'nakadaka',
//    'odaka'] filtered to only those present -- not object-iteration
//    order -- so a given rng sequence picks the same bucket deterministically
//    regardless of engine/insertion-order quirks, which is what makes the
//    rng-based tests below meaningful.
```

### `js/settings.js`

Add `level: 'all'` to `DEFAULTS`.

### `index.html`

A new `settings-row settings-row-column` in the settings panel, below the
existing toggles: a 4-button segmented control (`id="setting-level"`,
`role="radiogroup"`), one button per `LEVELS` entry, labeled "2" / "3" / "4"
/ "All" with a mora-count subtext (e.g. "≤2 morae"). Markup mirrors jlpt's
existing round-size segmented control exactly (`settings-segmented` /
`segmented-btn` classes, `data-value` attributes, `.active` class on the
current selection).

### `js/app.js`

- `nextWord()` calls `WordSelect.pickWord(words, SettingsManager.get('level'))`
  instead of the old `pickRandomWord()`, which is removed (fully superseded,
  not run in parallel).
- `setupSettingsPanel()` gains level-button click handlers: toggle `.active`,
  `SettingsManager.set('level', btn.dataset.value)`. No immediate re-render
  of the current word on level change (matches how the auto-play/show-contour
  toggles already only take effect going forward, not retroactively).

### `style.css`

Port `.settings-segmented` / `.segmented-btn` (including `.active`,
`:hover`/`:focus-visible`) from jlpt's `style.css` — not previously needed
in onchou since earlier settings work didn't include a segmented control.

### `sw.js`

Add `js/word-select.js` to `CORE_ASSETS`, bump `CACHE_VERSION`.

## Testing

- `classifyPattern`: direct fixture cases for all four pattern types plus
  the boundary cases (accentNum 0, accentNum === moraCount, accentNum
  strictly between 1 and moraCount), using real words looked up from
  `vendor/kanji-data/compounds/accents_kanjium.txt` where convenient
  (matching this codebase's existing test-fixture convention).
- `groupByPattern`: fixture word lists asserting (a) correct bucket
  membership, (b) a pattern with zero matches is absent as a key entirely,
  (c) the `maxMora` filter excludes longer words.
- `pickWord`: using an injected fake `rng`, assert exactly which bucket and
  word get selected for known rng sequences; cover the empty-pool (`null`)
  case and the level-"2"-has-no-nakadaka-bucket case explicitly.
- `index.html`/`js/app.js` wiring (segmented-button clicks, persistence) is
  DOM/browser-only and gets manual in-browser verification, same as the
  rest of the settings panel.

## Non-goals

- No accuracy tracking or performance-based auto-advancement — advancement
  is entirely manual via the level picker. A future revision could add this
  (there's a natural extension point: `WordSelect.pickWord` already isolates
  the selection algorithm from the UI), but building accuracy-history
  storage now would be speculative ahead of any actual need.
- No change to `data/words.json` or the data-build pipeline
  (`tools/build-words.js`) — this feature only changes which word already
  in that file gets picked next, not what's in it.
- No retroactive re-render of the current word when the level changes
  mid-session — consistent with how the existing auto-play/show-contour
  settings already behave (take effect from the next action, not
  instantly).
