#!/usr/bin/env node

/**
 * Liquipedia Worlds scraper — direct Playwright rewrite (no CLI subprocess,
 * no eval-string quoting).
 *
 * Scrapes completed matches for ONE calendar day. The standalone match detail
 * page ("View match details") is the sole source of per-game info (duration,
 * winner, rosters) and of the per-game "Player Performance" screenshots.
 * Writes matches.json + public screenshot copies for the Remotion video.
 *
 * Usage: node scripts/scrape.mjs [YYYY-MM-DD | roundKeyword | all] [--headed]
 *
 * Target page: WORLDS_URL env (default: the 2026 Swiss Stage). Point it at the
 * playoffs page to scrape Bo5 series, e.g.
 *   WORLDS_URL=https://liquipedia.net/leagueoflegends/World_Championship/2026/Knockout_Stage \
 *     node scripts/scrape.mjs 2026-11-07
 *
 * Cloudflare: headless usually trips the Turnstile gate. If that happens,
 * re-run with --headed (WSLg shows the window) and click the CAPTCHA once;
 * the session cookie is persisted in .playwright-profile.
 */

import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright-core';
import { ROOT, clean, firstLine, fmtDur, parseDur, safeName } from './lib/util.mjs';

// ---------------------------------------------------------------------------
// Config & shared helpers
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const rawFilter = args.find((a) => !a.startsWith('--')) || '';

const TARGET_URL =
  process.env.WORLDS_URL ||
  'https://liquipedia.net/leagueoflegends/World_Championship/2026/Swiss_Stage';
const PROFILE_DIR = path.join(ROOT, '.playwright-profile');
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const MATCH_SELECTOR =
  '.brkts-matchlist-match.brkts-match-has-details, .brkts-match.brkts-match-has-details';

const playedGames = (m) => (parseInt(m.scoreA, 10) || 0) + (parseInt(m.scoreB, 10) || 0);

const log = (...m) => console.log('[Scraper]', ...m);
const warn = (...m) => console.warn('[Scraper] WARN:', ...m);
const die = (msg) => {
  console.error('[Scraper] ' + msg);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// Browser-side extraction (self-contained functions handed to page.evaluate)
// ---------------------------------------------------------------------------

/**
 * Per-game readers for a match detail page. All are self-contained (handed
 * to page.evaluate): they resolve the game's DOM root themselves — the whole
 * .match-bm for Bo1 (no toggle pills), otherwise the
 * [data-toggle-area-content="pill"] area for the clicked pill (pill 1 =
 * Overall Statistics; pill N+2 = Game N+1).
 */
/** Duration + win side of the ACTIVE game (call after switching pills). */
function readGameOverview(pill) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const bm = document.querySelector('.match-bm');
  if (!bm) return null;
  let root = bm;
  if (pill != null) {
    const btn = document.querySelector('[data-toggle-area-btn="' + pill + '"]');
    if (!btn) return null;
    root = (btn.closest('.content-switch-content-container') || document).querySelector(
      '[data-toggle-area-content="' + pill + '"]'
    );
    if (!root) return null;
  }
  const g = root.querySelector('.match-bm-lol-game-overview');
  if (!g) return null;
  const len = clean((g.querySelector('.match-bm-lol-game-summary-length') || {}).innerText);
  const score = clean((g.querySelector('.match-bm-lol-game-summary-score') || {}).innerText);
  // Score text is like "W–L" / "L–W": the FIRST side is team A of the series.
  return {
    duration: /^\d{1,2}:\d{2}/.test(len) ? len : null,
    aWin: /^[WW]/i.test(score),
    bWin: /[WW]\s*$/.test(score),
  };
}

/**
 * Rosters (role, player, champion) of the ACTIVE game's "Player Performance"
 * section (.match-bm-players-wrapper holds one .match-bm-players-team per
 * side, each with 5 .match-bm-players-player). Returns [{name, players}] in
 * DOM order (team A first).
 */
function readPlayerPerformance(pill) {
  const bm = document.querySelector('.match-bm');
  if (!bm) return null;
  let root = bm;
  if (pill != null) {
    const btn = document.querySelector('[data-toggle-area-btn="' + pill + '"]');
    if (!btn) return null;
    root = (btn.closest('.content-switch-content-container') || document).querySelector(
      '[data-toggle-area-content="' + pill + '"]'
    );
    if (!root) return null;
  }
  const wrapper = root.querySelector('.match-bm-players-wrapper');
  if (!wrapper) return null;
  return Array.from(wrapper.querySelectorAll(':scope > .match-bm-players-team')).map((t) => ({
    name: (t.querySelector('.match-bm-players-team-header a[title]') || {}).title || '',
    players: Array.from(t.querySelectorAll('.match-bm-players-player')).map((pl) => ({
      role: (pl.querySelector('.match-bm-players-player-role img') || {}).title || null,
      name: (pl.querySelector('.match-bm-players-player-name a') || {}).title || '',
      champion:
        (pl.querySelector('.match-bm-players-player-icon a') || {}).title ||
        ((pl.querySelector('.match-bm-players-player-name i') || {}).textContent || '').trim() ||
        null,
    })),
  }));
}

/** Wraps the active game's "Player Performance" section for element capture. */
function wrapPPSection(pill) {
  const bm = document.querySelector('.match-bm');
  if (!bm) return null;
  let root = bm;
  if (pill != null) {
    const btn = document.querySelector('[data-toggle-area-btn="' + pill + '"]');
    if (!btn) return null;
    root = (btn.closest('.content-switch-content-container') || document).querySelector(
      '[data-toggle-area-content="' + pill + '"]'
    );
    if (!root) return false;
  }
  const heads = Array.from(root.querySelectorAll('.mw-heading'));
  const idx = heads.findIndex(
    (h) => /player performance/i.test(h.textContent || '') && !/overall/i.test(h.textContent || '')
  );
  if (idx < 0) return false;
  const parent = heads[idx].parentElement;
  if (!parent) return false;
  const kids = Array.from(parent.children);
  const start = kids.indexOf(heads[idx]);
  const end = kids.indexOf(heads[idx + 1]);
  if (start < 0 || (idx + 1 < heads.length && end <= start)) return false;
  const slice = end > start ? kids.slice(start, end) : kids.slice(start);
  const wrap = document.createElement('div');
  wrap.id = 'pp-scrape-shot';
  parent.insertBefore(wrap, slice[0]);
  slice.forEach((el) => wrap.appendChild(el));
  return true;
}

/** Restores the DOM after wrapPPSection. */
function unwrapPPSection() {
  const wrap = document.getElementById('pp-scrape-shot');
  if (!wrap) return;
  const parent = wrap.parentElement;
  while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
  wrap.remove();
}
/**
 * Extracts every completed match (teams, scores, round, bestOf, date) from
 * the bracket. Per-game data is deliberately NOT read here — the standalone
 * detail page is the sole source (filled by enrichFromDetailPage).
 */
function extractMatchList(MONTHS) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const firstLine = (t) => clean(t.split('\n')[0]);
  // Two Liquipedia layouts: the Swiss "matchlist" and the knockout bracket.
  const wrappers = Array.from(
    document.querySelectorAll('.brkts-matchlist-match.brkts-match-has-details, .brkts-match.brkts-match-has-details')
  );
  const stageName = firstLine(clean((location.pathname.split('/').pop() || '').replace(/_/g, ' '))) || 'Knockout Stage';

  const matches = [];
  wrappers.forEach((w, idx) => {
    const popup = w.querySelector('.brkts-popup');
    if (!popup) return;

    // -- Teams / scores / round -------------------------------------------
    let teamA = '', scoreA = '', teamB = '', scoreB = '', roundName = '';
    const cells = Array.from(w.querySelectorAll('.brkts-matchlist-cell'));
    if (cells.length >= 4) {
      [teamA, scoreA, scoreB, teamB] = cells.slice(0, 4).map((c) => clean(c.innerText));
      const container = w.closest('.brkts-matchlist');
      if (container) roundName = firstLine(container.innerText || '');
    } else {
      const entries = Array.from(w.querySelectorAll('.brkts-opponent-entry'));
      if (entries.length < 2) return;
      const readEntry = (e) => ({
        name: clean(e.getAttribute('aria-label') || (e.querySelector('.brkts-opponent-entry-left') || {}).innerText),
        score: clean((e.querySelector('.brkts-opponent-score-inner') || {}).innerText || ''),
      });
      ({ name: teamA, score: scoreA } = readEntry(entries[0]));
      ({ name: teamB, score: scoreB } = readEntry(entries[1]));
      roundName = stageName;
    }

    if (!teamA || !teamB) return;
    if (!scoreA || !scoreB || scoreA === '-' || scoreB === '-' || isNaN(scoreA) || isNaN(scoreB)) return;

    const popupText = popup.innerText;

    // Prefer the popup's own "(BoN)" tag, then the round label.
    const boMatch = popupText.match(/\(Bo(\d)\)/i) || roundName.match(/\(Bo(\d)\)/i);
    const bestOf = boMatch ? parseInt(boMatch[1], 10) : 1;

    // Match date from the popup header: "October 24, 2026 - 01:00 MYT".
    // Parsed as a calendar date (toISOString would shift across midnight).
    let date = null;
    const dateMatch = popupText.match(/([A-Z][a-z]+ \d{1,2}, \d{4})/);
    if (dateMatch) {
      const [mon, day, year] = dateMatch[1].split(/[\s,]+/);
      const mi = MONTHS.indexOf(mon);
      if (mi >= 0) date = year + '-' + String(mi + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }

    const nA = parseInt(scoreA, 10);
    const nB = parseInt(scoreB, 10);
    matches.push({
      _wrapper: idx,
      date,
      round: roundName,
      bestOf,
      teamA,
      scoreA,
      teamB,
      scoreB,
      winner: nA > nB ? teamA : nB > nA ? teamB : teamA,
      duration: null,
      gameDurations: [],
      games: [],
    });
  });
  return matches;
}

// ---------------------------------------------------------------------------
// Pipeline steps
// ---------------------------------------------------------------------------

/** Step 1: open the target page and wait for the lazily rendered bracket. */
async function openBracket(page) {
  log('Opening page...');
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 90_000 });

  const challenge = await page
    .locator('text=Verify you are human')
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
  if (challenge && !headed) {
    die('Cloudflare CAPTCHA detected. Re-run with --headed (WSLg) and click it once; the cookie persists in .playwright-profile.');
  }

  log('Waiting for match bracket to render...');
  await page
    .waitForSelector(MATCH_SELECTOR, { timeout: 40_000 })
    .catch(() => die(`No match bracket found on ${TARGET_URL}. Wrong URL or Cloudflare-blocked (try --headed).`));
  // Liquipedia renders the bracket lazily round by round via JS — networkidle
  // isn't enough (JS fires in waves), so poll until the wrapper count stabilizes.
  let count = 0;
  for (let stable = 0; stable < 3; ) {
    await page.waitForTimeout(1_500);
    const n = await page.locator(MATCH_SELECTOR).count();
    if (n === count) stable++;
    else { count = n; stable = 0; }
  }
  log(`Bracket ready: ${count} matches.`);
}

/** Step 3: strict single-day (or round-keyword) selection. */
function selectMatches(allMatches) {
  const availableDates = Array.from(new Set(allMatches.map((m) => m.date).filter(Boolean))).sort();
  const failNoMatches = (why) => {
    console.error(`[Scraper] ${why}`);
    console.error(`[Scraper] Dates with completed matches: ${availableDates.join(', ') || '(none)'}`);
    console.error('[Scraper] Refusing to fall back to other days (a day report must be one day).');
    console.error('[Scraper] Use `all` explicitly for TEST-ONLY multi-day scraping.');
    process.exit(1);
  };

  let filtered, testMode = false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawFilter)) {
    filtered = allMatches.filter((m) => m.date === rawFilter);
    if (filtered.length === 0) failNoMatches(`No completed matches for ${rawFilter} on ${TARGET_URL}.`);
  } else if (rawFilter === 'all') {
    testMode = true;
    filtered = allMatches;
    warn('TEST MODE: `all` produces a MULTI-DAY dataset. Do not use it for real inference.');
  } else if (rawFilter) {
    filtered = allMatches.filter((m) => m.round.toLowerCase().includes(rawFilter.toLowerCase()));
    if (filtered.length === 0) failNoMatches(`No matches matching round keyword "${rawFilter}".`);
  } else {
    filtered = allMatches.filter((m) => m.date === useDate);
    if (filtered.length === 0) failNoMatches(`No completed matches for today (${useDate}) on ${TARGET_URL}.`);
  }
  if (!testMode) {
    const days = Array.from(new Set(filtered.map((m) => m.date).filter(Boolean)));
    if (days.length > 1) die(`Refusing to write a multi-day dataset (${days.join(', ')}).`);
  }
  log(`Selected ${filtered.length} matches${testMode ? ' (TEST MODE, multi-day)' : ` for ${useDate}`} (of ${allMatches.length} total).`);
  return { matches: filtered, testMode };
}

/** "View match details" href from a match's popup, or null. */
async function detailHref(wrappers, m) {
  try {
    return await wrappers
      .nth(m._wrapper)
      .locator('.brkts-popup')
      .evaluate((el) => {
        const a = Array.from(el.querySelectorAll('a')).find((x) => /View match details/i.test(x.innerText || ''));
        return a ? a.href : null;
      });
  } catch {
    return null;
  }
}

/** Switch a detail page to Game N (pill N+2); no-op for Bo1. */
async function switchGame(detailPage, pill) {
  if (pill == null) return;
  try {
    await detailPage.locator(`[data-toggle-area-btn="${pill}"]`).evaluate((el) => el.click());
  } catch {}
  await detailPage.waitForTimeout(300);
}

/**
 * Step 3b: one detail-page visit per match fills games (duration, winner,
 * rosters) + series duration. Detail pages carry no player data for the
 * overview; rosters come from each game's Player Performance section.
 */
async function enrichFromDetailPage(detailPage, m, href) {
  await detailPage.goto(href, { waitUntil: 'networkidle', timeout: 90_000 });
  await detailPage.waitForTimeout(2_000);

  const played = playedGames(m);
  const games = [];
  for (let gi = 0; gi < played; gi++) {
    const pill = played > 1 ? gi + 2 : null;
    await switchGame(detailPage, pill);
    const row = await detailPage.evaluate(readGameOverview, pill).catch(() => null);
    if (!row) {
      warn(`  no game overview for Game ${gi + 1} (${m.teamA} vs ${m.teamB}).`);
      continue;
    }
    const teams = await detailPage.evaluate(readPlayerPerformance, pill).catch(() => null);
    // Team names on the detail page can be the long form ("Hanwha Life
    // Esports") while the bracket uses short tags ("HLE") — match by name,
    // fall back to DOM order (team A first).
    const ta = teams && (teams.find((t) => t.name === m.teamA) || teams[0]);
    const tb = teams && (teams.find((t) => t.name === m.teamB) || teams[1]);
    if (!teams || !ta || !tb || !ta.players.length) {
      warn(`  no Player Performance rosters for Game ${gi + 1} (${m.teamA} vs ${m.teamB}).`);
    }
    games.push({
      game: gi + 1,
      duration: row.duration,
      winner: row.aWin ? m.teamA : row.bWin ? m.teamB : null,
      teamA: { name: m.teamA, players: ta ? ta.players : [] },
      teamB: { name: m.teamB, players: tb ? tb.players : [] },
    });
  }

  m.games = games;
  const secs = games.map((g) => parseDur(g.duration)).filter((v) => v != null);
  m.duration = secs.length ? fmtDur(secs.reduce((a, b) => a + b, 0)) : null;
  m.gameDurations = games.map((g) => g.duration);
  log(`  read ${games.length}/${played} games from detail page (series total: ${m.duration ?? 'unknown'})`);
}

/** Step 4: one "Player Performance" section screenshot per played game. */
async function capturePPShots(detailPage, m, href, dirs, idx, total) {
  await detailPage.goto(href, { waitUntil: 'networkidle', timeout: 90_000 });
  await detailPage.waitForTimeout(2_000);
  let count = 0;

  for (let gi = 0; gi < m.games.length; gi++) {
    const gameNum = m.games[gi].game || gi + 1;
    const pill = m.games.length > 1 ? gi + 2 : null;
    await switchGame(detailPage, pill);
    const wrapped = await detailPage.evaluate(wrapPPSection, pill).catch(() => false);
    if (!wrapped) {
      warn(`  [${idx}/${total}] no Player Performance section for Game ${gameNum} (${m.teamA} vs ${m.teamB}); skipping.`);
      continue;
    }
    const fname = shotFilename(m, gameNum);
    let saved = 0;
    try {
      await detailPage.locator('#pp-scrape-shot').screenshot({ path: path.join(dirs.shotDir, fname) });
      saveShot(m, dirs, fname, gi);
      saved++;
      log(`  [${idx}/${total}] ${fname}`);
    } catch (e) {
      warn(`  [${idx}/${total}] screenshot failed for ${fname}: ${e.message.split('\n')[0]}`);
    } finally {
      await detailPage.evaluate(unwrapPPSection).catch(() => {});
    }
    count += saved;
  }
  return count;
}

function shotFilename(m, gameNum) {
  const multi = m.games.length > 1 ? `_g${gameNum}` : '';
  return `${safeName(m.teamA)}_vs_${safeName(m.teamB)}${multi}.png`;
}

function saveShot(m, dirs, fname, gi) {
  fs.copyFileSync(path.join(dirs.shotDir, fname), path.join(dirs.publicShotDir, fname));
  m.games[gi].screenshot = `worlds/screenshots/${fname}`;
}

/** Integrity: a decided series should expose one readable game per game played. */
function reportIntegrity(matches) {
  for (const m of matches) {
    const played = playedGames(m);
    if (m.games.length < played || !m.duration) {
      warn(
        `${m.teamA} ${m.scoreA}-${m.scoreB} ${m.teamB} has incomplete game details ` +
          `(${m.games.length}/${played} games read, duration ${m.duration ?? 'UNKNOWN'}). ` +
          "Liquipedia hasn't published the full breakdown yet; totals stay empty."
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const useDate = /^\d{4}-\d{2}-\d{2}$/.test(rawFilter) ? rawFilter : new Date().toISOString().slice(0, 10);
log(`Target page: ${TARGET_URL}`);
log(`Filter: "${rawFilter || '(none)'}" | Output date: ${useDate}`);

const context = await chromium
  .launchPersistentContext(PROFILE_DIR, {
    headless: !headed,
    viewport: { width: 1600, height: 1000 },
  })
  .catch((e) => die(`Could not launch Chromium (${e.message.split('\n')[0]}). If the profile is locked, close the other browser and retry.`));

try {
  const page = await context.newPage();
  await openBracket(page);

  // 2. Extract every completed match.
  log('Extracting match data...');
  const allMatches = await page.evaluate(extractMatchList, MONTHS);
  if (!Array.isArray(allMatches) || allMatches.length === 0) {
    die(`Extraction returned 0 matches from ${TARGET_URL}.`);
  }

  // 3. Filter to ONE day (strict; `all` is TEST-ONLY multi-day mode).
  const { matches } = selectMatches(allMatches);

  // 3b + 4. One detail-page visit per match: fill game data, then capture the
  // "Player Performance" section screenshot per game. Matches without a
  // usable detail page fall back to popup capture (overview tabs).
  const wrappers = page.locator(MATCH_SELECTOR);
  const dirs = {
    shotDir: path.join(ROOT, `output/screenshots/${useDate}`),
    publicShotDir: path.join(ROOT, 'remotion/public/worlds/screenshots'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

  const detailPage = await context.newPage().catch(() => null);
  if (detailPage) await detailPage.setViewportSize({ width: 1600, height: 2000 }).catch(() => {});
  let captured = 0;

  log('Reading detail pages + capturing Player Performance screenshots...');
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!playedGames(m) || !detailPage) continue;

    const href = await detailHref(wrappers, m);
    if (!href) {
      warn(`No "View match details" link for ${m.teamA} vs ${m.teamB}; details stay unavailable.`);
      continue;
    }
    log(`${m.teamA} vs ${m.teamB}: ${href}`);
    try {
      await enrichFromDetailPage(detailPage, m, href);
      const before = captured;
      await capturePPShots(detailPage, m, href, dirs, i + 1, matches.length);
      captured = before + m.games.filter((g) => g.screenshot).length;
    } catch (e) {
      const state = detailPage.isClosed() ? '(closed)' : `url=${detailPage.url()}`;
      warn(`Detail page processing failed for ${m.teamA} vs ${m.teamB}: ${e.message.split('\n')[0]} [${state}]; game details stay partial.`);
    }
  }
  await detailPage?.close().catch(() => {});

  reportIntegrity(matches);

  // 5. Write the dataset (strip the internal wrapper-index marker).
  const dataset = matches.map(({ _wrapper, ...rest }) => rest);
  const jsonPath = path.join(ROOT, `output/data/${useDate}`, 'matches.json');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(dataset, null, 2), 'utf-8');
  log(`Saved dataset (${dataset.length} matches, ${captured} screenshots) to ${jsonPath}.`);
} finally {
  await context.close().catch(() => {});
}
