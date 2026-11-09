#!/usr/bin/env node
/**
 * Pre-render asset guard.
 *
 * Every screenshot referenced by the latest run's matches.json must exist under
 * remotion/public, otherwise the render silently produces a broken/blank image.
 * Fails loudly instead (consistent with the pipeline's "no silent fallback" rule).
 *
 * Usage: node scripts/check_assets.mjs [publicDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Default to <repo>/remotion/public regardless of the caller's cwd.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.resolve(process.argv[2] || path.join(repoRoot, 'remotion/public'));
const matchesPath = path.join(publicDir, 'worlds/matches.json');

if (!fs.existsSync(matchesPath)) {
  console.error(`[Assets] Missing ${matchesPath} — run the scrape stage first.`);
  process.exit(1);
}

const matches = JSON.parse(fs.readFileSync(matchesPath, 'utf8'));
const missing = [];

for (const m of matches) {
  const shots = (m.games || []).map((g) => g.screenshot).filter(Boolean);
  for (const s of shots) {
    if (!fs.existsSync(path.join(publicDir, s))) {
      missing.push(`${s}  (${m.teamA} ${m.scoreA}-${m.scoreB} ${m.teamB})`);
    }
  }
}

if (missing.length) {
  console.error(`[Assets] ${missing.length} screenshot(s) referenced by matches.json are missing:`);
  for (const line of missing) console.error(`  - ${line}`);
  console.error('[Assets] Restore them (output/screenshots/<DATE>/) or re-run the scrape stage.');
  process.exit(1);
}

console.log(`[Assets] OK — all screenshots for ${matches.length} match(es) present.`);
