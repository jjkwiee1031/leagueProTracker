/**
 * Small shared helpers for the scripts (duration parsing, filename safety,
 * CLI flag parsing).
 */
import path from 'path';

/** Repo root (scripts/lib/../..), independent of caller cwd. */
export const ROOT = path.resolve(import.meta.dirname, '../..');

/** "26:01" | "1:04:11" -> seconds; null when not parseable. */
export const parseDur = (s) => {
  const p = String(s || '').split(':').map((n) => parseInt(n, 10));
  if (p.length === 2 && p.every((n) => !isNaN(n))) return p[0] * 60 + p[1];
  if (p.length === 3 && p.every((n) => !isNaN(n))) return p[0] * 3600 + p[1] * 60 + p[2];
  return null;
};

/** seconds -> "m:ss" or "h:mm:ss"; null passthrough. */
export const fmtDur = (sec) => {
  if (sec == null) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(sec / 3600);
  return h
    ? h + ':' + pad(Math.floor((sec % 3600) / 60)) + ':' + pad(sec % 60)
    : Math.floor(sec / 60) + ':' + pad(sec % 60);
};

/** Filesystem-safe name fragment ("Top Esports" -> "Top_Esports"). */
export const safeName = (s) =>
  String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');

/** Squash whitespace; null/undefined -> ''. */
export const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** First line of a text block, whitespace-cleaned. */
export const firstLine = (t) => clean(String(t || '').split('\n')[0]);

/**
 * Simple CLI flag reader: flag('--out') -> value or null; flag('--dry-run')
 * (no value) -> true.
 */
export function flag(argv, name, { value = true } = {}) {
  const i = argv.indexOf(name);
  if (i < 0) return value ? null : false;
  return value ? argv[i + 1] ?? null : true;
}

/** Valid YYYY-MM-DD or today (UTC). */
export const dateArg = (s) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : new Date().toISOString().slice(0, 10);
