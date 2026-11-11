-- pgvector semantic search over transcript chunks (full-match English commentary)
-- Model: openai/text-embedding-3-small via OpenRouter → fixed 1536 dims.
-- NOTE: on Supabase the extension lives in the `extensions` schema.

create extension if not exists vector with schema extensions;

-- One row per ~30-60s chunk of a transcript (SRT cues merged by time window).
create table transcript_chunks (
  chunk_id    bigint generated always as identity primary key,
  game_id     bigint not null references games (game_id) on delete cascade,
  chunk_index smallint not null check (chunk_index >= 0),
  content     text not null,
  start_sec   numeric,
  end_sec     numeric,
  embedding   extensions.vector(1536) not null,
  unique (game_id, chunk_index)
);

create index transcript_chunks_game_id_idx on transcript_chunks (game_id);
create index transcript_chunks_embedding_idx
  on transcript_chunks using hnsw (embedding extensions.vector_cosine_ops);

alter table transcript_chunks enable row level security;

-- Search RPC: cosine KNN over chunks with optional team/date/game filters.
-- Called by scripts/db_semantic_search.mjs via PostgREST.
create or replace function match_transcript_chunks(
  query_embedding extensions.vector(1536),
  match_teams text[] default null,
  match_date date default null,
  game_number smallint default null,
  match_count int default 10
)
returns table (
  chunk_id bigint,
  game_id bigint,
  chunk_index smallint,
  content text,
  start_sec numeric,
  end_sec numeric,
  distance double precision
)
language sql stable
security invoker
set search_path = public, extensions
as $$
  select tc.chunk_id, tc.game_id, tc.chunk_index, tc.content,
         tc.start_sec, tc.end_sec,
         tc.embedding <=> query_embedding as distance
  from transcript_chunks tc
  join games g using (game_id)
  join matches m on m.match_id = g.match_id
  join teams ta on ta.team_id = m.team_a_id
  join teams tb on tb.team_id = m.team_b_id
  where (match_date is null or m.match_date = match_date)
    and (game_number is null or g.game_number = game_number)
    and (match_teams is null
         or upper(ta.abbreviation) = any(match_teams)
         or upper(tb.abbreviation) = any(match_teams))
  order by tc.embedding <=> query_embedding
  limit greatest(1, least(match_count, 100));
$$;

-- Summary generation removed from the pipeline; column no longer populated.
alter table transcripts drop column if exists summary;
