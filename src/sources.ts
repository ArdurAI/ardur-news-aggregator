/**
 * Source registry — the curated, tiered, per-topic source list.
 *
 * SCAFFOLD ONLY. Seed the registry by extracting `newsSourceAllowList` and
 * `newsTopics` from `ardur.ai/main:scripts/news-sources.mjs`, then EXPAND each
 * topic to >= 20-30 sources (the existing list is the trusted core, not the
 * ceiling). Every source must declare a fetch strategy so ingestion is uniform.
 */

import type { SourceTier, TopicMeta } from './contracts.ts';

/** How a single source is fetched. */
export type FetchStrategy =
  | { kind: 'rss'; feedUrl: string } // direct publisher RSS/Atom
  | { kind: 'google-news-rss' } // topic query against the Google News meta-feed
  | { kind: 'json'; endpoint: string }; // structured API (e.g. arXiv, vendor JSON)

export interface SourceDefinition {
  domain: string; // canonical host, e.g. "reuters.com"
  label: string; // display name
  tier: SourceTier;
  topics: string[]; // topic ids this source covers
  strategy: FetchStrategy;
  /** Optional weight hint for credibility scoring (consumed downstream). */
  credibilityHint?: number;
}

export interface TopicDefinition extends TopicMeta {
  query: string; // meta-feed query (when strategy === 'google-news-rss')
  terms: string[]; // relevance terms for hint extraction
  /** Minimum distinct sources required before the topic is considered healthy. */
  diversityFloor: number; // default target: 20
}

/**
 * Load the full source registry. Implementations should return the curated
 * allow-list expanded to >= 20-30 sources/topic and validated against
 * `source-safety` (every feedUrl must normalize to a safe public https URL).
 */
export function loadSources(): SourceDefinition[] {
  throw new Error('not implemented: seed from scripts/news-sources.mjs, expand to >=20/topic');
}

/** Load the topic definitions (ids, labels, queries, diversity floors). */
export function loadTopics(): TopicDefinition[] {
  throw new Error('not implemented: seed from scripts/news-sources.mjs newsTopics');
}

/** Sources that cover a given topic id. */
export function sourcesForTopic(_topicId: string): SourceDefinition[] {
  throw new Error('not implemented');
}
