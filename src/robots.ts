/**
 * robots.txt — per-host cache and path checker.
 *
 * Honors the User-Agent "ArdurContentBot" (falling back to "*").
 * Caches parsed results for the lifetime of the process (one 6-hour cycle).
 * Respects Crawl-delay (returned to callers; callers must enforce it).
 */

import { GOOGLE_NEWS_FETCH_HOSTS, normalizePublicUrl } from './source-safety.ts';

const ROBOTS_USER_AGENT = 'ArdurContentBot';
const ROBOTS_FETCH_TIMEOUT_MS = 8_000;
const ROBOTS_MAX_BYTES = 256_000;

export interface RobotsResult {
  /** Whether our bot is allowed to fetch this URL. */
  allowed: boolean;
  /** Crawl-delay in seconds, if specified. */
  crawlDelaySeconds: number | null;
}

interface ParsedRobots {
  /** Paths disallowed for our agent (or * fallback). */
  disallowed: string[];
  /** Paths allowed for our agent (or * fallback) — overrides disallowed when more specific. */
  allowed: string[];
  crawlDelaySeconds: number | null;
  /** Timestamp (ms) when this was fetched. */
  fetchedAt: number;
}

// Per-host cache — intentionally module-level (lives for process lifetime).
const cache = new Map<string, ParsedRobots>();
// Track in-flight fetches to avoid parallel duplicate requests per host.
const inFlight = new Map<string, Promise<ParsedRobots>>();

function parseRobotsText(text: string): { disallowed: string[]; allowed: string[]; crawlDelaySeconds: number | null } {
  const disallowed: string[] = [];
  const allowed: string[] = [];
  let crawlDelaySeconds: number | null = null;

  // robots.txt is line-based; we extract relevant groups
  // Track which agent group we're in (null = not in a relevant group)
  let inRelevantGroup = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) {
      inRelevantGroup = false;
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === 'user-agent') {
      const ua = value.toLowerCase();
      inRelevantGroup = ua === '*' || ua === ROBOTS_USER_AGENT.toLowerCase();
      continue;
    }

    if (!inRelevantGroup) continue;

    if (field === 'disallow') {
      if (value) disallowed.push(value);
    } else if (field === 'allow') {
      if (value) allowed.push(value);
    } else if (field === 'crawl-delay') {
      const d = parseFloat(value);
      if (Number.isFinite(d) && d > 0) {
        crawlDelaySeconds = d;
      }
    }
  }

  return { disallowed, allowed, crawlDelaySeconds };
}

function pathAllowed(parsed: ParsedRobots, urlPath: string): boolean {
  // Most specific matching rule wins
  let bestMatchLen = -1;
  let bestAllowed = true; // default allow when no rule matches

  for (const pattern of parsed.disallowed) {
    if (urlPath.startsWith(pattern) && pattern.length > bestMatchLen) {
      bestMatchLen = pattern.length;
      bestAllowed = false;
    }
  }
  for (const pattern of parsed.allowed) {
    if (urlPath.startsWith(pattern) && pattern.length > bestMatchLen) {
      bestMatchLen = pattern.length;
      bestAllowed = true;
    }
  }
  return bestAllowed;
}

async function fetchRobots(host: string): Promise<ParsedRobots> {
  const robotsUrl = `https://${host}/robots.txt`;
  let text = '';
  try {
    // Validate host is reachable (basic SSRF guard: skip private hosts)
    const validated = normalizePublicUrl(robotsUrl);
    if (!validated) {
      return { disallowed: [], allowed: [], crawlDelaySeconds: null, fetchedAt: Date.now() };
    }

    let resp: Response;
    try {
      resp = await fetch(validated, {
        headers: { 'user-agent': `${ROBOTS_USER_AGENT}/1.0 (+https://ardur.ai/bot)` },
        redirect: 'error',
        signal: AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS),
      });
    } catch {
      // Network error, redirect, or timeout — fail-open (no restrictions assumed).
      // Do NOT follow redirects: a redirect could point at an internal host that
      // passed the initial normalizePublicUrl check but shouldn't be re-fetched
      // without re-validation.
      const empty = parseRobotsText('');
      return { ...empty, fetchedAt: Date.now() };
    }

    if (resp.ok) {
      const raw = await resp.text();
      text = raw.length > ROBOTS_MAX_BYTES ? raw.slice(0, ROBOTS_MAX_BYTES) : raw;
    }
    // 4xx/5xx = assume allowed (fail-open for robots.txt fetch failures)
  } catch {
    // Outer catch: normalizePublicUrl threw or other unexpected error — no restrictions.
  }

  const parsed = parseRobotsText(text);
  return { ...parsed, fetchedAt: Date.now() };
}

/**
 * Check whether our bot is allowed to fetch the given URL.
 * Results are cached per-host for the lifetime of the process.
 */
export async function checkRobots(url: string): Promise<RobotsResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, crawlDelaySeconds: null };
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname || '/';

  // Google News is always allowed (it's our own feed)
  if (GOOGLE_NEWS_FETCH_HOSTS.has(host)) {
    return { allowed: true, crawlDelaySeconds: null };
  }

  if (!cache.has(host)) {
    // Deduplicate parallel fetches for the same host
    if (!inFlight.has(host)) {
      const promise = fetchRobots(host).then((result) => {
        cache.set(host, result);
        inFlight.delete(host);
        return result;
      });
      inFlight.set(host, promise);
    }
    await inFlight.get(host);
  }

  const robotsData = cache.get(host);
  if (!robotsData) {
    return { allowed: true, crawlDelaySeconds: null };
  }

  return {
    allowed: pathAllowed(robotsData, path),
    crawlDelaySeconds: robotsData.crawlDelaySeconds,
  };
}

/** Clear the robots cache (for testing). */
export function clearRobotsCache(): void {
  cache.clear();
  inFlight.clear();
}
