/**
 * Clustering — group items that cover the same story across sources.
 * Ported from clusterItems/similarity/tokens in build-news-digests.mjs.
 */
import type { AggregatedItem, Cluster } from '@ardurai/contracts';
export declare function stripMarkup(text: string): string;
export interface ClusterOptions {
    threshold: number;
    importantTerms: string[];
}
export declare function clusterItems(items: Omit<AggregatedItem, 'clusterId'>[], options: ClusterOptions): {
    items: AggregatedItem[];
    clusters: Cluster[];
};
