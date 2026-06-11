/**
 * robots.txt — per-host cache and path checker.
 *
 * Honors the User-Agent "ArdurContentBot" (falling back to "*").
 * Caches parsed results for the lifetime of the process (one 6-hour cycle).
 * Respects Crawl-delay (returned to callers; callers must enforce it).
 */
import { GOOGLE_NEWS_FETCH_HOSTS, normalizePublicUrl } from "./source-safety.js";
const ROBOTS_USER_AGENT = 'ArdurContentBot';
const ROBOTS_FETCH_TIMEOUT_MS = 8_000;
const ROBOTS_MAX_BYTES = 256_000;
// Per-host cache — intentionally module-level (lives for process lifetime).
const cache = new Map();
// Track in-flight fetches to avoid parallel duplicate requests per host.
const inFlight = new Map();
function parseRobotsText(text) {
    const disallowed = [];
    const allowed = [];
    let crawlDelaySeconds = null;
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
        if (colonIdx === -1)
            continue;
        const field = line.slice(0, colonIdx).trim().toLowerCase();
        const value = line.slice(colonIdx + 1).trim();
        if (field === 'user-agent') {
            const ua = value.toLowerCase();
            inRelevantGroup = ua === '*' || ua === ROBOTS_USER_AGENT.toLowerCase();
            continue;
        }
        if (!inRelevantGroup)
            continue;
        if (field === 'disallow') {
            if (value)
                disallowed.push(value);
        }
        else if (field === 'allow') {
            if (value)
                allowed.push(value);
        }
        else if (field === 'crawl-delay') {
            const d = parseFloat(value);
            if (Number.isFinite(d) && d > 0) {
                crawlDelaySeconds = d;
            }
        }
    }
    return { disallowed, allowed, crawlDelaySeconds };
}
function pathAllowed(parsed, urlPath) {
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
async function fetchRobots(host) {
    const robotsUrl = `https://${host}/robots.txt`;
    let text = '';
    try {
        // Validate host is reachable (basic SSRF guard: skip private hosts)
        const validated = normalizePublicUrl(robotsUrl);
        if (!validated) {
            return { disallowed: [], allowed: [], crawlDelaySeconds: null, fetchedAt: Date.now() };
        }
        const resp = await fetch(validated, {
            headers: { 'user-agent': `${ROBOTS_USER_AGENT}/1.0 (+https://ardur.ai/bot)` },
            redirect: 'follow',
            signal: AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS),
        });
        if (resp.ok) {
            const raw = await resp.text();
            text = raw.length > ROBOTS_MAX_BYTES ? raw.slice(0, ROBOTS_MAX_BYTES) : raw;
        }
        // 4xx/5xx = assume allowed (fail-open for robots.txt fetch failures)
    }
    catch {
        // Network error = treat as no restrictions (fail-open)
    }
    const parsed = parseRobotsText(text);
    return { ...parsed, fetchedAt: Date.now() };
}
/**
 * Check whether our bot is allowed to fetch the given URL.
 * Results are cached per-host for the lifetime of the process.
 */
export async function checkRobots(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
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
export function clearRobotsCache() {
    cache.clear();
    inFlight.clear();
}
