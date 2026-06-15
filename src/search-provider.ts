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
import { assertAllowedFetchUrl, readBoundedText, normalizePublicUrl, GOOGLE_NEWS_FETCH_HOSTS } from './source-safety.ts';
import type { SourceTier } from '@ardurai/contracts';
import { stripMarkup } from './util.ts';

const SEARCH_USER_AGENT = 'ArdurAI/1.0 (+https://ardur.ai)';
const SEARCH_MAX_BYTES = 1_500_000;
const SEARCH_TIMEOUT_MS = 20_000;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// ── Interface ────────────────────────────────────────────────────────────────

export interface SearchResult {
  url: string;
  title: string;
  domain: string;
  publishedAt?: string;
  sourceLabel?: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, topicId: string, now: Date): Promise<SearchResult[]>;
}

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
  'krebsonsecurity.com', 'darkreading.com', 'securityweek.com',
]);

export function classifyDiscoveredDomain(domain: string): { tier: SourceTier; credibilityHint: number } {
  if (KNOWN_PRIMARY_DOMAINS.has(domain)) return { tier: 'primary', credibilityHint: 0.95 };
  if (KNOWN_PAPER_DOMAINS.has(domain)) return { tier: 'paper', credibilityHint: 0.9 };
  if (KNOWN_TECHNICAL_NEWS.has(domain)) return { tier: 'technical-news', credibilityHint: 0.8 };
  if (KNOWN_SECURITY_NEWS.has(domain)) return { tier: 'security-news', credibilityHint: 0.75 };
  // Unknown domain — default tier for catalog review
  return { tier: 'news', credibilityHint: 0.6 };
}

// ── Google News RSS provider ─────────────────────────────────────────────────

function toArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

export class GoogleNewsSearchProvider implements SearchProvider {
  readonly name = 'google-news-rss';

  async search(query: string, _topicId: string, _now: Date): Promise<SearchResult[]> {
    if (!query) return [];

    const url = new URL('https://news.google.com/rss/search');
    url.searchParams.set('q', query);
    url.searchParams.set('hl', 'en-US');
    url.searchParams.set('gl', 'US');
    url.searchParams.set('ceid', 'US:en');

    let feedUrl: string;
    try {
      feedUrl = assertAllowedFetchUrl(url.toString(), GOOGLE_NEWS_FETCH_HOSTS);
    } catch {
      return [];
    }

    try {
      const response = await fetch(feedUrl, {
        headers: { 'user-agent': SEARCH_USER_AGENT },
        redirect: 'error',
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });

      if (!response.ok) return [];

      const xml = await readBoundedText(response, {
        maxBytes: SEARCH_MAX_BYTES,
        label: 'google-news-search',
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = parser.parse(xml) as Record<string, any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const channel = parsed['rss']?.['channel'] as Record<string, any> | undefined;
      if (!channel) return [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: any[] = toArray(channel['item']);
      const results: SearchResult[] = [];

      for (const item of items) {
        const rawTitle: string = String(item['title'] ?? '');
        const rawUrl: string = String(item['link'] ?? '');
        const pubDate: string = String(item['pubDate'] ?? '');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sourceEl = item['source'] as Record<string, any> | string | undefined;
        const sourceLabel =
          typeof sourceEl === 'object' && sourceEl !== null
            ? String(sourceEl['#text'] ?? '')
            : '';

        if (!rawUrl) continue;

        // Normalize through SSRF guard before surfacing to callers (#20)
        const normalizedUrl = normalizePublicUrl(rawUrl, { allowHttp: true });
        if (!normalizedUrl) continue;

        let domain = '';
        try {
          domain = new URL(normalizedUrl).hostname.replace(/^www\./, '');
        } catch {
          continue;
        }

        const result: SearchResult = {
          url: normalizedUrl,
          title: stripMarkup(rawTitle),
          domain,
        };
        if (pubDate) result.publishedAt = pubDate;
        if (sourceLabel) result.sourceLabel = sourceLabel;
        results.push(result);
      }

      return results;
    } catch {
      return [];
    }
  }
}

// ── Provider registry ────────────────────────────────────────────────────────

/** Returns the default set of search providers used in production. */
export function defaultSearchProviders(): SearchProvider[] {
  return [new GoogleNewsSearchProvider()];
}

/**
 * Run all providers for a topic query, de-duplicate by URL, and return
 * the merged result set. Logs newly-discovered domains for catalog review.
 */
export async function searchAllProviders(
  query: string,
  topicId: string,
  now: Date,
  providers: SearchProvider[],
  knownDomains: Set<string>,
  onNewDomain?: (domain: string, classification: { tier: SourceTier; credibilityHint: number }) => void,
): Promise<SearchResult[]> {
  if (!query || providers.length === 0) return [];

  const settled = await Promise.allSettled(providers.map((p) => p.search(query, topicId, now)));
  const seenUrls = new Set<string>();
  const merged: SearchResult[] = [];

  for (const result of settled) {
    if (result.status === 'rejected') continue;
    for (const item of result.value) {
      if (!item.url || seenUrls.has(item.url)) continue;
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
