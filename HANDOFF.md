# Handoff notes — refactor + vector DB plan

Read this if you come back after a break. Covers: what the refactor changed, how to publish to GitHub, and the plan for adding vector (semantic) search on Supabase.

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

## 3. Next: vector database (pgvector on Supabase)

Goal: semantic search over game transcripts/summaries — e.g. "find games where casters discussed an early dragon soul fight" → matched game + transcript excerpts, usable for grounding summaries and future RAG.

### Design (fits the existing schema)

- Enable `vector` extension (Dashboard → Database → Extensions, or in the migration).
- New table `transcript_chunks`: one row per ~500-1000-char chunk of a transcript.
  - `chunk_id` bigint identity PK
  - `game_id` bigint NOT NULL FK → games (CASCADE)
  - `chunk_index` smallint NOT NULL — order within the transcript
  - `content` text NOT NULL — chunk text
  - `start_sec` / `end_sec` numeric NULL — timestamps from the SRT, so hits can be linked back to video moments
  - `embedding` vector(1536) NOT NULL — `text-embedding-3-small` (OpenAI, 1536 dims). Alternatives: 3072 (`text-embedding-3-large`) or a local model's dim — **pick before creating the index, dim is fixed**.
  - `summary_embedding` stays on `transcripts` (one vector per game) if game-level search is wanted: `alter table transcripts add column embedding vector(1536)`.
  - UNIQUE (game_id, chunk_index); index on FK `game_id`.
- Index: **HNSW** (`using hnsw (embedding vector_cosine_ops)`) — better recall/latency than IVFFlat at this scale and needs no training rows. Halfvec (pgvector 0.7+) could halve storage if needed later.
- RLS: enabled, no policies (pipeline uses service role — consistent with every other table).
- Embedding client: new `scripts/lib/embeddings.mjs` (OpenAI API via `EMBEDDING_API_KEY` / `OPENAI_API_KEY` in `leagueProDB/.env`), used by a `scripts/db_transcript_embed.mjs` that chunks SRTs and upserts chunks idempotently on (game_id, chunk_index).
- Query path: `scripts/db_semantic_search.mjs` — embed query, `select ... order by embedding <=> $query_vector limit k` joined to `games`/`matches` for team/date filters.

### Draft migration — `leagueProDB/supabase/migrations/20260217000000_transcript_vectors.sql`

```sql
create extension if not exists vector;

create table transcript_chunks (
  chunk_id    bigint generated always as identity primary key,
  game_id     bigint not null references games (game_id) on delete cascade,
  chunk_index smallint not null check (chunk_index >= 0),
  content     text not null,
  start_sec   numeric,
  end_sec     numeric,
  embedding   vector(1536) not null,
  unique (game_id, chunk_index)
);
create index transcript_chunks_game_id_idx on transcript_chunks (game_id);
create index transcript_chunks_embedding_idx
  on transcript_chunks using hnsw (embedding vector_cosine_ops);

alter table transcript_chunks enable row level security;

alter table transcripts add column embedding vector(1536);
create index transcripts_embedding_idx on transcripts using hnsw (embedding vector_cosine_ops);
```

### Steps when implementing
1. Read `leagueProDB/DATABASE.md` + load the `supabase` and `supabase-postgres-best-practices` skills (project rule for any Postgres work).
2. Apply the migration (Supabase MCP or `supabase db push`).
3. Write `scripts/lib/embeddings.mjs` + `scripts/db_transcript_embed.mjs`; backfill existing `transcripts` rows.
4. Write `scripts/db_semantic_search.mjs`; smoke-test with a Chinese query against a known game.
5. Update `DATABASE.md` (ERD + tables) and the `lol-pro-video-transcript` skill (new optional embed/search step after Step 4).

Open decisions before writing code: embedding model/dim (OpenAI vs local), chunk size (500-1000 chars ≈ safe default for Mandarin transcripts), whether to chunk the `summary` too, and whether search results should filter by team/date metadata in SQL (recommended) or purely by cosine.
