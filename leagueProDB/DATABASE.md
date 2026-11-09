# leagueProDB — Database Design

Supabase Postgres (`public` schema). Purpose: store LoL pro matches + transcripts so the AI pipeline can retrieve exact player names/teams/roles per match, correct transcriptions, and generate summaries.

## ERD
```
teams ──1:N── matches ──1:N── games ──1:N── game_players ──N:1── players
  │              │             │ 2N
  │              └─────────────┴── (team_id refs)
  └── transcripts (via matches)
```

## Tables

### teams
| col | type | notes |
|---|---|---|
| team_id | bigint identity | PK |
| name | text | NOT NULL UNIQUE |
| abbreviation | text | NOT NULL UNIQUE |
| region | text | NOT NULL |

### players
| col | type | notes |
|---|---|---|
| player_id | bigint identity | PK |
| player_name | text | NOT NULL UNIQUE |

### matches
| col | type | notes |
|---|---|---|
| match_id | bigint identity | PK |
| team_a_id | bigint | FK → teams, CHECK ≠ team_b_id |
| team_b_id | bigint | FK → teams |
| winner_team_id | bigint | FK → teams, CHECK ∈ {team_a, team_b} |
| tournament | text | NOT NULL |
| round | text | NOT NULL — "Round 4 High Matches (Bo3)" / "Knockout Stage" |
| best_of | smallint | NOT NULL, CHECK ∈ (1, 3, 5) |
| score_a / score_b | smallint | NOT NULL, ≥ 0 |
| duration | interval | **nullable** — series total; NULL when Liquipedia hasn't published the breakdown (never invented) |
| patch | text | **nullable** — not exposed by the scraper |
| match_date | date | NOT NULL |

UNIQUE (team_a_id, team_b_id, match_date) — no duplicate pair per day.

### games — one row per played game
| col | type | notes |
|---|---|---|
| game_id | bigint identity | PK |
| match_id | bigint | FK → matches (CASCADE) |
| game_number | smallint | 1..5; UNIQUE per match |
| duration | interval | **nullable** — per-game length when published |
| winner_team_id | bigint | FK → teams, nullable |
| screenshot | text | public asset path (Remotion `staticFile()`), nullable |

### game_players — junction table, rosters per **game** (replaces per-match `match_players`)
| col | type | notes |
|---|---|---|
| game_id | bigint | FK → games (CASCADE), part of PK |
| player_id | bigint | FK → players, part of PK |
| team_id | bigint | FK → teams — must be one of the owning match's two teams (enforced by trigger `trg_game_player_team`) |
| role | text | CHECK ∈ TOP, JUNGLE, MID, ADC, SUPPORT — derived from Liquipedia's fixed slot order |
| champion | text | NOT NULL — champion used in that game |

PK (game_id, player_id). A player may change teams/roles/champions between games and matches.

### transcripts — one row per **game**
| col | type | notes |
|---|---|---|
| transcript_id | bigint identity | PK |
| game_id | bigint | FK → games (CASCADE) |
| transcript | text | NOT NULL — raw output of transcription |
| summary | text | nullable — AI-generated game summary |

UNIQUE (game_id) — one transcript per game.

## Canonical query (AI pipeline)
```sql
select p.player_name, t.name, t.abbreviation, gp.role, gp.champion
from game_players gp
join games g using (game_id)
join players p using (player_id)
join teams t using (team_id)
where g.match_id = :match_id
order by g.game_number,
         array_position(array['TOP','JUNGLE','MID','ADC','SUPPORT'], gp.role);
```

## Rules
- RLS enabled on all tables, no policies (pipeline uses service role / direct SQL; not exposed to anon).
- All deletes: `restrict` except matches cascade → games, games cascade → game_players + transcripts.
- Indexes on all FK columns + `matches.match_date`.
- Migration: `supabase/migrations/20260215000000_initial_schema.sql` + `20260216000000_transcripts_per_game.sql` (transcripts moved from match-level to game-level; `summary` added).
- Scraped data maps 1:1: match-level `round/bestOf/scoreA/scoreB/winner/duration` → `matches`; `games[]` → `games`; per-game `players[{role,name,champion}]` → `game_players`.
