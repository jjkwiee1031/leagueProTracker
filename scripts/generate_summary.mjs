#!/usr/bin/env node

/**
 * Generates a *dynamic* Mandarin narration summary from scraped matches.json by
 * asking the pi coding agent (headless / non-interactive) to write it, then
 * validates the result against the contract the video depends on.
 *
 * Contract (consumed by parse_vtt.mjs + WorldsReport.tsx):
 *   - 1-3 `intro` lines
 *   - exactly N `match` lines, matchIndex 0..N-1 in order (one per match)
 *   - exactly 1 `recap` line
 *   - 1-2 `outro` lines
 *   - every text is a SINGLE line (no newlines): edge-tts emits exactly one VTT
 *     cue per line, and parse_vtt.mjs zips segments -> cues 1:1.
 *
 * Fails loudly (exit 1) when the LLM is unavailable, times out, or returns
 * output that breaks the contract. No silent fallback.
 * Escape hatch: `--template` (or SUMMARY_MODE=template) uses the deterministic
 * templated summary for offline debugging/reproduction.
 *
 * Usage: node scripts/generate_summary.mjs [YYYY-MM-DD] [--template]
 *
 * Env: SUMMARY_MODE=llm|template, SUMMARY_LLM_CMD=pi, SUMMARY_MODEL=<model>,
 *      SUMMARY_LLM_ATTEMPTS=2, SUMMARY_LLM_TIMEOUT_MS=180000
 */

import fs from 'fs';
import path from 'path';
import { callPiAgent, extractJsonObject } from './lib/llm.mjs';
import { supabaseRestClient } from './lib/supabase.mjs';
import { dateArg, ROOT } from './lib/util.mjs';

const args = process.argv.slice(2);
const targetDate = dateArg(args.find((a) => !a.startsWith('--')));
const useTemplate =
  args.includes('--template') || (process.env.SUMMARY_MODE || 'llm').toLowerCase() === 'template';

const jsonPath = path.join(ROOT, `output/data/${targetDate}/matches.json`);

// ---------------------------------------------------------------------------
// Data loading: Supabase DB (primary) with matches.json fallback
// ---------------------------------------------------------------------------

// Narration uses team ABBREVIATIONS (e.g. "TES" not "Top Esports") — the
// Mandarin TTS voice reads short all-caps tags correctly once spacedTags()
// spaces them letter by letter; full names contain words it would mangle.
const nameAbbrMap = new Map(); // full team name -> abbreviation (from DB teams table)

async function loadMatchesFromDb(date) {
  const { rest } = supabaseRestClient();
  const select = [
    'match_id', 'round', 'best_of', 'score_a', 'score_b', 'duration', 'winner_team_id',
    'team_a:teams!matches_team_a_id_fkey(team_id,name,abbreviation)',
    'team_b:teams!matches_team_b_id_fkey(team_id,name,abbreviation)',
    'games(game_number,duration)',
  ].join(',');
  const rows = await rest(
    'GET',
    `matches?select=${encodeURIComponent(select)}&match_date=eq.${date}&order=match_id.asc`
  );

  // full display name -> short tag, used to annotate the Remotion matches.json
  nameAbbrMap.clear();
  for (const m of rows) {
    if (m.team_a?.name && m.team_a?.abbreviation) nameAbbrMap.set(m.team_a.name, m.team_a.abbreviation);
    if (m.team_b?.name && m.team_b?.abbreviation) nameAbbrMap.set(m.team_b.name, m.team_b.abbreviation);
  }
  return rows.map((m) => {
    const games = (m.games || []).sort((a, b) => a.game_number - b.game_number);
    return {
      teamA: m.team_a?.abbreviation || '',
      teamB: m.team_b?.abbreviation || '',
      winner:
        m.winner_team_id === m.team_a?.team_id ? m.team_a?.abbreviation
        : m.winner_team_id === m.team_b?.team_id ? m.team_b?.abbreviation
        : null,
      scoreA: String(m.score_a),
      scoreB: String(m.score_b),
      round: m.round,
      bestOf: m.best_of,
      duration: m.duration || null,
      gameDurations: games.map((g) => g.duration).filter(Boolean),
      games,
    };
  });
}

let matches;
let matchSource;
const db = supabaseRestClient();
if (db) {
  matches = await loadMatchesFromDb(targetDate);
  matchSource = 'Supabase DB';
} else if (fs.existsSync(jsonPath)) {
  console.warn('[Summary] SUPABASE_URL/SUPABASE_KEY not set — falling back to matches.json');
  matches = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  matchSource = `matches.json`;
} else {
  console.error('[Summary] No Supabase credentials (env or leagueProDB/.env) and no matches.json.');
  process.exit(1);
}
if (!Array.isArray(matches) || matches.length === 0) {
  console.error(`[Summary] No matches for ${targetDate} (source: ${matchSource}).`);
  process.exit(1);
}
console.log(`[Summary] Loaded ${matches.length} matches from ${matchSource} — generating Mandarin summary (${useTemplate ? 'template' : 'LLM'})...`);

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

// Speak short all-caps tags letter by letter ("TES" -> "T E S") so the Mandarin
// TTS voice reads each letter instead of guessing a word/pinyin. Applied to the
// LLM output too, so tags are correct no matter how the model wrote them.
const spacedTags = (text) =>
  String(text || '')
    .replace(/(^|[^A-Za-z0-9])([A-Z][A-Z0-9]{1,5})(?![A-Za-z0-9])/g, (_m, pre, tag) =>
      // Series tags read naturally as a word ("BO3"); don't spell them out.
      /^BO\d+$/i.test(tag) ? pre + tag : pre + tag.split('').join(' ')
    )
    .replace(/\s+/g, ' ')
    .trim();

// Speak a match length in Chinese units ("26:01" -> "26分钟1秒").
const speakDuration = (dur) => {
  const p = String(dur || '').split(':').map(Number);
  if (!p.length || p.some(Number.isNaN)) return String(dur || '');
  const [h, m, s] = p.length === 3 ? p : [0, ...p];
  let out = '';
  if (h) out += `${h}小时`;
  if (m) out += `${m}分钟`;
  if (s) out += `${s}秒`;
  return out || String(dur || '');
};

const CN_NUM = { 1: '一', 2: '两', 3: '三', 4: '四', 5: '五' };

// A real sweep = the loser won no games (2-0, 3-0). A Bo1 can never be a sweep.
const isSweep = (m) => {
  const a = Number(m.scoreA);
  const b = Number(m.scoreB);
  return Math.min(a, b) === 0 && Math.max(a, b) >= 2;
};

// Series formats present in the day, e.g. [{ name: 'BO3', count: 2 }] (Bo1 excluded).
const seriesFormats = (ms) => {
  const counts = {};
  ms.forEach((m) => {
    const bo = m.bestOf || 1;
    if (bo > 1) counts[bo] = (counts[bo] || 0) + 1;
  });
  return Object.keys(counts)
    .map(Number)
    .sort((a, b) => a - b)
    .map((bo) => ({ name: `BO${bo}`, count: counts[bo] }));
};

// ---------------------------------------------------------------------------
// Deterministic template (escape hatch, no LLM)
// ---------------------------------------------------------------------------
function templateSegments() {
  const segments = [
    { kind: 'intro', text: '2026英雄联盟全球总决赛,瑞士轮最新赛报!' },
    { kind: 'intro', text: `今日共有${matches.length}场激烈对局:` },
  ];

  matches.forEach((m, idx) => {
    const winner = m.winner;
    const loser = m.winner === m.teamA ? m.teamB : m.teamA;
    const score = m.winner === m.teamA ? `${m.scoreA}比${m.scoreB}` : `${m.scoreB}比${m.scoreA}`;
    const n = (m.games && m.games.length) || Number(m.scoreA || 0) + Number(m.scoreB || 0) || 1;
    const prefix = n > 1 ? `${CN_NUM[n] || n}局总耗时` : '耗时';
    // No published breakdown -> no duration claim at all.
    const durationClause = m.duration ? `,${prefix}${speakDuration(m.duration)}` : '';
    segments.push({
      kind: 'match',
      matchIndex: idx,
      text: `第${idx + 1}场,${spacedTags(winner)}以${score}击败${spacedTags(loser)}${durationClause}。`,
    });
  });

  const sweeps = matches.filter(isSweep).length;
  const formats = seriesFormats(matches);
  const mix = formats.length ? `其中${formats.map((f) => `${f.count}场${f.name}`).join('、')},` : '';
  segments.push({ kind: 'recap', text: `今日${matches.length}场对决,${mix}${sweeps}场横扫收场。` });
  segments.push({ kind: 'outro', text: '以上是今天的战报,关注我们获取更多最新赛事!' });
  return segments;
}

// ---------------------------------------------------------------------------
// Facts handed to the LLM (pre-formatted so it never does tag/duration math)
// ---------------------------------------------------------------------------
function buildFacts() {
  const matchFacts = matches.map((m, idx) => {
    const winner = m.winner;
    const loser = m.winner === m.teamA ? m.teamB : m.teamA;
    const winScore = m.winner === m.teamA ? m.scoreA : m.scoreB;
    const loseScore = m.winner === m.teamA ? m.scoreB : m.scoreA;
    return {
      index: idx,
      round: m.round,
      bestOf: m.bestOf || 1,
      gamesPlayed: (m.games && m.games.length) || 1,
      winner,
      winnerSpaced: spacedTags(winner),
      loser,
      loserSpaced: spacedTags(loser),
      seriesScore: `${winScore}比${loseScore}`,
      // null when Liquipedia has not published the per-game breakdown yet.
      durationSpoken: m.duration ? speakDuration(m.duration) : null,
      gameDurationsSpoken: (m.gameDurations || []).filter(Boolean).map(speakDuration),
    };
  });

  // Longest single game of the day, straight from each match's gameDurations.
  const longest = matches
    .flatMap((m) =>
      (m.gameDurations || [])
        .filter(Boolean)
        .map((d) => ({ teams: `${m.teamA} vs ${m.teamB}`, duration: d }))
    )
    .map((g) => {
      const [mm, ss] = g.duration.split(':').map(Number);
      return { ...g, sec: mm * 60 + ss };
    })
    .sort((a, b) => b.sec - a.sec)[0];

  return {
    date: targetDate,
    totalMatches: matches.length,
    seriesFormats: seriesFormats(matches),
    multiGameCount: matches.filter((m) => (m.bestOf || 1) > 1).length,
    sweepCount: matches.filter(isSweep).length,
    longestGame: longest
      ? { teams: longest.teams, duration: longest.duration, durationSpoken: speakDuration(longest.duration) }
      : null,
    matches: matchFacts,
  };
}

function buildPrompt(facts, previousError) {
  const retry = previousError
    ? `\n【上一次输出不合格,原因】\n${previousError}\n请修正后重新输出完整 JSON。\n`
    : '';
  const seriesText = facts.seriesFormats.length
    ? `、多局系列赛 ${facts.seriesFormats.map((f) => `${f.count}场${f.name}`).join('、')}`
    : '';
  const longestText = facts.longestGame
    ? `、最长一局是 ${facts.longestGame.teams} 的 ${facts.longestGame.durationSpoken}`
    : '';
  return `你是《英雄联盟》2026 全球总决赛瑞士轮的中文赛事解说。根据下面的比赛数据,为竖屏短视频写一段赛报解说词。
${retry}
【输出格式】只输出一个 JSON 对象,不要任何解释、markdown 或代码块围栏:
{"segments":[{"kind":"intro","text":"..."},{"kind":"match","matchIndex":0,"text":"..."},{"kind":"recap","text":"..."},{"kind":"outro","text":"..."}]}

【硬性要求】
1. 结构:2-3 条 intro;恰好 ${facts.totalMatches} 条 match(matchIndex 依次为 0..${facts.totalMatches - 1},顺序与数据一致);恰好 1 条 recap;1-2 条 outro。
2. 每条 text 必须是**单行**纯文本:不能含换行符、制表符、双引号、markdown、emoji、括号注释、列表符号。
3. 每条 match 只写一句话,30-50 个汉字,必须包含:获胜队伍、大比分、系列赛总时长。
   - 队伍名必须原样使用数据里的 winnerSpaced / loserSpaced(例如 "G E N"),不得改写、不得去掉空格。
   - 总时长必须原样使用数据里的 durationSpoken(例如 "1小时34分钟14秒")。
   - **如果某场的 durationSpoken 是 null**:说明官方尚未公布该场的分场数据,该句**绝对不能提到任何时长**(不许写分、小时、秒,也不许猜测),只写获胜队伍、大比分和点评即可。
   - 可以加入不超过 8 个字的点评(如 横扫/逆转/鏖战三局/爆冷),但**不得编造**数据中没有的事实(不要写选手名、英雄名、经济差等未提供的信息)。
4. recap:一句话总结今日整体情况,必须提到:总场次 ${facts.totalMatches} 场${seriesText}、横扫 ${facts.sweepCount} 场${longestText}。20-45 个汉字,只能用上述已给事实。
5. outro:一句谢谢收看,15-30 个汉字。
6. 只用简体中文、数字与字母。数字比分写成 "2比0" 形式。
7. **空格规则**:中文与数字/字母之间不要加空格(写成 "2比0" 而不是 " 2比0 ");唯一允许的空格是队伍标签内部(如 "G E N")与标签两侧。
8. 数据里的 teams 是 "A vs B" 形式,口播时请说成 "A 对 B",不要出现 "vs"。

【比赛数据(JSON)】
${JSON.stringify(facts, null, 1)}

【输出】只输出 JSON。`;
}

// ---------------------------------------------------------------------------
// LLM invocation (pi headless)
// ---------------------------------------------------------------------------
function callAgent(prompt, attempt) {
  return callPiAgent(prompt, {
    envPrefix: 'SUMMARY_LLM',
    systemPrompt: 'You are a JSON-only API for a LoL esports video pipeline. Follow the user instructions exactly and reply with only the requested JSON object.',
    attempt,
    label: '[Summary]',
    defaultTimeoutMs: 180_000,
  });
}

// ---------------------------------------------------------------------------
// Validation + normalization
// ---------------------------------------------------------------------------
const normalizeSegments = (rawSegments) =>
  rawSegments.map((s) => {
    const out = { kind: s.kind };
    if (typeof s.matchIndex === 'number') out.matchIndex = s.matchIndex;
    out.text = spacedTags(String(s.text || '').replace(/[\r\n\t]+/g, ' ').trim());
    return out;
  });

function validate(segments, facts) {
  if (!Array.isArray(segments)) return ['segments 不是数组'];
  const errs = [];
  const n = facts.totalMatches;

  const intro = segments.filter((s) => s.kind === 'intro');
  const match = segments.filter((s) => s.kind === 'match');
  const recap = segments.filter((s) => s.kind === 'recap');
  const outro = segments.filter((s) => s.kind === 'outro');

  if (intro.length + match.length + recap.length + outro.length !== segments.length) {
    errs.push('存在非法 kind(只允许 intro/match/recap/outro)');
  }
  if (intro.length < 1 || intro.length > 3) errs.push(`intro 应为 1-3 条,实际 ${intro.length}`);
  if (match.length !== n) errs.push(`match 应为 ${n} 条,实际 ${match.length}`);
  if (recap.length !== 1) errs.push(`recap 应为 1 条,实际 ${recap.length}`);
  if (outro.length < 1 || outro.length > 2) errs.push(`outro 应为 1-2 条,实际 ${outro.length}`);

  // Section order: intro(s) -> match(es) -> recap -> outro(s)
  const order = segments.map((s) => s.kind).join(',');
  const expected = [
    ...Array(intro.length).fill('intro'),
    ...Array(match.length).fill('match'),
    'recap',
    ...Array(outro.length).fill('outro'),
  ].join(',');
  if (order !== expected) errs.push('段落顺序必须为 intro -> match -> recap -> outro');

  // matchIndex sequence
  match.forEach((s, i) => {
    if (s.matchIndex !== i) errs.push(`match[${i}] 的 matchIndex 应为 ${i},实际 ${s.matchIndex}`);
  });

  // Per-line text checks
  segments.forEach((s, i) => {
    const t = String(s.text || '');
    if (!t) errs.push(`segments[${i}] text 为空`);
    if (/[\r\n]/.test(t)) errs.push(`segments[${i}] text 含换行符`);
    if (t.length > 90) errs.push(`segments[${i}] text 过长(${t.length} 字)`);
    if (t.length < 6) errs.push(`segments[${i}] text 过短(${t.length} 字)`);
  });

  // Factual guard: each match line must carry the winner tag, the score and the spoken duration.
  match.forEach((s, i) => {
    const f = facts.matches[i];
    const t = String(s.text || '');
    if (f && !t.includes(f.winnerSpaced)) errs.push(`match[${i}] 缺少获胜队伍 "${f.winnerSpaced}"`);
    if (f && !t.includes(f.seriesScore)) errs.push(`match[${i}] 缺少大比分 "${f.seriesScore}"`);
    // Duration is only required when it is actually known; when unknown the line
    // must not mention a duration at all (no guessing).
    if (f && f.durationSpoken) {
      if (!t.includes(f.durationSpoken)) errs.push(`match[${i}] 缺少总时长 "${f.durationSpoken}"`);
    } else if (f && /小时|分钟|\d+\s*秒/.test(t)) {
      errs.push(`match[${i}] 时长未知,但解说词提到了时长`);
    }
  });

  return errs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function writeOutputs(segments) {
  const scriptContent = segments.map((s) => s.text).join('\n');
  const summaryPath = path.join(ROOT, `output/data/${targetDate}/summary.txt`);
  const summaryJsonPath = path.join(ROOT, `output/data/${targetDate}/summary.json`);
  const publicSummaryJson = path.join(ROOT, 'remotion/public/worlds/summary.json');
  const publicMatchesJson = path.join(ROOT, 'remotion/public/worlds/matches.json');

  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.mkdirSync(path.dirname(publicSummaryJson), { recursive: true });
  fs.writeFileSync(summaryPath, scriptContent, 'utf-8');
  fs.writeFileSync(summaryJsonPath, JSON.stringify(segments, null, 2), 'utf-8');
  fs.writeFileSync(publicSummaryJson, JSON.stringify(segments, null, 2), 'utf-8');
  // Keep the Remotion-visible matches.json in sync with the run's data.
  // Team names are swapped to DB abbreviations so cards + narration share tags
  // (screenshots and roster players keep the scraper's full-name structure).
  const scrapedPath = path.join(ROOT, `output/data/${targetDate}/matches.json`);
  if (fs.existsSync(scrapedPath)) {
    const abbr = (name) => nameAbbrMap.get(name) || name;
    if (nameAbbrMap.size > 0) {
      const scraped = JSON.parse(fs.readFileSync(scrapedPath, 'utf-8'));
      for (const m of scraped) {
        m.teamA = abbr(m.teamA);
        m.teamB = abbr(m.teamB);
        if (m.winner) m.winner = abbr(m.winner);
        for (const g of m.games || []) {
          if (g.winner) g.winner = abbr(g.winner);
          if (g.teamA?.name) g.teamA.name = abbr(g.teamA.name);
          if (g.teamB?.name) g.teamB.name = abbr(g.teamB.name);
        }
      }
      fs.writeFileSync(publicMatchesJson, JSON.stringify(scraped, null, 2), 'utf-8');
      console.log(`Wrote abbreviations-annotated matches.json to ${publicMatchesJson}.`);
    } else {
      fs.copyFileSync(scrapedPath, publicMatchesJson);
      console.log(`Copied matches.json to ${publicMatchesJson} (no DB abbreviations available).`);
    }
  }

  console.log(`\n=== Generated Script (${segments.length} lines) ===\n${scriptContent}\n========================\n`);
  console.log(`Saved to ${summaryPath} + segments JSON (local & public).`);
}

function main() {
  if (useTemplate) {
    writeOutputs(templateSegments());
    return;
  }

  const facts = buildFacts();
  const attempts = Math.max(1, Number(process.env.SUMMARY_LLM_ATTEMPTS || 2));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let raw;
    try {
      raw = callAgent(buildPrompt(facts, lastError), attempt);
    } catch (err) {
      lastError = err.message;
      console.error(`[Summary] ${lastError}`);
      continue;
    }

    const parsed = extractJsonObject(raw);
    if (!parsed || parsed.__parseError || !Array.isArray(parsed.segments)) {
      lastError = '输出不是合法的 JSON 对象,或缺少 segments 数组。';
      console.error(`[Summary] attempt ${attempt}: ${lastError}`);
      console.error(`[Summary] raw head: ${String(raw).slice(0, 300)}`);
      continue;
    }

    const segments = normalizeSegments(parsed.segments);
    const errs = validate(segments, facts);
    if (errs.length) {
      lastError = errs.join('; ');
      console.error(`[Summary] attempt ${attempt} invalid: ${lastError}`);
      continue;
    }

    writeOutputs(segments);
    console.log(`[Summary] LLM summary accepted on attempt ${attempt}.`);
    return;
  }

  console.error(`[Summary] FAILED after ${attempts} attempt(s). Last error: ${lastError}`);
  console.error('[Summary] No fallback (fail loudly). Use --template for the deterministic summary.');
  process.exit(1);
}

main();
