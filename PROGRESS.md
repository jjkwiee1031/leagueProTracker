# Progress: Worlds Daily Match Report Pipeline

## Fixed: fabricated duration when Liquipedia lags
- 2026-10-29 has IG 2-1 LYON whose popup has **no game-detail blocks yet** (7974 B vs 44 KB for MKOI/T1; no `.brkts-popup-game-detail-container`, only `brkts-popup-body-grid-row-detail`) → the scraper used a hardcoded `'30:00'` fallback and the LLM narrated "系列赛总时长30分钟" as fact.
- [x] `scrape.mjs`: removed the fabricated duration fallback → `null` + loud Node-side WARNING ("N/M games read, duration UNKNOWN"); also aborts if the browser eval returns no result block (so an eval error can't look like "no matches today").
- [x] `generate_summary.mjs`: `durationSpoken` is `null` when unknown; prompt forbids any duration claim for those matches; guard requires a duration only when known **and rejects any 小时/分钟/秒 mention when it isn't**; template omits the duration clause.
- [x] `MatchCard.tsx`: shows “时长未公布” instead of an empty slot (`duration?: string | null`).
- [x] **Lesson: no backticks or `$(` inside the scraper's injected function** — it is embedded in a double-quoted `sh -c` string, so they get executed (this broke one scrape run).
- [x] Run 2026-10-29 (gold theme): COMPLETE in 3m14s (render 1m57s), narration honest — `I G 以2比1力克 L Y O N 鏖战三局艰难取胜` (no duration), MKOI/T1 line keeps `1小时5分钟43秒`.
- [x] Notion page created + video/images attached (`output/data/2026-10-29/notion.json`).
- [ ] Optional: extract per-game **win/loss** from `brkts-popup-body-grid-row-detail` (available even without durations) so `gamesPlayed` and “鏖战三局” come from data.

## Fixed: deleted screenshots (my cleanup bug)
- Restoring the 2026-10-27 run's 6 shots was needed because a `find -newermt -delete` cleanup during knockout testing removed them (`CFO_vs_T1`, `BLG_vs_KC`, `LOS_vs_TSW_g1/g2`, `TLAW_vs_AL_g1/g2`) — recovered from `output/screenshots/2026-10-27/` + `output/archive/2026-10-27/screenshots/`; all `matches.json` refs resolve again.
- [x] New `scripts/check_assets.mjs` pre-render guard (wired into the render stage; `exit 1` + missing list). Verified passing/failing.
- Rule: never delete from `remotion/public/worlds/screenshots` unless replacing the whole run.

## Active Task: Color themes (gold default)
- [x] New `remotion/src/theme.ts` — single source of truth; components use `useTheme()`, zero hardcoded hex left in the Worlds files
- [x] 4 palettes: `gold` (default, championship amber), `blue` (legacy look), `crimson`, `emerald`
- [x] Win/loss recolored to the accent (gold winner + glow, loser muted grey); `blue` keeps green/red
- [x] Switch at runtime via the `theme` prop: Studio props panel, `--props='{"theme":"blue"}'`, or `WorldsReport` / `WorldsReport-blue|-crimson|-emerald` compositions
- [x] Pipeline: `WORLDS_THEME=<name> bash scripts/run_pipeline.sh <DATE>` (unset = gold)
- [x] Docs: `style.json` color block rewritten to gold + `themes` map; AGENTS.md one-liner
- [x] `npm run lint` clean, `bash -n` clean, `npx remotion compositions` lists all 4
- [ ] NOT rendered (user previews in the Studio)

## Active Task: Knockout readiness (coming matches)
- [x] Dual-layout scraper: Swiss `.brkts-matchlist-match` + Knockout `.brkts-match` bracket
- [x] **One day per run**: date filter is now strict — 0 matches for the day → `exit 1` with the list of dates that do have matches; the old silent "last 8" fallback is gone
- [x] Multi-day data can no longer leak: a non-test run asserts a single distinct date before writing
- [x] Unplayed matches auto-excluded (empty bracket scores) → running before a match ends fails loudly, no garbage JSON
- [x] `all` is explicit TEST MODE (prints `TEST MODE`, multi-day) — never for real inference
- [x] Screenshot filenames sanitized for `staticFile()` (full names like `Anyone's Legend` → `Anyones_Legend`)
- [x] MatchCard badge appends `· BO5` when the round label has no series tag (knockout `round` = `Knockout Stage`)
- [x] Verified: `2025-11-03` (no matches) → exit 1 + date list; `2026-11-04` (scheduled/unplayed) → exit 1; `2025-11-09` → **exactly 1 match** in `output/data/2025-11-09/matches.json`, 5 sanitized shots; Swiss regression → 33/0/33 (list/bracket/union)
- [x] `npm run lint` clean

## Fixed: popup details lag → detail-page fallback
- [x] scrape.mjs: when a popup lacks per-game detail blocks, opens the popup’s “View match details” page (Match:ID_Wrd26KnOut_*) and reads per-game durations + winners from the match-bm layout (clicks Game N pills, reads [data-toggle-area-content]). No player/champion data there — those stay empty until Liquipedia updates the popup; re-run later to backfill.
- [x] Popup without Game N tabs captures the Overview screenshot once (no duplicate shots).
- [x] Verified 2026-11-07 T1 3-1 KC: durations 35:39/29:42/36:44/35:15, winners W-W-L-W, total 2:17:20; db_ingest added 4 games.
- [x] Also fixed run_pipeline.sh double-shift eating --skip-render/--skip-scrape flags.

## Refactor: scrape.mjs (2026-11-07)
- [x] Restructured into named pipeline steps (openBracket / extractMatchList / selectMatches / enrichFromDetailPage / capturePPShots / capturePopupShots / reportIntegrity); ONE detail-page visit per match now does both data + PP screenshots.
- [x] Lesson: every function passed to page.evaluate must be fully self-contained — Node-side helpers (clean, MATCH_SELECTOR, cross-fn calls) don't serialize; caused silent ReferenceErrors swallowed by .catch(()=>null).
- [x] Detail-page team names can be long form ("Hanwha Life Esports") vs bracket short tags ("HLE") — roster teams matched by name with DOM-order fallback.
- [x] Verified Bo5 (T1 v KC: 4 games, full rosters, 4 shots) + Swiss (2026-10-31: 5 games, 10 players/game, 0 warns).

## Fixed: screenshots now from detail-page "Player Performance" section
- [x] scrape.mjs: popup .brkts-popup-game-detail parsing REMOVED — detail page (Match:ID_*) is now the SOLE source of per-game info filled for every match in step 3b before screenshots. Winner derives from series score only.
- [x] Rosters restored from detail page: per game, switch to Game N pill and read `.match-bm-players-wrapper` (role from role-icon img title, player from name anchor title, champion from icon anchor title). Roles come as Top/Jungle/Mid/Bot/Support ("Bot", not "ADC"). Teams matched by name, fallback to DOM order.
- [x] scrape.mjs: every match now visits its Match:ID detail page for screenshots; per game, the Player Performance section (heading → next heading, any level) is wrapped in a temp element and captured via element screenshot (scroll/viewport-proof), DOM restored after. Bo1 = single section; Bo3/Bo5 = click Game N pill first (inactive areas have zero-size rects).
- [x] Old popup capture kept only as fallback when a match has no usable detail page.
- [x] Verified 2026-11-07 T1 vs KC: 4 clean PP shots (heading + both team tables, no Damage Dealt bleed); dataset screenshots refs updated.

## Active Task: Bo5 support
- [x] Probed the code: scraper/video are format-agnostic (`.brkts-popup-game-detail` loop, `duration` = sum, N screenshots/chips)
- [x] Removed hardcoded `BO3` wording — generic `BO3`/`BO5` labels in `RecapCard.tsx`, template recap, LLM facts (`seriesFormats`) + prompt
- [x] Sweep definition fixed: loser won 0 games (2-0 / 3-0); a Bo1 can no longer be counted as a sweep
- [x] Configurable target page: `WORLDS_URL` (default Swiss Stage) used by `check_auth.sh` + `scrape.mjs`, echoed by `run_pipeline.sh`
- [x] **Knockout page uses a different DOM** (`.brkts-match` bracket, teams in `.brkts-opponent-entry`, **0** `.brkts-matchlist`): scraper now handles both layouts; `bestOf` read from the popup's `(BoN)`; `round` falls back to the stage name
- [x] **Verified live on `2025/Knockout_Stage`:** 7 completed Bo5 series, 28 per-game screenshots, all winners/scores/per-game winners/series totals correct (`T1 3-2 KT` final, `AL 2-3 T1`, `G2 1-3 TES`, `T1 3-0 TES`, `GEN 3-1 HLE`, `KT 3-0 CFO`, `GEN 1-3 KT`). Evidence: `output/data/2025-knockout_stage/matches.json` + `output/screenshots/2025-knockout_stage/`
- [x] Docs: correct URL is `.../2026/Knockout_Stage` (the `Playoffs` path 404s)
- [ ] No video rendered from the knockout data yet (user asked to scrape only)

## Active Task: Pipeline observability (stage timings)
Problem: running the script gave no clue which stage was active or what was slow.

- [x] `scripts/run_pipeline.sh` rewritten: `▶ STEP n/9 <name> (started HH:MM:SS)` / `✔ <name> <duration>` banners
- [x] 15s heartbeat (`⏱ <label> … Ns elapsed`) on long stages, **TTY only** so piped logs stay clean
- [x] `⊘ … (skipped)` for `--skip-*`; `FAILED STEP n/9 (after Ns)` + table on error, non-zero exit
- [x] Final `STAGE TIMINGS` table: per-stage time, share bar, `← slowest`, `TOTAL`
- [x] Per-stage log `output/logs/<DATE>_pipeline.log` (`step\tname\tseconds\tstatus`)
- [x] `--dry-run` prints the planned stages with rough durations
- [x] `--skip-render` (steps 1-6 + archive) for a fast loop without rendering
- [x] Heartbeat override for non-TTY runs: `PIPELINE_HEARTBEAT=auto|on|off`, `PIPELINE_HEARTBEAT_SECS` (timestamped `⏱ … Ns elapsed (HH:MM:SS)`)
- [x] Fixed the old literal `\n` echo bug (stages now use printf)
- [x] **Measured with render (2026-10-26, 53 s video):** render **6m46s = 86%**, LLM 30s, auth 21s, TTS 10s, rest <1s → **7m47s total**
- [x] **Measured without render (2026-10-26):** scrape **1m20s = 63%**, LLM 21s, auth 13s, TTS 11s → **2m06s total**
- Note: heartbeat is `auto` (TTY-only) by default; my captured runs were piped so it looked silent — use `PIPELINE_HEARTBEAT=on` to force it in wrappers/pipes.

## Active Task: Dynamic (LLM) narration + girl TTS voice

### Goal
Replace the fixed templated narration with LLM-written copy (agent in the loop) and switch the
TTS voice to a Mandarin girl voice.

### Decisions (user)
- LLM invocation: **pi headless agent** (`pi --print --no-session -nt --system-prompt ...`).
- Dynamic shape: **1 line per match (ordered) + a day `recap` segment**.
- Failure policy: **fail loudly** — no silent template fallback (`--template` only as a manual escape hatch).
- Voice: **`zh-TW-HsiaoChenNeural`** (chosen from samples in `output/tts-samples/`).

### Checklist
- [x] TTS voice → `zh-TW-HsiaoChenNeural` in `scripts/tts.sh` (+ `TTS_VOICE`/`TTS_PITCH`/`TTS_RATE` overrides)
- [x] Voice samples rendered: `output/tts-samples/` (6 voices + 3 pitch variants)
- [x] `scripts/generate_summary.mjs` rewritten: facts → prompt → `pi` → JSON extract → normalize → strict validate → retry(2) → `exit 1`
- [x] Factual guard: each match line must contain winner tag + series score + spoken duration; preformatted facts prevent the LLM doing tag/duration math
- [x] `spacedTags()` now leaves series tags (`BO3`) intact, still spaces team tags (`GEN` → `G E N`)
- [x] New `recap` kind: `remotion/src/components/RecapCard.tsx` (DAY RECAP results list + aggregate chips)
- [x] `WorldsReport.tsx`: last match card ends at the recap cue; recap card runs recap→outro; `CaptionTrack`/`parse_vtt` know `recap`
- [x] `run_pipeline.sh` step 3 labelled LLM; docs updated (SKILL.md, AGENTS.md, worlds-style README + component snapshot)
- [x] Verified: `npm run lint` clean; full pipeline `2026-10-26 --skip-scrape --skip-notion` twice (LLM accepted attempt 1 each time, different copy each run), audio 53.8s ≤ video 54.5s; frames confirm match cards + DAY RECAP card

## Active Task: Bo3 (multi-game series) support
Swiss Stage Rounds 3-5 are **Bo3** (2-3 games per match) while Rounds 1-2 are Bo1. The
pipeline was Bo1-only: it read a single game's duration/kills and captured one popup shot.

### Live DOM findings (probed 2026-10-28 on the real Swiss Stage page)
- Every match popup has one `.brkts-popup-game-detail` per played game (`[data-toggle-area-content=2..N]`,
  tab buttons `[data-toggle-area-btn=2..N]`; content `1` = Overview).
- Per game: `.brkts-popup-game-detail-header-summary` = `Game 1 - 35:45` (label + duration).
- Per game winner: header `.generic-label[data-label-type=result-win|result-loss]`, first = team A, second = team B.
- Per game players: two `.brkts-popup-game-detail-player-container` (team A, team B); each player has
  `.brkts-popup-game-detail-player-character img[alt]` (champion), a name `a`, and `.brkts-popup-game-detail-player-stats` (KDA + gold).
- Bo1 popups simply have 1 game detail (tabs: Overview, Game 1), so the same code path covers both.

### Checklist
- [x] Probe real Bo3 popups (structure validated on GEN 2-1 LYON + all 4 completed Bo3 matches)
- [x] `scripts/scrape.mjs` — per-game extraction (`games[]`, per-game duration/winner/champions/KDA), total series duration, `bestOf`, one screenshot **per game**
- [x] `scripts/generate_summary.mjs` — Bo3 narration (series score + `N局总耗时…`)
- [x] `remotion/src/components/MatchCard.tsx` — cycle game screenshots, game badge + per-game duration chips
- [x] `scripts/notion_sync.mjs` — per-game duration in the bullet
- [x] Validate: `npm run lint` (tsc) + full pipeline run on a Bo3 day (`--skip-notion`)
- [x] Docs: SKILL.md Bo3 section

### Verification (2026-10-28)
- `npm run lint` (eslint + tsc) clean.
- Full pipeline `--skip-notion` on **2026-10-26** (2x Bo3 incl. `GEN 2-1 LYON` 3 games + 2x Bo1) and
  **2026-10-27** (2x Bo3 + 2x Bo1): scrape (6/6 per-game shots), summary, TTS, subtitles, render, archive all OK.
- Frame-checked renders: Bo3 card shows series score (`2:1`), series total (`1:34:14`), per-game chips
  (`G1 35:45 · G2 26:32 · G3 31:57`), round badge `Round 3 High · BO3`, and cycles one player-performance
  screenshot per game (G1→G2→G3) with dot indicators. Bo1 matches unchanged.
- Fixed en route: round label was reading an inner collapse-area (showed the match datetime); now reads
  `w.closest('.brkts-matchlist').innerText` first line, which also supplies `bestOf`.

## Goal
Automated pipeline to scrape all Swiss Stage matches for the day, generate a Mandarin summary with TTS, render a vertical Remotion video report, and sync everything to Notion.

## Checklist
- [x] Step 0: Scaffolding, archiving old assets, reset PROGRESS.md
- [x] Step 1: `scripts/scrape.mjs` — Generalized multi-match scraper
- [x] Step 2: `scripts/generate_summary.mjs` — Mandarin narration generator
- [x] Step 3: `scripts/tts.sh` — edge-tts narration render (+ `scripts/parse_vtt.mjs` → subtitle frames)
- [x] Step 4: `remotion/src/WorldsReport.tsx` + subcomponents (HeadlineOpener / MatchCard / CaptionTrack)
- [x] Step 5: Wire into `Root.tsx` & `Composition.tsx`
- [x] **FIX:** Composition duration now tracks narration length via `public/worlds/render-config.json` (audio was previously clipped).
- [x] **FIX:** WorldsReportProps gained `[key: string]: unknown` index signature (required by Remotion `LooseComponentType`).
- [x] **FIX:** `--log=warn` in `run_pipeline.sh` (was invalid `warning`).
- [x] Step 6: `scripts/notion_sync.mjs` — standalone Notion day-page creator (REST; needs `NOTION_TOKEN` + `NOTION_PARENT_PAGE_ID` env)
- [x] Step 7: `scripts/run_pipeline.sh` — Master orchestrator (8 steps, flags `--skip-scrape` / `--skip-notion`)
- [x] Step 8: Verification — `tsc --noEmit` clean; full render `output/2026-10-25_worlds_report.mp4` (1080x1920@30, 56.9s, h264+aac, 4.4MB). CJK font confirmed (`NotoSansSC-Regular.otf`).
- [x] Step 9: Documentation — SKILL.md pipeline section + PROGRESS.md
- [x] **Change 1:** Correct match duration — was grabbed from the first `MM:SS` (the match START time, e.g. `01:00 MYT`); now reads the leaf `.brkts-popup-spaced` in `.brkts-popup-body-grid` (e.g. `33:08`).
- [x] **Change 2:** Team acronyms spelled letter-by-letter in narration/captions (`TES` → `T E S`) via `speak()` in `generate_summary.mjs` so Mandarin TTS reads each letter.
- [x] **Change 3:** Each MatchCard embeds its player-performance popup screenshot; scraper copies shots into `remotion/public/worlds/screenshots/<TeamA>_vs_<TeamB>.png` and sets `match.screenshot`.
- [x] **Change 4:** Video now follows the TTS instead of fixed timeframes. `generate_summary.mjs` emits `summary.json` segments (`intro`/`match`/`outro`); `parse_vtt.mjs` zips them onto the edge-tts cues (`kind` + `matchIndex`); `WorldsReport` shows each `MatchCard` from its spoken cue's start frame until the next cue, with an outro card at the outro cue. Longer spellings (e.g. `T L A W`) automatically get more time.
- [x] **Scraper hardening:** wait for lazy bracket load (poll), filter by match date (parsed from popup header calendar-style, no TZ shift), serialized extraction via `fn.toString()` (avoids template-literal backslash stripping), Result-block parsing (stdout echoes code), correct screenshot Result regex.

- [x] **Change 6:** Opener/outro date now comes from the run's data (`matches[0].date` → `render-config.date` fallback), not a build-time constant. Verified: 10-24 render derives `2026-10-24`.
- [x] **Change 7:** Renders are backed up (pipeline step 9, `scripts/archive.mjs`) into `output/archive/videos/` + `output/archive/<DATE>/{data,screenshots,render-inputs,manifest.json}`. Art style snapshotted for reuse at `.agents/skills/esports-match-tracker/assets/worlds-style/` (`style.json`, `components/`, data contracts).

## Pitfalls resolved (crash recovery)
- Composition duration was hardcoded shorter than the TTS track → last narration line clipped. Fixed by writing `narrationFrames` (from `ffprobe`) into `render-config.json` and letting the Composition take `max(cardEnd, narrationFrames)`.
- Remotion `Composition` typing error → added index signature to props interface.
- Rendered output verified audio `56.3s` ≤ video `56.9s` (no clip).

## Notion sync (via SSO MCP) — DONE
- Parent page created: `🏆 Worlds Reports — Swiss Stage 2026`
- Day page: `🎮 Worlds — Swiss Stage 2026-10-25` (summary + 8 match bullets + 8 performance screenshots + embedded video)
- Video re-encoded to `2026-10-25_worlds_report_compact.mp4` (2.3 MB) because Notion's upload limit is **5 MiB** (full-res 7.1 MB rejected as `validation_error`).
- Standalone `notion_sync.mjs` also updated awareness: video attachment should use the compact file.

## Runs
- 2026-10-25 → `output/2026-10-25_worlds_report.mp4` · Notion page `404385ce-570e-812a-a33a-c6239324ee14`
- 2026-10-24 (yesterday) → `output/2026-10-24_worlds_report.mp4` · compact `_compact.mp4` (2.5 MB) · Notion page `404385ce-570e-81df-92ef-ee157f11f5db` (video block real + 8 image blocks; rebuilt with the date-corrected render)
- Notion refs are recorded to `output/data/<DATE>/notion.json` and archived, so future video swaps are a single `update_content` replace.
- [x] **Change 5:** Narration speaks match length in units (`26:01` → `26分钟1秒`) via `speakDuration()` in `generate_summary.mjs`. Both days re-rendered and Notion videos replaced.
- Note: `remotion/public/worlds/*` (matches/screenshots/narration/subtitles/render-config) always hold the **latest** run; re-render an older day by re-running `run_pipeline.sh <DATE>`.

## Remaining manual / env-gated items
- [ ] `run_pipeline.sh` Step 8 (`notion_sync.mjs`) still needs `NOTION_TOKEN` + `NOTION_PARENT_PAGE_ID` for unattended runs; interactive/single-day sync uses the Notion SSO MCP directly (create_file_upload + curl, then create_pages/update_page).
- [x] Re-synced the Notion day page video with the TTS-timed render (compact 2.4 MB).
- [x] Cleaned the Notion Video section: removed stray `Full-res …` text and fixed the video so it is a real playable block (the earlier tag was inserted inline and stored as escaped literal text). Lesson: media tags must be their own blank-line-separated block, never inline in a paragraph.
## generate_summary.mjs → Supabase DB source (2026-11-01) — DONE
- [x] `generate_summary.mjs` now loads matches for the date from Supabase REST (`match_date=eq`, `match_id.asc`; teams + games joined). Creds: `SUPABASE_URL` + `SUPABASE_SECRET_KEY` (or legacy `SUPABASE_KEY`) from env or `leagueProDB/.env` (created). Fallback to `matches.json` with warning if no creds; exit 1 if neither.
- [x] Narration team names switched to `teams.abbreviation` (TES/HLE/G2...); `spacedTags()` keeps letter-by-letter TTS spacing (TES → "T E S"). Template + LLM + validator all use the spaced abbreviations.
- Fixed: PostgREST select needed `join(',')` (was `join('')`, produced concatenated field names); same bug still latent in `scripts/supabase_load.mjs`.
- DB side: `GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role, anon, authenticated` (new sb_secret key 403'd otherwise).
- Verified 2026-11-01 via `--template`: 3 matches, "K C以2比0击败M K O I…" etc.

## Pipeline: scrape → DB ingest → summary-from-DB (2026-11-01) — DONE
- [x] New `scripts/db_ingest.mjs` — idempotent REST upload of scraped matches.json to Supabase (teams/players/matches/games/game_players, same conflict rules as ingest_matches.mjs). Tested on 2026-11-01 (idempotent re-run: 0 new games, no dupes).
- [x] `run_pipeline.sh` gains Stage 3 "Upload match data to Supabase DB" between scrape and summary.
- [x] Skill `.agents/skills/esports-match-tracker/SKILL.md` updated: new stage order + summary reads DB (abbreviations, spaced tags).
- [x] Verified full (template-mode) pipeline run end-to-end.

## Noisy-audio transcript fix + 2026-11-05 quarterfinal summary (2026-11-05) — DONE
- Video 8XINrtm-npU (GEN vs LYON QF g1 highlights, 呆梦demo): loud BGM → whisper small found no speech (zh and en, and center-channel filter destroyed speech too).
- Fix: `pip install demucs` in `yt-dlp/.venv`, `demucs --two-stems=vocals` on the mp3 → whisper small en on separated vocals → 209 usable lines. yt-dlp YouTube auto-subs were 429-throttled; demucs is the reliable path for music-heavy videos.
- Ran esports-match-tracker pipeline for 2026-11-05 (Knockout Stage): GEN 3-0 LYON scraped + ingested (match_id 47).
- Fixed two latent bugs in `scripts/supabase_load.mjs`: `join('')` concatenated-select bug (documented in skill; now `join(',')` with games embed on one line) + env loader now accepts `SUPABASE_SECRET_KEY` like the other scripts.
- Deliverable: `output/data/2026-11-05/GenGEsports_vs_LYON_g1.summary.md` (DB-grounded, 10 real champs/players); transcript at `output/8XINrtm-npU_demucs.srt`.
