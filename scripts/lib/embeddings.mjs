/**
 * OpenRouter embeddings client (OpenAI-compatible POST /api/v1/embeddings).
 * Model: openai/text-embedding-3-small → 1536-dim vectors.
 * Env: EMBEDDING_API_KEY or OPENROUTER_API_KEY (leagueProDB/.env works).
 */
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

export const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;

function loadEmbeddingEnv(root = REPO_ROOT) {
  try {
    const envPath = path.resolve(root, 'leagueProDB/.env');
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^\s*(EMBEDDING_API_KEY|OPENROUTER_API_KEY)\s*=\s*(.+)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env, fine */ }
}

export function embeddingKey(root = REPO_ROOT) {
  loadEmbeddingEnv(root);
  return process.env.EMBEDDING_API_KEY || process.env.OPENROUTER_API_KEY || null;
}

/**
 * Embed a batch of texts. Returns { embedding, usage } for a single string,
 * or an ordered array of embeddings for an array input.
 * Retries transient failures up to 3 times.
 */
export async function embed(texts, { model = EMBEDDING_MODEL, attempts = 3 } = {}) {
  const key = embeddingKey();
  if (!key) throw new Error('Missing EMBEDDING_API_KEY / OPENROUTER_API_KEY (leagueProDB/.env or env)');

  const single = typeof texts === 'string';
  const input = single ? [texts] : texts;
  if (input.length === 0) return [];

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OpenRouter embeddings ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = await res.json();
      const vectors = json.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
      if (vectors.some((v) => v.length !== EMBEDDING_DIMS)) {
        throw new Error(`Unexpected embedding dims: got ${vectors.map((v) => v.length).join(',')}, want ${EMBEDDING_DIMS}`);
      }
      return single ? { embedding: vectors[0], usage: json.usage } : vectors;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}
