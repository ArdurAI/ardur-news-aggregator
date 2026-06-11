/**
 * Shared source and topic type definitions — imported by sources.ts, catalog.ts,
 * and ingest.ts. Extracted here so catalog.ts can depend on these types without
 * creating a circular dependency with sources.ts.
 */
import type { SourceTier, TopicMeta } from '@ardurai/contracts';
export type FetchStrategy = {
    kind: 'rss';
    feedUrl: string;
} | {
    kind: 'google-news-rss';
} | {
    kind: 'json';
    endpoint: string;
};
export interface SourceDefinition {
    domain: string;
    label: string;
    tier: SourceTier;
    topics: string[];
    strategy: FetchStrategy;
    credibilityHint?: number;
}
export interface TopicDefinition extends TopicMeta {
    query: string;
    terms: string[];
    diversityFloor: number;
}
