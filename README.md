# leagueProTracker

LoL pro-match tracking toolkit, three pipelines:

1. **Worlds daily report video** — scrape a day's Liquipedia matches → upload to
   Supabase → LLM Mandarin narration → edge-tts → Remotion vertical video.
   Entry: `scripts/run_pipeline.sh <YYYY-MM-DD> "<tournament>"`.
   See `.agents/skills/esports-match-tracker/SKILL.md` for the full workflow +
   invariants (narration↔subtitle contract, duration rules, DB idempotency).
2. **Pro match video transcripts** — YouTube LoL pro-match video → mp3 → local
   Whisper → grounded Chinese summary (match data + champion table) → optional
   `transcripts` DB row. See `.agents/skills/lol-pro-video-transcript/SKILL.md`.
3. **Match database** — Supabase schema + docs in `leagueProDB/` (read
   `leagueProDB/DATABASE.md` before any Postgres work).

## Layout

| Path | What |
|---|---|
| `scripts/` | pipeline scripts (scrape, db ingest/lookup/upload, summary, TTS, VTT) |
| `scripts/lib/` | shared helpers: Supabase env+REST, pi-headless LLM call, utils |
| `remotion/` | Remotion video project (own git repo; `npm run dev`/`build`/`lint` from `remotion/`) |
| `.agents/skills/` | agent skills driving the workflows above |
| `leagueProDB/` | Supabase schema, migrations, DB docs |
| `yt-dlp/` | vendored yt-dlp + Whisper venv (not committed — 6.8 GB) |

## Setup

- Node 20+, `npm install` at root and in `remotion/`.
- Supabase creds in `leagueProDB/.env`: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`.
- TTS: `edge-tts` on PATH; media probing: `ffprobe`/`python3`.
- Playwright: persistent profile in `.playwright-profile/` (gitignored); if
  Cloudflare challenges headless runs, re-run `scripts/scrape.mjs --headed`.

All colors live in `remotion/src/theme.ts`. Render outputs land in `output/`
(gitignored); `remotion/public/worlds/` always holds the latest run's inputs.
