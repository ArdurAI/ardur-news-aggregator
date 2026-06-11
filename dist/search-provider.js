/**
 * SearchProvider — pluggable per-topic search discovery beyond the 155-feed catalog.
 *
 * A2: Widen ingestion beyond the curated catalog by querying search providers per
 * topic. Unknown domains discovered this way are tier-classified via the same
 * credibilityHint heuristic and logged for catalog review.
 *
 * Design doc §3.2: keep Google News RSS as the first named provider; other
 * providers (Bing News, Brave, DuckDuckGo) can be added as drop-ins.
 */
import { XMLParser } from 'fast-xml-parser';
import { assertAllowedFetchUrl, readBoundedText, GOOGLE_NEWS_FETCH_HOSTS } from "./source-safety.js";
const SEARCH_USER_AGENT = 'ArdurAI/1.0 (+https://ardur.ai)';
const SEARCH_MAX_BYTES = 1_500_000;
const SEARCH_TIMEOUT_MS = 20_000;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
// ── Domain tier classification ───────────────────────────────────────────────
const KNOWN_PRIMARY_DOMAINS = new Set([
    'openai.com', 'anthropic.com', 'kubernetes.io', 'cloud.google.com',
    'aws.amazon.com', 'azure.microsoft.com', 'nist.gov', 'cncf.io',
]);
const KNOWN_PAPER_DOMAINS = new Set(['arxiv.org', 'paperswithcode.com']);
const KNOWN_TECHNICAL_NEWS = new Set([
    'infoq.com', 'thenewstack.io', 'devops.com', 'sdtimes.com',
    'dzone.com', 'infoworld.com', 'techradar.com',
]);
const KNOWN_SECURITY_NEWS = new Set([
    'thehackernews.com', 'bleepingcomputer.com', 'threatpost.com',
    'krebs onsecurity.com', 'darkreading.com', 'securityweek.com',
]);
export function classifyDiscoveredDomain(domain) {
    if (KNOWN_PRIMARY_DOMAINS.has(domain))
        return { tier: 'primary', credibilityHint: 0.95 };
    if (KNOWN_PAPER_DOMAINS.has(domain))
        return { tier: 'paper', credibilityHint: 0.9 };
    if (KNOWN_TECHNICAL_NEWS.has(domain))
        return { tier: 'technical-news', credibilityHint: 0.8 };
    if (KNOWN_SECURITY_NEWS.has(domain))
        return { tier: 'security-news', credibilityHint: 0.75 };
    // Unknown domain — default tier for catalog review
    return { tier: 'news', credibilityHint: 0.6 };
}
// ── Google News RSS provider ─────────────────────────────────────────────────
function toArray(val) {
    if (val === undefined || val === null)
        return [];
    return Array.isArray(val) ? val : [val];
}
function stripMarkup(text) {
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
export class GoogleNewsSearchProvider {
    name = 'google-news-rss';
    async search(query, _topicId, _now) {
        if (!query)
            return [];
        const url = new URL('https://news.google.com/rss/search');
        url.searchParams.set('q', query);
        url.searchParams.set('hl', 'en-US');
        url.searchParams.set('gl', 'US');
        url.searchParams.set('ceid', 'US:en');
        let feedUrl;
        try {
            feedUrl = assertAllowedFetchUrl(url.toString(), GOOGLE_NEWS_FETCH_HOSTS);
        }
        catch {
            return [];
        }
        try {
            const response = await fetch(feedUrl, {
                headers: { 'user-agent': SEARCH_USER_AGENT },
                redirect: 'error',
                signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
            });
            if (!response.ok)
                return [];
            const xml = await readBoundedText(response, {
                maxBytes: SEARCH_MAX_BYTES,
                label: 'google-news-search',
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const parsed = parser.parse(xml);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const channel = parsed['rss']?.['channel'];
            if (!channel)
                return [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const items = toArray(channel['item']);
            const results = [];
            for (const item of items) {
                const rawTitle = String(item['title'] ?? '');
                const rawUrl = String(item['link'] ?? '');
                const pubDate = String(item['pubDate'] ?? '');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const sourceEl = item['source'];
                const sourceLabel = typeof sourceEl === 'object' && sourceEl !== null
                    ? String(sourceEl['#text'] ?? '')
                    : '';
                if (!rawUrl)
                    continue;
                let domain = '';
                try {
                    domain = new URL(rawUrl).hostname.replace(/^www\./, '');
                }
                catch {
                    continue;
                }
                const result = {
                    url: rawUrl,
                    title: stripMarkup(rawTitle),
                    domain,
                };
                if (pubDate)
                    result.publishedAt = pubDate;
                if (sourceLabel)
                    result.sourceLabel = sourceLabel;
                results.push(result);
            }
            return results;
        }
        catch {
            return [];
        }
    }
}
// ── Provider registry ────────────────────────────────────────────────────────
/** Returns the default set of search providers used in production. */
export function defaultSearchProviders() {
    return [new GoogleNewsSearchProvider()];
}
/**
 * Run all providers for a topic query, de-duplicate by URL, and return
 * the merged result set. Logs newly-discovered domains for catalog review.
 */
export async function searchAllProviders(query, topicId, now, providers, knownDomains, onNewDomain) {
    if (!query || providers.length === 0)
        return [];
    const settled = await Promise.allSettled(providers.map((p) => p.search(query, topicId, now)));
    const seenUrls = new Set();
    const merged = [];
    for (const result of settled) {
        if (result.status === 'rejected')
            continue;
        for (const item of result.value) {
            if (!item.url || seenUrls.has(item.url))
                continue;
            seenUrls.add(item.url);
            merged.push(item);
            if (!knownDomains.has(item.domain) && onNewDomain) {
                const classification = classifyDiscoveredDomain(item.domain);
                onNewDomain(item.domain, classification);
            }
        }
    }
    return merged;
}
