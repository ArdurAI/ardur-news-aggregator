/**
 * Ingestion — fetch one source, parse its feed, emit normalized raw items.
 * Ported from fetchTopic/splitTitle/publishedDate in refresh-news.mjs and extended
 * to support direct RSS, Google News RSS meta-feed, and Atom/JSON (e.g. arXiv).
 */
import type { SourceTier } from '@ardurai/contracts';
import type { SourceDefinition, TopicDefinition } from './source-types.ts';
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
}
export interface IngestResult {
    source: SourceDefinition;
    items: RawItem[];
    ok: boolean;
    error?: string;
}
export declare function ingestSource(source: SourceDefinition, topic: TopicDefinition, opts: {
    now: Date;
    maxAgeMs: number;
    perSourceTimeoutMs?: number;
}): Promise<IngestResult>;
export declare function ingestTopic(topic: TopicDefinition, sources: SourceDefinition[], opts: {
    now: Date;
    maxAgeMs: number;
    concurrency: number;
    perSourceTimeoutMs: number;
}): Promise<IngestResult[]>;
