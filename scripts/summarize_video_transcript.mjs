#!/usr/bin/env node
/**
 * Summarizes a Whisper transcript of a LoL PRO MATCH video: the LLM reads the
 * garbled transcript together with output/champions.json (to decode ASR
 * homophones into real champion names) and optional match data (teams/scores/
 * durations from matches.json or the Supabase DB), then writes a concise
 * Chinese summary of how the match went — NOT a line-by-line transcript edit.
 *
 * Scope: LoL pro-match videos only (see .agents/skills/lol-pro-video-transcript).
 *
 * Usage:
 *   node scripts/summarize_video_transcript.mjs <transcript.srt|txt> \
 *     [--game TAGA_vs_TAGB[_gN]] [--matches <matches.json>] [--out <file>] \
 *     [--db] [--date YYYY-MM-DD] [--dry-run]
 *
 * --game (recommended): identifies which matchup the video covers, e.g.
 *   "BLG_vs_HLE" or "BLG_vs_HLE_g2". Team tags are matched loosely
 *   (case-insensitive). With a _gN suffix the champion list comes from exactly
 *   that game (10 champs); without it the best-scoring game is chosen.
 *   When --game is absent the script auto-detects, but agents should CONFIRM
 *   with the user (see skill) and pass --game explicitly.
 *
 * Grounding: --db uses the Supabase DB (per-game player names/roles + exact
 * champion lists, EN mapped to CN via output/champions.json); without it, or
 * when the DB lookup fails, falls back to matches.json
 * (default: remotion/public/worlds/matches.json — the latest pipeline run).
 *
 * Output: output/data/<DATE>/<TAGA>_vs_<TAGB>[_gN].summary.md (DATE from the
 * match data; --out overrides). --dry-run prints to stdout instead.
 *
 * Env: REFINE_LLM_CMD=pi, REFINE_MODEL=<model>, REFINE_LLM_ATTEMPTS=2,
 *      REFINE_LLM_TIMEOUT_MS=600000
 */

import fs from 'fs';
import path from 'path';
import { callPiAgent } from './lib/llm.mjs';
import { flag, ROOT } from './lib/util.mjs';

const LABEL = '[SumYT]';
const CHAMPS_PATH = path.join(ROOT, 'output/champions.json');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const useDb = args.includes('--db');
const gameArg = flag(args, '--game');
const dateArg = flag(args, '--date');
const matchesPath = path.resolve(flag(args, '--matches') || path.join(ROOT, 'remotion/public/worlds/matches.json'));
const inputPath = path.resolve(
  args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--matches' && args[i - 1] !== '--out') || ''
);

if (!fs.existsSync(inputPath)) {
  console.error(`${LABEL} Missing transcript: ${inputPath}`);
  process.exit(1);
}

/** --game TAGA_vs_TAGB_gN -> { tokens: ['TAGA','TAGB'], gameNum: n|null } */
function parseGameArg(gameArg) {
  if (!gameArg) return { tokens: [], gameNum: null };
  const parts = String(gameArg).split(/_+/).filter((p) => p && p.toLowerCase() !== 'vs');
  const last = parts[parts.length - 1];
  const numMatch = parts.length > 0 && /^g(\d+)$/i.test(last) ? parseInt(last.slice(1), 10) : null;
  if (numMatch) parts.pop();
  return { tokens: parts.map((p) => p.toUpperCase()), gameNum: numMatch };
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------
/** SRT or plain text -> [{stamp, text}] cues. */
function readCues(inputPath) {
  const raw = fs.readFileSync(inputPath, 'utf-8');
  const isSrt = /^\s*1\s*\n\S*-->/.test(raw.slice(0, 200)) || inputPath.endsWith('.srt');
  if (!isSrt) {
    return raw.replace(/\r/g, '').split('\n').filter((l) => l.trim())
      .map((l) => ({ stamp: '', text: l.trim() }));
  }
  const cues = [];
  for (const b of raw.replace(/\r/g, '').split(/\n\n+/)) {
    const ls = b.split('\n').filter((l) => l.trim() !== '');
    const stampLine = ls.find((l) => l.includes('-->'));
    const text = ls.filter((l) => l !== stampLine && !/^\d+$/.test(l.trim())).join(' ').trim();
    if (text) cues.push({ stamp: (stampLine || '').split('-->')[0].trim(), text });
  }
  return cues;
}

/** Cues -> LLM-friendly text: minute stamps only once per ~minute. */
function transcriptTextFrom(cues) {
  let lastMin = -1;
  return cues
    .map((c) => {
      const m = c.stamp ? parseInt(c.stamp.split(':')[1], 10) : null;
      const prefix = m != null && m !== lastMin ? `[${String(m).padStart(2, '0')}:00] ` : '';
      if (m != null && m !== lastMin) lastMin = m;
      return prefix + c.text;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Match data grounding (DB primary, matches.json fallback)
// ---------------------------------------------------------------------------
/** EN -> CN champion name map from output/champions.json (empty on miss). */
function championNameMap() {
  try {
    const map = new Map();
    for (const v of Object.values(JSON.parse(fs.readFileSync(CHAMPS_PATH, 'utf-8')))) {
      map.set(String(v.en || '').toLowerCase(), v.cn || v.hant || v.en);
    }
    return map;
  } catch {
    return new Map(); // champions.json missing: keep EN names
  }
}

/** --db path: DB match with per-game rosters + CN champion lists, or null. */
async function loadDbMatch(tokens, date) {
  const { loadMatchFromDb } = await import('./db_match_lookup.mjs');
  const db = await loadMatchFromDb({ tokens, date });
  if (!db) {
    console.error(`${LABEL} --db: no match in Supabase${tokens.length ? ` for tokens ${tokens.join('+')}` : ''}${date ? ` on ${date}` : ''}; falling back to matches.json.`);
    return null;
  }
  const m = db.match;
  const toCn = (c) => championNameMap().get(String(c).toLowerCase()) || c;
  m.games = db.games.map((g) => ({
    game: g.game,
    duration: g.duration,
    winner: g.winner,
    teamA: { players: g.teamA.players, champions: g.teamA.players.map((p) => toCn(p.champion)) },
    teamB: { players: g.teamB.players, champions: g.teamB.players.map((p) => toCn(p.champion)) },
  }));
  m.factTeams = `${m.teamA} vs ${m.teamB}`;
  m.factWinner = m.winner;
  console.log(`${LABEL} --db loaded: ${m.factTeams} (${m.round}, ${m.date}) — ${m.games.length} game(s) with rosters.`);
  return m;
}

/**
 * matches.json path: the matches matching --game tokens, annotated with
 * factTeams/factWinner. Throws with a candidate list on no-match/ambiguity.
 */
function loadJsonMatches(matchesPath, tokens, gameArg) {
  const ms = JSON.parse(fs.readFileSync(matchesPath, 'utf-8'));
  if (!tokens.length) return { ms, selectedMatch: null };

  const byName = ms.filter((m) => {
    const A = String(m.teamA || '').toUpperCase();
    const B = String(m.teamB || '').toUpperCase();
    return tokens.every((t) => A.includes(t) || B.includes(t));
  });
  if (!byName.length) {
    console.error(`${LABEL} --game "${gameArg}" matched no match. Available:`);
    for (const m of ms) console.error(`  ${m.teamA}_vs_${m.teamB}  (${m.round || ''}, ${m.date || '?'})`);
    process.exit(1);
  }
  if (byName.length > 1) {
    console.error(`${LABEL} --game "${gameArg}" is ambiguous (${byName.length} matches: ${byName.map((m) => `${m.teamA}_vs_${m.teamB}`).join('; ')}). Use more distinct team tags.`);
    process.exit(1);
  }
  return { ms: byName, selectedMatch: byName[0] };
}

/** Per-game champion entries: [{teamsRef, gameNum, teamAChampions, teamBChampions, ...}] */
function gamesWithChampions(ms) {
  const out = [];
  for (const m of ms) {
    (m.games || []).forEach((g, i) => {
      const a = g.teamA?.championsCN || g.teamA?.champions || [];
      const b = g.teamB?.championsCN || g.teamB?.champions || [];
      if (a.length || b.length) {
        out.push({
          teamAChampions: a, teamBChampions: b, teamsRef: m, gameNum: i + 1,
          duration: g.duration ?? null, winner: g.winner ?? null,
        });
      }
    });
  }
  return out;
}

/** How many of a game's champion CN names appear in the transcript. */
const champHits = (game, hay) =>
  [...game.teamAChampions, ...game.teamBChampions].filter((c) => c && hay.includes(c)).length;

// ---------------------------------------------------------------------------
// Champion narrowing: only champs plausibly appearing in the transcript
// ---------------------------------------------------------------------------
/**
 * Narrows the champion table. Returns { champList, targetMatch, useGame }.
 * Source of truth: champions actually in the covered match(es); falls back to
 * a loose transcript scan only when no match data exists.
 */
function narrowChampions(allChamps, transcriptText, matchFacts, matchFactsGames, selectedMatch, selectedGameNum) {
  const hay = transcriptText;
  if (!matchFacts || !matchFactsGames.length) {
    // Loose scan: any champion whose EN or CN name (first 2 chars) shows up.
    const champList = allChamps.filter((c) => {
      const en = String(c.en || '').toLowerCase().replace(/[^a-z]/g, '');
      if (en && hay.toLowerCase().includes(en)) return true;
      const cn = String(c.cn || '');
      return cn.length > 1 && hay.includes(cn.slice(0, 2));
    });
    return { champList: champList.length ? champList : allChamps, targetMatch: null, useGame: null };
  }

  // Narrow to ONE match: the one whose teams + champion names the transcript
  // mentions most (transcripts discuss a single game).
  let best = selectedMatch || null;
  let bestScore = selectedMatch ? Infinity : 0;
  if (!selectedMatch) {
    for (const m of matchFacts) {
      const teams = `${m.factTeams || ''} ${m.factWinner || ''} ${m.teamA || ''} ${m.teamB || ''}`.toLowerCase();
      const teamScore = teams.split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && hay.toLowerCase().includes(w)).length;
      const champScore = matchFactsGames.filter((g) => g.teamsRef === m).reduce((s, g) => s + champHits(g, hay), 0);
      const score = teamScore * 10 + champScore;
      if (score > bestScore) { bestScore = score; best = m; }
    }
  }
  const gamesFor = matchFactsGames.filter((g) => g.teamsRef === best);
  if (!gamesFor.length) {
    console.error(`${LABEL} No games with champion data for the selected match; cannot narrow champions.`);
    process.exit(1);
  }

  // Narrow to ONE game: --game _gN forces it; otherwise score each game by
  // champion-name mentions.
  let bestGame = null;
  let bestGameScore = 0;
  if (selectedGameNum) {
    bestGame = gamesFor.find((g) => g.gameNum === selectedGameNum) || null;
    if (!bestGame) {
      console.error(`${LABEL} --game ..._g${selectedGameNum}: no such game in the selected match (it has ${gamesFor.length} game(s) with data).`);
      process.exit(1);
    }
  } else {
    for (const g of gamesFor) {
      const s = champHits(g, hay);
      if (s > bestGameScore) { bestGameScore = s; bestGame = g; }
    }
    if (bestGameScore < 2) {
      console.error(`${LABEL} Cannot pin the transcript to one game (best game ${bestGame?.gameNum} scored ${bestGameScore} champion-name hits). Re-run with an explicit --game <A>_vs_<B>_gN. Per-game hit scores:`);
      for (const g of gamesFor) console.error(`  g${g.gameNum}: ${champHits(g, hay)}`);
      process.exit(1);
    }
    console.log(`${LABEL} Single game selected (game ${bestGame.gameNum}, ${bestGameScore} champion-name hits)`);
  }

  const champs = new Set([...bestGame.teamAChampions, ...bestGame.teamBChampions]);
  const champList = allChamps.filter((c) => champs.has(c.cn));
  return { champList: champList.length ? champList : allChamps, targetMatch: best, useGame: bestGame };
}

// ---------------------------------------------------------------------------
// Prompt + LLM
// ---------------------------------------------------------------------------
function buildPrompt(transcriptText, champList, matchFacts, dbPlayersByGame, useGame, targetMatch) {
  const matchJson = (matchFacts || []).map((m) => {
    const base = {
      teams: m.factTeams, winner: m.factWinner,
      score: m.scoreA != null ? `${m.scoreA}-${m.scoreB}` : undefined,
      round: m.round, duration: m.duration, bestOf: m.bestOf,
    };
    if (useGame) {
      base.game = {
        num: useGame.gameNum, duration: useGame.duration ?? null, winner: useGame.winner ?? null,
      };
    }
    return base;
  });

  const rosterBlock = dbPlayersByGame && useGame
    ? (() => {
        const p = dbPlayersByGame.get(useGame.gameNum);
        if (!p) return '';
        const side = (list) => list.map((x) => `${x.role}:${x.name}(${x.champion})`).join(', ');
        return `【选手名单(官方名,按位次)】\n- 第${useGame.gameNum}局 ${targetMatch?.factTeams || ''}:\n  一方: ${side(p.teamA)}\n  另一方: ${side(p.teamB)}\n转录中的选手昵称(如 "哥哥"/"江哥"/"天哥")请对照此名单推断真名。\n`;
      })()
    : '';

  return `你是一名《英雄联盟》职业比赛内容编辑。下面是一段关于 LoL 职业比赛的中文视频的 Whisper 语音识别转录(可能有同音错字)。请理解并写一段**这场比赛怎么打的**总结。

【理解提示】
1. 语音识别常把英雄名写成同音错字(如 "落客"→洛克/乐芙兰类、革温→格温、楼梦→洛、估骂等)。请结合上下文与下面的英雄名对照表,推断真正的英雄名,再理解战术讨论。
2. 视频可能包含 BP(选人)阶段分析、对线细节、团战解说。总结要覆盖:BP 思路(若在)、关键对线/资源/团战节点、比赛走势与胜负原因。
3. ${matchFacts ? '下面的比赛数据给出对阵双方与结果,请据此校准队伍名与胜负(注意转录里可能用队伍中文称呼)。' : '没有比赛数据,队伍名按转录内容推断,不确定就写模糊些。'}
4. 只用转录+数据中能推出的事实,不要编造具体数字(经济、击杀数等转录里没有的不要加)。
5. 输出为简体中文 Markdown,结构:
   ## 一句话结果
   (1-2 句:谁打谁、结果、大致时长)
   ## 比赛进程
   (3-6 个要点:前期对线/野区、关键资源、决定性团战、转折点)
   ## 胜负关键
   (2-3 句:为什么赢/输)
6. 转录是片段/解说观点时,注明"据该视频解说观点",与客观事实分开。

${champList.length ? `【英雄名对照表(英文|中文)】\n${champList.map((c) => `${c.en}|${c.cn}`).join(', ')}\n` : ''}
${matchFacts ? `【比赛数据】\n${JSON.stringify(matchJson, null, 1)}\n` : ''}${rosterBlock}
【转录文本】
${transcriptText}

直接输出 Markdown,不要代码块围栏。`;
}

function callAgent(promptText, attempt) {
  return callPiAgent(promptText, {
    envPrefix: 'REFINE_LLM',
    systemPrompt: 'You are a LoL esports content editor. Follow the user instructions exactly and reply with only the requested output.',
    attempt,
    label: LABEL,
    defaultTimeoutMs: 600_000,
    maxBufferMb: 20,
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const safeTag = (s) => String(s || '').replace(/[^A-Za-z0-9]+/g, '');

function resolveOutputPath(targetMatch, gameTokens, selectedGameNum, useGame, matchDate, inputPath) {
  const explicit = flag(process.argv.slice(2), '--out');
  if (explicit) return path.resolve(explicit);
  let outName = null;
  if (targetMatch) {
    const tags = [targetMatch.teamA, targetMatch.teamB].map(safeTag);
    outName = `${tags[0]}_vs_${tags[1]}_g${useGame?.gameNum ?? selectedGameNum ?? ''}.summary.md`;
  } else if (gameTokens.length) {
    outName = `${gameTokens.map(safeTag).join('_vs_')}_g${selectedGameNum ?? ''}.summary.md`;
  }
  return outName && matchDate
    ? path.join(ROOT, 'output/data', matchDate, outName)
    : inputPath.replace(/\.(srt|txt)$/i, '') + '.summary.md';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const cues = readCues(inputPath);
if (!cues.length) {
  console.error(`${LABEL} Transcript has no content.`);
  process.exit(1);
}
const transcriptText = transcriptTextFrom(cues);
const { tokens: gameTokens, gameNum: selectedGameNum } = parseGameArg(gameArg);

// Ground in the DB when --db, else matches.json.
let matchFacts = null;
let matchFactsGames = [];
let matchDate = null;
let selectedMatch = null;
let dbPlayersByGame = null; // gameNum -> {teamA:[{role,name,champion}],teamB:[...]}

if (useDb) {
  try {
    const m = await loadDbMatch(gameTokens, dateArg);
    if (m) {
      selectedMatch = m;
      matchDate = m.date;
      dbPlayersByGame = new Map(m.games.map((g) => [g.game, { teamA: g.teamA.players, teamB: g.teamB.players }]));
      matchFactsGames = m.games.map((g, i) => ({
        teamAChampions: g.teamA.champions.filter(Boolean),
        teamBChampions: g.teamB.champions.filter(Boolean),
        teamsRef: m,
        gameNum: i + 1,
        duration: g.duration ?? null,
        winner: g.winner ?? null,
      }));
      matchFacts = [m];
    }
  } catch (e) {
    console.error(`${LABEL} --db failed (${e.message}); falling back to matches.json.`);
  }
}

if (!matchFacts && fs.existsSync(matchesPath)) {
  const { ms, selectedMatch: sel } = loadJsonMatches(matchesPath, gameTokens, gameArg);
  for (const m of ms) {
    m.factTeams = `${m.teamA} vs ${m.teamB}`;
    m.factWinner = m.winner;
  }
  selectedMatch = sel;
  matchDate = ms[0]?.date || null;
  matchFactsGames = gamesWithChampions(ms);
  if (!matchFactsGames.length) {
    console.error(`${LABEL} WARNING: match data has no games with champion data; falling back to loose transcript scan.`);
    matchFacts = null;
  } else {
    matchFacts = ms;
  }
}

// Champion table + prompt.
const allChamps = fs.existsSync(CHAMPS_PATH)
  ? Object.values(JSON.parse(fs.readFileSync(CHAMPS_PATH, 'utf-8'))).map((v) => ({ en: v.en, cn: v.cn || v.hant || v.en }))
  : [];
const { champList, targetMatch, useGame } = narrowChampions(
  allChamps, transcriptText, matchFacts, matchFactsGames, selectedMatch, selectedGameNum
);
if (champList.length) {
  console.log(`${LABEL} Champions listed in prompt: ${champList.length}${matchFacts && matchFactsGames.length ? ' (from match data)' : ' (loose transcript scan)'}: ${champList.map((c) => c.cn).join(', ')}`);
}

const prompt = buildPrompt(transcriptText, champList, matchFacts, dbPlayersByGame, useGame, targetMatch);

// LLM with bounded retries.
const attempts = Number(process.env.REFINE_LLM_ATTEMPTS || 2);
let summary = null;
for (let attempt = 1; attempt <= attempts && !summary; attempt++) {
  try {
    const out = callAgent(prompt, attempt).trim();
    if (!out.includes('## ') || out.length < 200) throw new Error('output too short or missing sections');
    summary = out;
  } catch (e) {
    console.error(`${LABEL} attempt ${attempt}: ${e.message}`);
  }
}
if (!summary) {
  console.error(`${LABEL} FAILED; nothing written.`);
  process.exit(1);
}

if (dryRun) {
  console.log(summary);
  process.exit(0);
}

const outPath = resolveOutputPath(targetMatch, gameTokens, selectedGameNum, useGame, matchDate, inputPath);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, summary + '\n', 'utf-8');
console.log(`${LABEL} Summary written -> ${outPath} (${summary.length} chars, ${cues.length} transcript lines read)`);
