// Chunks a full-match English commentary SRT by time window, embeds the chunks
// (openai/text-embedding-3-small via OpenRouter) and stores them in the
// `transcript_chunks` pgvector table, linked to the game resolved by
// matchup + date (+ game number). Also upserts the full transcript into
// `transcripts`. Idempotent: re-running replaces the same game's chunks.
//
// Usage:
//   node scripts/db_transcript_embed.mjs output/mp3/<id>.srt --teams HLE,BLG \
//     --date 2026-11-08 [--game N] [--window 45] [--dry-run]
// Env: SUPABASE_URL + SUPABASE_KEY/SUPABASE_SECRET_KEY and
//      EMBEDDING_API_KEY/OPENROUTER_API_KEY (leagueProDB/.env works).
import fs from 'fs';
import path from 'path';
import { uploadTranscriptToDb } from './db_transcript_upload.mjs';
import { embed, EMBEDDING_MODEL, EMBEDDING_DIMS } from './lib/embeddings.mjs';
import { supabaseRestClient } from './lib/supabase.mjs';

const DEFAULT_WINDOW_SEC = 45;   // target chunk duration
const MAX_CHUNK_CHARS = 1200;    // hard cap so a chunk never exceeds one embedding batch item
const EMBED_BATCH = 64;          // cues per embeddings API call

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--teams') args.teams = argv[++i].split(',').map((t) => t.trim().toUpperCase());
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--game') args.game = Number(argv[++i]);
    else if (a === '--window') args.window = Number(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else args._.push(a);
  }
  return args;
}

function srtTimestampToSec(ts) {
  const m = ts.trim().match(/^(\d+):(\d+):(\d+)[,.](\d+)$/);
  if (!m) throw new Error(`Bad SRT timestamp: ${ts}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** Parse SRT into cues [{start, end, text}]. */
export function parseSrt(srt) {
  const cues = [];
  for (const block of srt.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (lines.length < 2) continue;
    const tIdx = lines.findIndex((l) => l.includes('-->'));
    if (tIdx === -1) continue;
    const [a, b] = lines[tIdx].split('-->');
    const text = lines.slice(tIdx + 1).join(' ').trim();
    if (!text) continue;
    cues.push({ start: srtTimestampToSec(a), end: srtTimestampToSec(b), text });
  }
  return cues;
}

/**
 * Merge consecutive cues into ~windowSec chunks.
 * Returns [{index, content, start_sec, end_sec}].
 */
export function chunkCues(cues, windowSec = DEFAULT_WINDOW_SEC) {
  const chunks = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.texts.length) {
      chunks.push({
        index: chunks.length,
        content: cur.texts.join(' '),
        start_sec: cur.start,
        end_sec: cur.end,
      });
    }
    cur = null;
  };
  for (const c of cues) {
    if (!cur) cur = { start: c.start, end: c.end, texts: [] };
    const projectedChars = cur.texts.join(' ').length + c.text.length + 1;
    if (cur.texts.length && (c.start - cur.start >= windowSec || projectedChars > MAX_CHUNK_CHARS)) {
      flush();
      cur = { start: c.start, end: c.end, texts: [] };
    }
    cur.texts.push(c.text);
    cur.end = c.end;
  }
  flush();
  return chunks;
}

/** Insert chunks for a game (replaces any existing chunks for that game).
 *  Embeds everything first so a failed batch can't leave the game half-stored. */
async function storeChunks(rest, gameId, chunks) {
  const vectors = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    vectors.push(...(await embed(chunks.slice(i, i + EMBED_BATCH).map((c) => c.content))));
  }
  await rest('DELETE', `transcript_chunks?game_id=eq.${gameId}`);
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const rows = batch.map((c, j) => ({
      game_id: gameId,
      chunk_index: c.index,
      content: c.content,
      start_sec: c.start_sec,
      end_sec: c.end_sec,
      // pgvector via PostgREST takes the literal '[0.1,0.2,...]' string
      embedding: JSON.stringify(vectors[j]),
    }));
    await rest('POST', 'transcript_chunks', rows, '');
  }
}

// CLI entry
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = parseArgs(process.argv.slice(2));
  const [srtPath] = args._;
  if (!srtPath || !args.teams) {
    console.error('Usage: node scripts/db_transcript_embed.mjs <srt> --teams HLE,BLG --date YYYY-MM-DD [--game N] [--window 45] [--dry-run]');
    process.exit(1);
  }

  const srt = fs.readFileSync(srtPath, 'utf-8');
  const cues = parseSrt(srt);
  if (!cues.length) {
    console.error('No cues parsed from SRT — is this a Whisper SRT?');
    process.exit(1);
  }
  const chunks = chunkCues(cues, args.window ?? DEFAULT_WINDOW_SEC);
  const totalChars = chunks.reduce((n, c) => n + c.content.length, 0);
  console.log(`Parsed ${cues.length} cues → ${chunks.length} chunks (~${Math.round(totalChars / chunks.length)} chars avg, window=${args.window ?? DEFAULT_WINDOW_SEC}s)`);
  console.log(`Embedding with ${EMBEDDING_MODEL} (${EMBEDDING_DIMS} dims)…`);

  if (args.dryRun) {
    for (const c of chunks.slice(0, 3)) {
      console.log(`  [${c.index}] ${c.start_sec.toFixed(0)}s–${c.end_sec.toFixed(0)}s: ${c.content.slice(0, 100)}…`);
    }
    console.log(`  … (${chunks.length} chunks total; dry run, nothing written)`);
    process.exit(0);
  }

  const db = supabaseRestClient();
  if (!db) throw new Error('Missing SUPABASE_URL / SUPABASE_KEY (leagueProDB/.env or env)');

  const transcript = srt;
  const res = await uploadTranscriptToDb({
    transcript, tokens: args.teams, date: args.date, game: args.game ?? null,
  });
  console.log(`Transcript upserted → transcripts.transcript_id=${res.transcriptId} (game_id=${res.gameId}, ${res.matchup} ${res.date})`);

  await storeChunks(db.rest, res.gameId, chunks);
  console.log(`Stored ${chunks.length} chunks in transcript_chunks (game_id=${res.gameId})`);
}
