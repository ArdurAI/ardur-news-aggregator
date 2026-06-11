/**
 * Dedup — collapse exact duplicates; keep cross-source corroboration.
 * Ported and generalized from uniqueByTitle in refresh-news.mjs.
 */
import type { RawItem } from './ingest.ts';
export declare function fingerprint(item: Pick<RawItem, 'title' | 'url'>): string;
export interface DedupResult {
    items: (RawItem & {
        fingerprint: string;
    })[];
    duplicatesRemoved: number;
}
export declare function dedupe(items: RawItem[]): DedupResult;
