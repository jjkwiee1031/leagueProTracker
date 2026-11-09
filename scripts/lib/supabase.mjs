/**
 * Minimal Supabase REST (PostgREST) client used by all DB scripts.
 * No dependency: plain fetch against /rest/v1.
 */
import { supabaseCreds } from './env.mjs';

/**
 * Returns { url, key, rest } or null when credentials are missing.
 * rest(method, pathname, body, prefer?) -> parsed JSON; throws on non-2xx.
 */
export function supabaseRestClient() {
  const creds = supabaseCreds();
  if (!creds) return null;
  const { url, key } = creds;

  async function rest(method, pathname, body, prefer) {
    const res = await fetch(`${url}/rest/v1/${pathname}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Supabase REST ${method} ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : [];
  }

  return { url, key, rest };
}
