# Manual copy, not a submodule

Sibling apps (jlpt, kanji-drill, wanikanji) vendor
[kanji-data](https://github.com/bagustris/kanji-data) as a real git
submodule at `vendor/kanji-data` (see their `.gitmodules`:
`url = https://github.com/bagustris/kanji-data`).

This checkout was created in a network-restricted sandbox where
`git submodule add https://github.com/bagustris/kanji-data vendor/kanji-data`
timed out (no outbound network access). As a stand-in, only the one file
onchou actually needs —
`vendor/kanji-data/compounds/accents_kanjium.txt` — was copied in directly
from a local checkout of kanji-data.

**TODO**: once this repo is on a machine with network access, replace this
directory with a real submodule:

```bash
rm -rf vendor/kanji-data
git submodule add https://github.com/bagustris/kanji-data vendor/kanji-data
```

See `docs/superpowers/specs/2026-09-04-onchou-pitch-accent-trainer-design.md`
("Data > Source") for why this file is vendored at all, and `kanji-data`'s
own `CREDITS.md` for the Kanjium attribution/licensing caveat.
