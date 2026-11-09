---
name: esports-match-tracker
description: Worlds daily report video — load when tracking a day's pro matches (scrape → Supabase → optional Remotion render), running or editing run_pipeline.sh / scrape.mjs / generate_summary.mjs, changing narration or subtitle contract, or touching WorldsReport / MatchCard TSX.
---

# Worlds Daily Report

Track one day's pro matches from Liquipedia: scrape → Supabase upload → video gate → Mandarin narration → TTS → vertical Remotion render.

## Steps

**1. Data stages.** Run with the gate flag — data only, no video:

```bash
bash scripts/run_pipeline.sh <YYYY-MM-DD> "<tournament>" --stop-after-db
# tournament name (e.g. "World Championship 2026") is required, 2nd arg
# flags: --stop-after-db (default here) | --skip-scrape | --skip-render | --dry-run
```

**2. Video gate.** Ask the user (structured question tool): "Generate video now" / "Stop here — data only".

**3. Act on the answer.**
- Yes → `bash scripts/run_pipeline.sh <DATE> "<tournament>" --skip-scrape` (no re-scrape; ingest is idempotent; summary/TTS render fresh from the DB). Done when `output/<DATE>_worlds_report.mp4` exists.
- No → stop. Give the user the resume command so they can continue any time.

Skip the gate only when the user asked for the full video up front in the same request.

## Reference

### Invariants (every run, every edit)
- **One day per run**: 0 completed matches → `exit 1`; `all` flag = TEST-ONLY multi-day.
- **Duration is never invented**: series `duration` = sum of real game lengths; unpublished → `null`, card shows "时长未公布", narration must not mention any duration. Per-game lengths live only in `gameDurations` / `games[].duration`.
- **One line == one cue**: narration line count and order are the video's timing spine; audio ≤ composition duration; exactly N `match` segments in `matchIndex` order.
- **Colors only in `remotion/src/theme.ts`** — no hardcoded hex anywhere.
- Summary reads the **Supabase DB** (`SUPABASE_URL` + secret key from env or `leagueProDB/.env`); no creds → falls back to `matches.json` with a warning; neither → `exit 1`.
- Bo1/Bo3/Bo5 auto-detected; one screenshot per game.
- Knockouts: `WORLDS_URL=https://liquipedia.net/leagueoflegends/World_Championship/2026/Knockout_Stage` (the `Playoffs` path 404s).

### Files

| Path | What |
|---|---|
| `output/data/<DATE>/matches.json` | Scraped matches — the render's ground truth |
| `output/data/<DATE>/summary.{txt,json}` | Narration text + timed segments |
| `output/<DATE>_worlds_report.mp4` (+ `_compact.mp4`) | Render (master + ≤5 MiB compact) |
| `output/logs/<DATE>_pipeline.log` | Stage timings |
| `remotion/public/worlds/*` | **Latest** run's render inputs: `matches.json`, `subtitles.json`, `narration.{mp3,vtt}`, `render-config.json`, `screenshots/*.png` |

`remotion/public/worlds/` holds only the newest run — re-render an older day by re-running the pipeline for that date. Before rendering, `check_assets.mjs` fails if any screenshot referenced in `matches.json` is missing from `remotion/public`.

`matches.json` per match: `teams` (+tags/logos), `scores`, `round`, `bestOf`, `duration` (see invariant), `gameDurations`, `games[]` (winner, duration, screenshot filename).

### Narration ↔ video contract
- Segments: 1-3 `intro` → exactly N `match` (order 0..N-1) → 1 `recap` → 1-2 `outro`; one line per segment, single-line, ≤90 chars. Invalid output → retry ×2 → `exit 1` (`SUMMARY_MODEL`, `SUMMARY_LLM_ATTEMPTS`, `SUMMARY_LLM_TIMEOUT_MS`).
- `parse_vtt.mjs` zips segments onto edge-tts cues; card timing derives from cues, not fixed slots. Voice `zh-TW-HsiaoChenNeural` (`TTS_VOICE/PITCH/RATE`); all-caps tags auto-spaced for the Mandarin voice (`TES` → "T E S"); narration uses team `abbreviation` from the DB.
- `generate_summary.mjs` guards against invented facts — never narrate a duration absent from the DB/`matches.json`.
- Ingest (`scripts/db_ingest.mjs <DATE> "<tournament>"`) is idempotent: teams on `abbreviation`, players on `player_name`, matches on `(team_a_id, team_b_id, match_date)`, games only when `(match_id, game_number)` is new.
- Shared script helpers live in `scripts/lib/`: env + Supabase REST client (`env.mjs`, `supabase.mjs`), pi-headless LLM call + JSON extraction (`llm.mjs`), durations/filenames/flags (`util.mjs`). Reuse them; do not re-inline env parsing, REST calls, or `pi` invocation in scripts.

### Remotion
- `remotion/src/WorldsReport.tsx` — root composition, vertical 1080×1920 @ 30 fps; duration = `max(cards, narrationFrames)` so the last spoken line never clips.
- Components: `MatchCard` (teams, scores, `BO{n}` badge, per-game chips, "时长未公布" slot), `RecapCard` (on the `recap` cue), `HeadlineOpener`, `CaptionTrack`. Registered in `Root.tsx` as `WorldsReport` (+ per-theme variants).
- Theme via `useTheme()` — default `gold`; override with `WORLDS_THEME=blue|crimson|emerald` or `WorldsReport-<name>` compositions. Palettes live only in `theme.ts`.
- Art-style snapshot for new video types: `.agents/skills/esports-match-tracker/assets/worlds-style/`.
- Run remotion commands from `remotion/`; lint with `npm run lint`.

### Scraper (`scripts/scrape.mjs`)
The **detail page** (`Match:ID_*`, opened per match) is the sole source of per-game info: durations, winners, rosters, and per-game "Player Performance" screenshots. The popup carries only teams/scores/date.

- Per-game pills on Bo3/Bo5: `[data-toggle-area-btn="N"]` where pill 1 = Overall Statistics, **pill N+2 = Game N+1**; Bo1 has no pills (whole `.match-bm` is the game).
- Roster team names on the detail page can be long form ("Hanwha Life Esports") vs bracket short tags ("HLE") — match by name, fall back to DOM order (team A first).
- Two bracket layouts: Swiss `.brkts-matchlist-match…`, Knockout `.brkts-match…` + `.brkts-opponent-entry[aria-label]`.
- Any function passed to `page.evaluate` must be **self-contained**: Node-side helpers, consts, and cross-function calls don't serialize — the failure is a silent `ReferenceError` swallowed by `.catch(() => null)`. When a browser fn reads `undefined` for something that exists on the page, check for a Node-scope reference first. (The browser-side fns in `scrape.mjs` — `readGameOverview`, `readPlayerPerformance`, `wrapPPSection`, `extractMatchList` — therefore define their own `clean` etc. and never import from `scripts/lib/`.)
- Cloudflare Turnstile blocks headless: re-run with `--headed` (WSLg) and click once; the cookie persists in `.playwright-profile`.
- The old popup-based extraction (`.brkts-popup-game-detail`, CLI-injected eval via `sh -c`) is removed — reach for the detail-page flow instead of resurrecting it.
