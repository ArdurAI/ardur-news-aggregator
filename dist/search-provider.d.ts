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
import type { SourceTier } from '@ardurai/contracts';
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
export declare function classifyDiscoveredDomain(domain: string): {
    tier: SourceTier;
    credibilityHint: number;
};
export declare class GoogleNewsSearchProvider implements SearchProvider {
    readonly name = "google-news-rss";
    search(query: string, _topicId: string, _now: Date): Promise<SearchResult[]>;
}
/** Returns the default set of search providers used in production. */
export declare function defaultSearchProviders(): SearchProvider[];
/**
 * Run all providers for a topic query, de-duplicate by URL, and return
 * the merged result set. Logs newly-discovered domains for catalog review.
 */
export declare function searchAllProviders(query: string, topicId: string, now: Date, providers: SearchProvider[], knownDomains: Set<string>, onNewDomain?: (domain: string, classification: {
    tier: SourceTier;
    credibilityHint: number;
}) => void): Promise<SearchResult[]>;
