/**
 * Ingestion — fetch one source, parse its feed, emit normalized raw items.
 * Ported from fetchTopic/splitTitle/publishedDate in refresh-news.mjs and extended
 * to support direct RSS, Google News RSS meta-feed, and Atom/JSON (e.g. arXiv).
 */

import { XMLParser } from 'fast-xml-parser';
import type { SourceTier } from '@ardurai/contracts';
import type { SourceDefinition, TopicDefinition } from './source-types.ts';
import {
  assertAllowedFetchUrl,
  readBoundedText,
  normalizePublicUrl,
  GOOGLE_NEWS_FETCH_HOSTS,
  DEFAULT_FETCH_PORTS,
} from './source-safety.ts';
import { stripMarkup } from './util.ts';

export interface RawItem {
  topic: string;
  topicLabel: string;
  title: string;
  source: string;
  sourceDomain: string;
  sourceUrl: string;
  url: string;
  tier: SourceTier;
  publishedAt: string;
  summaryHint: string;
  feedRank: number;
  /** Full article text shipped in the feed (content:encoded / Atom content), stripped of HTML. */
  feedBody?: string;
}

export interface IngestResult {
  source: SourceDefinition;
  items: RawItem[];
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const RSS_MAX_BYTES = 1_500_000;
const SUMMARY_MAX_CHARS = 250;
const USER_AGENT = 'ArdurAI/1.0 (+https://ardur.ai)';

// Additional CDN/feed proxy hosts that some feed URLs resolve through
const EXTRA_FEED_HOSTS = new Set([
  'feeds.feedburner.com',
  'feed.infoq.com',
  'export.arxiv.org',
]);

function splitTitle(rawTitle: string, fallbackSource: string): { title: string; source: string } {
  const cleaned = stripMarkup(rawTitle);
  // Only split on " - " pattern at the very end, to avoid splitting mid-title dashes
  const match = cleaned.match(/^(.*?)\s+-\s+([^-]{2,60})$/);
  if (!match) return { title: cleaned, source: fallbackSource || 'News source' };
  return { title: (match[1] ?? cleaned).trim(), source: fallbackSource || (match[2] ?? '').trim() || 'News source' };
}

function publishedDate(value: unknown, now: Date): Date {
  const d = new Date(String(value ?? ''));
  if (!Number.isFinite(d.valueOf())) return now;
  // Clamp future dates to now
  return d.valueOf() > now.valueOf() ? now : d;
}

function toArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function truncate(text: string, maxChars: number): string {
  const stripped = stripMarkup(text);
  if (stripped.length <= maxChars) return stripped;
  return stripped.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
}

// Build the allowed hosts set for a given source
function allowedHostsFor(source: SourceDefinition): Set<string> {
  const hosts = new Set([source.domain]);
  for (const h of EXTRA_FEED_HOSTS) hosts.add(h);
  return hosts;
}

// ---------------------------------------------------------------------------
// Feed parsers
// ---------------------------------------------------------------------------

interface ParsedEntry {
  title: string;
  url: string;
  pubDate: string;
  sourceLabel: string;
  sourceUrl: string;
  description: string;
  /** Full content from the feed (content:encoded for RSS, content for Atom). May be HTML. */
  rawContent: string;
}

function parseRssChannel(parsed: Record<string, unknown>): ParsedEntry[] {
  // RSS 2.0 path: rss.channel.item
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rss = parsed['rss'] as Record<string, any> | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channel = rss?.['channel'] as Record<string, any> | undefined;
  if (channel) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = toArray(channel['item']);
    return items.map((item) => {
      // Google News RSS <source> element
      const sourceEl = item['source'];
      const sourceLabel = typeof sourceEl === 'object' && sourceEl !== null
        ? String(sourceEl['#text'] ?? '')
        : '';
      const sourceUrl = typeof sourceEl === 'object' && sourceEl !== null
        ? String(sourceEl['@_url'] ?? '')
        : '';
      return {
        title: String(item['title'] ?? ''),
        url: String(item['link'] ?? item['@_rdf:about'] ?? ''),
        pubDate: String(item['pubDate'] ?? item['dc:date'] ?? ''),
        sourceLabel,
        sourceUrl,
        description: String(item['description'] ?? ''),
        rawContent: String(item['content:encoded'] ?? item['description'] ?? ''),
      };
    });
  }

  // Atom path: feed.entry
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed = parsed['feed'] as Record<string, any> | undefined;
  if (feed) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries: any[] = toArray(feed['entry']);
    return entries.map((entry) => {
      // Atom link can be string or object with @_href
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const linkEl = entry['link'];
      let url = '';
      if (typeof linkEl === 'string') url = linkEl;
      else if (Array.isArray(linkEl)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const alternate = linkEl.find((l: any) => l['@_rel'] === 'alternate' || !l['@_rel']);
        url = String(alternate?.['@_href'] ?? '');
      } else if (typeof linkEl === 'object' && linkEl !== null) {
        url = String(linkEl['@_href'] ?? '');
      }
      return {
        title: String(entry['title']?.['#text'] ?? entry['title'] ?? ''),
        url,
        pubDate: String(entry['published'] ?? entry['updated'] ?? ''),
        sourceLabel: String(feed['title']?.['#text'] ?? feed['title'] ?? ''),
        sourceUrl: '',
        description: String(entry['summary']?.['#text'] ?? entry['summary'] ?? ''),
        rawContent: String(
          entry['content']?.['#text'] ?? entry['content'] ??
          entry['summary']?.['#text'] ?? entry['summary'] ?? '',
        ),
      };
    });
  }

  return [];
}

function buildRawItems(
  entries: ParsedEntry[],
  source: SourceDefinition,
  topic: TopicDefinition,
  now: Date,
  maxAgeMs: number,
): RawItem[] {
  const results: RawItem[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const pubDate = publishedDate(entry.pubDate, now);
    if (now.valueOf() - pubDate.valueOf() > maxAgeMs) continue;

    const feedSourceLabel = entry.sourceLabel ? stripMarkup(entry.sourceLabel) : source.label;
    const split = splitTitle(entry.title, feedSourceLabel);
    if (!split.title) continue;

    const itemUrl = normalizePublicUrl(entry.url);
    if (!itemUrl) continue;

    const rawSourceUrl = entry.sourceUrl
      ? entry.sourceUrl
      : source.strategy.kind === 'rss'
        ? source.strategy.feedUrl
        : '';
    const normalizedSourceUrl = rawSourceUrl ? normalizePublicUrl(rawSourceUrl) : '';

    // feedBody: full text from the feed (content:encoded / Atom content), stripped of HTML.
    // Only set when substantial — short snippets are not worth preferring over a URL fetch.
    const strippedContent = entry.rawContent ? stripMarkup(entry.rawContent) : '';

    results.push({
      topic: topic.id,
      topicLabel: topic.label,
      title: split.title,
      source: split.source,
      sourceDomain: (() => {
        try { return new URL(itemUrl).hostname.replace(/^www\./, ''); } catch { return source.domain; }
      })(),
      sourceUrl: normalizedSourceUrl,
      url: itemUrl,
      tier: source.tier,
      publishedAt: pubDate.toISOString(),
      summaryHint: truncate(entry.description || entry.rawContent || split.title, SUMMARY_MAX_CHARS),
      feedRank: i,
      ...(strippedContent.length >= 200 ? { feedBody: strippedContent } : {}),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function ingestSource(
  source: SourceDefinition,
  topic: TopicDefinition,
  opts: { now: Date; maxAgeMs: number; perSourceTimeoutMs?: number },
): Promise<IngestResult> {
  const DEFAULT_TIMEOUT_MS = 30_000;
  const timeout = Number.isFinite(opts.perSourceTimeoutMs ?? DEFAULT_TIMEOUT_MS)
    ? (opts.perSourceTimeoutMs ?? DEFAULT_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  try {
    let feedUrl: string;
    let allowedHosts: Set<string>;

    if (source.strategy.kind === 'google-news-rss') {
      if (!topic.query) {
        // 'all' topic has no query — skip
        return { source, items: [], ok: true };
      }
      const url = new URL('https://news.google.com/rss/search');
      url.searchParams.set('q', topic.query);
      url.searchParams.set('hl', 'en-US');
      url.searchParams.set('gl', 'US');
      url.searchParams.set('ceid', 'US:en');
      feedUrl = assertAllowedFetchUrl(url.toString(), GOOGLE_NEWS_FETCH_HOSTS);
      allowedHosts = GOOGLE_NEWS_FETCH_HOSTS;
    } else if (source.strategy.kind === 'rss') {
      allowedHosts = allowedHostsFor(source);
      feedUrl = assertAllowedFetchUrl(source.strategy.feedUrl, allowedHosts, { allowedPorts: DEFAULT_FETCH_PORTS });
    } else {
      // json strategy — treat as Atom/RSS endpoint
      allowedHosts = allowedHostsFor(source);
      feedUrl = assertAllowedFetchUrl(source.strategy.endpoint, allowedHosts, { allowedPorts: DEFAULT_FETCH_PORTS });
    }

    const response = await fetch(feedUrl, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      return { source, items: [], ok: false, error: `HTTP ${response.status} ${response.statusText}` };
    }

    const xml = await readBoundedText(response, {
      maxBytes: RSS_MAX_BYTES,
      label: `${source.domain} feed`,
    });

    const parsed = parser.parse(xml) as Record<string, unknown>;
    const entries = parseRssChannel(parsed);
    const items = buildRawItems(entries, source, topic, opts.now, opts.maxAgeMs);
    return { source, items, ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { source, items: [], ok: false, error };
  }
}

export async function ingestTopic(
  topic: TopicDefinition,
  sources: SourceDefinition[],
  opts: { now: Date; maxAgeMs: number; concurrency: number; perSourceTimeoutMs: number },
): Promise<IngestResult[]> {
  const { concurrency, perSourceTimeoutMs, now, maxAgeMs } = opts;
  const results: IngestResult[] = [];
  const queue = [...sources];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const source = queue.shift();
      if (!source) break;
      const result = await ingestSource(source, topic, { now, maxAgeMs, perSourceTimeoutMs });
      results.push(result);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, sources.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
