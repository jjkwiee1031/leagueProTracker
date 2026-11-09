/**
 * Shared pi headless (non-interactive) LLM invocation for the scripts.
 * Callers control behavior via env vars namespaced by a prefix, e.g.:
 *   <PREFIX>_CMD (default `pi`), <PREFIX>_MODEL, <PREFIX>_LLM_TIMEOUT_MS
 */
import { execFileSync } from 'child_process';

/**
 * Runs `pi --print` with the given prompt. Throws on failure with the first
 * lines of stderr (suited to retry loops that feed the error back to the LLM).
 *
 * @param {string} prompt
 * @param {object} opts
 * @param {string} opts.envPrefix  env var namespace (e.g. 'SUMMARY_LLM')
 * @param {string} opts.systemPrompt
 * @param {number} opts.attempt    1-based, for logging
 * @param {string} opts.label      log prefix, e.g. '[Summary]'
 * @param {number} [opts.defaultTimeoutMs=180000]
 * @param {number} [opts.maxBufferMb=10]
 */
export function callPiAgent(prompt, {
  envPrefix, systemPrompt, attempt = 1, label = '[LLM]',
  defaultTimeoutMs = 180_000, maxBufferMb = 10,
}) {
  const cmd = process.env[`${envPrefix}_CMD`] || 'pi';
  const argv = [
    '--print',
    '--no-session',
    '-nt', // no tools: pure text generation
    '--no-context-files', // skip AGENTS.md/CLAUDE.md: pure generation
    '--no-skills',
    '--system-prompt', systemPrompt,
  ];
  // MODEL var may sit at either nesting level: <P>_MODEL or <P>_LLM_MODEL.
  const model = process.env[`${envPrefix}_MODEL`] || process.env[`${envPrefix}_LLM_MODEL`];
  if (model) argv.push('--model', model);
  argv.push(prompt);

  const timeout = Number(process.env[`${envPrefix}_TIMEOUT_MS`] || defaultTimeoutMs);
  console.log(`${label} LLM attempt ${attempt}: ${cmd} (timeout ${timeout}ms)...`);
  try {
    return execFileSync(cmd, argv, {
      encoding: 'utf-8',
      timeout,
      maxBuffer: maxBufferMb * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = (err.stderr ? String(err.stderr) : '') || err.message;
    throw new Error(`LLM invocation failed: ${detail.split('\n').slice(0, 3).join(' ')}`);
  }
}

/** Extracts the first balanced {...} from raw output (tolerates stray prose). */
export function extractJsonObject(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return { __parseError: text.slice(start, i + 1).slice(0, 200) };
        }
      }
    }
  }
  return null;
}
