/**
 * Loads Supabase credentials from leagueProDB/.env (without overriding real
 * env vars). The single source of env-credential truth for every script.
 */
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** Parse leagueProDB/.env into process.env (SUPABASE_URL/KEY/SECRET_KEY). */
export function loadSupabaseEnv(root = REPO_ROOT) {
  try {
    const envPath = path.resolve(root, 'leagueProDB/.env');
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^\s*(SUPABASE_URL|SUPABASE_KEY|SUPABASE_SECRET_KEY)\s*=\s*(.+)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env, fine */ }
}

/** Supabase creds after loadSupabaseEnv(): { url, key } or null when unset. */
export function supabaseCreds(root = REPO_ROOT) {
  loadSupabaseEnv(root);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY;
  return url && key ? { url, key } : null;
}
