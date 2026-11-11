// Uploads a video transcript to the leagueProDB `transcripts` table,
// resolved by matchup (team abbreviations) + date + game number.
// Usage:
//   node scripts/db_transcript_upload.mjs output/mp3/<id>.srt --teams HLE,BLG \
//     --date 2026-11-08 [--game 2]
// Env: SUPABASE_URL + SUPABASE_KEY/SUPABASE_SECRET_KEY (leagueProDB/.env works).
import fs from 'fs';
import path from 'path';
import { supabaseRestClient } from './lib/supabase.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const MATCH_SELECT = [
  'match_id,match_date,round',
  'team_a:teams!matches_team_a_id_fkey(abbreviation,name)',
  'team_b:teams!matches_team_b_id_fkey(abbreviation,name)',
  'games!games_match_id_fkey(game_id,game_number)',
].join(',');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--teams') args.teams = argv[++i].split(',').map((t) => t.trim().toUpperCase());
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--game') args.game = Number(argv[++i]);
    else args._.push(a);
  }
  return args;
}

export async function uploadTranscriptToDb({ transcript, tokens = [], date, game = null } = {}) {
  const db = supabaseRestClient();
  if (!db) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_KEY (leagueProDB/.env or env)');
  }
  const { rest } = db;

  // 1. find the match by date + team abbreviations
  let q = `matches?select=${encodeURIComponent(MATCH_SELECT)}&order=match_date.desc&limit=200`;
  if (date) q += `&match_date=eq.${date}`;
  let matches = await rest('GET', q);
  if (tokens.length) {
    matches = matches.filter((m) => {
      const a = (m.team_a?.abbreviation || '').toUpperCase();
      const b = (m.team_b?.abbreviation || '').toUpperCase();
      return tokens.some((t) => t === a || t === b);
    });
  }
  if (!matches.length) {
    throw new Error(`No match found for tokens=${tokens.join('/')} date=${date || 'any'}. Check abbreviations/date.`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous: ${matches.length} matches. Candidates:\n` +
      matches.map((m) => `- ${m.match_date} ${m.team_a?.abbreviation} vs ${m.team_b?.abbreviation}`).join('\n') +
      `\nNarrow with --date or exact team tags.`);
  }
  const match = matches[0];

  // 2. resolve game_id
  const games = match.games || [];
  let gameId;
  if (game != null) {
    const g = games.find((g) => g.game_number === game);
    if (!g) {
      throw new Error(`Game ${game} not found for match ${match.match_id} (available: ${games.map((g) => g.game_number).join(',')})`);
    }
    gameId = g.game_id;
  } else if (games.length === 1) {
    gameId = games[0].game_id;
  } else {
    const bo = match.round?.match(/Bo(\d)/)?.[1] || '';
    throw new Error(`Bo${bo} match has ${games.length} games — pass --game N (${games.map((g) => g.game_number).join(',')}).`);
  }

  // 3. upsert transcript (one row per game via unique game_id)
  const [row] = await rest('POST', 'transcripts?on_conflict=game_id',
    { game_id: gameId, transcript },
    'resolution=merge-duplicates,return=representation');
  return {
    matchId: match.match_id,
    gameId,
    matchup: `${match.team_a?.abbreviation} vs ${match.team_b?.abbreviation}`,
    date: match.match_date,
    transcriptId: row?.transcript_id,
  };
}

// CLI entry
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = parseArgs(process.argv.slice(2));
  const [srtPath] = args._;
  if (!srtPath || !args.teams) {
    console.error('Usage: node scripts/db_transcript_upload.mjs <srt> --teams HLE,BLG --date YYYY-MM-DD [--game N]');
    process.exit(1);
  }
  const transcript = fs.readFileSync(srtPath, 'utf-8');
  const res = await uploadTranscriptToDb({
    transcript, tokens: args.teams, date: args.date, game: args.game ?? null,
  });
  console.log(`Uploaded → transcripts.transcript_id=${res.transcriptId} (game_id=${res.gameId}, ${res.matchup} ${res.date})`);
}
