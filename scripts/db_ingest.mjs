#!/usr/bin/env node
// Uploads a scraped matches.json into the Supabase DB (v2 schema), idempotent.
// Runs after scrape and BEFORE generate_summary (which then reads the DB).
//
// Env (or leagueProDB/.env): SUPABASE_URL, SUPABASE_SECRET_KEY (or SUPABASE_KEY).
//
// Usage: node scripts/db_ingest.mjs <YYYY-MM-DD> "<tournament>"
//   (reads output/data/<DATE>/matches.json; tournament name required, NOT hardcoded)
//
// Idempotency: 
//   teams   upsert on abbreviation (ignore duplicates; unknown region -> 'UNKNOWN')
//   players upsert on player_name
//   matches upsert on (team_a_id, team_b_id, match_date)
//   games   inserted only when (match_id, game_number) is new
//   game_players insert .. on conflict do nothing

import fs from 'fs';
import path from 'path';
import { supabaseRestClient } from './lib/supabase.mjs';
import { dateArg, ROOT } from './lib/util.mjs';

const date = dateArg(process.argv[2]);
const TOURNAMENT = process.argv[3];
if (!TOURNAMENT) {
  console.error('usage: node scripts/db_ingest.mjs <YYYY-MM-DD> "<tournament>"');
  process.exit(1);
}
const file = path.join(ROOT, `output/data/${date}/matches.json`);
if (!fs.existsSync(file)) {
  console.error(`[DB-Ingest] Cannot find ${file}`);
  process.exit(1);
}
const matches = JSON.parse(fs.readFileSync(file, 'utf-8'));
if (!Array.isArray(matches) || matches.length === 0) {
  console.error(`[DB-Ingest] ${file} has no matches.`);
  process.exit(1);
}

const db = supabaseRestClient();
if (!db) {
  console.error('[DB-Ingest] SUPABASE_URL / SUPABASE_SECRET_KEY not set (env or leagueProDB/.env).');
  process.exit(1);
}
const rest = db.rest;

const ROLES = { Top: 'TOP', Jungle: 'JUNGLE', Mid: 'MID', ADC: 'ADC', Bot: 'ADC', Support: 'SUPPORT' };
const q = (s) => `"${encodeURIComponent(s)}"`;



async function main() {
  // 1. Teams: ingest full names only. The teams table is the source of truth —
  // its `abbreviation` column maps a full name to a short tag when needed.
  // Unknown teams are inserted with abbreviation = full name (can be edited in
  // the table later); team ids are then resolved by full name.
  const teamNames = [...new Set(matches.flatMap((m) => [m.teamA, m.teamB, m.winner]))].filter(Boolean);
  const teams = await rest('GET', `teams?select=team_id,name`);
  const known = new Map(teams.map((t) => [t.name, t.team_id]));
  const missing = teamNames.filter((t) => !known.has(t));
  if (missing.length) {
    const inserted = await rest('POST', 'teams?on_conflict=abbreviation',
      missing.map((t) => ({ name: t, abbreviation: t, region: 'UNKNOWN' })),
      'resolution=ignore-duplicates,return=representation');
    for (const t of inserted) known.set(t.name, t.team_id);
  }
  const teamId = Object.fromEntries(known);

  // 2. Players
  const playerNames = [...new Set(
    matches.flatMap((m) => (m.games || []).flatMap((g) =>
      [...(g.teamA?.players || []), ...(g.teamB?.players || [])].map((p) => p.name).filter(Boolean)))
  )];
  if (playerNames.length) {
    await rest('POST', 'players?on_conflict=player_name',
      playerNames.map((n) => ({ player_name: n })),
      'resolution=ignore-duplicates');
  }

  for (const m of matches) {
    if (teamId[m.teamA] == null || teamId[m.teamB] == null) {
      throw new Error(`Unknown team: ${m.teamA} / ${m.teamB}`);
    }
  }

  // 3. Matches (upsert on (team_a_id, team_b_id, match_date))
  const matchRows = matches.map((m) => ({
    team_a_id: teamId[m.teamA], team_b_id: teamId[m.teamB], winner_team_id: teamId[m.winner],
    tournament: TOURNAMENT, round: m.round, best_of: m.bestOf || 1,
    score_a: parseInt(m.scoreA, 10) || 0, score_b: parseInt(m.scoreB, 10) || 0,
    duration: m.duration || null, patch: null, match_date: m.date || date,
  }));
  await rest('POST', `matches?on_conflict=team_a_id,team_b_id,match_date`, matchRows,
    'resolution=ignore-duplicates');

  // 4. Existing games for these matches (to skip already-inserted games)
  const dbMatches = await rest('GET',
    `matches?select=match_id,round,match_date,team_a_id,team_b_id&match_date=eq.${q(date)}`);
  const findMatch = (m) => dbMatches.find((d) =>
    d.team_a_id === teamId[m.teamA] && d.team_b_id === teamId[m.teamB] && d.round === m.round);
  const matchIds = matches.map(findMatch).filter(Boolean).map((d) => d.match_id);
  const existingGames = matchIds.length
    ? await rest('GET', `games?select=game_id,match_id,game_number&match_id=in.(${matchIds.join(',')})`)
    : [];

  // 5. Games + game_players
  let gamesInserted = 0;
  let gpInserted = 0;
  for (const m of matches) {
    const dm = findMatch(m);
    if (!dm) throw new Error(`Match not found in DB after upsert: ${m.teamA} vs ${m.teamB} (${m.round})`);
    for (const g of m.games || []) {
      const dur = g.duration || null;
      let gameId = existingGames.find((e) => e.match_id === dm.match_id && e.game_number === g.game)?.game_id;
      if (!gameId) {
        const [row] = await rest('POST', 'games', [{
          match_id: dm.match_id, game_number: g.game, duration: dur,
          winner_team_id: teamId[g.winner] ?? null, screenshot: g.screenshot ?? null,
        }], 'return=representation');
        gameId = row.game_id;
        gamesInserted++;
      }
      const roster = [
        ...(g.teamA?.players || []).map((p) => ({ p, side: m.teamA })),
        ...(g.teamB?.players || []).map((p) => ({ p, side: m.teamB })),
      ].filter((x) => x.p.name);
      const gpRows = roster.map(({ p, side }) => ({
        game_id: gameId,
        player_id: undefined, // resolved below via players lookup
        team_id: teamId[side],
        role: ROLES[p.role] || p.role,
        champion: p.champion,
        __name: p.name,
      }));
      if (gpRows.length) {
        // resolve player ids in one query
        const names = [...new Set(gpRows.map((r) => r.__name))];
        const players = await rest('GET', `players?select=player_id,player_name&player_name=in.(${names.map(q).join(',')})`);
        const pid = Object.fromEntries(players.map((p) => [p.player_name, p.player_id]));
        for (const r of gpRows) {
          if (pid[r.__name] == null) throw new Error(`Unknown player: ${r.__name}`);
        }
        await rest('POST', 'game_players',
          gpRows.map(({ __name, player_id, ...row }) => ({ ...row, player_id: pid[__name] })),
          'resolution=ignore-duplicates');
        gpInserted += gpRows.length;
      }
    }
  }

  console.log(`[DB-Ingest] ${date}: ${matches.length} matches verified, ${gamesInserted} new games, ${gpInserted} game_player rows processed.`);
}

main().catch((err) => {
  console.error(`[DB-Ingest] FAILED: ${err.message}`);
  process.exit(1);
});
