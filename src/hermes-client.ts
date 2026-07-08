/**
 * Hermes LLM client — shared by fact-extractor and article-synthesizer.
 *
 * When Hermes Agent is available (local cron), delegates AI calls to
 * `hermes chat --quiet` via stdin. When unavailable (CI), returns null
 * so callers fall back to deterministic extraction.
 *
 * Detection: `HERMES_AVAILABLE=0` or `CI=true` → skip.
 * Otherwise checks for `hermes` on PATH.
 */

import { execSync } from 'node:child_process';

const FORCE_SKIP =
  process.env['HERMES_AVAILABLE'] === '0' || process.env['CI'] === 'true';

function hermesOnPath(): boolean {
  if (FORCE_SKIP) return false;
  try {
    execSync('which hermes', { timeout: 3000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const AVAILABLE: boolean = hermesOnPath();

export function hermesAvailable(): boolean {
  return AVAILABLE;
}

/**
 * Call Hermes Agent with a prompt, return the raw stdout.
 * Returns null if Hermes is unavailable or the call fails.
 */
export function hermesGenerate(
  prompt: string,
  opts: { timeoutMs?: number; model?: string | undefined } = {},
): string | null {
  if (!AVAILABLE) return null;

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const modelArg = opts.model ? `-m "${opts.model}"` : '';

  try {
    const result = execSync(
      `hermes chat --quiet ${modelArg} <<'HERMES_EOF'\n${prompt}\nHERMES_EOF`,
      { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 100 * 1024, shell: '/bin/bash' },
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Call Hermes and parse the output as JSON matching `schema`.
 * Returns the parsed object or null.
 */
export function hermesGenerateJson<T>(
  prompt: string,
  opts: { timeoutMs?: number; model?: string | undefined } = {},
): T | null {
  const raw = hermesGenerate(prompt, opts);
  if (!raw) return null;

  // Try direct JSON parse
  try { return JSON.parse(raw) as T; } catch {}

  // Try extracting JSON from markdown/code blocks
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]) as T; } catch { return null; }
}
