---
name: lol-pro-video-transcript
description: >
  League-of-Legends PRO MATCH videos only — download the audio (mp3) of a FULL
  pro-match VOD or stream (full English caster commentary, not 5-10 min clips)
  with the vendored yt-dlp, transcribe with the local Whisper model, then store
  the transcript + time-window chunks with pgvector embeddings in Supabase
  (transcripts + transcript_chunks tables). Not for general YouTube videos,
  podcasts, or non-LoL content.
allowed-tools: Bash(yt-dlp/.venv/bin/*) Bash(whisper) Bash(python3) Bash(node)
---

# LoL Pro Video Transcript (full VOD mp3 → Whisper → pgvector chunks)

**Scope: League of Legends professional match videos only** — full-length pro
tournament VODs/streams with caster commentary. NOT highlight/commentary clips
(5-15 min fan edits): the pipeline targets complete matches (30-50 min audio),
whose long transcripts feed the vector DB for semantic search.

Project-local toolchain lives in `yt-dlp/.venv/bin/` (do NOT reinstall):

```bash
YTDLP=yt-dlp/.venv/bin/yt-dlp
WHISPER=yt-dlp/.venv/bin/whisper      # openai-whisper, small model cached at ~/.cache/whisper/small.pt
```

## Workflow

### Step 1 — Download mp3 (fast)
```bash
$YTDLP -x --audio-format mp3 --audio-quality 0 -o "output/mp3/%(id)s.mp3" "<youtube-url>"
```
- Output name = video id (`<id>.mp3`); that id is the run's slug everywhere below.
- **All downloads (mp3, srt) live in `output/mp3/`** — never in `output/` root.
- If YouTube throttles/blocks: retry with `-N 4` or `--force-ipv4`.

### Step 2 — Transcribe FULL commentary in English (GPU fp32: ~0.7x realtime; CPU ~4x realtime)
```bash
$WHISPER output/mp3/<id>.mp3 --model small --language en --task transcribe \
  --device cuda --fp16 False --output_format srt --output_dir output/mp3/
```
- `--language en` (full English caster commentary; was `zh` for Chinese clips).
- A full VOD is 30-50 min → expect a **long SRT** (thousands of cues) and a
  30-60 min transcription run on GPU. For a Bo3 series VOD, transcribe once and
  split per game at the break points, or ask the user which game to embed.
- **Always `--fp16 False` on this machine**: the GTX 1650 Ti has no tensor cores
  and whisper fp16 emits NaNs on it. If CUDA is unavailable, drop
  `--device cuda --fp16 False` to run on CPU.

### Step 3 — Upload transcript + embed chunks into the DB (pgvector)

Saves the full transcript in `transcripts` (one row per **game**, no summary)
and time-window chunks with embeddings in `transcript_chunks` (pgvector,
`openai/text-embedding-3-small` via OpenRouter, 1536 dims).

First determine **which game the video covers** and confirm with the user
(ask_questions) if ambiguous. Then:

```bash
node scripts/db_transcript_embed.mjs output/mp3/<id>.srt \
  --teams TAGA,TAGB --date YYYY-MM-DD [--game N] [--window 45] [--dry-run]
```

- Run `--dry-run` first: prints chunk count/sizes and sample chunks, writes nothing.
- Chunks: consecutive SRT cues merged into ~45 s windows (`--window`), capped
  at 1200 chars; each chunk keeps `start_sec`/`end_sec` for video-time linking.
- Needs `SUPABASE_URL` + `SUPABASE_KEY` (service role) and `EMBEDDING_API_KEY`
  (or `OPENROUTER_API_KEY`) in env or `leagueProDB/.env`.
- Teams matched by `teams.abbreviation` (loosely, case-insensitive); Bo3/Bo5
  single-game uploads need `--game N` (script lists options otherwise).
- **Idempotent**: re-running replaces the same game's transcript and chunks.
- Success prints the `transcripts.transcript_id` + stored chunk count.

### Step 4 — Semantic search (optional)

```bash
node scripts/db_semantic_search.mjs "early dragon soul teamfight" \
  [--teams HLE,BLG] [--date YYYY-MM-DD] [--game N] [--limit 10] [--full]
```
- Cosine KNN over `transcript_chunks` via the `match_transcript_chunks` RPC,
  with optional team/date/game filters. `--full` prints whole chunk texts.

## Artifacts per video id
`output/mp3/<id>.mp3` → `output/mp3/<id>.srt` (long, full-match transcript)
→ `transcripts` row + `transcript_chunks` rows in the DB (main deliverable).
No summary is generated anymore.

## DB schema (see leagueProDB/DATABASE.md)
- `transcripts` (game_id UNIQUE, transcript text) — full raw transcript.
- `transcript_chunks` (game_id, chunk_index, content, start_sec, end_sec,
  embedding vector(1536)) — HNSW cosine index; RLS enabled, service role only.
