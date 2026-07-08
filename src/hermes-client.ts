/**
 * Hermes LLM client — shared by fact-extractor and article-synthesizer.
 *
 * When Hermes Agent is available (local cron), delegates AI calls to
 * `hermes chat -q` via a temp file. When unavailable (CI), returns null
 * so callers fall back to deterministic extraction.
 *
 * Detection: `HERMES_AVAILABLE=0` or `CI=true` → skip.
 * Otherwise checks for `hermes` on PATH (lazy, not at import time).
 */

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const FORCE_SKIP =
  process.env['HERMES_AVAILABLE'] === '0' || process.env['CI'] === 'true';

let _checked = false;
let _available = false;

export function hermesAvailable(): boolean {
  if (FORCE_SKIP) return false;
  if (_checked) return _available;
  _checked = true;
  try {
    execSync('which hermes', { timeout: 3000, stdio: 'ignore' });
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

/**
 * Call Hermes Agent with a prompt, return the raw stdout.
 * Returns null if Hermes is unavailable or the call fails.
 */
export function hermesGenerate(
  prompt: string,
  opts: { timeoutMs?: number; model?: string | undefined } = {},
): string | null {
  if (!hermesAvailable()) return null;

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const modelArg = opts.model ? `-m "${opts.model}"` : '';
  const tmpFile = join(tmpdir(), `hermes-prompt-${randomUUID()}.txt`);

  try {
    writeFileSync(tmpFile, prompt, 'utf8');
    const result = execSync(
      `hermes chat -q "$(cat '${tmpFile}')" ${modelArg} --quiet`,
      { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 100 * 1024, shell: '/bin/bash' },
    );
    return result.trim() || null;
  } catch {
    return null;
  } finally {
    try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch {}
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
