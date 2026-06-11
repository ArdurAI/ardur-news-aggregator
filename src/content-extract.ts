/**
 * Full-text article fetch and content extraction.
 *
 * Fetches article URLs (SSRF-guarded via existing source-safety primitives),
 * classifies access (allowed / paywalled / robots-disallowed / tos-restricted),
 * extracts main-content text, and returns a structured result ready for the ETL store.
 *
 * Copyright posture (A5):
 *   - Bodies stored PRIVATELY; never emitted on the wire.
 *   - Wire carries metadata + extracted facts + short quotes (<25 words) only.
 *   - Paywalled/robots-disallowed sources receive snippet-only extraction + flagged status.
 */

import { assertAllowedFetchUrl, readBoundedText, DEFAULT_FETCH_PORTS } from './source-safety.ts';
import { checkRobots } from './robots.ts';
import { docIdFromUrl, contentHashOf } from './etl-store.ts';
import type { SourceDocument, SourceTier, ExtractionStatus, AccessPolicy } from '@ardurai/contracts';

const ARTICLE_USER_AGENT = 'ArdurContentBot/1.0 (+https://ardur.ai/bot)';
const ARTICLE_MAX_BYTES = 3_000_000; // 3 MB — generous but bounded
const FETCH_TIMEOUT_MS = 20_000;
const SNIPPET_MAX_CHARS = 500;

// Per-host concurrency cap — max parallel fetches to one host
const hostInFlight = new Map<string, number>();
const MAX_PER_HOST = 1;

// Heuristic paywall markers
const PAYWALL_META_PATTERNS = [
  /isAccessibleForFree["'\s]*:\s*["']?false/i,
  /og:article:access["'\s]*content=["']subscriber/i,
];

const PAYWALL_SELECTORS = [
  'paywall',
  'pay-wall',
  'subscriber-only',
  'premium-content',
  'metered-content',
  'restricted-content',
  'locked-content',
];

const TOS_DISALLOW_DOMAINS = new Set([
  // Known domains that prohibit automated scraping in their ToS
  // Extend this list as needed based on policy review
  'wsj.com',
  'ft.com',
  'nytimes.com',
  'bloomberg.com',
  'economist.com',
]);

// ── HTML → text extraction ───────────────────────────────────────────────────

const REMOVE_TAGS_RE = /<(script|style|nav|header|footer|aside|noscript|figure|form|iframe|svg|button)[^>]*>[\s\S]*?<\/\1>/gi;
const STRIP_TAGS_RE = /<[^>]+>/g;
const COLLAPSE_WS_RE = /[ \t\r\n]{2,}/g;

/** Naïve but dependency-free HTML → readable-text extraction. */
function extractText(html: string): string {
  // Remove block-level non-content tags wholesale
  let text = html.replace(REMOVE_TAGS_RE, ' ');
  // Strip remaining tags
  text = text.replace(STRIP_TAGS_RE, ' ');
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(COLLAPSE_WS_RE, ' ').trim();
  return text;
}

/** Find the largest contiguous text block — rough main-body heuristic. */
function mainBodyFrom(text: string, snippetMaxChars: number): { body: string; isSnippet: boolean } {
  // Split into paragraphs and pick the 80% longest contiguous run
  const paragraphs = text.split(/\n{2,}|\s{4,}/).map((p) => p.trim()).filter((p) => p.length > 80);
  if (!paragraphs.length) {
    const snippet = text.slice(0, snippetMaxChars).trim();
    return { body: snippet, isSnippet: true };
  }
  // Take all paragraphs — callers decide how much to keep
  const body = paragraphs.join('\n\n');
  const isSnippet = body.length < 300;
  return { body, isSnippet };
}

// ── Paywall detection ────────────────────────────────────────────────────────

function detectPaywall(html: string, domain: string): boolean {
  if (TOS_DISALLOW_DOMAINS.has(domain)) return true;
  for (const pattern of PAYWALL_META_PATTERNS) {
    if (pattern.test(html)) return true;
  }
  const lowerHtml = html.toLowerCase();
  for (const selector of PAYWALL_SELECTORS) {
    if (lowerHtml.includes(`class="${selector}"`) || lowerHtml.includes(`id="${selector}"`)) {
      return true;
    }
  }
  // Likely paywalled if the "body" is very short (< 200 chars of text after stripping)
  const bodyText = extractText(html);
  if (bodyText.length < 200) return true;
  return false;
}

// ── Language detection (simple heuristic) ───────────────────────────────────

function detectLang(html: string): string | null {
  const langMatch = /<html[^>]+lang=["']([a-zA-Z-]+)["']/i.exec(html);
  return langMatch?.[1]?.toLowerCase().split('-')[0] ?? null;
}

// ── Per-host rate limiting ───────────────────────────────────────────────────

async function acquireHostSlot(host: string): Promise<() => void> {
  // Spin-wait until this host has capacity (simple politeness guard)
  while ((hostInFlight.get(host) ?? 0) >= MAX_PER_HOST) {
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  hostInFlight.set(host, (hostInFlight.get(host) ?? 0) + 1);
  return () => {
    hostInFlight.set(host, Math.max(0, (hostInFlight.get(host) ?? 1) - 1));
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface FetchedArticle {
  doc: SourceDocument;
  /** Extracted body text — PRIVATE; store in EtlStore, never emit on wire. */
  body: string | null;
  /** HTTP ETag from the response — pass to EtlStore.put() opts for conditional re-fetch. Not on wire. */
  etag?: string;
  /** HTTP Last-Modified from the response. Not on wire. */
  lastModified?: string;
}

export interface ArticleFetchOpts {
  title?: string;
  publishedAt?: string;
  source?: string;
  tier?: SourceTier;
  etag?: string;
  lastModified?: string;
}

/**
 * Fetch and extract one article URL.
 * Returns a SourceDocument (wire-safe) and private body text.
 * Respects robots.txt, ToS policy, and SSRF guards.
 */
export async function fetchArticle(
  url: string,
  opts: ArticleFetchOpts = {},
): Promise<FetchedArticle> {
  const fetchedAt = new Date().toISOString();

  let canonicalUrl: string;
  try {
    canonicalUrl = assertAllowedFetchUrl(url, [], { allowedPorts: DEFAULT_FETCH_PORTS });
  } catch {
    // Not a public URL
    return makeFailedDoc(url, fetchedAt, 'tos-restricted', opts);
  }

  let host: string;
  try {
    host = new URL(canonicalUrl).hostname.replace(/^www\./, '');
  } catch {
    return makeFailedDoc(url, fetchedAt, 'tos-restricted', opts);
  }

  // robots.txt check
  const { allowed, crawlDelaySeconds } = await checkRobots(canonicalUrl);
  if (!allowed) {
    return makeFailedDoc(canonicalUrl, fetchedAt, 'robots-disallowed', opts);
  }

  // Per-host rate limiting: enforce crawl-delay if specified
  const release = await acquireHostSlot(host);
  try {
    if (crawlDelaySeconds && crawlDelaySeconds > 0) {
      await new Promise<void>((r) => setTimeout(r, Math.min(crawlDelaySeconds * 1000, 5000)));
    }

    const headers: Record<string, string> = {
      'user-agent': ARTICLE_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    };
    if (opts.etag) headers['if-none-match'] = opts.etag;
    if (opts.lastModified) headers['if-modified-since'] = opts.lastModified;

    const response = await fetch(canonicalUrl, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 304) {
      // Not modified — caller can use their cached version
      return makeNotModifiedDoc(canonicalUrl, fetchedAt, opts);
    }

    if (!response.ok) {
      return makeFailedDoc(canonicalUrl, fetchedAt, 'allowed', opts);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return makeFailedDoc(canonicalUrl, fetchedAt, 'tos-restricted', opts);
    }

    const html = await readBoundedText(response, {
      maxBytes: ARTICLE_MAX_BYTES,
      label: `article ${host}`,
    });

    const etag = response.headers.get('etag') ?? undefined;
    const lastModified = response.headers.get('last-modified') ?? undefined;
    const lang = detectLang(html);

    if (detectPaywall(html, host)) {
      const snippet = extractText(html).slice(0, SNIPPET_MAX_CHARS);
      const contentHash = contentHashOf(snippet);
      const id = docIdFromUrl(canonicalUrl);
      const doc: SourceDocument = {
        id,
        url: canonicalUrl,
        source: opts.source ?? host,
        sourceDomain: host,
        tier: opts.tier ?? 'news',
        title: opts.title ?? '',
        publishedAt: opts.publishedAt ?? fetchedAt,
        fetchedAt,
        extraction: 'snippet',
        accessPolicy: 'paywalled',
        wordCount: snippet.split(/\s+/).length,
        lang,
        contentHash,
      };
      const result: FetchedArticle = { doc, body: snippet };
      if (etag !== undefined) result.etag = etag;
      if (lastModified !== undefined) result.lastModified = lastModified;
      return result;
    }

    const bodyText = extractText(html);
    const { body } = mainBodyFrom(bodyText, SNIPPET_MAX_CHARS);
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    const contentHash = contentHashOf(body);
    const id = docIdFromUrl(canonicalUrl);

    const doc: SourceDocument = {
      id,
      url: canonicalUrl,
      source: opts.source ?? host,
      sourceDomain: host,
      tier: opts.tier ?? 'news',
      title: opts.title ?? '',
      publishedAt: opts.publishedAt ?? fetchedAt,
      fetchedAt,
      extraction: wordCount > 50 ? 'full' : 'snippet',
      accessPolicy: 'allowed',
      wordCount,
      lang,
      contentHash,
    };

    const result: FetchedArticle = { doc, body };
    if (etag !== undefined) result.etag = etag;
    if (lastModified !== undefined) result.lastModified = lastModified;
    return result;
  } finally {
    release();
  }
}

function makeFailedDoc(
  url: string,
  fetchedAt: string,
  accessPolicy: AccessPolicy,
  opts: ArticleFetchOpts,
): FetchedArticle {
  let canonicalUrl = url;
  let host = url;
  try {
    const parsed = new URL(url);
    canonicalUrl = `${parsed.origin}${parsed.pathname}`;
    host = parsed.hostname.replace(/^www\./, '');
  } catch {
    // use url as-is
  }
  const id = docIdFromUrl(canonicalUrl);
  const contentHash = contentHashOf('');
  const doc: SourceDocument = {
    id,
    url: canonicalUrl,
    source: opts.source ?? host,
    sourceDomain: host,
    tier: opts.tier ?? 'news',
    title: opts.title ?? '',
    publishedAt: opts.publishedAt ?? fetchedAt,
    fetchedAt,
    extraction: 'failed',
    accessPolicy,
    wordCount: null,
    lang: null,
    contentHash,
  };
  return { doc, body: null };
}

function makeNotModifiedDoc(
  url: string,
  fetchedAt: string,
  opts: ArticleFetchOpts,
): FetchedArticle {
  // Caller should use existing stored doc; return a thin placeholder
  return makeFailedDoc(url, fetchedAt, 'allowed', opts);
}

/** Word-count of extracted body (0 if body is null). */
export function wordCountOf(body: string | null): number {
  if (!body) return 0;
  return body.split(/\s+/).filter(Boolean).length;
}
