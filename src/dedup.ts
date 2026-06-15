/**
 * Dedup — collapse exact duplicates; keep cross-source corroboration.
 * Ported and generalized from uniqueByTitle in refresh-news.mjs.
 */

import type { RawItem } from './ingest.ts';
import { stripMarkup } from './util.ts';

function normalizeTitle(title: string): string {
  return stripMarkup(title).toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeUrlPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    return url.toLowerCase().slice(0, 200);
  }
}

export function fingerprint(item: Pick<RawItem, 'title' | 'url'>): string {
  return `${normalizeTitle(item.title)}|${normalizeUrlPath(item.url)}`;
}

export interface DedupResult {
  items: (RawItem & { fingerprint: string })[];
  duplicatesRemoved: number;
}

export function dedupe(items: RawItem[]): DedupResult {
  const withFingerprints = items.map((item) => ({ ...item, fingerprint: fingerprint(item) }));
  // Key: fingerprint + sourceDomain — same story from same source is a dup
  const seen = new Map<string, true>();
  const output: (RawItem & { fingerprint: string })[] = [];
  let duplicatesRemoved = 0;

  for (const item of withFingerprints) {
    const sameSourceKey = `${item.fingerprint}::${item.sourceDomain}`;
    if (seen.has(sameSourceKey)) {
      duplicatesRemoved++;
      continue;
    }
    seen.set(sameSourceKey, true);
    output.push(item);
  }

  return { items: output, duplicatesRemoved };
}
