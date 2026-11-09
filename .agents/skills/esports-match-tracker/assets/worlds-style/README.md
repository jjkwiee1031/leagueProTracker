# Worlds Report — reusable style kit

Snapshot of the esports scoreboard art style (dark neon, cyan accent, slab
cards, cue-synced captions) so a **different** video type can be built with the
same look without re-deriving it.

Source of truth for the live pipeline is `remotion/src/`; this folder is a
frozen copy for reuse and a record of the style.

## Contents
- `style.json` — machine-readable tokens: palette, typography, radii, motion, layout, timing.
- `components/` — the TSX sources that define the look (copied at the last render):
  - `HeadlineOpener.tsx` — neon gradient title shot (opener + closing card).
  - `MatchCard.tsx` — scorecard: round badge, teams, series score, total duration, per-game chips, and per-game performance screenshots (Bo1/Bo3).
  - `RecapCard.tsx` — day wrap-up: results list + aggregate chips (Bo3 count, sweeps, longest game).
  - `CaptionTrack.tsx` — bottom caption overlay driven by subtitle cues.
  - `WorldsReport.tsx` — the composition wiring (sequences + audio + timing model).

## Reuse
1. Copy the `components/` folder into your project (e.g. `src/worlds-style/`), keeping the four files together so their relative imports resolve.
2. Register a `Composition` at `1080×1920`, `fps 30` (see `WorldsReport.tsx`).
3. Feed your own data using the contracts below; nothing else is hard-coded.

### Data contracts
`matches.json` (array) — Bo1 and Bo3 share one shape; `games` carries the per-game detail
```jsonc
{
  "idx": 3,                       // DOM index (scraper bookkeeping)
  "date": "2026-10-26",           // calendar date of the match
  "round": "Round 3 High Matches (Bo3)",  // section title (drives the badge + bestOf)
  "teamA": "GEN", "scoreA": "2",       // series score
  "teamB": "LYON", "scoreB": "1",
  "winner": "GEN",
  "bestOf": 3,                   // parsed from the round label; 1 for Bo1
  "duration": "1:34:14",         // SERIES total = sum of game lengths (H:MM:SS if >=1h)
  "gameDurations": ["35:45", "26:32", "31:57"],
  "games": [
    {
      "game": 1, "duration": "35:45", "winner": "LYON",
      "teamA": { "champions": ["Rumble", "..."], "kdaStats": ["Rumble Kiin 2/1/1 ( 26.5K)"] },
      "teamB": { "champions": ["..."], "kdaStats": ["..."] },
      "screenshot": "worlds/screenshots/GEN_vs_LYON_g1.png"
    }
  ],
  "champions": ["Rumble", "..."],   // legacy/compat: unique picks across the series
  "kdaStats": ["..."],               // legacy/compat: game-1 lines
  "screenshot": "worlds/screenshots/GEN_vs_LYON_g1.png"  // legacy/compat: game 1
}
```
Notes
- Bo1 = one entry in `games` (`screenshot` = `<A>_vs_<B>.png`); Bo3 = 2-3 entries (`_g1,_g2,_g3`).
- `duration` is the **series total**; per-game lengths live in `gameDurations` / `games[].duration`.
- `games[].winner` comes from the popup's `result-win`/`result-loss` labels (side A then side B).

`subtitles.json` (array) — one entry per narration cue
```jsonc
{ "start": 210, "end": 390, "text": "第1场,...", "kind": "match", "matchIndex": 0 }
```
`kind` ∈ `intro | match | recap | outro`. `summary.json` holds the same segments without frames.
The narration is **LLM-generated** (pi headless) but must keep exactly N `match` segments (one per match,
in order); `recap` triggers the DAY RECAP card.

`render-config.json`
```jsonc
{ "narrationFrames": 1980, "fps": 30, "date": "2026-10-24" }
```

## Timing model (no fixed timeframes)
Cards follow the narration, not a constant slot:

- **opener** runs `0 → first match cue start`
- **match i card** runs from its cue start to the next match cue start (last one ends at the `recap` cue)
- **recap card** runs from the `recap` cue start to the `outro` cue start
- **outro card** runs from the outro cue start to the end
- composition duration = `max(90 + Σ 190×gamesPerMatch, narrationFrames)` so audio never clips
- fallback: `openerFrames 90`, `cardFrames 190` when no cue timing exists

Longer lines (a letter-spelled team name, a longer duration, a Bo3 series score)
therefore get more screen time automatically. A Bo3 card stays on screen for its
whole spoken line and cycles one performance screenshot per played game
(split evenly across the card).

## Backups
Renders and their inputs are archived by `scripts/archive.mjs` (pipeline step 9):
`output/archive/videos/<DATE>_worlds_report.mp4` (+ `_compact.mp4`) and
`output/archive/<DATE>/{data,screenshots,render-inputs,manifest.json}`.
