-- Transcripts link to each game (was per-match); add summary column

drop index if exists idx_transcripts_match;

alter table transcripts
  drop constraint transcripts_one_per_language,
  drop column match_id,
  drop column language,
  drop column refined_transcription;

alter table transcripts rename column original_transcription to transcript;

alter table transcripts
  add column game_id bigint not null,
  add column summary  text;

alter table transcripts
  add constraint transcripts_game_id_fkey
    foreign key (game_id) references games (game_id) on delete cascade;

-- one transcript per game
alter table transcripts
  add constraint transcripts_one_per_game unique (game_id);

create index idx_transcripts_game on transcripts (game_id);
