# Handoff notes — refactor + vector DB (English full-VOD transcripts)

Read this if you come back after a break. Covers: what the refactor changed, how to publish to GitHub, and the vector-search pipeline for full-match English commentary transcripts.

## 1. What the refactor changed (commit `1d97b13`)

All pipeline scripts were refactored onto shared modules in `scripts/lib/`. Behavior preserved — verified live (DB load, template summary, transcript summarizer end-to-end, asset guard).

| Module | Replaces |
|---|---|
| `scripts/lib/env.mjs` | 4 duplicated `leagueProDB/.env` parsers |
| `scripts/lib/supabase.mjs` | 3 duplicated PostgREST `fetch` wrappers |
| `scripts/lib/llm.mjs` | 2 duplicated `pi --print` headless callers + JSON extractor |
| `scripts/lib/util.mjs` | scattered duration/filename/flag helpers; `ROOT` = repo root |

Per script: `db_ingest`, `db_match_lookup`, `db_transcript_upload`, `generate_summary` now use the lib; `summarize_video_transcript` restructured from a flat script into named functions (parse args → read cues → ground in DB/matches.json → narrow champions → build prompt → LLM retries → output); `scrape.mjs` lost dead code (`capturePopupShots` was never called).

Env vars unchanged: `SUMMARY_LLM_CMD/SUMMARY_MODEL/SUMMARY_LLM_ATTEMPTS/SUMMARY_LLM_TIMEOUT_MS`, `REFINE_LLM_*` (same names, same meaning). Scripts now work from any cwd.

Removed stale references in `.agents/skills/esports-match-tracker/SKILL.md` (`leagueProDB/ingest_matches.mjs`, `scripts/supabase_load.mjs` no longer exist).

## 2. Publishing to GitHub

```bash
git remote add origin git@github.com:<you>/leagueProTracker.git
git push -u origin main   # branch is master/main per git default; check `git branch`
```

Already excluded (`.gitignore`) — do NOT force-add these:
- `leagueProDB/.env`, `auth.json` — **secrets**
- `output/`, `remotion/public/worlds/` — run artifacts
- `.playwright-profile/`, `.playwright*` — browser session cookies
- `yt-dlp/` — 6.8 GB vendored toolchain (yt-dlp source + Whisper venv)
- `remotion/` — has its **own git history**. Either publish it as a second repo, or convert to a submodule: `git rm -r --cached . 2>/dev/null; git submodule add <remotion-repo-url> remotion`

## 3. Vector DB (pgvector on Supabase) — implemented for English full-VOD transcripts

Pipeline changed (2026-02-17): skill `lol-pro-video-transcript` now targets FULL pro-match VODs with English commentary (not 10-min Chinese clips). No summaries are generated anymore (`scripts/summarize_video_transcript.mjs` deleted; `generate_summary.mjs` kept for the Worlds-report pipeline).

### What exists
- Migration `leagueProDB/supabase/migrations/20260217000000_transcript_vectors.sql`:
  - `vector` extension; table `transcript_chunks` (game_id FK, chunk_index, content, start_sec/end_sec, embedding vector(1536), UNIQUE(game_id, chunk_index)); HNSW cosine index; RLS on, no policies.
  - RPC `match_transcript_chunks(query_embedding, match_teams, match_date, game_number, match_count)` — cosine `<=>` KNN with optional team/date/game filters.
  - `transcripts.summary` dropped.
- `scripts/lib/embeddings.mjs` — OpenRouter embeddings client (model `openai/text-embedding-3-small`, 1536 dims), env `EMBEDDING_API_KEY`/`OPENROUTER_API_KEY` (leagueProDB/.env works).
- `scripts/db_transcript_embed.mjs` — SRT → ~45 s time-window chunks (≤1200 chars, timestamps preserved) → transcripts upsert + chunks replace per game. `--dry-run` to preview. Idempotent.
- `scripts/db_transcript_upload.mjs` — summary support removed; uploads full transcript only.
- `scripts/db_semantic_search.mjs` — embed query → RPC → print matches with video timestamps. `--teams/--date/--game/--limit/--full`.
- 2026-11-10 audit fixes: removed unused `CHUNK_SELECT` in `db_semantic_search.mjs`; `storeChunks` in `db_transcript_embed.mjs` now embeds all batches **before** deleting old chunks (a mid-batch API failure can no longer leave a game half-stored).

### Remaining steps
- DONE (2026-11-10): migration applied via MCP (name `transcript_vectors`); `service_role` granted DML on `transcript_chunks` + execute on the RPC (new tables don't auto-grant). First ingest: `Mc5forNfXDQ.srt` → game_id=65 (BLG vs T1 2026-11-09 g1), 50 chunks; `db_semantic_search.mjs` smoke-tested OK. Note: migration uses `extensions.vector` + `set search_path = public, extensions` (Supabase keeps pgvector in `extensions`).
1. ~~Apply the migration~~ ✅
2. ~~Add EMBEDDING_API_KEY~~ ✅ (in `leagueProDB/.env`)
3. Backfill other local SRTs when needed.