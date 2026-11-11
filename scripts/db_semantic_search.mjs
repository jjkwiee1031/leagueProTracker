// Semantic search over transcript_chunks (pgvector). Embeds the query with the
// same model used at ingest, then finds the nearest chunks (cosine distance),
// joined to games/matches/teams for context. Supports team/date filters.
//
// Usage:
//   node scripts/db_semantic_search.mjs "early dragon soul teamfight" \
//     [--teams HLE,BLG] [--date 2026-11-08] [--game N] [--limit 10] [--full]
// Env: SUPABASE_URL + SUPABASE_KEY/SUPABASE_SECRET_KEY, EMBEDDING_API_KEY/
//      OPENROUTER_API_KEY (leagueProDB/.env works).
import path from 'path';
import { embed } from './lib/embeddings.mjs';
import { supabaseRestClient } from './lib/supabase.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--teams') args.teams = argv[++i].split(',').map((t) => t.trim().toUpperCase());
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--game') args.game = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--full') args.full = true;
    else args._.push(a);
  }
  return args;
}

function fmtSec(s) {
  if (s == null) return '?';
  const t = Math.round(Number(s));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

async function search(query, { teams = [], date, game, limit = 10, full = false } = {}) {
  const db = supabaseRestClient();
  if (!db) throw new Error('Missing SUPABASE_URL / SUPABASE_KEY (leagueProDB/.env or env)');
  const { embedding } = await embed(query);
  const vec = JSON.stringify(embedding);

  // PostgREST can't do `order by embedding <=> q` directly — call the RPC.
  // match_transcript_chunks(query_embedding, match_teams, match_date, game_number, match_count)
  const res = await fetch(`${db.url}/rest/v1/rpc/match_transcript_chunks`, {
    method: 'POST',
    headers: {
      apikey: db.key,
      Authorization: `Bearer ${db.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query_embedding: vec,
      match_teams: teams.length ? teams : null,
      match_date: date || null,
      game_number: game ?? null,
      match_count: limit,
    }),
  });
  if (!res.ok) {
    throw new Error(`RPC match_transcript_chunks ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 400));
  }
  return res.json();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = parseArgs(process.argv.slice(2));
  const [query] = args._;
  if (!query) {
    console.error('Usage: node scripts/db_semantic_search.mjs "<query>" [--teams HLE,BLG] [--date YYYY-MM-DD] [--game N] [--limit 10] [--full]');
    process.exit(1);
  }
  const rows = await search(query, args);
  if (!rows.length) {
    console.log('No matches.');
    process.exit(0);
  }
  for (const r of rows) {
    console.log(`game_id=${r.game_id} chunk ${r.chunk_index} @ ${fmtSec(r.start_sec)}–${fmtSec(r.end_sec)} (distance ${r.distance != null ? Number(r.distance).toFixed(4) : '?'})`);
    console.log(`  ${args.full ? r.content : r.content.slice(0, 220) + (r.content.length > 220 ? '…' : '')}`);
  }
}
