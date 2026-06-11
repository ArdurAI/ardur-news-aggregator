/**
 * Clustering — group items that cover the same story across sources.
 *
 * SCAFFOLD ONLY. Extract `clusterItems`, `similarity`, `tokens` from
 * `ardur.ai/main:scripts/build-news-digests.mjs` (token-overlap similarity with
 * an "important entity" boost, threshold ~0.82). Each cluster's member count
 * across DISTINCT sources is the corroboration signal ranking depends on.
 */

import type { AggregatedItem, Cluster } from './contracts.ts';

export interface ClusterOptions {
  /** Similarity threshold to merge an item into an existing cluster (~0.82). */
  threshold: number;
  /** Entities that get a similarity boost (e.g. "openai", "kubernetes"). */
  importantTerms: string[];
}

/**
 * Cluster deduped items into stories. Assigns each item a `clusterId` and
 * returns both the enriched items and the cluster summaries (with tier
 * histogram, distinct-domain count, and time span).
 */
export function clusterItems(
  _items: Omit<AggregatedItem, 'clusterId'>[],
  _options: ClusterOptions,
): { items: AggregatedItem[]; clusters: Cluster[] } {
  throw new Error('not implemented: port clusterItems/similarity from build-news-digests.mjs');
}
