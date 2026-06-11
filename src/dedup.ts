/**
 * Dedup — collapse identical/near-identical items across sources.
 *
 * SCAFFOLD ONLY. Generalize `uniqueByTitle` from
 * `ardur.ai/main:scripts/refresh-news.mjs`: build a stable fingerprint from the
 * normalized title + canonical URL so the SAME story from MULTIPLE sources is
 * recognized (those become cluster members, not discards — see cluster.ts).
 */

import type { RawItem } from './ingest.ts';

/** Stable dedup key: normalized title + canonical URL host/path. */
export function fingerprint(_item: Pick<RawItem, 'title' | 'url'>): string {
  throw new Error('not implemented');
}

export interface DedupResult {
  items: (RawItem & { fingerprint: string })[];
  duplicatesRemoved: number;
}

/**
 * Remove exact duplicates (same fingerprint AND same source). Cross-source
 * matches are KEPT — corroboration is signal, consumed by clustering/ranking.
 */
export function dedupe(_items: RawItem[]): DedupResult {
  throw new Error('not implemented');
}
