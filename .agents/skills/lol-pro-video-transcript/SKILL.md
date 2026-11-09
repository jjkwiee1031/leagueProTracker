---
name: lol-pro-video-transcript
description: >
  League-of-Legends PRO MATCH video transcripts only — download the audio (mp3)
  of a YouTube video about LoL professional match content (pro tournament
  VODs/streams, caster commentary, pro analysis videos) with the vendored
  yt-dlp, transcribe with the local Whisper model, then write a Markdown how-
  the-match-went summary via an inline pi child process, grounded in the
  project's match data and champion-name table (output/champions.json). Not
  for general YouTube videos, podcasts, or non-LoL content.
allowed-tools: Bash(yt-dlp/.venv/bin/*) Bash(whisper) Bash(python3) Bash(node)
---

# LoL Pro Video Transcript (mp3 → Whisper → match summary)

**Scope: League of Legends professional match videos only** — pro tournament
VODs/streams, caster commentary or analysis of pro games. General YouTube
videos, music, vlogs, and non-LoL content are out of scope. Highlight/commentary
clips (5-15 min fan edits) are valid input.

Project-local toolchain lives in `yt-dlp/.venv/bin/` (do NOT reinstall):

```bash
YTDLP=yt-dlp/.venv/bin/yt-dlp
WHISPER=yt-dlp/.venv/bin/whisper      # openai-whisper, small model cached at ~/.cache/whisper/small.pt
```

## Workflow (proven on run 2026-11-01, video AyazGF9P3gA)

### Step 1 — Download mp3 (fast)
```bash
$YTDLP -x --audio-format mp3 --audio-quality 0 -o "output/mp3/%(id)s.mp3" "<youtube-url>"
```
- Output name = video id (`<id>.mp3`); that id is the run's slug everywhere below.
- **All downloads (mp3, srt, demucs srt) live in `output/mp3/`** — never in `output/` root.
- If YouTube throttles/blocks: retry with `-N 4` or `--force-ipv4`.

### Step 2 — Transcribe (GPU fp32: ~0.7x realtime; falls back to CPU ~4x realtime)
```bash
$WHISPER output/mp3/<id>.mp3 --model small --language zh --task transcribe \
  --device cuda --fp16 False --output_format srt --output_dir output/mp3/
```
- **Always `--fp16 False` on this machine**: the GTX 1650 Ti has no tensor cores and whisper fp16 emits NaNs on it 
- If CUDA is unavailable (`torch.cuda.is_available()` false), drop `--device cuda --fp16 False` to run on CPU.

### Step 3 — Summarize how the match went

First determine **which matchup/game the video covers**: use what the user tells you, or infer from the
transcript (run `--dry-run` first — the auto-detected match/game prints). If it can't be pinned down,
**ask the user** (use ask_questions: list the day's matches from `matches.json`) before proceeding.

```bash
node scripts/summarize_video_transcript.mjs output/mp3/<id>.srt --game TAGA_vs_TAGB[_gN] \
  [--matches output/data/<DATE>/matches.json] [--db] [--date YYYY-MM-DD] [--dry-run]
```
- `--db`: ground in the Supabase DB instead of matches.json — real player names/roles per game
  (decodes caster nicknames like "江哥"→Rookie) and exact per-game champion lists (EN in DB,
  mapped to CN via `output/champions.json`). Needs `SUPABASE_URL` + `SUPABASE_KEY`
  (service role) in env or `leagueProDB/.env`. Missing match/keys → falls back to matches.json.
- `--game` (recommended): e.g. `HLE_vs_BLG` or `HLE_vs_BLG_g2`. Team tags matched loosely
  (case-insensitive); `_gN` forces the exact game (10 champs in the prompt); without it the best-hit
  game is chosen. Unknown tag → script exits listing available matchups.
- Output: `output/data/<DATE>/<TAGA>_vs_<TAGB>[_gN].summary.md` (DATE taken from the match data;
  `--out` overrides). With `--dry-run` it prints to stdout instead.
- The LLM decodes ASR homophones, calibrates teams/result with match data, and writes
  一句话结果 / 阵容与 BP / 比赛进程 / 胜负关键.
- Guardrails: no invented stats; casters' opinions marked "据该视频解说观点".

### Step 4 — Upload transcript to the DB (transcripts table)

After the summary is written, **ask the user** (use ask_questions) whether to upload the
transcript to the `transcripts` table in Supabase (one row per **game**:
`game_id`, `transcript`, `summary`). If yes, resolve the game by matchup + date and upsert:

```bash
node scripts/db_transcript_upload.mjs output/mp3/<id>.srt \
  --teams TAGA,TAGB --date YYYY-MM-DD [--game N] \
  [--summary output/data/<DATE>/<TAGA>_vs_<TAGB>[_gN].summary.md]
```

- Teams matched by `teams.abbreviation` (loosely, case-insensitive); date narrows the day.
- Bo1 match: game resolved automatically; Bo3/Bo5: `--game N` required (script lists options).
- Ambiguous/missing match → script exits with candidates; fix tokens/date and retry.
- Upserts on `game_id` (UNIQUE) — re-running overwrites the same game's transcript/summary.
- Success prints `transcripts.transcript_id=<n> (game_id=<n>, TAGA vs TAGB <date>)`.

## Artifacts per video id
`output/mp3/<id>.mp3` → `output/mp3/<id>.srt` → `output/data/<DATE>/<TAGA>_vs_<TAGB>[_gN].summary.md` (main deliverable)
→ optionally a row in the DB `transcripts` table (Step 4).
Never touch `output/data/<DATE>/summary.*` from this skill.
