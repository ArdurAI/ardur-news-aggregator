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
import type { SourceDocument, SourceTier } from '@ardurai/contracts';
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
export declare function fetchArticle(url: string, opts?: ArticleFetchOpts): Promise<FetchedArticle>;
/** Word-count of extracted body (0 if body is null). */
export declare function wordCountOf(body: string | null): number;
