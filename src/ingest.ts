/**
 * Ingestion — fetch one source, parse its feed, emit normalized raw items.
 *
 * SCAFFOLD ONLY. Extract the fetch+parse+score core from
 * `ardur.ai/main:scripts/refresh-news.mjs` (`fetchTopic`, `scoreItem`,
 * `splitTitle`, `publishedDate`). All fetches MUST go through `source-safety`.
 * Captured text is metadata/feed-derived only — never the article body.
 */

import type { SourceTier } from './contracts.ts';
import type { SourceDefinition, TopicDefinition } from './sources.ts';

/** Raw item straight off a feed, before dedup/clustering. */
export interface RawItem {
  topic: string;
  topicLabel: string;
  title: string;
  source: string;
  sourceDomain: string;
  sourceUrl: string;
  url: string;
  tier: SourceTier;
  publishedAt: string; // ISO 8601 UTC
  summaryHint: string; // feed description / metadata, NOT article body
  feedRank: number; // 0-based position in the source feed
}

export interface IngestResult {
  source: SourceDefinition;
  items: RawItem[];
  ok: boolean;
  error?: string; // populated on failure; the run continues (degraded coverage)
}

/** Fetch + parse a single source for a single topic. Must never throw. */
export function ingestSource(
  _source: SourceDefinition,
  _topic: TopicDefinition,
  _opts: { now: Date; maxAgeMs: number },
): Promise<IngestResult> {
  throw new Error('not implemented: port fetch/parse from scripts/refresh-news.mjs');
}

/** Ingest every source for a topic concurrently, with per-source timeouts. */
export function ingestTopic(
  _topic: TopicDefinition,
  _sources: SourceDefinition[],
  _opts: { now: Date; maxAgeMs: number; concurrency: number; perSourceTimeoutMs: number },
): Promise<IngestResult[]> {
  throw new Error('not implemented');
}
