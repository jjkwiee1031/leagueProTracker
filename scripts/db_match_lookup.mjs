// Loads one match (+ per-game rosters) from the Supabase DB for transcript
// grounding. Teams are matched by `teams.abbreviation` (source of truth).
// Usage: const db = await loadMatchFromDb({ tokens: ['GEN','IG'], date: '2026-11-08' });
import { supabaseRestClient } from './lib/supabase.mjs';

const ROLE_ORDER = { Top: 0, Jungle: 1, Mid: 2, Bot: 3, Support: 4 };

const MATCH_SELECT = [
  'match_id', 'round', 'best_of', 'duration', 'match_date', 'winner_team_id',
  'team_a:teams!matches_team_a_id_fkey(team_id,name,abbreviation)',
  'team_b:teams!matches_team_b_id_fkey(team_id,name,abbreviation)',
  'games!games_match_id_fkey(game_number,duration,winner_team_id,game_players(role,champion,team_id,players(player_name)))',
].join(',');

export async function loadMatchFromDb({ tokens = [], date } = {}) {
  const db = supabaseRestClient();
  if (!db) return null;
  const { rest } = db;

  let q = `matches?select=${encodeURIComponent(MATCH_SELECT)}&order=match_id.asc`;
  if (date) q += `&match_date=eq.${date}`;
  let rows = await rest('GET', q);

  if (tokens.length) {
    const upper = tokens.map((t) => t.toUpperCase());
    rows = rows.filter((m) =>
      upper.includes((m.team_a?.abbreviation || '').toUpperCase()) ||
      upper.includes((m.team_b?.abbreviation || '').toUpperCase()));
  }
  if (!rows.length) return null;
  const m = rows[0];

  const roster = (gp, teamId) =>
    (gp || []).filter((g) => g.team_id === teamId)
      .map((g) => ({ role: g.role, name: g.players?.player_name || '', champion: g.champion }))
      .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));

  const winnerAbbr = (teamId) =>
    teamId === m.team_a?.team_id ? m.team_a?.abbreviation
      : teamId === m.team_b?.team_id ? m.team_b?.abbreviation
      : null;

  const games = (m.games || [])
    .sort((a, b) => a.game_number - b.game_number)
    .map((g) => ({
      game: g.game_number,
      duration: g.duration || null,
      winner: winnerAbbr(g.winner_team_id),
      teamA: { players: roster(g.game_players, m.team_a?.team_id) },
      teamB: { players: roster(g.game_players, m.team_b?.team_id) },
    }));

  return {
    match: {
      date: m.match_date,
      round: m.round,
      bestOf: m.best_of,
      teamA: m.team_a?.abbreviation || m.team_a?.name || '',
      teamB: m.team_b?.abbreviation || m.team_b?.name || '',
      winner: winnerAbbr(m.winner_team_id),
      duration: m.duration || null,
    },
    games,
  };
}
