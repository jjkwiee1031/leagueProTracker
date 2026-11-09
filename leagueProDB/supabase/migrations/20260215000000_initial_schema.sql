-- League of Legends match transcription project — initial schema
-- Target: Supabase Postgres (public schema)
-- v2 (2026-11): matches the rewritten Liquipedia scraper — per-game detail,
-- scores/winner/best-of/round/duration on the match, rosters per game with
-- champions. Duration columns are nullable on purpose: Liquipedia publishes
-- per-game breakdowns late; the pipeline never invents one.

create table teams (
  team_id      bigint generated always as identity primary key,
  name         text not null unique,
  abbreviation text not null unique,
  region       text not null
);

create table players (
  player_id   bigint generated always as identity primary key,
  player_name text not null unique
);

create table matches (
  match_id      bigint generated always as identity primary key,
  team_a_id     bigint not null references teams (team_id) on delete restrict,
  team_b_id     bigint not null references teams (team_id) on delete restrict,
  winner_team_id bigint references teams (team_id) on delete restrict,
  tournament    text not null,
  round         text not null,          -- "Round 4 High Matches (Bo3)" / "Knockout Stage"
  best_of       smallint not null default 1 check (best_of in (1, 3, 5)),
  score_a       smallint not null default 0 check (score_a >= 0),
  score_b       smallint not null default 0 check (score_b >= 0),
  duration      interval,               -- series total; null when unpublished
  patch         text,                   -- not exposed by the scraper; nullable
  match_date    date not null,
  constraint matches_different_teams check (team_a_id <> team_b_id),
  constraint matches_winner_is_participant check (winner_team_id in (team_a_id, team_b_id)),
  constraint matches_unique_per_day unique (team_a_id, team_b_id, match_date)
);

create table games (
  game_id        bigint generated always as identity primary key,
  match_id       bigint not null references matches (match_id) on delete cascade,
  game_number    smallint not null check (game_number between 1 and 5),
  duration       interval,              -- null when Liquipedia hasn't published it
  winner_team_id bigint references teams (team_id) on delete restrict,
  screenshot     text,                  -- public asset path (remotion staticFile)
  constraint games_unique_number unique (match_id, game_number)
);

create table game_players (
  game_id   bigint not null references games (game_id) on delete cascade,
  player_id bigint not null references players (player_id) on delete restrict,
  team_id   bigint not null references teams (team_id) on delete restrict,
  role      text not null check (role in ('TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT')),
  champion  text not null,
  primary key (game_id, player_id)
);
-- team_id ∈ {match.team_a_id, match.team_b_id} is enforced by a trigger (CHECK
-- constraints cannot reference other tables): invalid side inserts abort.

create table transcripts (
  transcript_id          bigint generated always as identity primary key,
  match_id               bigint not null references matches (match_id) on delete cascade,
  language               text not null,
  original_transcription text not null,
  refined_transcription  text,
  constraint transcripts_one_per_language unique (match_id, language)
);

-- Query patterns: per-game roster lookup, team rosters, match listing
create index idx_games_match on games (match_id);
create index idx_games_winner on games (winner_team_id);
create index idx_game_players_team on game_players (team_id);
create index idx_game_players_player on game_players (player_id);
create index idx_matches_team_a on matches (team_a_id);
create index idx_matches_team_b on matches (team_b_id);
create index idx_matches_winner on matches (winner_team_id);
create index idx_matches_date on matches (match_date);
create index idx_transcripts_match on transcripts (match_id);

-- Integrity trigger: game_players.team_id must be one of the match's two teams.
create function check_game_player_team() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from games g
    join matches m on m.match_id = g.match_id
    where g.game_id = new.game_id and new.team_id in (m.team_a_id, m.team_b_id)
  ) then
    raise exception 'team_id % is not a participant of the match owning game %', new.team_id, new.game_id;
  end if;
  return new;
end;
$$;
create trigger trg_game_player_team
before insert or update of team_id, game_id on game_players
for each row execute function check_game_player_team();

-- Supabase: lock down — tables are pipeline-internal; no Data API exposure
alter table teams         enable row level security;
alter table players       enable row level security;
alter table matches       enable row level security;
alter table games         enable row level security;
alter table game_players  enable row level security;
alter table transcripts   enable row level security;
