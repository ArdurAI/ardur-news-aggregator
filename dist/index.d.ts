/**
 * ardur-news-aggregator — public entrypoint.
 *
 * Stage 1 of the Ardur content pipeline: ingest ALL clustered coverage (no
 * source ceiling — A1), widen via per-topic search discovery (A2), run the
 * ETL (full-text fetch + extraction + persistent store — A3), extract
 * ExtractedFact[] with per-source provenance (A4), and enforce the copyright
 * guard (A5).  Emits AggregationArtifact with rev-3 extensions when the ETL
 * is enabled.
 *
 * Practical limits (no silent caps):
 *   - Per-source fetch budget (perSourceTimeoutMs).
 *   - Dedup (title+url fingerprint + contentHash).
 *   - robots.txt / ToS restrictions — flagged as warnings, never silently dropped.
 *
 * ETL is opt-in via ARDUR_ETL_ENABLED=true (or options.etlEnabled).
 * When disabled the pipeline behaves exactly as before (CI-friendly).
 */
import type { AggregationArtifact, CycleMeta } from '@ardurai/contracts';
export * from '@ardurai/contracts';
export * from './contracts-v3.ts';
export type { SourceDefinition, TopicDefinition, FetchStrategy } from './sources.ts';
export type { RawItem, IngestResult } from './ingest.ts';
export type { SearchProvider, SearchResult } from './search-provider.ts';
export type { EtlStore } from './etl-store.ts';
export interface AggregationOptions {
    cycle?: CycleMeta;
    maxAgeMs?: number;
    perSourceTimeoutMs?: number;
    concurrency?: number;
    now?: Date;
    /** Pin the artifact's runId for deterministic output. When absent, a random UUID is generated. */
    runId?: string;
    /** Run the full ETL (fetch bodies + extract facts). Defaults to ARDUR_ETL_ENABLED env var. */
    etlEnabled?: boolean;
    /** Max article fetches per topic during ETL (budget guard). Default: 30. */
    etlFetchBudgetPerTopic?: number;
    /** Per-article fetch timeout in ms during ETL. Default: 20 000. */
    etlArticleTimeoutMs?: number;
}
export declare function runAggregation(options?: AggregationOptions): Promise<AggregationArtifact>;
